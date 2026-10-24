// Space DO, base layer: rate limits, approval asks, capability checks, the versioned file store (tree/blobs), presence, the alarm.
// One layer of the Space class chain (core -> gc -> events -> files -> tasks -> Space in src/space.ts); split for size only, no behavior lives in the chain itself.
import { isRoot } from "../../client/account.ts";
import { DurableObject } from "cloudflare:workers";
import { globMatch, RelayError, type Peer } from "../ops.ts";
import { b64encode, type BlobStore } from "../blobs.ts";
import { type Member, now, VERB_PREFIX } from "./util.ts";

export class SpaceCore extends DurableObject<Env> {
  sql!: SqlStorage;
  store!: BlobStore | null;
  lastSeenAt = new Map<string, number>();
  waiters = new Set<() => void>(); // long-poll callers parked until the next event
  wait(sec: number) {
    return new Promise<void>(res => { const done = () => { clearTimeout(tm); this.waiters.delete(done); res(); };
      const tm = setTimeout(done, Math.min(Math.max(sec, 0), 25) * 1000); this.waiters.add(done); });
  }
  // env knob: unset or "" (a declared-but-empty binding) = the default, so an empty deploy var never silently turns a limit off
  knob(k: string, def: number): number { const v = (this.env as any)[k]; const n = v === undefined || v === null || v === "" ? def : Number(v); return Number.isFinite(n) && n >= 0 ? n : def; }

  // ---------- per-token rate limit: requests per minute per token (a peer token, or one OAuth grant) in this space ----------
  // Default 600/min (RATE_PER_MIN env; per space or per peer via admin `ratelimit <space> <per_min> [peer]`; 0 = off). Fixed one-minute
  // windows held in memory: cheap, and a DO restart only ever forgives, never over-blocks. Over the limit = 429 with when to retry.
  rate = new Map<string, { win: number; n: number }>();
  rateLimitFor(peer: Peer): number {
    const r = this.sql.exec("select k, v from meta where k in ('rate_per_min', ?)", "rate:" + peer.name).toArray() as any[];
    const own = r.find(x => x.k !== "rate_per_min"), all = r.find(x => x.k === "rate_per_min");
    return Number(own?.v ?? all?.v ?? this.knob("RATE_PER_MIN", 600));
  }
  rateHit(peer: Peer): { status: number; error: string; retry_after: number } | null {
    const lim = this.rateLimitFor(peer); if (!(lim > 0)) return null;
    const key = peer.id + ":" + (peer.grant ?? "token"), win = Math.floor(Date.now() / 60_000), cur = this.rate.get(key);
    if (!cur || cur.win !== win) { if (this.rate.size > 5000) this.rate.clear(); this.rate.set(key, { win, n: 1 }); return null; }
    if (++cur.n <= lim) return null;
    const retry = Math.max(1, Math.ceil(((win + 1) * 60_000 - Date.now()) / 1000));
    return { status: 429, retry_after: retry, error: `rate limited: ${peer.name} sent more than ${lim} requests in a minute to workspace ${this.spaceId} (limit for this token: ${lim}/min). Retry in ${retry}s; prefer wait=<sec> long-polls or events/stream over tight polling. ${this.selfHostedRoot() ? `The owner can raise it: admin.ts ratelimit ${this.spaceId} <per_min> ${peer.name}` : `If normal use hits it, tell the workspace owner: they see ${peer.name} on the server's /start page (Status) and can revoke or reconnect it; the limit itself is set by the server's operator`}` };
  }
  async setRate(perMin?: number | null, peerName?: string | null) {
    const k = peerName ? "rate:" + peerName : "rate_per_min";
    if (perMin !== undefined && perMin !== null) {
      if (!Number.isInteger(perMin) || perMin < 0 || perMin > 1_000_000) throw new Error("per_min: 0 (no limit) to 1000000");
      this.sql.exec("insert or replace into meta values(?,?)", k, String(perMin));
    }
    const peers = Object.fromEntries((this.sql.exec("select k, v from meta where k like 'rate:%'").toArray() as any[]).map(r => [String(r.k).slice(5), Number(r.v)]));
    const all = this.sql.exec("select v from meta where k='rate_per_min'").toArray()[0]?.v;
    return { per_min: Number(all ?? this.knob("RATE_PER_MIN", 600)), peers };
  }
  // a space of the operator's own (root) account on a Kitebook server strangers don't sign up on: its owner has the admin key and admin.ts.
  // Everyone else (hosted signups via /start) gets hints that point at /start, never at a CLI they don't have.
  selfHostedRoot() { const a = this.sql.exec("select v from meta where k='acct'").toArray()[0]?.v; return isRoot(a as string | null) && (this.env as any).HOSTED !== "1"; }
  get spaceId() { return (this.sql.exec("select v from meta where k='id'").toArray()[0]?.v as string) ?? "?"; }

  // ---------- phone review page (approval gates v2): one-time asks a runner opens, decided from GET/POST /approve/<id> ----------
  // The server only carries the decision. Binding (payload hash + HMAC nonce, 5-minute expiry) and passkey signatures are
  // checked by the runner, which holds the key; an id is single-use and dies at its expiry.
  askRow(id: string) {
    const r = this.sql.exec("select * from asks where id=?", String(id)).toArray()[0] as any; if (!r) return null;
    if (r.state === "pending" && Date.now() > r.expires) { this.sql.exec("update asks set state='expired' where id=?", r.id); r.state = "expired"; }
    return r;
  }
  async askView(id: string) {
    const r = this.askRow(id); if (!r) return null;
    return { kind: r.kind, state: r.state, view: JSON.parse(r.view), challenge: r.nonce, passkey: r.passkey ? JSON.parse(r.passkey) : null, expires_at: r.expires, owner_only: !!r.owner_only, task: r.task ?? null };
  }
  async askDecide(id: string, b: any): Promise<{ status: number; error?: string; state?: string }> {
    const r = this.askRow(id); if (!r) return { status: 404, error: "no such request" };
    if (r.state !== "pending") return { status: 410, error: `this request is ${r.state}` };
    const str = (x: any) => typeof x === "string" && x.length > 0 && x.length <= 8192;
    let state: string, resp: any;
    if (r.kind === "register") {
      const c = b?.credential; if (!c || !str(c.id) || !str(c.publicKey) || !str(c.clientDataJSON) || typeof c.alg !== "number") return { status: 400, error: "send credential {id, publicKey, alg, clientDataJSON}" };
      state = "registered"; resp = { credential: { id: c.id, publicKey: c.publicKey, alg: c.alg, clientDataJSON: c.clientDataJSON } };
    } else {
      if (!["approved", "rejected"].includes(b?.decision)) return { status: 400, error: "decision: approved | rejected" };
      state = b.decision; resp = { decision: b.decision };
      if (state === "approved" && r.passkey) { // the runner verifies the signature; the server just refuses an approval that carries none
        const x = b.assertion; if (!x || !str(x.id) || !str(x.clientDataJSON) || !str(x.authenticatorData) || !str(x.signature)) return { status: 400, error: "this runner requires a passkey signature to approve" };
        resp.assertion = { id: x.id, clientDataJSON: x.clientDataJSON, authenticatorData: x.authenticatorData, signature: x.signature };
      }
    }
    this.sql.exec("update asks set state=?, response=? where id=? and state='pending'", state, JSON.stringify(resp), r.id);
    for (const w of [...this.waiters]) w(); // wake the runner's approval_wait
    return { status: 200, state };
  }

  // ---------- caps ----------
  member(id: string): Member | null {
    const r = this.sql.exec("select * from members where peer_id=?", id).toArray()[0] as any;
    return r ? { ...r, verbs: JSON.parse(r.verbs), paths: JSON.parse(r.paths) } : null;
  }
  // "write:shared/**" in a grant's paths narrows one verb: when a verb has its own entries they are its only globs; plain globs
  // cover every other verb. So paths ["**", "write:shared/**"] = read everything, write only shared/** (oauth.ts PRESETS).
  pathsFor = (m: Member, verb: string) => { const own = m.paths.filter(g => g.startsWith(verb + ":")).map(g => g.slice(verb.length + 1));
    return own.length ? own : m.paths.filter(g => !VERB_PREFIX.test(g)); };
  pathOk = (m: Member, p: string, verb = "read") => this.pathsFor(m, verb).some(g => globMatch(g, p));
  dirOk = (m: Member, d: string) => !d || this.pathsFor(m, "read").some(g => g.startsWith("**") || g.startsWith(d + "/") || globMatch(g, d) || globMatch(g, d + "/x"));
  // an app without "send tasks": say what the owner can do about it (agents kitebook this to their human as is; never the account key)
  need(peer: Peer, verb: string, path?: string): Member {
    // Only internal, authenticated owner UI/RPC calls construct this system identity. Public peers have generated p_ ids.
    if (peer.id === "owner" && peer.kind === "system") return { peer_id: "owner", name: "owner", kind: "system", verbs: ["read", "write", "delete", "dispatch"], paths: ["**"], webhook: null, revoked: 0 };
    const m = this.member(peer.id);
    if (!m || m.revoked || !m.verbs.includes(verb)) throw new RelayError(403, verb === "dispatch" && m && !m.revoked ? sendDenied(m.name, this.spaceId) : `no ${verb} access to workspace ${this.spaceId}${verb === "write" && m && !m.revoked ? writeHint(m.name, path) : ""}`);
    if (path !== undefined && !this.pathOk(m, path, verb)) throw new RelayError(403, `no ${verb} access to ${path}${verb === "write" ? writeHint(m.name, path) : ""}`);
    return m;
  }

  // ---------- storage ----------
  headSeq(): number { return (this.sql.exec("select max(seq) s from commits").one().s as number) ?? 0; }
  seqOf(ref?: string): number {
    if (!ref || ref === "main" || ref === "HEAD") return this.headSeq();
    const r = this.sql.exec("select seq from commits where id=? or id like ?", ref, ref + "%").toArray();
    if (r.length !== 1) throw new RelayError(404, `unknown commit ${ref}`);
    return r[0].seq as number;
  }
  // path -> {sha,size} at a commit
  treeAt(ref?: string): Map<string, { sha: string; size: number }> {
    const m = new Map<string, { sha: string; size: number }>();
    const rows = (!ref || ref === "main" || ref === "HEAD")
      ? this.sql.exec("select path, sha, size from tree").toArray()
      : this.sql.exec(`select c.path, c.sha, b.size from changes c join (select path, max(seq) s from changes where seq<=? group by path) l
          on c.path=l.path and c.seq=l.s left join blobs b on b.sha=c.sha where c.sha is not null`, this.seqOf(ref)).toArray();
    for (const r of rows) m.set(r.path as string, { sha: r.sha as string, size: r.size as number });
    return m;
  }
  // The live tree under a path prefix, by primary-key range instead of a full scan (prefix "a/b/" = paths in ["a/b/", "a/b0"): "0"
  // is the byte after "/"). Empty prefix = the whole tree. Historical refs still rebuild the tree from changes (treeAt).
  treeUnder(pre: string, ref?: string): Map<string, { sha: string; size: number }> {
    if (!pre || (ref && ref !== "main" && ref !== "HEAD")) return this.treeAt(ref);
    const hi = pre.slice(0, -1) + String.fromCharCode(pre.charCodeAt(pre.length - 1) + 1), m = new Map<string, { sha: string; size: number }>();
    for (const r of this.sql.exec("select path, sha, size from tree where path >= ? and path < ?", pre, hi).toArray()) m.set(r.path as string, { sha: r.sha as string, size: r.size as number });
    return m;
  }
  blobAt(path: string, ref?: string): string | null {
    if (!ref || ref === "main" || ref === "HEAD") return (this.sql.exec("select sha from tree where path=?", path).toArray()[0]?.sha as string) ?? null;
    return this.treeAt(ref).get(path)?.sha ?? null;
  }
  blobMeta(sha: string) { return this.sql.exec("select size, enc, loc from blobs where sha=?", sha).one() as { size: number; enc: string; loc: string }; }
  async body(sha: string): Promise<{ enc: string; data: string }> { // data is text (utf8) or base64
    const r = this.sql.exec("select content, enc, loc from blobs where sha=?", sha).one() as any;
    if (r.loc === "inline") return { enc: r.enc, data: r.content };
    if (!this.store) throw new RelayError(503, "file lives in external blob storage, which isn't configured on this host");
    let u: Uint8Array | null;
    try { u = await this.store.get(sha); } catch (e: any) { throw new RelayError(500, String(e?.message ?? e)); } // e.g. integrity check failed
    if (!u) throw new RelayError(500, `blob missing from ${this.store.kind} storage`);
    return { enc: r.enc, data: r.enc === "base64" ? b64encode(u) : new TextDecoder().decode(u) };
  }
  async content(sha: string): Promise<string> { // text only
    const b = await this.body(sha);
    if (b.enc !== "utf8") throw new RelayError(415, "binary file; use read and content_base64");
    return b.data;
  }

  inboxState(peerId: string): { cursor: number; watch: string[] } {
    const v = this.sql.exec("select v from meta where k=?", `inbox:${peerId}`).toArray()[0]?.v as string | undefined;
    try { const j = v ? JSON.parse(v) : {}; return { cursor: Number(j.cursor) || 0, watch: Array.isArray(j.watch) ? j.watch : [] }; } catch { return { cursor: 0, watch: [] }; }
  }
  online = (peerId: string) => this.ctx.getWebSockets(peerId).length > 0;
  seen = (peerId: string) => this.sql.exec("update members set last_seen=? where peer_id=?", now(), peerId);
  presence(m: any) {
    const online = this.online(m.peer_id);
    return { online, last_seen: online ? now() : m.last_seen ?? null, wake: online ? "socket" : m.webhook ? "webhook" : "poll" };
  }

  // One alarm, multiplexed: next fire = the soonest of lease expiry, subscription expiry and the next due outbox delivery.
  async armAlarm(at: number) {
    if (!Number.isFinite(at)) return;
    at = Math.max(at, Date.now() + 1000); // overdue/poisoned work can never spin an immediate alarm loop
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > at) await this.ctx.storage.setAlarm(at);
  }
}

// The words an agent passes on when it may not send tasks: the owner allows it by signing the app in again (choosing the option that
// sends or runs tasks) or in Settings, Connected apps. Never "use the recovery code" (an agent must not ask for it).
// a refused write (kb_add to kb/global, a file in shared/): say which permission the owner changes and where, in plain words
// (kb-write-default: an app on the old "its folder" default got a bare "no write access" and couldn't tell its human what to do)
export function writeHint(name: string, path?: string) {
  const mem = path === undefined || /^(kb|shared)(\/|$)/.test(path);
  return mem ? `. ${name} isn't allowed to save to shared memory (shared/ and kb/) yet. Ask the owner to open Settings, Connected apps (/settings#apps), press Change under ${name}, pick "Read everything, save to shared memory, send tasks" and Save.`
    : `. Apps save only to shared memory (shared/ and kb/); code goes in through git or a task, so this refusal is expected.`;
}
export function sendDenied(name: string, space: string) {
  const cli = /^pi\b|^pi[-_]/.test(name) || name === "pi" ? "pi" : /^codex/.test(name) ? "codex" : /^claude/.test(name) ? "claude" : "<agent>";
  return `This app isn't allowed to send tasks yet (workspace ${space}). Ask the owner to allow it: re-run \`${cli} mcp login kitebook\` and choose 'run tasks', or change it under Connected apps in Settings (/settings).`;
}
