// Directory Durable Object (one per account): peers, hashed tokens, caps, spaces, invites, admin commands, OAuth state, owner sessions;
// plus the account routing helpers the front door (src/index.ts) shares with it.
import { ROOT_ACCOUNT, ACCT_SRC, isRoot, dirName, spaceName } from "../client/account.ts";
import { DurableObject } from "cloudflare:workers";
import { sha256, type Peer } from "./ops.ts";
import { blobStore } from "./blobs.ts";
import { OAUTH_SCHEMA, OAUTH_MIGRATE, VERBS, KINDS, dirOauth } from "./oauth.ts";
import { ACT_SCHEMA, sessionFns } from "./session.ts";
import { authFetch, mintSession, sessionOf, sessionEnd, devices, passkeyRemove, authJwt, forgetClient } from "./auth.ts";
import { LOGIN_SCHEMA, loginFns } from "./login.ts";
import { DEVICE_SCHEMA, DEVICE_MIGRATE, deviceFns } from "./devices.ts";
import { JOIN_SCHEMA, joinFns } from "./join.ts";
import { remotePwFns } from "./remote-pw.ts";
import { passkeyFns } from "./passkey.ts";
import { accessGrant, fingerprint, OWNER_KEY_RE } from "./policy.ts";
import { canon } from "../client/payload.ts";
import * as DL from "./devlog.ts";
import { lockdownKey, DEFAULT_TENANT, type Lockdown } from "./ingress.ts";
import { ACCOUNT_SCHEMA, accountFns, AUDIT_SKIP, auditTarget, type Metric } from "./account-store.ts";

// Accounts: one deployment (one URL) serves many users. Each account has its own Dir (peers, tokens, spaces, invites),
// its own admin key, and its own Space objects, so nothing is shared across accounts. "root" is the operator's account
// (ADMIN_TOKEN), kept for single-user deployments and backwards compatibility.
// Credentials carry their account so the front door can route without a lookup: rk.<acct>.<secret> (peer token),
// ak.<acct>.<secret> (account admin key), inv_<acct>.<code> (invite), and the OAuth at./rt./ac.<acct>.<secret> (access, refresh,
// auth code). Old rk_/inv_ forms without an account are root.
// the tunnel helper's report, kept to known fields (client/tunnel.ts TState; it never sends the token)
export const TUNNEL_TOKEN_RE = /^[A-Za-z0-9+/=_-]{40,4096}$/, TUNNEL_HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const tunnelClean = (a: any) => { const url = (v: any) => typeof v === "string" && /^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(v) ? v : null, str = (v: any, n = 240) => typeof v === "string" ? v.slice(0, n) : null;
  return { mode: a.mode === "named" ? "named" : a.mode === "off" ? "off" : "quick", state: ["starting", "up", "down", "stopped"].includes(a.state) ? a.state : "down", url: url(a.url), previous: url(a.previous), changed_at: str(a.changed_at, 40),
    since: str(a.since, 40), error: str(a.error), restarts: Number(a.restarts) || 0, port: Number(a.port) || null, hostname: str(a.hostname, 253), local: url(a.local) }; };
export const ACCT_RE = new RegExp(`^${ACCT_SRC}$`);
export const spaceStub = (env: Env, acct: string, id: string) => env.SPACE.get(env.SPACE.idFromName(spaceName(acct, id))) as any;
export const dirStub = (env: Env, acct: string = ROOT_ACCOUNT) => env.DIR.get(env.DIR.idFromName(dirName(acct))) as any;
export const acctOf = (cred: string | null | undefined) => { const m = cred?.match(/^(?:rk|ak|at|rt|ac)\.([a-z0-9-]+)\./) ?? cred?.match(/^inv_([a-z0-9-]+)\./); return m ? m[1] : ROOT_ACCOUNT; };

// Settings (/settings): an app's access can end on a date (expires, ms; null = no end), and an app the owner's Mac connected at install
// (runner op agent_connect) remembers which runner made it, so running the installer again reuses that connection instead of adding pi-2.
const PEER_MIGRATE = ["alter table peers add column expires integer", "alter table peers add column made_by text"];
// What the installer gives a coding agent it connects on the owner's Mac: the consent page's "Just this folder" (its own kb/<name>),
// no task sending; the owner widens it in Settings.
export const AGENT_PEERS: Record<string, string> = { pi: "pi", codex: "codex", claude: "claude-code", "claude-code": "claude-code", cursor: "cursor", gemini: "gemini", opencode: "opencode", copilot: "copilot", grok: "grok" };
export type Cap = { space: string; verbs: string[]; paths: string[] };
// Kitebook-wide default quotas for non-root accounts. A plain self-hosted Kitebook has none; HOSTED=1 (a Kitebook server strangers sign up on) has these.
export function quotaDefaults(env: any) {
  const hosted = env?.HOSTED === "1", n = (k: string, d: number) => { const v = env?.[k]; return v === undefined || v === "" || !(Number(v) >= 0) ? d : Number(v); };
  return { spaces: n("QUOTA_SPACES", hosted ? 3 : 0), peers: n("QUOTA_PEERS", hosted ? 25 : 0), storage_mb: n("QUOTA_STORAGE_MB", hosted ? 500 : 0) };
}
export const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const now = () => new Date().toISOString();
export const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");
export const b64url = (n: number) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");


// ---------- Directory: peers, hashed tokens, caps, spaces (one instance) ----------
export class Dir extends DurableObject<Env> {
  sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env); this.sql = ctx.storage.sql;
    const fresh = !this.sql.exec("select 1 from sqlite_master where type='table' and name='acct'").toArray().length; // a brand-new directory (new install / account)
    this.sql.exec(`
create table if not exists spaces(id text primary key, name text, created text);
create table if not exists peers(id text primary key, name text unique, kind text, token_hash text unique, webhook text, created text, revoked integer default 0);
create table if not exists caps(peer_id text, space_id text, verbs text, paths text, primary key(peer_id, space_id));
create table if not exists invites(code_hash text primary key, space_id text, kind text, verbs text, paths text, expires text, used_by text);
create table if not exists acct(k text primary key, v text);`);
    this.sql.exec(OAUTH_SCHEMA); this.sql.exec(ACT_SCHEMA); this.sql.exec(LOGIN_SCHEMA); this.sql.exec(DEVICE_SCHEMA); this.sql.exec(JOIN_SCHEMA); for (const m of [...OAUTH_MIGRATE, ...PEER_MIGRATE, ...DEVICE_MIGRATE]) try { this.sql.exec(m); } catch {} // column already there
    this.acct = (this.sql.exec("select v from acct where k='id'").toArray()[0]?.v as string) ?? ROOT_ACCOUNT;
    this.sql.exec(ACCOUNT_SCHEMA); accountFns.ensureOwner(this); // users (the owner, for now), audit trail, usage counters (src/account-store.ts)
    this.sql.exec(DL.DEVLOG_SCHEMA); // Experimental's recent logs/errors ring (src/devlog.ts), account-wide: auth and the front door aren't per workspace
    if (fresh) this.sql.exec("insert or ignore into acct values(?, 'on')", lockdownKey()); // ingress lockdown: on for new installs; an upgrade has no key ("auto", src/ingress.ts)
  }
  // recent logs/errors (src/devlog.ts): written by the front door, the Spaces and the runner op logs_report; read through op relay_logs / Settings
  async devlogPut(entries: DL.Entry[]) { try { return DL.put(this.sql, Array.isArray(entries) ? entries : [entries], DL.envSecrets(this.env)); } catch (e) { console.error("devlog put", e); return { stored: 0 }; } }
  async devlogRead(q: any) { return { entries: DL.read(this.sql, q ?? {}), counts: DL.counts(this.sql) }; }
  // ---- ingress lockdown (src/ingress.ts): the setting per tenant (whether the tenant has an owner device is src/devices.ts `enforced`) ----
  async ingressSetting(tenant = DEFAULT_TENANT): Promise<{ setting: Lockdown }> {
    const v = this.sql.exec("select v from acct where k=?", lockdownKey(tenant)).toArray()[0]?.v as string | undefined;
    return { setting: v === "on" || v === "off" ? v : "auto" };
  }
  async ingressSet(setting: Lockdown, tenant = DEFAULT_TENANT) {
    if (!["on", "off", "auto"].includes(setting)) throw new Error("lockdown: on | off | auto");
    if (setting === "auto") this.sql.exec("delete from acct where k=?", lockdownKey(tenant)); else this.sql.exec("insert or replace into acct values(?,?)", lockdownKey(tenant), setting);
    return await this.ingressSetting(tenant);
  }
  acct: string;
  space(id: string) { return spaceStub(this.env, this.acct, id); }
  // Per-account quotas: the operator's per-account override (admin quota), else the kitebook default (QUOTA_*; HOSTED=1 turns on
  // hosted defaults). 0 = unlimited. The operator's own root account is never limited.
  limits(): { spaces: number; peers: number; storage_mb: number } {
    if (isRoot(this.acct)) return { spaces: 0, peers: 0, storage_mb: 0 };
    const o = JSON.parse((this.sql.exec("select v from acct where k='quota'").toArray()[0]?.v as string) ?? "{}");
    return { ...quotaDefaults(this.env), ...o };
  }
  quotaErr(what: string, n: number, max: number, fix: string) { return new Error(`${what} quota reached: this account has ${n} of ${max}. ${fix}, or ask the server's operator to raise it`); }
  tok(kind: "rk" | "ak") { return isRoot(this.acct) && kind === "rk" ? "rk_" + b64url(24) : `${kind}.${this.acct}.${b64url(24)}`; }
  async createAccount(id: string, owner?: string) {
    if (this.sql.exec("select 1 from acct where k='admin'").toArray().length) throw new Error(`account ${id} already exists`);
    const key = `ak.${id}.${b64url(24)}`;
    this.sql.exec("insert or replace into acct values('id',?)", id); this.acct = id;
    this.sql.exec("insert into acct values('admin',?)", await sha256(key));
    this.sql.exec("insert into acct values('created',?)", now()); if (owner) this.sql.exec("insert into acct values('owner',?)", owner);
    this.sql.exec("update users set created=? where id=? and created is null", now(), DEFAULT_TENANT); accountFns.audit(this, "signup", "account_create", id);
    return { account: id, admin_key: key, note: "shown once; it's this account's master key (use it as KITEBOOK_ADMIN_TOKEN)" };
  }
  // Every account starts with workspace main: hosted signup makes it at once; a self-hosted operator's root account gets it the first time
  // it is used (first sign-in, Create install command, a sign-in request), so a fresh Kitebook never answers "no space main".
  async ensureMain() { if (!this.sql.exec("select 1 from spaces limit 1").toArray().length) await this.admin("space", { id: "main" }); return { space: "main" }; }
  async hasSpace() { return this.sql.exec("select 1 from spaces limit 1").toArray().length > 0; }
  async title(): Promise<string | null> { return (this.sql.exec("select v from acct where k='title'").toArray()[0]?.v as string) || null; }
  async isAdmin(keyHash: string) { return (this.sql.exec("select v from acct where k='admin'").toArray()[0]?.v as string) === keyHash; }
  async rotateAdmin() { const key = `ak.${this.acct}.${b64url(24)}`; this.sql.exec("update acct set v=? where k='admin'", await sha256(key)); return { admin_key: key }; }
  // ---- the account itself (src/account-store.ts): its users, audit trail and usage counters ----
  async users() { return { account: this.acct, users: accountFns.users(this) }; }
  async auditPut(actor: string, action: string, target = "", ok = true) { accountFns.audit(this, actor, action, target, ok); }
  async meter(metric: Metric, n = 1) { accountFns.meter(this, metric, n); }
  async auth(tokenHash: string): Promise<{ peer: Peer; caps: Cap[] } | null> {
    const p = this.sql.exec("select id,name,kind from peers where token_hash=? and revoked=0 and (expires is null or expires>?)", tokenHash, Date.now()).toArray()[0] as any;
    if (!p) { const o = await dirOauth(this, "auth", [tokenHash]); if (o) accountFns.meter(this, "requests"); return o; } // OAuth access token (at.*), narrowed to its grant
    accountFns.meter(this, "requests");
    const caps = this.sql.exec("select space_id,verbs,paths from caps where peer_id=?", p.id).toArray().map((c: any) => ({ space: c.space_id, verbs: JSON.parse(c.verbs), paths: JSON.parse(c.paths) }));
    return { peer: { id: p.id, name: p.name, kind: p.kind }, caps };
  }
  // autorun's live check (Space senderState): one of this account's apps (an assistant or coding agent; every one was connected by the
  // owner: consent, /start, their Mac, admin), not removed and its access not ended. A person (human) or a runner is never an app.
  async peerState(name: string) {
    const p = this.sql.exec("select kind, revoked, expires from peers where name=?", String(name)).toArray()[0] as any;
    if (!p) return { live: false, own: false, why: "no such app" };
    const live = !p.revoked && (p.expires == null || Number(p.expires) > Date.now()), app = p.kind === "assistant" || p.kind === "coding_agent";
    return { live, own: app, ...(!live ? { why: p.revoked ? "removed" : "access ended" } : !app ? { why: p.kind === "human" ? "a person, not one of your apps" : "a Mac, not one of your apps" } : {}) };
  }
  async invite(codeHash: string) {
    const r = this.sql.exec("select * from invites where code_hash=?", codeHash).toArray()[0] as any;
    if (!r || r.used_by || r.expires < now()) return null;
    return { space: r.space_id, kind: r.kind, verbs: JSON.parse(r.verbs), paths: JSON.parse(r.paths), expires: r.expires };
  }
  async redeem(codeHash: string, name: string, webhook?: string) {
    const inv = await this.invite(codeHash); if (!inv) throw new Error("invite is invalid, used, or expired");
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name ?? "")) throw new Error("name: lowercase letters, digits, - or _, max 32");
    if (webhook && !/^https:\/\//.test(webhook)) throw new Error("webhook must be https");
    if (this.sql.exec("select 1 from peers where name=?", name).toArray().length) throw new Error(`name ${name} is taken`);
    this.sql.exec("update invites set used_by=? where code_hash=?", name, codeHash);
    const { token } = await this.admin("peer", { name, kind: inv.kind, webhook });
    await this.admin("grant", { peer: name, space: inv.space, verbs: inv.verbs, paths: inv.paths });
    return { name, kind: inv.kind, space: inv.space, verbs: inv.verbs, paths: inv.paths, token };
  }
  // ---- owner sign-in + app sign-in on Better Auth (src/auth.ts): /api/auth/*, /consent and the OAuth metadata come here (fetch) ----
  async fetch(req: Request) { return await authFetch(this as any, req); }
  async baMint(origin: string, ua?: string) { return await mintSession(this as any, origin, ua); } // Set-Cookie headers of a new owner session
  async baSession(origin: string, cookie: string) { return await sessionOf(this as any, origin, cookie); }
  async baSessionEnd(origin: string, a: { id?: string; cookie?: string }) { return await sessionEnd(this as any, origin, a); }
  async baDevices(origin: string, mine: string) { return await devices(this as any, origin, mine); }
  async baPasskeyRemove(origin: string, id: string) { return await passkeyRemove(this as any, origin, id); }
  async authJwt(origin: string, token: string) { const g: any = await authJwt(this as any, origin, token); if (g && !g.error) accountFns.meter(this, "requests"); return g; } // a Better Auth access token -> its live grant
  async actNonce(sess: string) { return await sessionFns.actNonce(this, sess); } // one-time nonces for the owner's Status-card actions
  async actUse(sess: string, n: string) { return await sessionFns.actUse(this, sess, n); }
  async setQuota(a: any) {
    if (!this.sql.exec("select 1 from acct where k='admin'").toArray().length) throw new Error("no account " + a.account);
    const o = JSON.parse((this.sql.exec("select v from acct where k='quota'").toArray()[0]?.v as string) ?? "{}");
    for (const k of ["spaces", "peers", "storage_mb"]) if (k in a) { if (a[k] === null) delete o[k]; else { const v = Number(a[k]); if (!(v >= 0)) throw new Error(k + ": a number >= 0 (0 = unlimited)"); o[k] = v; } }
    this.sql.exec("insert or replace into acct values('quota',?)", JSON.stringify(o));
    const lim = this.limits(); for (const r of this.sql.exec("select id, name from spaces").toArray() as any[]) await this.space(r.id).init(r.id, r.name, this.acct, lim.storage_mb);
    return { account: this.acct, limits: lim };
  }
  // revoke_self: a peer token revokes its peer; an OAuth token ends just its grant. Either way its subscriptions end with it.
  async revokeSelf(peer: { id: string; name: string; grant?: string }) {
    if (peer.grant) return { ...(await dirOauth(this, "revokeFamily", [peer.grant, "revoked by its holder (revoke_self)"])), peer: peer.name };
    return { ...(await this.admin("revoke", { peer: peer.name })), how: "peer token" };
  }
  // "Approve on my phone / Mac": tell this workspace's runners a connection request waits (only runners see the event); how many are online
  // device identity (src/devices.ts): machines, their browser sessions, the presence gate
  async baOriginSet(o: string) { this.sql.exec("insert or replace into acct values('ba:origin',?)", o); } // for revocations made without a request (deviceRevoke)
  async dev(fn: string, ...args: any[]) { return await deviceFns[fn](this as any, ...args); }
  async pk(fn: string, ...args: any[]) { return await passkeyFns[fn](this as any, ...args); } // a phone's passkey as an approval device (src/passkey.ts)
  async rpw(fn: string, ...args: any[]) { return await remotePwFns[fn](this as any, ...args); } // the master password typed on another device (src/remote-pw.ts)
  // a new machine joining (kitebook join) or claiming a remote server (kitebook login <url>): codes, approvals, the claim (src/join.ts)
  async join(fn: string, ...args: any[]) { return await joinFns[fn](this as any, ...args); }
  // revoke a device: its browser sessions (ours and the Better Auth ones it minted), presence windows and its runner token end now
  async deviceRevoke(id: string, by?: string) { // by: who, for the audit trail (the admin command audits its own call)
    const r = await deviceFns.revoke(this as any, id), o = (this.sql.exec("select v from acct where k='ba:origin'").toArray()[0] as any)?.v;
    for (const s of r.ba) { try { if (o) await sessionEnd(this as any, o, { id: s }); } catch {} }
    if (r.peer) try { await this.admin("revoke", { peer: r.peer }); } catch {} // no such peer any more: nothing to end
    if (by) accountFns.audit(this, by, "device_revoke", id); const { ba, ...v } = r; return v;
  }
  async login(fn: string, ...args: any[]) { return await loginFns[fn](this as any, ...args); } // kitebook open sign-in links (login.ts)
  async phoneReady(space: string) { return await this.space(space).phoneReady().catch(() => false); }
  async connectNotify(space: string, id: string) { return await this.space(space).connectRequested(id); }
  async oauth(fn: string, ...args: any[]) { return await dirOauth(this, fn, args); } // OAuth state lives here (oauth.ts); "oauth:global" holds device requests + clients
  ownerKeys(): any[] { try { return JSON.parse((this.sql.exec("select v from acct where k='owner_keys'").toArray()[0]?.v as string) ?? "[]"); } catch { return []; } }
  peerByName(name: string) { const p = this.sql.exec("select * from peers where name=?", name).toArray()[0] as any; if (!p) throw new Error("no peer " + name); return p; }
  // every admin command, from the server shell (/admin), Settings / start (session) or the Dir itself: counted, and audited unless it
  // only reads (src/account-store.ts AUDIT_SKIP). The actor is what the caller says made it (a.by: an app, "Settings"), else "admin".
  async admin(cmd: string, a: any): Promise<any> {
    const by = typeof a?.by === "string" && a.by ? a.by : "admin", audit = !AUDIT_SKIP.has(cmd);
    accountFns.meter(this, "admin");
    try { const r = await this.adminRun(cmd, a ?? {}); if (audit) accountFns.audit(this, by, cmd, auditTarget(a)); return r; }
    catch (e) { if (audit) accountFns.audit(this, by, cmd, auditTarget(a), false); throw e; }
  }
  async adminRun(cmd: string, a: any): Promise<any> {
    switch (cmd) {
      case "space": {
        if (!/^[a-z0-9-]{1,40}$/.test(a.id ?? "")) throw new Error("space id: lowercase letters, digits, dashes");
        const lim = this.limits(), have = this.sql.exec("select count(*) n from spaces").one().n as number;
        if (lim.spaces && have >= lim.spaces && !this.sql.exec("select 1 from spaces where id=?", a.id).toArray().length)
          throw this.quotaErr("space", have, lim.spaces, "Reuse a space you have (see /start -> Status)");
        this.sql.exec("insert or ignore into spaces values(?,?,?)", a.id, a.name ?? a.id, now());
        await this.space(a.id).init(a.id, a.name ?? a.id, this.acct, lim.storage_mb); await this.space(a.id).setOwnerKeys(this.ownerKeys()); return { space: a.id };
      }
      case "peer": {
        if (!KINDS.includes(a.kind)) throw new Error("kind: " + KINDS.join("|"));
        const lim = this.limits(), live = this.sql.exec("select count(*) n from peers where revoked=0").one().n as number;
        if (lim.peers && live >= lim.peers) throw this.quotaErr("peer", live, lim.peers, "Revoke one you no longer use (/start -> Status -> Revoke)");
        const token = this.tok("rk");
        this.sql.exec("insert into peers(id,name,kind,token_hash,webhook,created) values(?,?,?,?,?,?)", "p_" + hex(6), a.name, a.kind, await sha256(token), a.webhook ?? null, now());
        return { peer: a.name, kind: a.kind, token, note: "shown once; store it in that agent's secret vault" };
      }
      case "grant": {
        const verbs: string[] = a.verbs, paths: string[] = a.paths;
        if (!verbs?.length || verbs.some(v => !VERBS.includes(v))) throw new Error("verbs: " + VERBS.join(","));
        if (!paths?.length) throw new Error("give at least one path glob");
        if (!this.sql.exec("select 1 from spaces where id=?", a.space).toArray().length) throw new Error("no space " + a.space);
        const p = this.peerByName(a.peer);
        this.sql.exec("insert or replace into caps values(?,?,?,?)", p.id, a.space, JSON.stringify(verbs), JSON.stringify(paths));
        await this.space(a.space).setMember({ id: p.id, name: p.name, kind: p.kind, verbs, paths, webhook: p.webhook, revoked: p.revoked });
        return { granted: a.peer, space: a.space, verbs, paths };
      }
      case "invite": {
        if (!KINDS.includes(a.kind)) throw new Error("kind: " + KINDS.join("|"));
        const verbs: string[] = a.verbs, paths: string[] = a.paths;
        if (!verbs?.length || verbs.some(v => !VERBS.includes(v)) || !paths?.length) throw new Error("give verbs and paths");
        if (a.space === "main") await this.ensureMain(); // a fresh Kitebook's first invite (admin.ts invite main ..., Create install command)
        if (!this.sql.exec("select 1 from spaces where id=?", a.space).toArray().length) throw new Error("no space " + a.space);
        const code = isRoot(this.acct) ? "inv_" + b64url(18) : `inv_${this.acct}.${b64url(18)}`, hours = Math.min(Number(a.hours ?? 24), 24 * 14);
        const expires = new Date(Date.now() + hours * 3600_000).toISOString();
        this.sql.exec("insert into invites values(?,?,?,?,?,?,null)", await sha256(code), a.space, a.kind, JSON.stringify(verbs), JSON.stringify(paths), expires);
        return { code, path: `/join/${code}`, space: a.space, kind: a.kind, expires, note: "single use; give the full URL to the agent" };
      }
      case "revoke": case "rotate": {
        const p = this.peerByName(a.peer); let token: string | undefined;
        if (cmd === "revoke") { this.sql.exec("update peers set revoked=1 where id=?", p.id); // its Better Auth sign-ins end too (refresh tokens, consent)
          for (const f of this.sql.exec("select client_id from oauth_families where peer_id=? and source='consent' and revoked=0", p.id).toArray() as any[]) await forgetClient(this as any, null, f.client_id).catch(() => {});
          this.sql.exec("update oauth_families set revoked=1 where peer_id=?", p.id); }
        else { token = this.tok("rk"); this.sql.exec("update peers set token_hash=?, revoked=0 where id=?", await sha256(token), p.id); }
        for (const c of this.sql.exec("select space_id from caps where peer_id=?", p.id).toArray())
          await this.space(c.space_id as string).setMember({ id: p.id, name: p.name, kind: p.kind, webhook: p.webhook, revoked: cmd === "revoke" ? 1 : 0,
            terminate: cmd === "revoke" ? "Access revoked" : "Token rotated" }); // event subscriptions die with the credential
        return cmd === "revoke" ? { revoked: a.peer } : { peer: a.peer, token };
      }
      case "list": return {
        spaces: this.sql.exec("select * from spaces").toArray(),
        peers: this.sql.exec("select p.name,p.kind,p.revoked,c.space_id,c.verbs,c.paths from peers p left join caps c on c.peer_id=p.id").toArray() };
      case "status": { // the owner's glance at every space: peers + online, open tasks, what needs the owner, recent results (read-only; /start renders it)
        const out: any[] = []; for (const r of this.sql.exec("select id from spaces order by id").toArray()) out.push(await this.space(r.id as string).ownerStatus(this.acct));
        return { account: this.acct, at: new Date().toISOString(), spaces: out };
      }
      case "presence": { // who's working, every space (the /start panel; owner view)
        const out: any[] = []; for (const r of this.sql.exec("select id from spaces order by id").toArray()) out.push(await this.space(r.id as string).ownerPresence());
        return { account: this.acct, at: new Date().toISOString(), spaces: out };
      }
      case "task": { // one task in detail for the Status card (headline + next action, summary, diff, test log); read-only
        if (!this.sql.exec("select 1 from spaces where id=?", String(a.space ?? "")).toArray().length) throw new Error("no space " + a.space);
        return await this.space(a.space).ownerTask(a.task);
      }
      case "act": { // the owner's Status-card action on one task (approve | reject | answer | cancel | retry | retry_note | handoff); /start checks session + nonce first
        if (!this.sql.exec("select 1 from spaces where id=?", String(a.space ?? "")).toArray().length) throw new Error("no space " + a.space);
        return await this.space(a.space).ownerAct(a);
      }
      case "brief": { // Settings -> Instructions for your assistants: per space the text, its history and the apps' suggestions (read-only)
        const ids = a.space ? [String(a.space)] : (this.sql.exec("select id from spaces order by id").toArray() as any[]).map(r => r.id as string), out: any[] = [];
        for (const id of ids) { if (!this.sql.exec("select 1 from spaces where id=?", id).toArray().length) throw new Error("no space " + id); out.push(await this.space(id).briefOwner({ action: "read" })); }
        return { spaces: out };
      }
      case "brief_set": { // save | restore (Undo) | accept | dismiss; /start checks session + nonce first
        if (!this.sql.exec("select 1 from spaces where id=?", String(a.space ?? "")).toArray().length) throw new Error("no space " + a.space);
        if (!["set", "restore", "accept", "dismiss"].includes(a.action)) throw new Error("action: set | restore | accept | dismiss");
        return await this.space(a.space).briefOwner(a);
      }
      case "stuck": { // stuck detection: show/set the minutes of silence after which a claimed/running task reads "stuck?" (0 = off)
        if (!this.sql.exec("select 1 from spaces where id=?", a.space).toArray().length) throw new Error("no space " + a.space);
        return await this.space(a.space).setStuck(a.minutes == null || a.minutes === "" ? null : Number(a.minutes));
      }
      case "export": return await this.space(a.space).exportAll();
      case "import": {
        await this.admin("space", { id: a.space, name: a.space });
        return await this.space(a.space).importAll(a.dump);
      }
      case "retention": case "prune": { // live-state retention: show/set days (0 = keep forever), or prune now (older_than_sec overrides the window)
        if (!this.sql.exec("select 1 from spaces where id=?", a.space).toArray().length) throw new Error("no space " + a.space);
        const sp = this.space(a.space);
        const num = (v: any) => v == null || v === "" || v === "-" ? null : Number(v);
        return cmd === "retention" ? await sp.setRetention(num(a.days), num(a.events_max), num(a.repos_history), num(a.gc_grace_sec)) : await sp.prune(a.older_than_sec == null || a.older_than_sec === "" ? undefined : Number(a.older_than_sec) * 1000);
      }
      case "gc": { // blob GC now: mark unreferenced blobs, sweep the ones past the grace (grace_sec overrides it for this run; 0 = sweep now)
        if (!this.sql.exec("select 1 from spaces where id=?", a.space).toArray().length) throw new Error("no space " + a.space);
        const sp = this.space(a.space), r = await sp.gc(a.grace_sec == null || a.grace_sec === "" ? undefined : Number(a.grace_sec) * 1000);
        return { ...r, usage: (await sp.usage()).gc };
      }
      case "gc_store": { // operator only: audit the shared blob store for objects no space marks (stored before markers existed, or leaked)
        if (!isRoot(this.acct)) throw new Error("the blob store is shared by the whole Kitebook; its audit is the operator's (root admin key)");
        const st = blobStore(this.env); if (!st) return { store: null, note: "no external blob store on this Kitebook: inline blobs are collected per space (admin.ts gc <space>)" };
        // every root space first writes markers for the external blobs it holds (a space that never woke since the upgrade has none yet)
        for (const r of this.sql.exec("select id from spaces").toArray() as any[]) await this.space(r.id).ensureRefs();
        const graceMs = (a.grace_sec == null || a.grace_sec === "" ? 7 * 86400 : Number(a.grace_sec)) * 1000, del = a.delete === true || a.delete === "1" || a.delete === "delete";
        let objects = 0, unmarked = 0, bytes = 0, deleted = 0, skippedRecent = 0, cursor: string | undefined;
        do { const page = await st.list(cursor); cursor = page.cursor;
          for (const o of page.items) { objects++; if (await st.refs(o.sha)) continue;
            unmarked++; bytes += o.size ?? 0;
            if (!del) continue; if (o.uploaded && o.uploaded > Date.now() - graceMs) { skippedRecent++; continue; }
            if (!(await st.refs(o.sha))) { await st.del(o.sha); deleted++; } }
        } while (cursor);
        return { store: st.kind, objects, unmarked, unmarked_bytes: bytes, deleted, skipped_recent: skippedRecent,
          note: del ? "deleted objects no space marked (other accounts' spaces mark theirs when they wake; run this only once every account's spaces have been used since the upgrade)"
            : "report only; pass delete to remove unmarked objects older than the grace (default 7 days)" };
      }
      case "ratelimit": { // per-token requests/min in a space: show, set the space default, or set one peer's (0 = no limit)
        if (!this.sql.exec("select 1 from spaces where id=?", a.space).toArray().length) throw new Error("no space " + a.space);
        return await this.space(a.space).setRate(a.per_min == null || a.per_min === "" ? null : Number(a.per_min), a.peer || null);
      }
      case "pause": case "resume": { // kill switch: whole space, or one dispatcher peer
        if (!this.sql.exec("select 1 from spaces where id=?", a.space).toArray().length) throw new Error("no space " + a.space);
        return await this.space(a.space).setPause(cmd === "pause", a.peer || undefined, a.reason);
      }
      case "title": { // optional display name for this account's MCP connector (empty clears it)
        const t = String(a.title ?? "").trim().slice(0, 80);
        if (t) this.sql.exec("insert or replace into acct values('title',?)", t); else this.sql.exec("delete from acct where k='title'");
        return { title: t || null };
      }
      // ---- the owner's standing permissions (src/policy.ts): /start Permissions, the consent page, the review page's Always allow ----
      case "owner_key": { // register (or remove) a browser's P-256 owner key; every space gets the list (the runner pins its own copy)
        let keys = this.ownerKeys();
        if (a.remove) keys = keys.filter(k => k.fp !== a.remove && k.key !== a.remove);
        else { const key = String(a.key ?? ""); if (!OWNER_KEY_RE.test(key)) throw new Error("key: p256:<base64url SPKI> from the owner's browser");
          if (!keys.some(k => k.key === key)) { if (keys.length >= 10) throw new Error("10 owner keys at most: remove one you no longer use");
            // proof: HMAC(the trust secret in a `kitebook open` link's #fragment, key), which only that browser and the Mac that made the link
            // know (the server never sees the secret), so the Mac trusts this browser by itself (client/settings-sync.ts); no fingerprint to compare
            const proof = typeof a.proof === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(a.proof) ? a.proof : undefined;
            keys.push({ key, fp: await fingerprint(key), label: String(a.label ?? "browser").replace(/[^\w .,()/:-]/g, "").slice(0, 60) || "browser", added: now(), ...(proof ? { proof } : {}) }); } }
        this.sql.exec("insert or replace into acct values('owner_keys',?)", JSON.stringify(keys));
        for (const r of this.sql.exec("select id from spaces").toArray() as any[]) await this.space(r.id).setOwnerKeys(keys);
        return { owner_keys: keys };
      }
      case "policy": { // read: per space the signed policy, the apps (with what they can do now), runners (which owner keys each pinned), projects, audit list
        const ids = (this.sql.exec("select id from spaces order by id").toArray() as any[]).map(r => r.id as string).filter(id => !a.space || id === a.space);
        if (a.space && !ids.length) throw new Error("no space " + a.space);
        const exp = new Map((this.sql.exec("select name, expires from peers where expires is not null").toArray() as any[]).map(r => [r.name, r.expires])); // Settings: access end dates
        const spaces = await Promise.all(ids.map(id => this.space(id).policyState()));
        for (const sp of spaces) for (const ap of sp.apps) ap.expires = exp.get(ap.name) ?? null;
        return { owner_keys: this.ownerKeys(), spaces };
      }
      case "app_key": { // the relay-held signing key for an app that doesn't sign its own tasks (public half only)
        if (!this.sql.exec("select 1 from spaces where id=?", String(a.space ?? "")).toArray().length) throw new Error("no space " + a.space);
        const p = this.peerByName(String(a.app ?? "")); if (p.revoked || p.kind === "runner") throw new Error(`${a.app} isn't a connected assistant or coding agent`);
        return await this.space(a.space).appKey(p.name);
      }
      case "policy_set": { // a new owner-signed policy for one app, plus (optionally) what folders it can use; Tasks "can't send" drops dispatch
        if (!this.sql.exec("select 1 from spaces where id=?", String(a.space ?? "")).toArray().length) throw new Error("no space " + a.space);
        const p = this.peerByName(String(a.app ?? "")); if (p.revoked || p.kind === "runner") throw new Error(`${a.app} isn't a connected assistant or coding agent`);
        const row = this.sql.exec("select verbs, paths from caps where peer_id=? and space_id=?", p.id, a.space).toArray()[0] as any;
        const cur = { verbs: row ? JSON.parse(row.verbs) : [], paths: row ? JSON.parse(row.paths) : [] }, tasks = a.envelope?.policy?.apps?.[p.name]?.tasks ?? "ask";
        const next = accessGrant(a.access ?? null, cur, tasks), changed = canon(next) !== canon(cur);
        const r = await this.space(a.space).policyPut(a.envelope, { app: p.name, access: a.access ?? null, prev_caps: cur, next_caps: next, undo_of: a.undo_of ?? null });
        if (changed) { await this.admin("grant", { peer: p.name, space: a.space, verbs: next.verbs, paths: next.paths });
          this.sql.exec("update oauth_families set verbs=? where peer_id=? and space=? and revoked=0", JSON.stringify(next.verbs), p.id, a.space); } // an OAuth sign-in is narrowed to its family's verbs: keep them in step
        return { ...r, verbs: next.verbs, paths: next.paths };
      }
      // Run tasks without asking (Settings top row): the relay-held autorun key to name in the policy, and a new owner-signed policy that
      // only flips it; Experimental (Settings -> More -> Experimental): the same for its own field. dev_key / dev_set: their old names.
      case "autorun_key": case "dev_key": if (!this.sql.exec("select 1 from spaces where id=?", String(a.space ?? "")).toArray().length) throw new Error("no space " + a.space); return await this.space(a.space).autorunKey();
      case "app_updates": if (!this.sql.exec("select 1 from spaces where id=?", String(a.space ?? "")).toArray().length) throw new Error("no space " + a.space); return await this.space(a.space).appUpdatesSet(a.on === true); // Settings -> Updates "Let apps update Kitebook"
      case "autorun_set": case "dev_set": case "experimental_set": if (!this.sql.exec("select 1 from spaces where id=?", String(a.space ?? "")).toArray().length) throw new Error("no space " + a.space);
        return await this.space(a.space).switchPut(cmd === "experimental_set" ? "experimental" : "autorun", a.envelope, a.undo_of ?? null);
      // Settings -> Experimental / a task's "Run tests": the owner asks the Mac for a local CI run (client/ci.ts)
      case "ci_run": { if (!this.sql.exec("select 1 from spaces where id=?", String(a.space ?? "")).toArray().length) throw new Error("no space " + a.space); const sp = this.space(a.space);
        if (!(await sp.experimentalState())) throw new Error("Run tests is an Experimental feature: turn on Experimental first (Settings -> More)");
        return { id: await sp.ciAsk({ project: String(a.project ?? ""), branch: a.branch ? String(a.branch) : null, by: "you" }), queued: true }; }
      // ---- Settings (/settings) ----
      // ---- devices from the server shell (ADMIN_TOKEN / account key): list, approve a waiting machine (also the way back in when every
      // owner device is gone: the gate stays on), rename, revoke ----
      case "devices": return await this.dev("list", a.tenant);
      case "device_approve": return await this.dev("approve", String(a.id ?? ""));
      case "device_rename": return await this.dev("rename", String(a.id ?? ""), String(a.name ?? ""));
      case "device_revoke": return await this.deviceRevoke(String(a.id ?? ""));
      // forgotten master password (kitebook owner reset-password): drop that device's password key; it may set a new one for 15 minutes
      case "device_password_reset": { const l = await this.dev("list", a.tenant), id = a.id ? String(a.id) : (l.devices.filter((x: any) => x.state === "active").length === 1 ? l.devices.find((x: any) => x.state === "active").id : "");
        if (!id) throw new Error("which device? kitebook owner reset-password <device id> (kitebook owner devices lists them)"); return await this.dev("resetPassword", id); }
      case "login_link": { // the operator's first sign-in on a fresh self-hosted Kitebook (scripts/mac-host.sh, admin.ts open): a single-use 5-minute /start#login= link
        await this.ensureMain(); const t = await this.login("linkNew"); return { token: t.token, path: `/start#login=${t.token}`, expires: t.expires };
      }
      case "app_expiry": { // how long an app keeps its access: days from now, or null = no end date; an ended app's token stops working
        const p = this.peerByName(String(a.app ?? "")); if (p.kind === "runner" || p.kind === "human") throw new Error(`${a.app} isn't a connected assistant or coding agent`);
        const d = a.days == null || a.days === 0 ? null : Number(a.days); if (d !== null && !(d > 0 && d <= 3650)) throw new Error("days: 1 to 3650, or null for no end date");
        const exp = d === null ? null : Date.now() + d * 86400_000; this.sql.exec("update peers set expires=? where id=?", exp, p.id);
        return { app: p.name, expires: exp };
      }
      case "app_add": { // Settings -> Connected apps -> Add an app, or kitebook app add: a scoped key for an app with only an API-key field (shown once)
        const { APP_CHOICES, nameSlug } = await import("./named.ts"), c = APP_CHOICES[String(a.choice ?? "tasks")]; if (!c) throw new Error("access: " + Object.keys(APP_CHOICES).join(" | "));
        const base = nameSlug(String(a.name ?? "")).slice(0, 28).replace(/-+$/, ""); if (!base) throw new Error("type a name for the app, for example muse");
        const sp = String(a.space ?? "main"); if (sp === "main") await this.ensureMain(); if (!this.sql.exec("select 1 from spaces where id=?", sp).toArray().length) throw new Error("no space " + sp);
        let name = base; for (let i = 2; this.sql.exec("select 1 from peers where name=?", name).toArray().length; i++) { if (i > 50) throw new Error(`too many apps named ${base}; remove some`); name = `${base}-${i}`; }
        const d = a.days == null || a.days === 0 ? null : Number(a.days); if (d !== null && !(d > 0 && d <= 3650)) throw new Error("days: 1 to 3650, or none for no end date");
        const { token } = await this.admin("peer", { name, kind: "assistant" }); this.sql.exec("update peers set made_by=?, expires=? where name=?", "key:" + String(a.by ?? "owner"), d === null ? null : Date.now() + d * 86400_000, name);
        await this.admin("grant", { peer: name, space: sp, verbs: c.verbs, paths: c.paths(name) });
        await this.space(sp).noteLog(name, `Added ${name} with an app key: ${c.say}${d ? `, for ${d} days` : ""} (by ${String(a.by ?? "you")})`).catch(() => {});
        return { peer: name, key: token, access: c.say, expires: d === null ? null : Date.now() + d * 86400_000 };
      }
      case "agent_peer": { // runner op agent_connect: the owner's Mac connects a coding agent it found (install.sh, kitebook connect). Same name
        // again = the same connection with a fresh token (the agent's config is rewritten), its access as the owner left it.
        const base = AGENT_PEERS[String(a.agent ?? "")]; if (!base) throw new Error("agent: " + Object.keys(AGENT_PEERS).join(" | "));
        if (!this.sql.exec("select 1 from spaces where id=?", String(a.space ?? "")).toArray().length) throw new Error("no space " + a.space);
        const by = String(a.by ?? ""); let name = base, mine: any = null;
        for (let i = 2; i <= 50; i++) { const ex = this.sql.exec("select * from peers where name=?", name).toArray()[0] as any;
          if (!ex) break; if (ex.made_by === by && ex.kind === "coding_agent") { mine = ex; break; } name = `${base}-${i}`; }
        if (mine) { const { token } = await this.admin("rotate", { peer: name }); this.sql.exec("update peers set expires=null where id=?", mine.id);
          if (!this.sql.exec("select 1 from caps where peer_id=? and space_id=?", mine.id, a.space).toArray().length) await this.admin("grant", { peer: name, space: a.space, verbs: ["read", "write"], paths: [`kb/${name}/**`] });
          return { peer: name, token, reused: true }; }
        const { token } = await this.admin("peer", { name, kind: "coding_agent" }); this.sql.exec("update peers set made_by=? where name=?", by, name);
        await this.admin("grant", { peer: name, space: a.space, verbs: ["read", "write"], paths: [`kb/${name}/**`] });
        return { peer: name, token, reused: false };
      }
      case "owner_cmd": return await this.space(String(a.space ?? "main")).cmdPut(a.cmd, this.ownerKeys().map(k => k.key)); // a signed Settings change for the Mac
      case "expiries": return { apps: Object.fromEntries((this.sql.exec("select name, expires from peers where revoked=0 and expires is not null").toArray() as any[]).map(r => [r.name, r.expires])) };
      case "grants": return { grants: await dirOauth(this, "list", []) }; // OAuth approvals (token families); revoke_grant ends one, revoke <peer> all of a peer's
      case "revoke_grant": return await dirOauth(this, "revokeFamily", [a.id, "OAuth grant revoked by the owner"]).catch((e: any) => { throw new Error(String(e?.message ?? e).replace(/^oauth:[a-z_]+:/, "")); });
      case "usage": { // what this account uses against its quotas
        const lim = this.limits(), spaces = this.sql.exec("select id from spaces").toArray().map((r: any) => r.id as string);
        const storage: Record<string, number> = {}, gc: Record<string, any> = {}, mb = (b: number) => Math.round(b / 1048576 * 1000) / 1000;
        for (const id of spaces) { const u = await this.space(id).usage(); storage[id] = mb(u.bytes);
          gc[id] = { freed_mb: mb(u.gc.freed_bytes), freed_bytes: u.gc.freed_bytes, freed_blobs: u.gc.freed_blobs, marked_mb: mb(u.gc.marked_bytes), last_run: u.gc.last_run }; }
        return { account: this.acct, limits: lim, spaces: spaces.length, peers: this.sql.exec("select count(*) n from peers where revoked=0").one().n, storage_mb: storage, gc, counters: accountFns.counters(this, Number(a.days) || 30) };
      }
      case "quota": { // operator only: override one account's quotas ({account, spaces?, peers?, storage_mb?}; null resets a key to the default)
        if (!isRoot(this.acct)) throw new Error("quotas are set by the server's operator (root admin key)");
        if (!ACCT_RE.test(a.account ?? "") || isRoot(a.account)) throw new Error("account: an existing account id");
        return await (dirStub(this.env, a.account) as any).setQuota(a);
      }
      // ---- No server / domain (client/tunnel.ts): the built-in tunnel on the operator's own Mac. Root only: it's the machine's address ----
      case "tunnel_report": { // the tunnel helper, every few seconds over the local port (ADMIN_TOKEN): what it runs now; answered once with what the owner pressed in Settings
        if (!isRoot(this.acct)) throw new Error("the tunnel belongs to the server's operator");
        this.sql.exec("insert or replace into acct values('tunnel',?)", JSON.stringify({ ...tunnelClean(a), heard: Date.now() }));
        const ask = this.sql.exec("select v from acct where k='tunnel_ask'").toArray()[0]?.v as string | undefined;
        if (ask) this.sql.exec("delete from acct where k='tunnel_ask'"); // a token is handed over once and not kept here
        return { ask: ask ? JSON.parse(ask) : null };
      }
      case "connection": { // Settings -> Connection: the tunnel's last report (no token, ever) and whether a press is still on its way to the Mac
        if (!isRoot(this.acct)) return { tunnel: null, pending: null };
        const t = this.sql.exec("select v from acct where k='tunnel'").toArray()[0]?.v as string | undefined, q = this.sql.exec("select v from acct where k='tunnel_ask'").toArray()[0]?.v as string | undefined;
        const ask = q ? JSON.parse(q) : null;
        return { tunnel: t ? JSON.parse(t) : null, pending: ask ? { what: ask.token ? "token" : ask.quick ? "quick" : ask.on ? "on" : ask.off ? "off" : "restart", at: ask.at } : null };
      }
      case "tunnel_ask": { // Settings -> Connection presses (session + nonce, checked in start.ts): restart | token {token, hostname} | quick | on | off
        if (!isRoot(this.acct)) throw new Error("only the server's operator runs its tunnel");
        const act = String(a.action ?? ""), at = Date.now(); let ask: any;
        if (act === "restart") ask = { restart: true, at };
        else if (act === "quick") ask = { quick: true, at };
        else if (act === "on" || act === "off") ask = { [act]: true, at }; // public access on/off (the one-step install starts with it off)
        else if (act === "token") { const token = String(a.token ?? "").trim(), hostname = String(a.hostname ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
          if (!TUNNEL_TOKEN_RE.test(token)) throw new Error("token: paste the tunnel token Cloudflare shows for your tunnel (a long string of letters and digits)");
          if (!TUNNEL_HOST_RE.test(hostname)) throw new Error("hostname: the address you gave the tunnel in Cloudflare, e.g. kitebook.example.com");
          ask = { token, hostname, at }; }
        else throw new Error("action: restart | token | quick | on | off");
        this.sql.exec("insert or replace into acct values('tunnel_ask',?)", JSON.stringify(ask));
        return { asked: act, at };
      }
      case "ingress": return a.lockdown === undefined ? await this.ingressSetting() : await this.ingressSet(String(a.lockdown) as Lockdown); // the server shell: kitebook admin ingress [on|off|auto]
      case "audit": return { account: this.acct, entries: accountFns.auditList(this, a) }; // the account's audit trail, newest first (before: a seq to page back)
      case "users": return await this.users(); // the people in this account (today: its owner)
      case "rotate_admin": if (isRoot(this.acct)) throw new Error("root's key is the ADMIN_TOKEN secret"); return await this.rotateAdmin();
      default: throw new Error("admin: space | peer | invite | grant | revoke | rotate | list | status | presence | export | import | retention | ratelimit | prune | gc | gc_store | pause | resume | stuck | title | grants | revoke_grant | owner_key | policy | app_key | policy_set | login_link | app_expiry | app_add | agent_peer | owner_cmd | expiries | usage | quota | rotate_admin | dev_key | dev_set | tunnel_report | connection | tunnel_ask | devices | device_approve | device_rename | device_revoke | device_password_reset | ingress | audit | users");
    }
  }
}
