// Adding a machine without a token to paste (auth spec v2 phases "join another machine" + "remote server claim"). Both are RFC 8628-style:
// the new machine makes its device + presence keys (client/keystore.ts), sends the PUBLIC halves, prints a short code and polls; a human
// approves the code somewhere already trusted; the poller (proving it holds the device key) gets a runner token once.
//   join   `kitebook join <server>` on a laptop / cloud VM / CI box. Approved on an owner device: `kitebook approve <code>` (presence-gated:
//          the master password, or its optional Touch ID / Windows Hello shortcut, checked by the server through a presence-key signature) or Settings -> Devices
//          (same gate), or from the server shell. The approval shows the machine's name, OS, IP and rough place plus a phishing warning.
//   claim  `kitebook login <server>` on the owner's laptop, against a remote server that starts unclaimed (src/claim.ts). Approved only on
//          the SERVER'S SHELL (`kitebook owner approve <code>`, ADMIN_TOKEN) or with the single-use KITEBOOK_OWNER_CLAIM secret. The laptop
//          becomes owner device #1 and the claim closes for good; `kitebook owner reset` on the shell reopens it.
// Either way the result is a runner peer (the safe runner preset on workspace main) plus an ACTIVE row in devices (src/devices.ts) bound to
// that peer and key, so the machine's runner enrolls as a heartbeat, and revoking the device ends its runner (Dir.deviceRevoke).
// Codes live 10 minutes (JOIN_TTL), are single-decision, and the token is handed out once, then wiped from the row.
//   device_joins  id = sha256(device_code), kind join|claim, code (XXXX-XXXX), name, os, pubkey, presence_key, password_key, ip, loc, ua, created, expires,
//                 state pending|approved|denied|delivered, result (the runner credentials, until delivered), device, by
// acct keys (root Dir for the claim): claim:ever (this server has had an owner), claim:closed (no claim accepted), claim:secret:<sha256> (burned)
import { ROOT_ACCOUNT, isRoot } from "../client/account.ts";
import { sha256, type Res } from "./ops.ts";
import { KEY_RE, verifyP256 } from "./devices.ts";
import { DEFAULT_TENANT } from "./principal.ts";
import { PRESETS, rateHit } from "./oauth.ts";
import { claimBootstrap } from "./claim.ts";
import { NOT_FOUND } from "./ingress.ts";
export const JOIN_SCHEMA = `create table if not exists device_joins(id text primary key, tenant text not null default '${DEFAULT_TENANT}', kind text, code text, name text, os text, pubkey text, presence_key text, ip text, loc text, ua text, created integer, expires integer, state text, result text, device text, by text, password_key text);`;
export const JOIN_DOMAIN = "kitebook-join:v1"; // the poller signs "<domain>.<device_code>" with its device key (never valid as an open token or presence assertion)
const ALPHA = "BCDFGHJKMNPQRSTVWXZ"; // no vowels (no words), no look-alikes
export const JOIN_CODE_RE = /^[BCDFGHJKMNPQRSTVWXZ]{4}-?[BCDFGHJKMNPQRSTVWXZ]{4}$/i;
export const normCode = (c: any) => { const s = String(c ?? "").toUpperCase().replace(/[^A-Z]/g, ""); return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s; };
const newCode = () => normCode([...crypto.getRandomValues(new Uint8Array(8))].map(b => ALPHA[b % ALPHA.length]).join(""));
const rnd = (n: number) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const clean = (s: any, n = 60) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").trim().slice(0, n);
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const JOIN_WARNING = "Approve only a computer you are setting up yourself, right now. If someone sent you this code, or the name, IP or place don't match that computer, deny it: approving gives it a runner on your Kitebook.";
export const CLAIM_WARNING = "Approve only if you just ran kitebook login on your own computer and it shows this same code. The computer you approve becomes this Kitebook's owner.";
const ttl = (d: D) => { const v = Number(d.env?.JOIN_TTL); return (Number.isFinite(v) && v > 0 ? v : 600) * 1000; };
const interval = (d: D) => { const v = Number(d.env?.OAUTH_INTERVAL); return Number.isFinite(v) && v > 0 ? v : 5; };
type D = { sql: SqlStorage; acct: string; env?: any; admin: (cmd: string, a: any) => Promise<any>; ensureMain: () => Promise<any> };
const acctGet = (d: D, k: string) => (d.sql.exec("select v from acct where k=?", k).toArray()[0] as any)?.v as string | undefined;
const acctSet = (d: D, k: string, v: string) => d.sql.exec("insert or replace into acct values(?,?)", k, v);
const view = (r: any, warning: string) => ({ code: r.code, kind: r.kind, name: r.name, os: r.os || "unknown OS", ip: r.ip || "unknown", location: r.loc || null, requested: r.created, expires: r.expires, warning });
const open = (d: D, code: string, kind: string) => d.sql.exec("select * from device_joins where code=? and kind=? and state='pending' and expires>?", normCode(code), kind, Date.now()).toArray()[0] as any;
async function teq(a: string, b: string) { const x = await sha256(a), y = await sha256(b); let n = 0; for (let i = 0; i < x.length; i++) n |= x.charCodeAt(i) ^ y.charCodeAt(i); return n === 0 && x.length === y.length; }

export const joinFns: Record<string, (d: D, ...a: any[]) => any> = {
  // a new machine asks. kind join needs an owner device to approve it; kind claim is only reached through claimStart.
  async start(d, a: { kind: "join" | "claim"; name: string; os?: string; pubkey: string; presence_key?: string; password_key?: string; ip?: string; loc?: string; ua?: string; tenant?: string }) {
    const tenant = a.tenant ?? DEFAULT_TENANT, t = Date.now();
    if (a.kind === "join" && !acctGet(d, `devices:ever:${tenant}`)) throw new Error("this Kitebook has no owner device yet, so nobody could approve a join. Set up its first machine first (the install's own runner, or kitebook login on a remote server)");
    if (!NAME_RE.test(a.name ?? "")) throw new Error("name: lowercase letters, digits, - or _, max 32 (kitebook join --name <name>)");
    if (!KEY_RE.test(a.pubkey ?? "")) throw new Error("pubkey: p256:<base64url raw point>");
    if (a.presence_key != null && a.presence_key !== "" && !KEY_RE.test(a.presence_key)) throw new Error("presence_key: p256:<base64url raw point>");
    if (a.password_key != null && a.password_key !== "" && !KEY_RE.test(a.password_key)) throw new Error("password_key: p256:<base64url raw point>");
    if (d.sql.exec("select 1 from peers where name=?", a.name).toArray().length) throw new Error(`the name ${a.name} is taken on this Kitebook (names of removed connections stay reserved); pick another with --name`);
    if (d.sql.exec("select 1 from devices where pubkey=?", a.pubkey).toArray().length) throw new Error("this device key is already registered (a revoked device keeps its key out); make a new one: add --new-key");
    const lim = rateHit(d.sql, `${a.kind}:ip:${a.ip ?? "local"}`, 20); if (!lim.ok) throw new Error(`too many ${a.kind} requests from your address; try again in ${Math.ceil(lim.retry_after / 60)} min`);
    d.sql.exec("delete from device_joins where expires<? and state in ('pending','denied','delivered')", t - 86400_000);
    if (Number((d.sql.exec("select count(*) n from device_joins where tenant=? and state='pending' and expires>?", tenant, t).one() as any).n) >= 20) throw new Error("too many machines are waiting for approval; approve or deny some first (or wait 10 minutes)");
    let code = newCode(); for (let i = 0; i < 5 && d.sql.exec("select 1 from device_joins where code=? and state='pending'", code).toArray().length; i++) code = newCode();
    const dc = "kjd_" + rnd(24), ex = t + ttl(d);
    d.sql.exec("insert into device_joins(id,tenant,kind,code,name,os,pubkey,presence_key,password_key,ip,loc,ua,created,expires,state) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending')",
      await sha256(dc), tenant, a.kind, code, a.name, clean(a.os, 40), a.pubkey, a.presence_key || null, a.password_key || null, clean(a.ip, 64), clean(a.loc, 80), clean(a.ua, 120), t, ex);
    return { device_code: dc, user_code: code, expires_in: Math.round(ttl(d) / 1000), interval: interval(d) };
  },
  // the new machine polls. The token goes out once, only to a poller that signs with the device key it asked with.
  async poll(d, dc: string, sig: string) {
    const r = /^kjd_[A-Za-z0-9_-]{30,40}$/.test(dc ?? "") ? d.sql.exec("select * from device_joins where id=?", await sha256(dc)).toArray()[0] as any : null;
    if (!r) return { state: "unknown" };
    if (r.state === "pending") return r.expires < Date.now() ? { state: "expired" } : { state: "pending", interval: interval(d), expires: r.expires };
    if (r.state !== "approved") return { state: r.state === "delivered" ? "used" : r.state };
    if (!await verifyP256(r.pubkey, String(sig ?? ""), `${JOIN_DOMAIN}.${dc}`)) return { state: "bad_signature" };
    d.sql.exec("update device_joins set state='delivered', result=null where id=?", r.id);
    return { state: "approved", result: JSON.parse(r.result) };
  },
  async pending(d, kind = "join", tenant = DEFAULT_TENANT) {
    return (d.sql.exec("select * from device_joins where kind=? and tenant=? and state='pending' and expires>? order by created", kind, tenant, Date.now()).toArray() as any[]).map(r => view(r, kind === "claim" ? CLAIM_WARNING : JOIN_WARNING));
  },
  async show(d, code: string, kind = "join") { const r = open(d, code, kind); return r ? view(r, kind === "claim" ? CLAIM_WARNING : JOIN_WARNING) : null; },
  // the human's answer. yes: a runner peer (safe runner preset on main) + an active device bound to it and the key
  async decide(d, code: string, yes: boolean, by: string, kind = "join") {
    const c = normCode(code), r = open(d, c, kind);
    if (!r) { const old = d.sql.exec("select state, expires from device_joins where code=? and kind=? order by created desc limit 1", c, kind).toArray()[0] as any;
      throw new Error(!old ? `no ${kind === "claim" ? "claim" : "machine"} waits with code ${c || "?"}` : old.state === "pending" ? `code ${c} expired (codes last 10 minutes); start again on that machine` : `code ${c} was already ${old.state === "denied" ? "denied" : "approved"}`); }
    if (kind === "claim" && acctGet(d, "claim:closed")) throw new Error("this Kitebook already has its owner (claim closed); kitebook owner reset on the server shell reopens it");
    if (!yes) { d.sql.exec("update device_joins set state='denied', by=? where id=?", clean(by), r.id); return { denied: c, name: r.name }; }
    if (d.sql.exec("select 1 from peers where name=?", r.name).toArray().length) throw new Error(`the name ${r.name} was taken meanwhile; deny this and join again with another --name`);
    if (d.sql.exec("select 1 from devices where pubkey=?", r.pubkey).toArray().length) throw new Error("that device key was registered meanwhile; deny this one");
    await d.ensureMain(); const p = PRESETS.runner, t = Date.now(), id = "dev_" + rnd(9);
    const { token } = await d.admin("peer", { name: r.name, kind: "runner" });
    await d.admin("grant", { peer: r.name, space: "main", verbs: p.verbs, paths: p.paths });
    d.sql.exec("insert into devices(id,tenant,name,os,pubkey,presence_key,password_key,pw_at,pw_via,peer,state,via,created,last_seen) values(?,?,?,?,?,?,?,?,?,?, 'active', ?,?,?)", id, r.tenant, r.name, r.os, r.pubkey, r.presence_key, r.password_key ?? null, r.password_key ? t : null, r.password_key ? kind : null, r.name, kind, t, t);
    acctSet(d, `devices:ever:${r.tenant}`, "1");
    if (kind === "claim") { acctSet(d, "claim:ever", String(t)); acctSet(d, "claim:closed", JSON.stringify({ at: t, device: id, by: clean(by) })); }
    d.sql.exec("update device_joins set state='approved', by=?, device=?, result=? where id=?", clean(by), id, JSON.stringify({ account: d.acct, name: r.name, token, space: "main", verbs: p.verbs, paths: p.paths, device: id, owner: kind === "claim" }), r.id);
    return { approved: c, name: r.name, device: id, os: r.os, ip: r.ip };
  },
  // ---- the remote-server claim (root account) ----
  // An existing server (spaces, peers or an owner device from before) counts as claimed: turning the claim on never locks anyone out.
  async claimState(d) {
    if (!acctGet(d, "claim:ever") && (acctGet(d, `devices:ever:${DEFAULT_TENANT}`) || d.sql.exec("select 1 from spaces limit 1").toArray().length || d.sql.exec("select 1 from peers limit 1").toArray().length)) {
      acctSet(d, "claim:ever", "migrated"); if (!acctGet(d, "claim:closed")) acctSet(d, "claim:closed", JSON.stringify({ at: Date.now(), migrated: true })); }
    const closed = acctGet(d, "claim:closed");
    return { claimed: !!acctGet(d, "claim:ever"), open: !closed, owner: closed ? JSON.parse(closed) : null, waiting: (await joinFns.pending(d, "claim")).length };
  },
  async claimStart(d, a: any, secretEnv: string | null) {
    const s = await joinFns.claimState(d); if (!s.open) throw new Error("this Kitebook already has its owner. To add another computer: kitebook join <url> (approved on one of your devices)");
    const secret = typeof a.secret === "string" && a.secret ? a.secret : null;
    if (secret) { // PaaS: the deploy secret approves at once, exactly once
      if (!secretEnv) throw new Error("this server has no KITEBOOK_OWNER_CLAIM secret set; approve the code on its shell instead (kitebook owner approve <code>)");
      const lim = rateHit(d.sql, `claim-secret:ip:${a.ip ?? "local"}`, 10); if (!lim.ok) throw new Error(`too many tries; wait ${Math.ceil(lim.retry_after / 60)} min`);
      if (!await teq(secret, secretEnv)) throw new Error("that claim secret is wrong");
      const k = "claim:secret:" + await sha256(secretEnv); if (acctGet(d, k)) throw new Error("that claim secret was already used (it works once). Set a new KITEBOOK_OWNER_CLAIM and redeploy, or approve on the server shell");
      const st = await joinFns.start(d, { ...a, kind: "claim" }); acctSet(d, k, String(Date.now())); // burned before the decision: a failure after this still spends it
      await joinFns.decide(d, st.user_code, true, "KITEBOOK_OWNER_CLAIM", "claim"); return { ...st, approved: true };
    }
    return await joinFns.start(d, { ...a, kind: "claim" });
  },
  // the server shell's recovery: the next claim approved on the shell becomes an owner device too (devices from before stay until revoked)
  async claimReset(d) { d.sql.exec("delete from acct where k='claim:closed'"); acctSet(d, "claim:ever", acctGet(d, "claim:ever") ?? String(Date.now()));
    const devs = (d.sql.exec("select id, name, os, revoked from devices order by created").toArray() as any[]).map(r => ({ id: r.id, name: r.name, os: r.os, revoked: !!r.revoked }));
    return { open: true, devices: devs, note: "claim reopened: run kitebook login <url> on your computer, then kitebook owner approve <code> here. Revoke a lost device from the new one (kitebook devices revoke <id>)." }; },
};

// ---- the front door (src/index.ts): no token on these, the device code / keys are the credential ----
type H = { dir: (a: string) => any };
const j = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const ACCT_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
export const clientIp = (req: Request) => req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
export function roughPlace(req: Request) { const cf: any = (req as any).cf ?? {}, h = (k: string) => req.headers.get(k) ?? "";
  return [cf.city ?? h("cf-ipcity"), cf.region ?? h("cf-region"), cf.country ?? h("cf-ipcountry")].map(x => clean(x, 30)).filter(x => x && x !== "XX").join(", "); }
const body = async (req: Request) => (req.headers.get("content-type") ?? "").startsWith("application/json") ? await req.json().catch(() => null) : null;
const err = (e: any, status = 400) => j({ ok: false, error: String(e?.message ?? e) }, status);
let claimedSeen = false; // once claimed, a server never goes back behind the gate (reset only reopens the claim), so skip the Dir read
// The unclaimed gate: while a claim-mode server has never had an owner, only /health (before this), /claim and the shell's /admin/claim_*
// answer. Off (no Dir read at all) unless the claim bootstrap is on.
// edge (src/ingress.ts): from the public address the gate answers the ingress 404, the same body as an unknown path (the hint is for the
// server's own shell and browser, and /claim already says publicly whether it is claimed; nothing else of the server shows).
export async function claimGate(env: any, url: URL, edge: boolean, h: H): Promise<Response | null> {
  if (claimedSeen || !claimBootstrap().unclaimedGate(env)) return null;
  if ((await h.dir(ROOT_ACCOUNT).join("claimState")).claimed) { claimedSeen = true; return null; }
  if (url.pathname === "/claim" || url.pathname.startsWith("/claim/") || /^\/admin\/claim_[a-z]+$/.test(url.pathname)) return null;
  if (edge) return NOT_FOUND();
  return j({ ok: false, error: "This Kitebook hasn't been claimed yet. On your own computer run: kitebook login " + url.origin + " , then approve the code it shows on this server's shell: kitebook owner approve <code>" }, 404);
}
export async function joinFetch(req: Request, env: any, url: URL, h: H): Promise<Response | null> {
  const m = url.pathname.match(/^\/(join|claim)\/(start|poll)$/) ?? (url.pathname === "/claim" ? [url.pathname, "claim", "state"] : null);
  if (!m) return null;
  const [, kind, step] = m;
  if (kind === "claim" && !claimBootstrap().unclaimedGate(env)) return j({ ok: false, error: "This Kitebook isn't claimed remotely: its first device is the install's own runner. To add a computer: kitebook join " + url.origin }, 404);
  if (step === "state") return req.method === "GET" ? j({ ok: true, result: await h.dir(ROOT_ACCOUNT).join("claimState").then((s: any) => ({ claimed: s.claimed, open: s.open })) }) : err("GET", 405);
  if (req.method !== "POST") return err("POST", 405);
  const b: any = await body(req); if (!b) return err("send JSON", 415);
  const acct = kind === "claim" ? ROOT_ACCOUNT : String(b.account ?? ROOT_ACCOUNT); if (!ACCT_RE.test(acct)) return err("account: 2-31 chars");
  const ip = clientIp(req);
  const lim = await env.DIR.get(env.DIR.idFromName("oauth:global")).oauth("rate", `${kind}-${step}:ip:${ip}`, step === "poll" ? 1200 : 30) as { ok: boolean; retry_after: number };
  if (!lim.ok) return j({ ok: false, error: `too many requests from your address; wait ${Math.ceil(lim.retry_after / 60)} min` }, 429);
  const d = h.dir(acct);
  try {
    if (step === "poll") { const r = await d.join("poll", String(b.device_code ?? ""), String(b.sig ?? "")); return j({ ok: r.state !== "unknown" && r.state !== "bad_signature", result: r, ...(r.state === "unknown" ? { error: "no such request" } : r.state === "bad_signature" ? { error: "the poll wasn't signed by the device key that asked" } : {}) }, r.state === "unknown" ? 404 : r.state === "bad_signature" ? 403 : 200); }
    const a = { name: String(b.name ?? ""), os: b.os, pubkey: String(b.pubkey ?? ""), presence_key: b.presence_key ? String(b.presence_key) : undefined, password_key: b.password_key ? String(b.password_key) : undefined, ip, loc: roughPlace(req), ua: req.headers.get("user-agent") ?? "" };
    if (kind === "join") { const r = await d.join("start", { ...a, kind: "join" }); return j({ ok: true, result: { ...r, verification_uri: `${url.origin}/settings`, approve: `kitebook approve ${r.user_code}` } }); }
    const r = await d.join("claimStart", { ...a, secret: b.secret }, claimBootstrap().secret(env)); claimedSeen = claimedSeen || !!r.approved;
    return j({ ok: true, result: { ...r, approve: `kitebook owner approve ${r.user_code}` } });
  } catch (e: any) { return err(e, /too many/.test(String(e?.message)) ? 429 : /already|taken|registered/.test(String(e?.message)) ? 409 : 400); }
}

// ---- a runner's ops (/v1/join_*): only an ACTIVE owner device lists, approves (presence-gated) and denies ----
export async function joinOp(dir: any, peer: { name: string; kind: string }, op: string, args: any): Promise<Res> {
  if (peer.kind !== "runner") return { ok: false, status: 403, error: "only one of your Kitebook devices (its runner) approves machines; agent and app tokens can't" };
  const mine = await dir.dev("byPeer", peer.name);
  if (!mine || mine.state !== "active") return { ok: false, status: 403, error: "this machine isn't an active device of this Kitebook (start its runner once; a joined machine is approved on another device)" };
  try {
    if (op === "join_list") return { ok: true, result: { pending: await dir.join("pending", "join") } };
    if (op === "join_show") { const r = await dir.join("show", String(args.code ?? "")); return r ? { ok: true, result: r } : { ok: false, status: 404, error: `no machine waits with code ${normCode(args.code)} (expired after 10 minutes, or already decided)` }; }
    if (op === "join_deny") return { ok: true, result: await dir.join("decide", String(args.code ?? ""), false, peer.name) }; // never gated: the safe direction
    if (op === "join_approve") { const c = normCode(args.code), g = await dir.dev("gate", { action: `join_approve:${c}`, presence: args.presence ?? null, peer: peer.name });
      if (!g.ok) return { ok: false, status: 428, error: `approving a machine needs your presence on this device (kitebook approve asks for it): ${g.why}` };
      return { ok: true, result: await dir.join("decide", c, true, peer.name) }; }
    return { ok: false, status: 404, error: "join_list | join_show | join_approve | join_deny" };
  } catch (e: any) { return { ok: false, status: 400, error: String(e?.message ?? e) }; }
}
// ---- the server shell (/admin/claim_*, /admin/join_*, ADMIN_TOKEN or the account key): the root of trust, so nothing here is gated ----
export async function joinAdmin(dir: any, cmd: string, a: any, env: any, acct: string = ROOT_ACCOUNT) {
  if (cmd.startsWith("claim_") && !isRoot(acct)) throw new Error("the claim is the server's own (its operator's ADMIN_TOKEN), not an account's");
  switch (cmd) {
    case "claim_status": return { ...await dir.join("claimState"), mode: claimBootstrap().unclaimedGate(env) ? claimBootstrap().name : "off", secret_set: !!claimBootstrap().secret(env) };
    case "claim_pending": return { pending: await dir.join("pending", "claim") };
    case "claim_show": { const r = await dir.join("show", String(a.code ?? ""), "claim"); if (!r) throw new Error(`no claim waits with code ${normCode(a.code)} (codes last 10 minutes)`); return r; }
    case "claim_approve": return await dir.join("decide", String(a.code ?? ""), true, "server shell", "claim");
    case "claim_deny": return await dir.join("decide", String(a.code ?? ""), false, "server shell", "claim");
    case "claim_reset": return await dir.join("claimReset");
    case "join_pending": return { pending: await dir.join("pending", "join") };
    case "join_approve": return await dir.join("decide", String(a.code ?? ""), true, "server shell");
    case "join_deny": return await dir.join("decide", String(a.code ?? ""), false, "server shell");
  }
  throw new Error("admin: claim_status | claim_pending | claim_show | claim_approve | claim_deny | claim_reset | join_pending | join_approve | join_deny");
}
