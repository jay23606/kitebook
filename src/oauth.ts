// OAuth on the server: what Kitebook keeps next to Better Auth (src/auth.ts owns sign-in, OAuth 2.1 + PKCE, CIMD, DCR and refresh for new connections).
//   Grants: an approval creates (or reuses) a peer with caps on one space and opens a grant ("family" row: peer, client, space, verbs).
//     The consent page (src/auth.ts, the 3 presets below) and the device grant write them; every request checks its grant live, so
//     removing an app (or ending one grant) stops its tokens at once, and ends the MCP Events subscriptions, streams and sockets opened with them.
//   Device grant (RFC 8628) for Hark, runners and CLIs, still on the original token format until it moves to Better Auth (deferred):
//     POST /oauth/device_authorization, the owner approves on GET /device, the client polls POST /oauth/token. Its access tokens (at.<acct>.…, 1h)
//     authenticate exactly like the grant's peer, narrowed to its space and verbs; refresh tokens (rt.<acct>.…) rotate on every use, a replay
//     kills the grant, and their 30-day lifetime (OAUTH_REFRESH_TTL) slides. Revocation (RFC 7009) at /oauth/revoke.
//   Installs from before Better Auth: their at./rt. tokens keep working (refresh included) until the app signs in again; an old client id
//     at the old authorize endpoint gets a plain-words "remove and add the app again" (src/auth.ts OLD_CLIENT).
//   Sign-in requests: a browser asks to sign in to /start; the owner approves it with `kitebook approve <code>` on the Mac (the runner sees the
//     request through connect_get / connect_decide) or from a browser already signed in. Approved, the browser gets a Better Auth session.
// Only sha256 hashes of tokens and codes are stored.
import { ROOT_ACCOUNT, isRoot } from "../client/account.ts";
import { PRESENCE_JS } from "./presence-ui.ts";
import { sha256 } from "./ops.ts";
import { PAGE_HEADERS, esc } from "./approve.ts";
import { THEME_CSS, BASE_CSS } from "./ui.ts";
import { sessionOwner, sameOrigin } from "./session.ts";
import { OLD_CLIENT, forgetClient } from "./auth.ts";

export const VERBS = ["read", "write", "delete", "dispatch"], KINDS = ["assistant", "coding_agent", "runner", "human"];
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/, ACCT_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
// Safe preset grants. "write:<glob>" narrows one verb (space.ts pathsFor): an assistant reads everything and dispatches, but only
// writes under shared/** and the knowledge base kb/**. A runner gets what mirroring and task results need (delete: mirror removals), on its own paths only.
export const PRESETS: Record<string, { kind: string; verbs: string[]; paths: string[] }> = {
  assistant: { kind: "assistant", verbs: ["read", "write", "dispatch"], paths: ["**", "write:shared/**", "write:kb/**"] },
  coding_agent: { kind: "coding_agent", verbs: ["read", "write", "dispatch"], paths: ["**", "write:shared/**", "write:kb/**"] },
  runner: { kind: "runner", verbs: ["read", "write", "delete", "dispatch"], paths: ["tasks/**", "shared/**", "repos/**", "kb/**"] },
};
// The consent page's plain-words choices (docs/glossary.md: "what it can do"), turned into verbs and globs here so the page sends
// a word, not a glob. "Read and write one folder" is the narrow one an unverified app starts on; sending tasks is its own tick, off
// by default. "custom" = the fields as typed (what the app asked for).
const FOLDER_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
export function consentFolder(f: any) {
  const p = String(f ?? "").trim().replace(/^(\.?\/)+/, "").replace(/\/?\*\*$/, "").replace(/\/+$/, "");
  if (!FOLDER_RE.test(p) || p.split("/").some(x => x === "." || x === "..")) fail("invalid_scope", "folder: one folder path such as kb/notes (letters, digits, . _ - and /)");
  return p + "/**";
}
// "shared" = the documented assistant preset (llms.txt): read everything, write only shared/** and kb/** (shared memory: kb_add to
// kb/global or kb/<project> works). The recommended default since kb-write-default (2026-10-23: Muse's kb_add was refused on "its folder").
export function consentChoice(choice: string, folder?: string, dispatch = false): { verbs: string[]; paths: string[] } {
  const c = choice === "shared" ? { verbs: ["read", "write"], paths: [...PRESETS.assistant.paths] } : choice === "folder" ? { verbs: ["read", "write"], paths: [consentFolder(folder)] } : choice === "read" ? { verbs: ["read"], paths: ["**"] }
    : choice === "full" ? { verbs: ["read", "write", "delete"], paths: ["**"] } : fail("invalid_scope", "choice: shared | folder | read | full | custom");
  if (dispatch) c.verbs.push("dispatch");
  return c;
}
export const OAUTH_SCHEMA = `
create table if not exists oauth_peers(peer_id text primary key);
create table if not exists oauth_families(id text primary key, peer_id text, client_id text, space text, verbs text, source text, created text, revoked integer default 0);
create table if not exists oauth_tokens(hash text primary key, kind text, family text, expires integer, used integer default 0, revoked integer default 0);
create table if not exists oauth_codes(hash text primary key, family text, client_id text, redirect_uri text, challenge text, expires integer, used integer default 0);
create table if not exists oauth_device(code_hash text primary key, user_hash text unique, client_id text, req text, expires integer, interval integer, last_poll integer default 0, status text, acct text, family text);
create table if not exists oauth_clients(id text primary key, name text, redirect_uris text, secret_hash text, created text);
create table if not exists oauth_rate(k text, win integer, n integer, primary key(k, win));
create table if not exists oauth_connect(id text primary key, poll_hash text unique, code text, nonce text, client_id text, app text, redirect_uri text, challenge text, req text, expires integer, status text, family text, error text, by text, created text);`;
export const OAUTH_MIGRATE = ["alter table oauth_clients add column used text", // last lookup (authorize page, token endpoint), for the sweep
  "alter table oauth_clients add column self integer default 0", // registered by anyone (no owner): its name is unverified, swept if never consented
  "alter table oauth_clients add column consented text", // first owner approval at /oauth/authorize
  "alter table oauth_clients add column loopback_any integer default 0", // owner pre-registered CLI (/start): any loopback port and path
  "alter table oauth_clients add column acct text"]; // the account whose owner made it on /start: "Approve on my phone" asks that account

// a fresh self-hosted Kitebook: nobody has signed in yet, so there is no Mac to approve a sign-in request. Say the first step instead.
export const FRESH = "This Kitebook isn't set up yet, so there's no Mac to approve this. First sign-in: on the Mac running Kitebook, type kitebook open in Terminal (it opens Kitebook signed in), or paste the server's ADMIN_TOKEN under Use a recovery code.";
const rnd = (n: number) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");
class OErr extends Error { constructor(public code: string, msg: string, public status = 400) { super(msg); } }
const fail = (code: string, msg: string, status = 400): never => { throw new OErr(code, msg, status); };
export const knobs = (env: any) => {
  const n = (k: string, d: number) => { const v = Number(env?.[k]); return Number.isFinite(v) && v > 0 ? v : d; };
  const hosted = env?.HOSTED === "1";
  return { deviceTtl: n("OAUTH_DEVICE_TTL", 600), interval: n("OAUTH_INTERVAL", 5), slowdown: n("OAUTH_SLOWDOWN", 5), accessTtl: n("OAUTH_ACCESS_TTL", 3600),
    refreshTtl: n("OAUTH_REFRESH_TTL", 30 * 86400), grantMax: n("OAUTH_GRANT_MAX_TTL", 0), // 0 = no cap on a grant's total life
    // a hosted Kitebook is for Claude.ai/ChatGPT, which can only register themselves (some with a secret); "public" is safe anywhere
    dcrMode: (env?.OAUTH_DCR === "0" ? "off" : env?.OAUTH_DCR === "1" || hosted ? "all" : "public") as "off" | "public" | "all",
    dcr: env?.OAUTH_DCR !== "0", // CLIs can sign themselves up (the /start cards show their no-token commands)
    dcrIp: n("OAUTH_DCR_PER_IP_HOUR", 20), dcrAcct: n("OAUTH_DCR_PER_ACCOUNT_HOUR", 60), grantsHour: n("OAUTH_GRANTS_PER_HOUR", 30),
    clientUnused: n("OAUTH_CLIENT_UNUSED_TTL", 86400),
    // "Approve on my phone / Mac": a connection request (and the code shown with it) lives 5 minutes; per account 10 per 10 min, per IP 30/h
    connectTtl: n("OAUTH_CONNECT_TTL", 300), connectAcct: n("OAUTH_CONNECT_PER_ACCOUNT", 10), connectIp: n("OAUTH_CONNECT_PER_IP_HOUR", 30) };
};
// fixed-window counter in the calling DO's sql (the global Dir for IPs, an account Dir for its own grants)
export function rateHit(sql: SqlStorage, key: string, limit: number, winSec = 3600): { ok: boolean; retry_after: number } {
  const t = Math.floor(Date.now() / 1000), win = t - (t % winSec);
  sql.exec("delete from oauth_rate where win<?", win);
  const n = (sql.exec("insert into oauth_rate values(?,?,1) on conflict(k,win) do update set n=n+1 returning n", key, win).one().n as number);
  return { ok: n <= limit, retry_after: win + winSec - t };
}

// per-IP signup counter in the global OAuth Dir (Cloudflare sets cf-connecting-ip; local dev shares one bucket). Used by POST /signup and /start.
export async function signupLimit(env: any, req: Request) {
  const v = Number(env?.SIGNUP_PER_IP_HOUR), max = Number.isFinite(v) && v > 0 ? v : env?.HOSTED === "1" ? 5 : 20;
  return await env.DIR.get(env.DIR.idFromName("oauth:global")).oauth("rate", `signup:ip:${req.headers.get("cf-connecting-ip") ?? "local"}`, max) as { ok: boolean; retry_after: number };
}
// scope: verbs plus space:<id>, role:<kind>, path:<glob>, preset:<name>. Unknown words (openid, offline_access, …) are ignored, not errors.
// A preset fills in whatever the explicit words leave out (verbs, paths, role); the first preset named wins.
export function parseScope(s?: string) {
  const o = { verbs: [] as string[], space: undefined as string | undefined, kind: undefined as string | undefined, paths: [] as string[], preset: undefined as string | undefined };
  for (const t of String(s ?? "").split(/\s+/).filter(Boolean)) {
    if (VERBS.includes(t)) { if (!o.verbs.includes(t)) o.verbs.push(t); }
    else if (t.startsWith("space:")) o.space = t.slice(6); else if (t.startsWith("role:") && KINDS.includes(t.slice(5))) o.kind = t.slice(5);
    else if (t.startsWith("path:") && t.length > 5) o.paths.push(t.slice(5));
    else if (t.startsWith("preset:") && PRESETS[t.slice(7)] && !o.preset) o.preset = t.slice(7);
  }
  const p = o.preset ? PRESETS[o.preset] : null;
  if (p) { if (!o.verbs.length) o.verbs = [...p.verbs]; if (!o.paths.length) o.paths = [...p.paths]; o.kind ??= p.kind; }
  return o;
}
const scopeStr = (f: any, kind: string) => [`space:${f.space}`, ...JSON.parse(f.verbs), `role:${kind}`].join(" ");

// ---------- account Dir side (d is the Dir instance: d.sql, d.acct, d.admin, d.peerByName) ----------
type D = { sql: SqlStorage; acct: string; admin(cmd: string, a: any): Promise<any>; space(id: string): any };
const row = (d: D, q: string, ...b: any[]) => d.sql.exec(q, ...b).toArray()[0] as any;
// Ends a grant: its tokens, and in its space every event subscription, stream and socket opened with them (they are credentials too).
export async function killFamily(d: D, fam: string, reason = "OAuth grant revoked") {
  d.sql.exec("update oauth_families set revoked=1 where id=?", fam); d.sql.exec("update oauth_tokens set revoked=1 where family=?", fam);
  const f = row(d, "select peer_id, space, client_id, source from oauth_families where id=?", fam);
  if (f?.source === "consent") await forgetClient(d as any, null, f.client_id).catch(() => {}); // Better Auth's refresh tokens + consent for it go too
  if (f) await d.space(f.space).endGrant(f.peer_id, fam, reason).catch(() => {}); // the tokens are dead either way; the sweep is best effort
}

// A name clash never blocks connecting. The name an app asks for (or the owner typed) is used if it is free. If an earlier OAuth
// connection holds it (the same app connecting again), the default is to replace it: its old sign-ins end and the name carries
// over. Otherwise (taken by a token connection, revoked, or the owner chose "keep both") the next free name: pi-2, pi-3, ...
function freeName(d: D, base: string) {
  for (let i = 2; i < 100; i++) { const n = `${base.slice(0, 31 - String(i).length)}-${i}`; if (!row(d, "select 1 as x from peers where name=?", n)) return n; }
  return fail("invalid_request", `Too many connections are named ${base}. Remove some on /start, Status.`);
}
export function namePlan(d: D, name: string, replace?: boolean, clientId?: string): { name: string; replace: boolean; taken: boolean } {
  if (!NAME_RE.test(name ?? "")) fail("invalid_request", "Name: lowercase letters, digits, - or _ (up to 32), for example pi");
  const p = row(d, "select id, revoked from peers where name=?", name); if (!p) return { name, replace: false, taken: false };
  const live = !p.revoked && !!row(d, "select 1 as x from oauth_peers where peer_id=?", p.id)
    && (!clientId || !!row(d, "select 1 from oauth_families where peer_id=? and client_id=? and revoked=0", p.id, clientId));
  return live && replace !== false ? { name, replace: true, taken: true } : { name: freeName(d, name), replace: false, taken: true };
}
// what a choice lets the app do, in one plain sentence (the consent page, the phone page and `kitebook approve` all say the same)
export function canSay(app: string, verbs: string[], paths: string[]) {
  const send = verbs.includes("dispatch") ? "It can send tasks to your Mac; you approve each one." : "It can't send tasks or push.";
  const fs = paths.filter(g => !/^[a-z]+:/.test(g)).map(g => g === "**" ? "every folder" : g.replace(/\/?\*\*$/, ""));
  if (fs.includes("every folder")) {
    if (verbs.includes("delete")) return `${app} can read, edit and delete everything. ${send}`;
    const w = paths.filter(g => g.startsWith("write:")).map(g => g.slice(6).replace(/\/?\*\*$/, ""));
    if (verbs.includes("write")) return `${app} can read everything and edit ${w.length ? w.join(" and ") : "everything"}. ${send}`;
    return `${app} can read every folder and change nothing. ${send}`;
  }
  return `${app} can ${verbs.includes("write") ? "read and edit" : "read"} ${fs.join(", ") || "nothing"}. ${send}`;
}

// What a connection really got, in the words the success screen, `kitebook approve` and whoami all use:
// "Pi can: read and edit kb/pi/. Can't: delete files, send tasks."
export function grantSummary(app: string, verbs: string[], paths: string[]) {
  const W = (g: string) => g === "**" ? "every folder" : g.replace(/\/?\*\*$/, "") + "/";
  const plain = paths.filter(g => !/^[a-z]+:/.test(g)).map(W), wr = paths.filter(g => g.startsWith("write:")).map(g => W(g.slice(6))), all = plain.includes("every folder");
  const can: string[] = [], cant: string[] = [];
  if (verbs.includes("read")) can.push(verbs.includes("write") ? (all && wr.length ? `read every folder, edit ${wr.join(" and ")}` : `read and edit ${plain.join(", ")}`) : `read ${plain.join(", ")}`);
  else if (verbs.includes("write")) can.push(`edit ${(wr.length ? wr : plain).join(", ")}`);
  if (verbs.includes("delete")) can.push(`delete files in ${plain.join(", ")}`); else if (verbs.includes("write")) cant.push("delete files");
  if (!verbs.includes("write")) cant.push("change files");
  if (verbs.includes("dispatch")) can.push("send tasks to your Mac"); else cant.push("send tasks");
  return `${app} can: ${can.join("; ") || "nothing"}.${cant.length ? ` Can't: ${cant.join(", ")}.` : ""}`;
}

const acctFns = {
  // owner approved: peer + grant + a new token family. replace: undefined keeps the old behavior (an OAuth peer of that name is reused,
  // re-connecting Claude keeps its name), true ends that peer's earlier OAuth sign-ins first, false never reuses; any other clash
  // (a token connection, a revoked one) takes the next free name. Returns the family and the name it really got.
  async grant(d: D, a: { name: string; kind: string; space: string; verbs: string[]; paths: string[]; client_id: string; source: string; replace?: boolean }): Promise<{ family: string; name: string }> {
    if (!NAME_RE.test(a.name ?? "")) fail("invalid_request", "Name: lowercase letters, digits, - or _ (up to 32), for example pi");
    const lim = rateHit(d.sql, "grants", knobs((d as any).env).grantsHour); // per account: a stolen session can't mint grants without end
    if (!lim.ok) fail("rate_limited", `too many new connections for this account; try again in ${Math.ceil(lim.retry_after / 60)} min`, 429);
    if (!KINDS.includes(a.kind)) fail("invalid_request", "kind: " + KINDS.join("|"));
    if (!a.verbs?.length || a.verbs.some(v => !VERBS.includes(v))) fail("invalid_scope", "verbs: " + VERBS.join(","));
    if (!row(d, "select 1 as x from spaces where id=?", a.space)) fail("invalid_scope", "no space " + a.space);
    const plan = a.replace === undefined ? (() => { const x = namePlan(d, a.name, true, a.client_id); return { ...x, replace: false, reuse: x.replace }; })() : { ...namePlan(d, a.name, a.replace, a.client_id), reuse: false };
    if (plan.replace) { const pid = row(d, "select id from peers where name=?", plan.name).id; // the same app connecting again: its old sign-ins end now
      for (const f of d.sql.exec("select id from oauth_families where peer_id=? and revoked=0", pid).toArray() as any[]) await killFamily(d, f.id, "replaced by a new connection of the same app"); }
    a = { ...a, name: plan.name };
    if (!plan.replace && !plan.reuse) { try { await d.admin("peer", { name: a.name, kind: a.kind }); } catch (e: any) { fail("invalid_request", String(e?.message ?? e)); } // e.g. the account's peer quota
      d.sql.exec("insert into oauth_peers values(?)", row(d, "select id from peers where name=?", a.name).id); } // its rk token is never shown
    await d.admin("grant", { peer: a.name, space: a.space, verbs: a.verbs, paths: a.paths?.length ? a.paths : ["**"] });
    const id = "f_" + hex(8), pid = row(d, "select id from peers where name=?", a.name).id;
    d.sql.exec("insert into oauth_families(id,peer_id,client_id,space,verbs,source,created) values(?,?,?,?,?,?,?)", id, pid, a.client_id, a.space, JSON.stringify(a.verbs), a.source, new Date().toISOString());
    return { family: id, name: a.name };
  },
  namePlan(d: D, name: string, replace?: boolean, clientId?: string) { return namePlan(d, name, replace, clientId); },
  // ---- sign-in requests (kitebook approve <code>, or a signed-in browser) ----
  // a browser asking to sign in to /start (the "Send a sign-in request to my phone" button): the same request, kind login, no app access;
  // approved on the phone / `kitebook approve` (via the runner) or by a browser already signed in, it signs that browser in for 30 days
  async loginNew(d: D, a: { label: string; phone?: boolean }, k: ReturnType<typeof knobs>) {
    const sp = row(d, "select id from spaces order by (id='main') desc, id limit 1"); if (!sp) fail("invalid_request", isRoot(d.acct) ? FRESH : `There is no Kitebook account named ${d.acct} here. Check the name.`);
    const lim = rateHit(d.sql, "connect", k.connectAcct, 600);
    if (!lim.ok) fail("rate_limited", `Too many sign-in requests for this account. Try again in ${Math.ceil(lim.retry_after / 60)} min.`, 429);
    d.sql.exec("delete from oauth_connect where expires<?", Date.now() - 3600_000);
    const id = "cr_" + hex(8), poll = `pc.${d.acct}.${rnd(32)}`, nonce = rnd(24), exp = Date.now() + k.connectTtl * 1000, label = String(a.label ?? "").slice(0, 60) || "A browser";
    const raw = [...crypto.getRandomValues(new Uint8Array(8))].map(b => UC[b % UC.length]).join(""), code = raw.slice(0, 4) + "-" + raw.slice(4);
    const req = { kind: "login", phone: a.phone === true, name: label, replace: false, space: sp.id, folder: null, can: "That browser can then do anything you can on /start, for 30 days (you can remove it there)." };
    d.sql.exec("insert into oauth_connect(id,poll_hash,code,nonce,client_id,app,redirect_uri,challenge,req,expires,status,created) values(?,?,?,?,'login',?,'','',?,?,'pending',?)",
      id, await sha256(poll), code, nonce, label, JSON.stringify(req), exp, new Date().toISOString());
    return { id, poll, code, expires: exp, space: sp.id };
  },
  loginList(d: D) { return (d.sql.exec("select id, code, app, expires from oauth_connect where client_id='login' and status='pending' and expires>? order by created", Date.now()).toArray() as any[]).map(r => ({ id: r.id, code: r.code, label: r.app, expires: r.expires })); },
  async loginDecide(d: D, id: string, yes: boolean) { const r = acctFns.connectRow(d, id); if (!r || r.client_id !== "login") fail("invalid_request", "No such sign-in request.");
    return await acctFns.connectDecide(d, { id, nonce: r.nonce, yes, by: "a signed-in browser" }); },
  connectRow(d: D, id: string) {
    const r = row(d, "select * from oauth_connect where id=?", String(id ?? "")); if (!r) return null;
    if (r.status === "pending" && r.expires < Date.now()) { d.sql.exec("update oauth_connect set status='expired' where id=?", r.id); r.status = "expired"; }
    return r;
  },
  connectGet(d: D, id: string) { // runner side: what to ask the owner (no poll secret, no client details beyond the app's name)
    const r = acctFns.connectRow(d, id); if (!r) fail("invalid_request", "No such connection request.");
    const q = JSON.parse(r.req); return { id: r.id, kind: q.kind ?? "connect", phone: !!q.phone, status: r.status, code: r.code, nonce: r.nonce, app: r.app, name: q.name, replace: q.replace, space: q.space, folder: q.folder, can: q.can, expires: r.expires };
  },
  async connectDecide(d: D, a: { id: string; nonce: string; yes: boolean; by: string }) {
    const r = acctFns.connectRow(d, a.id); if (!r) fail("invalid_request", "No such connection request.");
    if (r.status === "expired") fail("invalid_grant", "This request expired. Start connecting again.");
    if (r.status !== "pending") fail("invalid_grant", `This request was already answered (${r.status}).`);
    if (typeof a.nonce !== "string" || a.nonce !== r.nonce) fail("invalid_grant", "This answer belongs to a different request.");
    if (!a.yes) { d.sql.exec("update oauth_connect set status='denied', by=? where id=?", a.by, r.id); return { state: "denied" }; }
    d.sql.exec("update oauth_connect set status='approving', by=? where id=? and status='pending'", a.by, r.id); // decided once
    const q = JSON.parse(r.req);
    if (q.kind === "login") { d.sql.exec("update oauth_connect set status='approved' where id=?", r.id); return { state: "approved", name: q.name }; }
    return fail("invalid_request", "No such sign-in request.");
  },
  // the /start page waiting for its sign-in request, polling with its own secret; approved, it signs in once
  async connectPoll(d: D, a: { poll: string; client_id: string; redirect_uri: string; challenge: string }) {
    const h = await sha256(String(a.poll ?? "")), r0 = row(d, "select id from oauth_connect where poll_hash=?", h); if (!r0) fail("invalid_grant", "This request isn't known here. Start connecting again.");
    const r = acctFns.connectRow(d, r0.id);
    if (r.client_id !== a.client_id || r.redirect_uri !== a.redirect_uri || r.challenge !== a.challenge) fail("invalid_grant", "This request belongs to another sign-in.");
    const q = JSON.parse(r.req);
    if (r.status === "approved" && q.kind === "login") { d.sql.exec("update oauth_connect set status='done' where id=? and status='approved'", r.id); return { state: "approved", login: true }; }
    if (r.status === "done") fail("invalid_grant", "This approval was already used. Start connecting again.");
    return { state: r.status === "approving" ? "pending" : r.status, ...(r.status === "failed" ? { error: r.error } : {}), code: r.code, expires: r.expires, by: r.by ?? null };
  },
  async issue(d: D, fam: string, k: ReturnType<typeof knobs>) {
    const f = row(d, "select f.*, p.kind, p.revoked as prev from oauth_families f join peers p on p.id=f.peer_id where f.id=?", fam);
    if (!f || f.revoked || f.prev) fail("invalid_grant", "grant was revoked");
    const at = `at.${d.acct}.${rnd(32)}`, rt = `rt.${d.acct}.${rnd(32)}`, t = Date.now();
    d.sql.exec("delete from oauth_tokens where expires<?", t - 86400_000); // spent and expired rows: nothing left to detect after expiry
    d.sql.exec("insert into oauth_tokens(hash,kind,family,expires) values(?,?,?,?)", await sha256(at), "access", fam, t + k.accessTtl * 1000);
    d.sql.exec("insert into oauth_tokens(hash,kind,family,expires) values(?,?,?,?)", await sha256(rt), "refresh", fam, t + k.refreshTtl * 1000);
    return { access_token: at, token_type: "Bearer", expires_in: k.accessTtl, refresh_token: rt, refresh_token_expires_in: k.refreshTtl, scope: scopeStr(f, f.kind) };
  },
  async refresh(d: D, a: { token: string; client_id: string }, k: ReturnType<typeof knobs>) {
    const t = row(d, "select t.*, f.client_id, f.revoked as frev, f.created as fcreated from oauth_tokens t join oauth_families f on f.id=t.family where t.hash=? and t.kind='refresh'", await sha256(a.token ?? ""));
    if (!t) fail("invalid_grant", "unknown refresh token");
    if (t.used && !t.frev) { await killFamily(d, t.family, "refresh token replayed"); fail("invalid_grant", "refresh token reuse detected; this grant is revoked, sign in again"); }
    if (t.used || t.revoked || t.frev) fail("invalid_grant", "refresh token revoked");
    if (t.expires < Date.now()) fail("invalid_grant", "refresh token expired");
    if (a.client_id ? t.client_id !== a.client_id : !String(t.client_id).startsWith("connect:")) fail("invalid_grant", "refresh token was issued to another client"); // /connect apps refresh without one
    if (k.grantMax && Date.parse(t.fcreated) + k.grantMax * 1000 < Date.now()) { await killFamily(d, t.family, "OAuth grant reached its maximum lifetime"); fail("invalid_grant", "this grant reached its maximum lifetime; sign in again"); }
    d.sql.exec("update oauth_tokens set used=1 where hash=?", t.hash);
    return await acctFns.issue(d, t.family, k);
  },
  // RFC 7009: a refresh token ends its whole family; an access token ends just itself. Unknown tokens are not an error.
  async revoke(d: D, token: string) {
    const t = row(d, "select * from oauth_tokens where hash=?", await sha256(token ?? ""));
    if (t?.kind === "refresh") await killFamily(d, t.family); else if (t) d.sql.exec("update oauth_tokens set revoked=1 where hash=?", t.hash);
    return { revoked: !!t };
  },
  // Dir.auth fallback for at.* tokens: the grant's peer, its caps narrowed to the grant's space and verbs.
  async auth(d: D, h: string) {
    const t = row(d, "select t.family from oauth_tokens t where t.hash=? and t.kind='access' and t.revoked=0 and t.expires>?", h, Date.now());
    return t ? await acctFns.authFamily(d, t.family) : null;
  },
  // the same for a grant (a Better Auth access token's live grant, src/auth.ts authJwt)
  async authFamily(d: D, fam: string) {
    const t = row(d, "select id as family, peer_id, space, verbs from oauth_families where id=? and revoked=0", fam); if (!t) return null;
    const p = row(d, "select id,name,kind from peers where id=? and revoked=0 and (expires is null or expires>?)", t.peer_id, Date.now()); if (!p) return null; // Settings: access ended
    const verbs: string[] = JSON.parse(t.verbs);
    const caps = d.sql.exec("select space_id,verbs,paths from caps where peer_id=? and space_id=?", p.id, t.space).toArray()
      .map((c: any) => ({ space: c.space_id, verbs: (JSON.parse(c.verbs) as string[]).filter(v => verbs.includes(v)), paths: JSON.parse(c.paths) }));
    return { peer: { id: p.id, name: p.name, kind: p.kind, grant: t.family as string }, caps }; // grant: ties event subscriptions to this grant
  },
  // the owner ends one grant (admin.ts revoke_grant <id>), or a peer ends its own (revoke_self)
  async revokeFamily(d: D, fam: string, reason?: string) {
    if (!row(d, "select 1 as x from oauth_families where id=?", fam)) fail("invalid_request", "no grant " + fam);
    await killFamily(d, fam, reason); return { revoked_grant: fam };
  },
  list(d: D) { return d.sql.exec("select f.id, p.name as peer, f.client_id, f.space, f.verbs, f.source, f.created, f.revoked from oauth_families f join peers p on p.id=f.peer_id order by f.created").toArray(); },
};

// ---------- global Dir side ("oauth:global"): device requests and registered clients, before any account is known ----------
const UC = "BCDFGHJKLMNPQRSTVWXZ"; // RFC 8628 6.1: no vowels, no look-alikes
const normCode = (s: string) => String(s ?? "").toUpperCase().replace(/[^A-Z]/g, "");
const globalFns = {
  async deviceStart(d: D, a: { client_id: string; req: any }, k: ReturnType<typeof knobs>) {
    d.sql.exec("delete from oauth_device where expires<?", Date.now() - 3600_000);
    const dc = `dc_${rnd(32)}`;
    for (;;) {
      const raw = [...crypto.getRandomValues(new Uint8Array(8))].map(b => UC[b % UC.length]).join("");
      try { d.sql.exec("insert into oauth_device(code_hash,user_hash,client_id,req,expires,interval,status) values(?,?,?,?,?,?,'pending')", await sha256(dc), await sha256(raw), a.client_id, JSON.stringify(a.req), Date.now() + k.deviceTtl * 1000, k.interval);
        return { device_code: dc, user_code: raw.slice(0, 4) + "-" + raw.slice(4), expires_in: k.deviceTtl, interval: k.interval }; } catch { /* user code collision: draw again */ }
    }
  },
  async deviceView(d: D, code: string) {
    const r = row(d, "select * from oauth_device where user_hash=?", await sha256(normCode(code)));
    return r && r.status === "pending" && r.expires > Date.now() ? { client_id: r.client_id, req: JSON.parse(r.req), expires: r.expires } : null;
  },
  // pending -> approving (one owner decision at a time), then approved/denied, or back to pending if the grant failed
  async deviceReserve(d: D, code: string) {
    const h = await sha256(normCode(code)), r = row(d, "select * from oauth_device where user_hash=?", h);
    if (!r || r.status !== "pending" || r.expires < Date.now()) return null;
    d.sql.exec("update oauth_device set status='approving' where user_hash=?", h); return { client_id: r.client_id, req: JSON.parse(r.req) };
  },
  async deviceFinish(d: D, code: string, status: "approved" | "denied" | "pending", acct?: string, family?: string) {
    d.sql.exec("update oauth_device set status=?, acct=?, family=? where user_hash=? and status='approving'", status, acct ?? null, family ?? null, await sha256(normCode(code)));
  },
  async devicePoll(d: D, a: { device_code: string; client_id: string }, k: ReturnType<typeof knobs>) {
    const h = await sha256(a.device_code ?? ""), r = row(d, "select * from oauth_device where code_hash=?", h), t = Date.now();
    if (!r || (a.client_id && r.client_id !== a.client_id)) fail("invalid_grant", "unknown device_code"); // /connect: the device code alone (no client_id)
    if (r.expires < t) { d.sql.exec("delete from oauth_device where code_hash=?", h); fail("expired_token", "the device code expired; start again"); }
    if (r.status === "denied") { d.sql.exec("delete from oauth_device where code_hash=?", h); fail("access_denied", "the owner denied this request"); }
    if (r.status === "issued") fail("invalid_grant", "device_code already used");
    if (r.status !== "approved" && r.last_poll && t - r.last_poll < r.interval * 1000) { // RFC 8628 3.5: too fast -> slow_down, interval grows for good
      d.sql.exec("update oauth_device set interval=interval+?, last_poll=? where code_hash=?", k.slowdown, t, h); fail("slow_down", `poll at most every ${r.interval + k.slowdown}s`); }
    d.sql.exec("update oauth_device set last_poll=? where code_hash=?", t, h);
    if (r.status !== "approved") fail("authorization_pending", "waiting for the owner to approve at /device");
    d.sql.exec("update oauth_device set status='issued' where code_hash=?", h); // single-threaded DO: exactly one poll wins
    return { acct: r.acct as string, family: r.family as string };
  },
  async rate(d: D, key: string, limit: number, winSec?: number) { return rateHit(d.sql, key, limit, winSec); },
  client(d: D, id: string) { const c = row(d, "select * from oauth_clients where id=?", id); if (c) d.sql.exec("update oauth_clients set used=? where id=?", new Date().toISOString(), id); return c ? { id: c.id, name: c.name, redirect_uris: JSON.parse(c.redirect_uris), secret_hash: c.secret_hash, self: !!c.self, loopback_any: !!c.loopback_any, acct: c.acct ?? null } : null; },
};
export const OAUTH_FNS: Record<string, (d: any, ...a: any[]) => any> = { ...acctFns, ...globalFns };

// ---------- front door ----------
type H = { dir(acct: string): any; global(): any; acctOf(c: string | null | undefined): string; teq(a: string | null, b: string): Promise<boolean> };
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version" };
const oj = (b: any, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache", ...CORS, ...extra } });
const oerr = (e: any) => e instanceof OErr ? oj({ error: e.code, error_description: e.message }, e.status) : oj({ error: "server_error", error_description: String(e?.message ?? e) }, 500);
async function form(req: Request): Promise<any> {
  if ((req.headers.get("content-type") ?? "").includes("application/json")) return await req.json().catch(() => ({}));
  return Object.fromEntries(new URLSearchParams(await req.text().catch(() => "")));
}
// RPC across the DO boundary loses the OErr class; carry code + message in the error text and rebuild it here
async function rpc(stub: any, fn: string, ...args: any[]) {
  try { return await stub.oauth(fn, ...args); }
  catch (e: any) { const m = String(e?.message ?? e).match(/^oauth:([a-z_]+):(.*)$/s); if (m) throw new OErr(m[1], m[2], m[1] === "invalid_client" ? 401 : m[1] === "access_denied" ? 403 : m[1] === "rate_limited" ? 429 : 400); throw e; }
}
export async function dirOauth(d: any, fn: string, args: any[]) {
  try { return await OAUTH_FNS[fn](d, ...args); } catch (e: any) { if (e instanceof OErr) throw new Error(`oauth:${e.code}:${e.message}`); throw e; }
}
export // the deciding owner: an admin key in the body wins; otherwise the /start session cookie, on a same-origin request only
const decider = async (req: Request, url: URL, env: any, key: string | undefined, h: H) => key ? await owner(env, key, h) : sameOrigin(req, url) ? await sessionOwner(req, h.dir) : null;
const NO_OWNER = "Sign in on this Kitebook's /start page in this browser first (run kitebook open on your Mac, or use your passkey).";
const signin = (url: URL) => `/start?next=${encodeURIComponent(url.pathname + url.search)}`;
export async function owner(env: any, key: string | undefined, h: Pick<H, "dir" | "acctOf" | "teq">) {
  if (!key) return null;
  if (key.startsWith("ak.")) { const a = h.acctOf(key), d = h.dir(a); return await d.isAdmin(await sha256(key)) ? { acct: a, dir: d } : null; }
  return env.ADMIN_TOKEN && await h.teq(key, env.ADMIN_TOKEN) ? { acct: ROOT_ACCOUNT, dir: h.dir(ROOT_ACCOUNT) } : null;
}
// confidential DCR clients authenticate with their secret (Basic or post); public ones (and device clients) just name themselves
async function clientOf(req: Request, p: any, h: H): Promise<string> {
  let id = p.client_id, secret = p.client_secret;
  const b = req.headers.get("authorization")?.match(/^Basic\s+(.+)$/i);
  if (b) { try { const [i, s] = atob(b[1]).split(":"); id = decodeURIComponent(i); secret = decodeURIComponent(s ?? ""); } catch { fail("invalid_client", "bad Basic credentials", 401); } }
  if (!id) fail("invalid_request", "client_id is required");
  if (String(id).startsWith("rc_")) {
    const c = await h.global().oauth("client", id); if (!c) fail("invalid_client", "unknown client", 401);
    if (c.secret_hash && (!secret || await sha256(secret) !== c.secret_hash)) fail("invalid_client", "client authentication failed", 401);
  }
  return id;
}
const RESOURCES = (o: string) => [o, o + "/", o + "/mcp", o + "/v1"];
export const slug = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "client";

// RFC 9728: a 401 names the protected-resource metadata (served by the account's Better Auth): /mcp for self-host, /u/<acct>/mcp hosted
// no token: the description says how to connect (connect by name, src/named.ts), ASCII only (a header)
export const wwwAuth = (o: string, mcp: string | null, hadToken: boolean, why?: string) =>
  `Bearer resource_metadata="${o}/.well-known/oauth-protected-resource${mcp ?? ""}"${hadToken ? `, error="invalid_token"${why ? `, error_description="${why.replace(/["\\]/g, "")}"` : ""}` : `, error_description="To connect: POST ${o}/connect {agent:'<your type, e.g. muse>', name:'<your own name>'}, show the owner the link, poll ${o}/token for the token. No client ID or registration needed"`}`;

export async function oauthFetch(req: Request, env: any, url: URL, h: H): Promise<Response | null> {
  const p = url.pathname, o = url.origin, k = knobs(env);
  if (!p.startsWith("/oauth/") && p !== "/device" && p !== "/connect") return null;
  if (req.method === "OPTIONS" && p !== "/device" && p !== "/oauth/authorize") return new Response(null, { status: 204, headers: CORS });
  try {
    if (p === "/connect") return await connectStart(req, env, url, h, k);
    if (p === "/oauth/register") fail("invalid_client", OLD_CLIENT.trim()); // new apps sign up at this account's Better Auth (its metadata names where)
    if (p === "/oauth/device_authorization" && req.method === "POST") {
      const b = await form(req);
      if (!/^[A-Za-z0-9._:-]{1,64}$/.test(b.client_id ?? "")) fail("invalid_client", "client_id: 1-64 of letters, digits, . _ : -", 401);
      const s = parseScope(b.scope), r = await rpc(h.global(), "deviceStart", { client_id: b.client_id, req: { ...s, name: b.name ? slug(b.name) : slug(b.client_id) } }, k);
      return oj({ ...r, verification_uri: `${o}/device`, verification_uri_complete: `${o}/device?user_code=${r.user_code}` });
    }
    if (p === "/oauth/token" && req.method === "POST") {
      const b = await form(req), gt = b.grant_type;
      if (b.resource && !RESOURCES(o).includes(b.resource)) fail("invalid_target", "unknown resource");
      if (gt === "urn:ietf:params:oauth:grant-type:device_code") {
        const cid = !b.client_id && !req.headers.get("authorization") ? "" : await clientOf(req, b, h), r = await rpc(h.global(), "devicePoll", { device_code: b.device_code, client_id: cid }, k); // "": /connect's code alone
        return oj(await rpc(h.dir(r.acct), "issue", r.family, k));
      }
      if (gt === "authorization_code") fail("invalid_grant", OLD_CLIENT.trim());
      if (gt === "refresh_token") { const cid = !b.client_id && !req.headers.get("authorization") ? "" : await clientOf(req, b, h); return oj(await rpc(h.dir(h.acctOf(b.refresh_token)), "refresh", { token: b.refresh_token, client_id: cid }, k)); }
      fail("unsupported_grant_type", "authorization_code | refresh_token | urn:ietf:params:oauth:grant-type:device_code");
    }
    if (p === "/oauth/revoke" && req.method === "POST") {
      const b = await form(req); if (/^(at|rt)\.[a-z0-9-]+\./.test(b.token ?? "")) await rpc(h.dir(h.acctOf(b.token)), "revoke", b.token);
      return oj({}); // RFC 7009 2.2: 200 whether or not the token existed
    }
    if (p === "/device") return await devicePage(req, env, url, h, k);
    if (p === "/oauth/authorize") return new Response(OLD_CLIENT, { status: 400, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  } catch (e: any) { return oerr(e); }
  return oj({ error: "invalid_request", error_description: "not found" }, 404);
}

// ---------- POST /connect: pairing for agents that can't take a redirect (a cloud VM: Muse...). RFC 8628, no client_id ----------
// {agent: "muse", name: "Luna"} -> the connection "muse-luna", a code and a link for the owner; the agent polls /token (grant_type
// device_code) with the device code alone. The link opens ONE step on the owner's Mac: "Connect muse-luna to your Mac" + the master password;
// Enter is the approval (the runner's loopback helper unlocks this Mac's password presence key and signs exactly that grant; the password
// never leaves the Mac; typed on a phone instead, it goes over HTTPS to the Mac, which checks it: src/remote-pw.ts). Default access: the assistant preset (read every folder, save to shared memory shared/** + kb/**, send tasks, each approved). Elsewhere: kitebook approve <code> on the Mac, or a
// signed-in browser with kitebook confirm. 10 per IP per hour, single use, 10 minutes.
export const PAIR_DEFAULT = { verbs: [...PRESETS.assistant.verbs], paths: [...PRESETS.assistant.paths] };
export const HELPER_PORT = 47615; // the runner's presence helper on 127.0.0.1 (client/device.ts presenceHelper); KITEBOOK_PRESENCE_PORT moves it
async function connectStart(req: Request, env: any, url: URL, h: H, k: ReturnType<typeof knobs>) {
  const o = url.origin, { connName, cleanName } = await import("./named.ts");
  if (req.method !== "POST") return oj({ error: "invalid_request", error_description: `POST ${o}/connect with {"agent":"<your type, e.g. muse>","name":"<your own name>"}` }, 405);
  const b = await form(req);
  const lim = await h.global().oauth("rate", `connect:ip:${req.headers.get("cf-connecting-ip") ?? "local"}`, Number(env?.CONNECT_PER_IP_HOUR) > 0 ? Number(env.CONNECT_PER_IP_HOUR) : 10);
  if (!lim.ok) return oj({ error: "slow_down", error_description: `too many connection requests from your address; try again in ${Math.ceil(lim.retry_after / 60)} min` }, 429, { "retry-after": String(lim.retry_after) });
  const name = connName(cleanName(String(b.agent ?? b.client_id ?? "")), cleanName(String(b.name ?? b.client_name ?? ""))) || "app";
  const r = await rpc(h.global(), "deviceStart", { client_id: "connect:" + name, req: { ...PAIR_DEFAULT, kind: "assistant", name: slug(name), via: "connect" } }, k);
  const link = `${o}/device?user_code=${r.user_code}`;
  return oj({ ...r, name, verification_uri: `${o}/device`, verification_uri_complete: link, token_endpoint: `${o}/token`, grant_type: "urn:ietf:params:oauth:grant-type:device_code", mcp: `${o}/mcp`,
    message: `Show the owner this link: ${link} (code ${r.user_code}; it works for 10 minutes). They open it on their Mac or phone and type their Kitebook master password (their Mac checks it). Meanwhile POST ${o}/token with grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=<device_code> every ${r.interval}s; it answers authorization_pending until then, then access_token (Authorization: Bearer for ${o}/mcp, 1 hour) and refresh_token (POST ${o}/token grant_type=refresh_token&refresh_token=<it> for a new one).` }, 200);
}
// the page reads the assertion's account (a presence-only approval: no session in this browser, the master password on the Mac is the proof)
const assertAcct = (p: string) => { try { const j = JSON.parse(atob(String(p).split(".")[0].replace(/-/g, "+").replace(/_/g, "/"))); return ACCT_RE.test(j?.a ?? "") || isRoot(j?.a ?? "-") ? String(j.a) : null; } catch { return null; } };
const rpIdOf = (o: string) => { try { return new URL(o).hostname; } catch { return ""; } };
const pageAcct = (a: any) => typeof a === "string" && ACCT_RE.test(a) ? a : ROOT_ACCOUNT; // which account a signed-out page acts for (self-host: root)
const fmtCode = (c: string) => { const n = normCode(c); return n.length === 8 ? n.slice(0, 4) + "-" + n.slice(4) : n; };

// ---------- device page ----------
async function devicePage(req: Request, env: any, url: URL, h: H, k: ReturnType<typeof knobs>) {
  if (req.method === "GET") { const n = rnd(16), ses = await sessionOwner(req, h.dir), code = url.searchParams.get("user_code") ?? "";
    const pv = code ? await h.global().oauth("deviceView", code) : null; // a /connect request: the one-step password page
    const port = Number(env?.KITEBOOK_PRESENCE_PORT) || HELPER_PORT;
    // remote: the master password may be typed here on another device and checked by the Mac (src/remote-pw.ts; Settings switch, default on)
    const acct = ses?.acct ?? pageAcct(url.searchParams.get("account")), remote = pv?.req?.via === "connect" ? !!(await h.dir(acct).rpw("setting").catch(() => null))?.on : false;
    if (url.searchParams.get("add") === "passkey") return new Response(authPage("Add this phone", passkeyBody(acct, remote || !!(await h.dir(acct).rpw("setting").catch(() => null))?.on), passkeyJs, n, false), { headers: PAGE_HEADERS(n) });
    if (pv?.req?.via === "connect") return new Response(authPage(`Connect ${pv.req.name}`, pairBody(fmtCode(code), pv.req.name, !!ses, port, remote, acct), pairJs, n, false), { headers: PAGE_HEADERS(n, `http://127.0.0.1:${port}`) });
    return new Response(authPage("Connect a device", deviceBody(code, ses?.acct ?? null, signin(url)), deviceJs, n), { headers: PAGE_HEADERS(n) }); }
  if (req.method !== "POST") return oj({ error: "invalid_request", error_description: "GET or POST" }, 405);
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return oj({ error: "invalid_request", error_description: "send JSON" }, 415); // no cross-site form posts
  const b: any = await req.json().catch(() => ({})), code = fmtCode(b.user_code), act = `device_grant:${code}`;
  // a phone's passkey as an approval device (src/passkey.ts): enrolling needs no session (the owner approves its code), approving with it neither
  if (typeof b.op === "string" && b.op.startsWith("passkey_")) {
    const d = h.dir(pageAcct(b.account)), ip = req.headers.get("cf-connecting-ip") ?? "local";
    try {
      if (b.op === "passkey_begin") { const lim = await h.global().oauth("rate", `passkey:ip:${ip}`, 10); if (!lim.ok) return oj({ error: "slow_down", error_description: "too many passkey requests from your address; try again later" }, 429);
        return oj({ ok: true, ...await d.pk("begin", { name: b.name }), rp_id: rpIdOf(url.origin) }); }
      if (b.op === "passkey_finish") return oj({ ok: true, ...await d.pk("finish", { id: b.id, cred_id: b.cred_id, spki: b.spki, client_data: b.client_data, origin: url.origin }) });
      if (b.op === "passkey_state") return oj({ ok: true, ...await d.pk("state", b.id) });
      if (b.op === "passkey_challenge") { if (!/^device_grant:[A-Z]{4}-[A-Z]{4}$/.test(String(b.action ?? ""))) return oj({ error: "invalid_request", error_description: "action: device_grant:<code>" }, 400);
        return oj({ ok: true, ...await d.pk("challenge", { action: b.action }), rp_id: rpIdOf(url.origin) }); }
    } catch (e: any) { return oj({ error: "invalid_request", error_description: String(e?.message ?? e) }, 400); }
    return oj({ error: "invalid_request", error_description: "op: passkey_begin | passkey_finish | passkey_state | passkey_challenge" }, 400);
  }
  let own: any = await decider(req, url, env, b.admin_key, h), byPresence = false;
  if (!own && b.op === "approve" && b.passkey && typeof b.passkey === "object") { // approved with the phone's passkey: bound to exactly this code
    const d = h.dir(pageAcct(b.account)), v = await d.pk("verify", { action: act, origin: url.origin, cred: b.passkey }).catch((e: any) => ({ ok: false, why: String(e?.message ?? e) }));
    if (!v.ok) return oj({ error: "access_denied", error_description: `Your passkey didn't approve this: ${v.why}` }, 401);
    own = { acct: pageAcct(b.account), dir: d }; byPresence = true;
  }
  // the master password typed on this page on another device (a phone): relayed over this HTTPS request to the owner's Mac, which checks it
  // and signs exactly this grant (src/remote-pw.ts, client/remote-presence.ts); then the same presence path as a password typed on the Mac
  if (!own && b.op === "approve" && typeof b.password === "string" && typeof b.presence !== "string") {
    const pv = await h.global().oauth("deviceView", b.user_code); if (pv?.req?.via !== "connect" && !await h.dir(pageAcct(b.account)).pk("pending", code)) return oj({ error: "invalid_grant", error_description: "unknown or expired code" }, 404);
    const lim = await h.global().oauth("rate", `remotepw:ip:${req.headers.get("cf-connecting-ip") ?? "local"}`, 20);
    if (!lim.ok) return oj({ error: "slow_down", error_description: `too many tries from your address; try again in ${Math.ceil(lim.retry_after / 60)} min` }, 429, { "retry-after": String(lim.retry_after) });
    const r = await h.dir(pageAcct(b.account)).rpw("ask", { action: act, password: b.password, from: "device page" }); b.password = "";
    if (!r.ok) return oj({ error: r.status === 401 ? "access_denied" : r.status === 503 ? "temporarily_unavailable" : r.status === 429 ? "slow_down" : "access_denied", error_description: r.error, ...(r.wrong ? { wrong: true } : {}) }, r.status);
    b.presence = r.presence;
  }
  if (!own && typeof b.presence === "string" && b.op === "approve") { // single use, bound to this code and signed by an owner device: no cookie, so no cross-site risk
    const a = assertAcct(b.presence); if (a) { const d = h.dir(a), ok = await d.dev("assert", b.presence, act, null).catch(() => null); if (ok?.ok) { own = { acct: a, dir: d }; byPresence = true; } } }
  if (!own) return oj({ error: "access_denied", error_description: b.admin_key ? "That recovery code isn't right." : b.presence ? "Your master password didn't confirm this (it may be for another computer, or too old: try again)." : NO_OWNER }, 401);
  const g = h.global();
  if (b.op === "view") { const r = await g.oauth("deviceView", b.user_code); return r ? oj({ ok: true, account: own.acct, ...r }) : oj({ error: "invalid_grant", error_description: "unknown or expired code" }, 404); }
  if (b.op !== "approve" && b.op !== "deny") return oj({ error: "invalid_request", error_description: "op: view | approve | deny" }, 400);
  // a phone's passkey waiting to become an approval device (src/passkey.ts): its code is approved like a pairing code (the master password,
  // kitebook approve <code> on the Mac, or a confirmed browser)
  if (b.op === "approve" && await own.dir.pk("pending", code)) {
    if (!byPresence) { const gt = await own.dir.dev("gate", { tenant: own.tenant, cred: own.cred ?? null, action: act, presence: typeof b.presence === "string" ? b.presence : null });
      if (!gt.ok) return oj({ error: "presence_required", error_description: `Confirm it's you first: run kitebook confirm on one of your computers, then approve again. (${gt.why})`, presence: { needed: true, action: act } }, 428); }
    const r = await own.dir.pk("approve", code); return oj({ ok: true, state: "approved", name: r.name, passkey: true, granted: `${r.name} can now approve with its passkey.` });
  }
  const r = await g.oauth("deviceReserve", b.user_code);
  if (!r) return oj({ error: "invalid_grant", error_description: "unknown, expired or already decided code" }, 404);
  if (b.op === "deny") { await g.oauth("deviceFinish", b.user_code, "denied"); return oj({ ok: true, state: "denied" }); }
  if (!byPresence) { const gt = await own.dir.dev("gate", { tenant: own.tenant, cred: own.cred ?? null, action: act, presence: typeof b.presence === "string" ? b.presence : null }); // presence gate (src/devices.ts)
    if (!gt.ok) { await g.oauth("deviceFinish", b.user_code, "pending"); return oj({ error: "presence_required", error_description: `Confirm it's you first: run kitebook confirm on one of your computers, then approve again. (${gt.why})`, presence: { needed: true, action: act } }, 428); } }
  try {
    const verbs = Array.isArray(b.verbs) ? b.verbs : r.req.verbs, paths = Array.isArray(b.paths) && b.paths.length ? b.paths : r.req.paths, pair = r.req.via === "connect";
    const nm = pair && b.name ? slug(String(b.name)) : b.name ?? r.req.name; // pairing: deduped (muse-luna-2), never taking over another connection's name
    const gr = await rpc(own.dir, "grant", { name: nm, kind: b.kind ?? r.req.kind ?? "assistant", space: b.space ?? r.req.space ?? "main", verbs: verbs?.length ? verbs : ["read"], paths, client_id: r.client_id, source: "device", ...(pair ? { replace: false } : {}) });
    await g.oauth("deviceFinish", b.user_code, "approved", own.acct, gr.family); return oj({ ok: true, state: "approved", name: gr.name, granted: grantSummary(gr.name, verbs?.length ? verbs : ["read"], paths) });
  } catch (e) { await g.oauth("deviceFinish", b.user_code, "pending"); throw e; }
}
// the one-step pairing page: the connection's name (editable), the master password, Enter. Change access is a small fold.
function pairBody(code: string, name: string, signedIn: boolean, port: number, remote = false, acct: string = ROOT_ACCOUNT) {
  const opt = (v: string, t: string, on = false) => `<label><input type="radio" name="acc" value="${v}"${on ? " checked" : ""}> ${t}</label>`;
  return `<div id="form"><h1>Connect <b id="nmv">${esc(name)}</b> to your Mac</h1>
<p class="note">It can read every folder, save to shared memory (the shared/ and kb/ folders) and send tasks to your Mac (you approve each one). Code <b>${esc(code)}</b>.</p>
<div id="pkbar" class="bar" hidden><button id="pkok" type="button">Approve with passkey</button></div>
<form id="pf"><label for="pw">Your Kitebook master password</label><input type="password" id="pw" autocomplete="current-password" autofocus>
<div class="bar"><button id="ok" type="submit">Connect</button><button id="tid" type="button" class="link">Use fingerprint or face unlock</button></div></form>
<details><summary>Change access</summary><label for="name">Name</label><input type="text" id="name" value="${esc(name)}" autocomplete="off">
<div class="ch">${opt("tasks", "Read everything, save to shared memory, send tasks (recommended)", true)}${opt("folder", "Just its own folder + send tasks")}${opt("read", "Read only")}</div></details>
${remote ? `<p class="small">Checked by your Mac: on another device (a phone), your password goes over HTTPS to your Mac, which checks it and forgets it; it isn't stored anywhere. Or run on your Mac: <code>kitebook approve ${esc(code)}</code>.</p>`
  : `<p class="small">Your password is checked on this Mac only. Not on your Mac? Run there: <code>kitebook approve ${esc(code)}</code>${signedIn ? " (or press Connect here and confirm with kitebook confirm)" : ""}.</p>`}
<p class="small" id="pkadd"><a href="/device?add=passkey${isRoot(acct) ? "" : `&account=${esc(acct)}`}">Approve from this phone with a passkey next time</a></p></div>
<section class="state" id="st-ok" hidden><div class="big okc" aria-hidden="true">✓</div><h2 id="done"></h2><p class="note" id="granted"></p><p class="note">It finishes connecting on its own. You can close this page.</p></section>
<script id="req" type="application/json">${JSON.stringify({ code, name, signedIn, port, remote, acct }).replace(/</g, "\\u003c")}</script>`;
}
// ---------- pages (same hardening as the approval page: CSP nonce, no framing, JSON-only POSTs) ----------
// One centered card, phone first, the /start palette, dark mode following the system. head=false: the body draws its own header.
export const authPage = (title: string, body: string, js: string, nonce: string, head = true) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>Kitebook: ${esc(title)}</title>
<style>${THEME_CSS}${BASE_CSS}
:root{--muted:var(--mut);--ok:var(--acc);--okbg:transparent;--okline:var(--acc);--blue:var(--link);--code:var(--soft);--no:var(--danger)}
/* consent and device pages (ui-design, "Quiet page"): one column, no card; the choices are a radio list on hairlines; Approve is the one filled button */
.wrap{min-height:100vh;display:flex;justify-content:center;align-items:flex-start;padding:32px 20px}@media (min-width:600px){.wrap{padding:72px 24px}}
.card{width:100%;max-width:480px;overflow-wrap:anywhere}
h1{font-size:28px;margin:0 0 12px}label{display:block;margin:16px 0 6px;color:var(--muted);font-size:15px}.v label{display:inline-flex;gap:6px;align-items:center;margin-right:16px;color:var(--fg)}
table{border-collapse:collapse;width:100%}th{text-align:left;color:var(--muted);font-weight:400;padding:10px 12px 10px 0;white-space:nowrap;border-top:1px solid var(--line)}td{padding:10px 0;border-top:1px solid var(--line)}
.pill{font-size:15px;font-weight:600;color:var(--danger);margin-left:6px;vertical-align:middle}.pill::before{content:"· ";font-weight:400}
.ch label{display:flex;gap:10px;align-items:center;color:var(--fg);margin:10px 0}.sub{margin:0 0 8px 30px}.note{font-size:15px}.small{color:var(--muted);font-size:14px;margin:20px 0 0}
.bar{display:flex;gap:12px;margin-top:24px}
button{flex:1;font-size:18px;min-height:52px;background:var(--acc);color:var(--onacc)}button:hover{background:var(--acc2)}button.no{background:none;color:var(--danger)}button.no:hover{background:var(--soft)}
button.link{flex:none;background:none;color:var(--link);padding:0;min-height:0;font-size:inherit;font-weight:400;text-decoration:underline}button.link:hover{background:none}
.hd{display:flex;gap:16px;align-items:center;margin-bottom:20px}.av{flex:none;width:52px;height:52px;border-radius:14px;background:var(--soft);color:var(--fg);display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:600}
.hd h1{margin:0;font-size:26px}.hd p{margin:2px 0 0;color:var(--muted)}.sum{font-size:19px;line-height:1.45;margin:0 0 16px}
.preset{display:flex;justify-content:flex-start;gap:14px;align-items:flex-start;width:100%;text-align:left;background:none;color:var(--fg);border:0;border-top:1px solid var(--line);border-radius:0;margin:0;font-size:17px;font-weight:400;padding:16px 4px;min-height:0}.preset:hover{background:var(--soft)}
#presets{border-bottom:1px solid var(--line);margin:8px 0 12px}.preset .dot{flex:none;width:20px;height:20px;margin-top:3px;border-radius:99px;border:2px solid var(--mut)}.preset[aria-pressed=true] .dot{border:6px solid var(--acc)}.preset[aria-pressed=true] b{color:var(--acc)}
.preset b{display:block;font-weight:600}.preset small{display:block;color:var(--muted);font-size:15px;margin-top:2px}.quiet{text-align:center;color:var(--muted);margin:16px 0 0}
.chk{display:flex;gap:10px;align-items:center;color:var(--fg);margin:12px 0}pre{margin:8px 0}
.code{font:600 22px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:1px;background:var(--soft);padding:2px 10px;border-radius:8px}
details summary{color:var(--link);margin:12px 0}.state{text-align:center;padding:8px 0}.state h2{font-size:24px;margin:12px 0 8px}.state p{margin:8px 0}
.big{font-size:56px;line-height:1;margin:8px 0}.okc{color:var(--acc)}.noc{color:var(--danger)}.spin{width:44px;height:44px;margin:8px auto;border:4px solid var(--line);border-top-color:var(--acc);border-radius:99px;animation:sp 1s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}a.btnlink{display:block;text-align:center;background:var(--acc);color:var(--onacc);padding:14px;border-radius:12px;text-decoration:none;font-weight:600}</style></head><body><div class="wrap"><main class="card">
${head ? `<h1>${esc(title)}</h1>` : ""}${body}<p id="msg" class="st" role="status"></p></main></div><script nonce="${nonce}">${js}</script></body></html>`;
// plain words on the page; the values sent back stay the API's verbs and globs (docs/glossary.md)
const VERB_LABEL: Record<string, string> = { dispatch: "send tasks" };
const FOLDERS_LABEL = "Folders it can use (list one or more; <code>**</code> means everything, <code>shared/**</code> means the shared folder and all inside it)";
const verbBoxes = (on: string[]) => `<div class="v">${VERBS.map(v => `<label><input type="checkbox" name="verb" value="${v}"${on.includes(v) ? " checked" : ""}> ${VERB_LABEL[v] ?? v}</label>`).join("")}</div>`;
const exactFields = (verbs: string[], paths: string[]) => `${verbBoxes(verbs)}<label>${FOLDERS_LABEL}</label><input type="text" id="paths" value="${esc(paths.join(" "))}">`;
// signed in (session cookie): name the account, no key field. Otherwise the key field plus a link to sign in (or sign up) on /start.
// signed in (session or remembered browser): name the account, no key field. Otherwise a link to sign in on /start (and come back);
// the recovery code (the account key) stays a hidden fallback, never the first thing asked.
const whoField = (acct: string | null, signinUrl: string) => acct
  ? `<p>Signed in to <b>${esc(acct)}</b>. Not you? <a href="${esc(signinUrl)}">Switch account</a>.</p>`
  : `<p>Sign in to your Kitebook first: <a href="${esc(signinUrl)}">Sign in</a>. You come straight back here.</p><details><summary>Use a recovery code instead</summary><label>Recovery code</label><input type="password" id="key" autocomplete="current-password"></details>`;
function deviceBody(code: string, acct: string | null, signinUrl: string) {
  return `<p>A device asked to connect to your Kitebook. Enter the code it shows.</p><div id="s1"><label>Code</label><input type="text" id="code" autocomplete="off" value="${esc(code)}">
${whoField(acct, signinUrl)}<div class="bar"><button id="look">Continue</button></div></div>
<div id="s2" hidden><table id="info"></table><div id="fields"></div><p class="warn">Only approve if you started this sign-in yourself and the code matches your device.</p><div class="bar"><button id="ok">Approve</button><button id="no" class="no">Deny</button></div></div>`;
}
const JS_COMMON = `const $=id=>document.getElementById(id),msg=t=>$("msg").textContent=t,off=()=>document.querySelectorAll("button").forEach(b=>b.disabled=true);
const picked=()=>({name:$("name").value.trim(),space:$("space").value.trim(),verbs:[...document.querySelectorAll("input[name=verb]:checked")].map(x=>x.value),paths:$("paths").value.split(/\\s+/).filter(Boolean)});
const key=()=>$("key")?$("key").value.trim()||undefined:undefined;
${PRESENCE_JS}
const post=async(path,body)=>{const r=await withPresence(()=>fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}));return [r.status,await r.json()]};
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));`;
const deviceJs = JS_COMMON + `
$("look").onclick=async()=>{msg("Checking…");const [s,j]=await post("/device",{op:"view",user_code:$("code").value,admin_key:key()});if(s!==200)return msg(j.error_description||j.error);
const q=j.req;$("info").innerHTML=(q.via==="connect"?"<tr><th></th><td><b>"+esc(q.name)+" wants to connect</b></td></tr>":"")+"<tr><th>client</th><td>"+esc(j.client_id)+"</td></tr><tr><th>account</th><td>"+esc(j.account)+"</td></tr><tr><th>role</th><td>"+esc(q.kind||"assistant")+"</td></tr>";
const V=["read","write","delete","dispatch"],on=q.verbs&&q.verbs.length?q.verbs:["read"];
$("fields").innerHTML='<label>Name for this app</label><input type="text" id="name"><label>Workspace</label><input type="text" id="space"><label>What it can do</label><div class="v">'+V.map(v=>'<label><input type="checkbox" name="verb" value="'+v+'"'+(on.includes(v)?" checked":"")+"> "+(v==="dispatch"?"send tasks":v)+"</label>").join("")+'</div><label>${FOLDERS_LABEL}</label><input type="text" id="paths">';
$("name").value=q.name||"";$("space").value=q.space||"main";$("paths").value=(q.paths&&q.paths.length?q.paths:["**"]).join(" ");$("s1").hidden=true;$("s2").hidden=false;msg("")};
const decide=async op=>{off();msg("Sending…");const [s,j]=await post("/device",{op,user_code:$("code").value,admin_key:key(),...picked()});
msg(s===200?(j.state==="approved"?"Approved. Your device finishes signing in on its own; you can close this page.":"Denied."):"Not accepted: "+(j.error_description||j.error));if(s!==200)document.querySelectorAll("button").forEach(b=>b.disabled=false)};
$("ok").onclick=()=>decide("approve");$("no").onclick=()=>decide("deny");`;
// The consent page (phone first, one card; src/auth.ts serves it to a signed-in owner): who wants in and onto which Mac, one big sentence
// of what it gets, three tappable choices with the recommended one picked, one primary button, Deny quiet. More options holds the name,
// workspace and exact access. Approve stays on a summary of what was granted; the app's own callback opens in a new tab.
type ConsentUi = { c: { id: string; name: string; self: boolean; auto?: { redirect: string; host: string; others: string[]; unnamed: boolean } | null }; redirect: string; acct: string; projects: string[]; plan: { name: string; replace: boolean; taken: boolean } | null; machine: string | null; query: string; space: string };
export function consentBody(o: ConsentUi) {
  const { c } = o, app = esc(c.name), base = slug(c.name), folder = "kb/" + base, name = o.plan?.name ?? base;
  const host = (() => { try { return new URL(o.redirect).host || o.redirect; } catch { return o.redirect; } })();
  const runOwn = !!o.projects?.length, initial = esc((String(c.name).match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase());
  const from = /^https:\/\//.test(c.id) ? (() => { try { return new URL(c.id).host; } catch { return ""; } })() : "";
  const preset = (p: string, title: string, line: string) => `<button type="button" class="preset" data-p="${p}" aria-pressed="${p === "tasks"}"><span class="dot"></span><span><b>${title}</b><small>${line}</small></span></button>`;
  return `<div id="form"><div class="hd"><div class="av" aria-hidden="true">${initial}</div><div><h1>${app}${c.self ? ` <span class="pill">unverified name</span>` : ""}</h1><p>wants to connect to <b>your Mac</b>${o.machine ? ` (${esc(o.machine)})` : ""}</p></div></div>
${c.auto ? `<p class="warn" id="sendto">${app} wants to connect. After approving, you'll be sent to <b>${esc(c.auto.host)}</b>.${c.auto.others.length ? ` Another app called ${esc(c.name.replace(/-\d+$/, ""))} connects from ${esc(c.auto.others.join(", "))}: this is a separate connection and gets nothing from that one.` : ""}${c.auto.unnamed ? " It didn't say its name: type one below." : ""}</p>` : ""}
<p class="sum" id="sum">${esc(canSay(c.name, PRESETS.assistant.verbs, PRESETS.assistant.paths))}</p>
<div id="presets" role="radiogroup" aria-label="What ${app} can do">
${preset("tasks", "Read everything, save to shared memory, send tasks (recommended)", "Reads every folder, saves only to shared memory (the shared/ and kb/ folders), and can ask your Mac to run tasks. You approve each one.")}
${preset("folder", "Just this folder", `Reads and edits only <span class="pf">${esc(folder)}</span>. It can't send tasks or see anything else.`)}
${preset("read", "Read only", "Reads every folder. Changes nothing.")}
</div>
<p class="note" id="nmline">It will be called <b id="nmv">${esc(name)}</b>. <button type="button" class="link" id="ren">Rename</button></p>
<div id="renbox"${c.auto?.unnamed ? "" : " hidden"}><label for="name">${c.auto?.unnamed ? "App name" : "Name for this app"}</label><input type="text" id="name" value="${esc(name)}" autocomplete="off"></div>
${o.plan?.replace ? `<label class="chk" id="replbox"><input type="checkbox" id="replace" checked> Replace the old ${esc(name)} connection (it stops working)</label>` : ""}
<details id="adv"><summary>More options</summary>
<label for="folder">The folder</label><input type="text" id="folder" value="${esc(folder)}"><p class="note">One folder and everything inside it, for example <code>kb/notes</code>.</p>
<label for="space">Workspace</label><input type="text" id="space" value="${esc(o.space)}">
<div class="ch">${runOwn ? `<label><input type="radio" name="choice" value="own"> This folder + run tasks on its own in the projects you pick (no asking each time; pushing still asks)</label>` : ""}<label><input type="radio" name="choice" value="full"> Everything: read, edit and delete in every folder</label><label><input type="radio" name="choice" value="custom"> Choose exactly</label></div>
${runOwn ? `<div class="sub" id="ownp" hidden>${o.projects.map(p => `<label class="chk"><input type="checkbox" class="pj" value="${esc(p)}"> ${esc(p)}</label>`).join("")}<label>For <select id="ownexp"><option value="1">1 day</option><option value="7" selected>7 days</option><option value="0">no end date</option></select></label></div>` : ""}
<div class="sub" id="custom" hidden>${exactFields(PRESETS.assistant.verbs, PRESETS.assistant.paths)}</div>
<p class="note">App ID ${esc(c.id)}.</p></details>
<div class="bar"><button id="ok">Approve</button></div><p class="quiet">Signed in${isRoot(o.acct) ? "" : ` as <b>${esc(o.acct)}</b>`} · <button type="button" class="link" id="no">Deny</button></p>
<p class="small">${c.self ? "This app named itself, so the name isn't checked; it gets only what you approve here. " : from ? `This app's details come from ${esc(from)}. ` : ""}After you approve, your browser goes back to ${esc(host)}. You're asked again whenever it connects, unless it's still in Settings, Connected apps.</p></div>
<section class="state" id="st-ok" hidden><div class="big okc" aria-hidden="true">✓</div><h2 id="done">Connected. Go back to ${app}.</h2><p class="sum" id="granted"></p><p class="note" id="finishnote">${app} finishes signing in on its own in the tab that just opened. You can close this page.</p><div class="bar" id="finishbar" hidden><button id="finish">Finish connecting ${app}</button></div><p class="quiet"><a href="/settings#apps">Change what ${app} can do</a></p></section>
<section class="state" id="st-no" hidden><div class="big noc" aria-hidden="true">✕</div><h2>Not connected</h2><p>You said no, so ${app} gets nothing. Returning to ${app}…</p></section>
<section class="state" id="st-err" hidden><div class="big noc" aria-hidden="true">!</div><h2>Not connected</h2><p id="errtext"></p><div class="bar"><button id="errnext">Try again</button></div></section>
<script id="req" type="application/json">${JSON.stringify({ q: o.query, _acct: o.acct, _app: c.name, _base: base, _own: runOwn }).replace(/</g, "\\u003c")}</script>`;
}
export const consentJs = JS_COMMON + `
const R=JSON.parse($("req").textContent),A=R._app,on=()=>document.querySelectorAll("button").forEach(b=>b.disabled=false),_acct=R._acct;
let P="tasks"; /* recommended: the assistant preset (read all, save to shared/ + kb/, send tasks, each one approved) so kb_add and a first task work; "own" = its folder + run on its own, under More options */
const ownp=()=>[...document.querySelectorAll("#ownp input.pj:checked")].map(x=>x.value),own=()=>P==="own"&&R._own;
const fold=()=>$("folder").value.trim().replace(/\\/+$/,"")||"kb/"+R._base;
const say=()=>{const f=fold();if(P==="read")return A+" can read every folder and change nothing. It can't send tasks or push.";if(P==="full")return A+" can read, edit and delete everything. It can't send tasks or push.";
if(P==="custom")return A+" gets exactly what you choose under More options.";if(P==="own")return A+" can read and edit "+f+" and run tasks on its own in "+(ownp().join(", ")||"the projects you pick")+". Pushing still asks you.";if(P==="tasks")return A+" can read every folder and save to shared memory (shared/ and kb/). It can send tasks to your Mac; you approve each one.";
return A+" can read and edit "+f+". It can't send tasks or push."};
const sync=()=>{$("sum").textContent=say();document.querySelectorAll(".preset").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.p===P)));document.querySelectorAll(".pf").forEach(x=>x.textContent=fold());
if($("ownp"))$("ownp").hidden=P!=="own";$("custom").hidden=P!=="custom";document.querySelectorAll("input[name=choice]").forEach(r=>r.checked=r.value===P)};
document.querySelectorAll(".preset").forEach(b=>b.onclick=()=>{P=b.dataset.p;sync()});document.querySelectorAll("input[name=choice]").forEach(r=>r.onchange=()=>{if(r.checked){P=r.value;sync()}});
document.querySelectorAll("#ownp input.pj").forEach(x=>x.onchange=sync);$("folder").oninput=sync;sync();
$("ren").onclick=()=>{$("renbox").hidden=false;$("name").focus()};$("name").oninput=()=>{$("nmv").textContent=$("name").value.trim()};
const body=()=>({oauth_query:R.q,...picked(),replace:$("replace")?$("replace").checked:true,choice:P==="tasks"?"shared":P==="own"?"folder":P,folder:fold(),dispatch:P==="tasks"||P==="own"});
const show=id=>{$("form").hidden=!!id;for(const x of ["st-ok","st-no","st-err"])$(x).hidden=x!==id;msg("");on()};
const fail=(t,label,fn)=>{show("st-err");$("errtext").textContent=t;$("errnext").textContent=label||"Try again";$("errnext").onclick=fn||(()=>show(null))};
// Connected: this tab stays on what was granted. The app's own callback gets the code in a new tab (opened on the Approve tap, so
// it isn't a blocked popup); if popups are off, one tap here finishes it.
const done=(to,granted,tab)=>{show("st-ok");$("granted").textContent=granted||"";if(tab&&!tab.closed){tab.location.href=to;return}
$("done").textContent="Approved. One more tap.";$("finishnote").textContent="Tap below to hand the approval back to "+A+".";$("finishbar").hidden=false;
$("finish").onclick=()=>{const w=window.open(to,"_blank");if(w){$("finishbar").hidden=true;$("done").textContent="Connected. Go back to "+A+".";$("finishnote").textContent=A+" finishes signing in on its own in the new tab. You can close this page."}else location.assign(to)}};
const approve=async()=>{if(own()&&!ownp().length)return msg("Pick at least one project it may run tasks in on its own, or choose another option");
const tab=window.open("","_blank");off();msg("Connecting…");const [s,j]=await post(location.pathname,body());
if(!j.redirect){if(tab)tab.close();on();if(s===401)return fail(j.error_description||j.error,"Sign in",()=>location.reload());return msg("Not connected: "+(j.error_description||j.error))}
if(own()&&j.peer){try{const d=+$("ownexp").value;await OWN.allow(_acct,j.space,j.peer,ownp(),d?Date.now()+d*86400000:null)}catch(e){msg("Connected, but running tasks on its own wasn't saved ("+e.message+"). Set it in Settings, Connected apps.");await new Promise(r=>setTimeout(r,2500))}}
done(j.redirect,j.granted,tab)};
$("ok").onclick=()=>approve();
$("no").onclick=async()=>{off();const [s,j]=await post(location.pathname,{oauth_query:R.q,deny:true});if(j.redirect){show("st-no");setTimeout(()=>location.assign(j.redirect),1200)}else{on();msg(j.error_description||j.error)}};`;
export const pairJs = JS_COMMON + `
const R=JSON.parse($("req").textContent),H="http://127.0.0.1:"+R.port+"/presence";
$("name").oninput=()=>{$("nmv").textContent=$("name").value.trim()};
const access=()=>{const v=(document.querySelector("input[name=acc]:checked")||{}).value||"tasks",n=$("name").value.trim()||R.name;
return v==="read"?{verbs:["read"],paths:["**"]}:v==="folder"?{verbs:["read","write","dispatch"],paths:["kb/"+n.toLowerCase().replace(/[^a-z0-9_-]+/g,"-")+"/**"]}:{verbs:${JSON.stringify(PRESETS.assistant.verbs)},paths:${JSON.stringify(PRESETS.assistant.paths)}}};
const local=async body=>{try{const r=await fetch(H,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"device_grant:"+R.code,...body}),...(body.shortcut?{}:{signal:AbortSignal.timeout(8000)})});return await r.json()}catch(e){return null}};
const go=async body=>{off();msg("Checking on this Mac…");const l=await local(body);
if(l&&!l.ok){on();return msg(l.error||"Not confirmed")}
/* not on the Mac (a phone): the password goes over HTTPS to the Mac, which checks it (remote, Settings switch); else the old ways */
const rem=!l&&R.remote&&typeof body.password==="string";
if(!l&&!rem&&body.shortcut&&R.remote){on();return msg("Fingerprint or face unlock works on your Mac only. Type your master password instead: your Mac checks it.")}
if(!l&&!rem&&!R.signedIn){on();return msg("Your password is checked on your Mac only here (approving from other devices is off, or Kitebook isn't running on this Mac). On your Mac, open this link there, or run: kitebook approve "+R.code)}
if(rem)msg("Checking with your Mac…");
const [s,j]=await post("/device",{op:"approve",user_code:R.code,name:$("name").value.trim()||R.name,...access(),...(l?{presence:l.presence}:rem?{password:body.password,account:R.acct}:{})});
if(rem)$("pw").value="";
if(s!==200){on();return msg("Not connected: "+(j.error_description||j.error))}
$("form").hidden=true;$("st-ok").hidden=false;$("done").textContent="Connected: "+j.name;$("granted").textContent=j.granted||"";msg("")};
const on=()=>document.querySelectorAll("button").forEach(b=>b.disabled=false);
$("pf").onsubmit=e=>{e.preventDefault();if(!$("pw").value)return msg("Type your Kitebook master password, then Enter");go({password:$("pw").value})};
$("tid").onclick=()=>go({shortcut:true});
/* this phone's passkey (src/passkey.ts), offered first when this browser added one; the master password stays below as the fallback */
if(kbPk.on()){$("pkbar").hidden=false;$("pkadd").hidden=true;$("pkok").onclick=async()=>{off();msg("Approve on your phone…");try{const [s0,c]=await post("/device",{op:"passkey_challenge",account:R.acct,action:"device_grant:"+R.code});
if(s0!==200||!c.challenge)throw new Error(c.error_description||"no passkey is set up for approvals here: use your master password");
const [s,j]=await post("/device",{op:"approve",user_code:R.code,account:R.acct,passkey:await kbPk.get(c),name:$("name").value.trim()||R.name,...access()});
if(s!==200)throw new Error("Not connected: "+(j.error_description||j.error));$("form").hidden=true;$("st-ok").hidden=false;$("done").textContent="Connected: "+j.name;$("granted").textContent=j.granted||"";msg("")}catch(e){on();msg(e.message||"Not approved")}}}`;
// enrolling this phone's passkey as an approval device: make it (the phone's PIN / fingerprint / face), then the owner approves its code with
// the master password (typed here, checked by the Mac) or kitebook approve <code> on the Mac; until then it approves nothing
function passkeyBody(acct: string, remote: boolean) {
  return `<div id="form"><h1>Approve from this phone</h1>
<p class="note">Add a passkey on this phone. Afterwards approvals here ask for the phone's own PIN, fingerprint or face. Your master password still works as the fallback.</p>
<label for="pkname">Name</label><input type="text" id="pkname" value="My phone" autocomplete="off">
<div class="bar"><button id="pkmake" type="button">Add passkey</button></div>
<div id="pkappr" hidden><p class="note">Now approve it once. Code <b id="pkcode"></b>.</p>
${remote ? `<form id="pkf"><label for="pw">Your Kitebook master password (checked by your Mac)</label><input type="password" id="pw" autocomplete="current-password"><div class="bar"><button type="submit">Approve</button></div></form>` : ""}
<p class="small">Or on your Mac run: <code>kitebook approve <span id="pkcode2"></span></code>. This page goes on by itself.</p></div></div>
<section class="state" id="st-ok" hidden><div class="big okc" aria-hidden="true">✓</div><h2 id="done">This phone approves with its passkey now.</h2><p class="note">Remove it any time in Settings -> Devices.</p></section>
<script id="req" type="application/json">${JSON.stringify({ acct }).replace(/</g, "\\u003c")}</script>`;
}
export const passkeyJs = JS_COMMON + `
const R=JSON.parse($("req").textContent);let E=null;
const on=()=>document.querySelectorAll("button").forEach(b=>b.disabled=false);
const fin=()=>{localStorage.setItem("kb-approver-passkey","1");$("form").hidden=true;$("st-ok").hidden=false;msg("")};
const poll=async()=>{for(let i=0;i<240&&E;i++){await new Promise(z=>setTimeout(z,2500));const [,s]=await post("/device",{op:"passkey_state",account:R.acct,id:E.id});if(s.state==="active")return fin();if(s.state!=="waiting")return msg("That request "+s.state+"; start again.")}};
$("pkmake").onclick=async()=>{if(!window.PublicKeyCredential)return msg("This browser can't make passkeys.");off();msg("Making the passkey…");
try{const [s,b]=await post("/device",{op:"passkey_begin",account:R.acct,name:$("pkname").value.trim()});if(s!==200)throw new Error(b.error_description||b.error);
const c=await navigator.credentials.create({publicKey:{challenge:kbPk.D(b.challenge),rp:{name:"Kitebook",id:b.rp_id},user:{id:kbPk.D(b.user_id),name:"Kitebook approvals",displayName:$("pkname").value.trim()||"My phone"},
pubKeyCredParams:[{type:"public-key",alg:-7}],authenticatorSelection:{authenticatorAttachment:"platform",userVerification:"required",residentKey:"preferred"},attestation:"none",timeout:60000}});
const spki=c.response.getPublicKey&&c.response.getPublicKey();if(!spki)throw new Error("This browser doesn't give out the passkey's public key; try another browser.");
const [s2,f]=await post("/device",{op:"passkey_finish",account:R.acct,id:b.id,cred_id:kbPk.B(c.rawId),spki:kbPk.B(spki),client_data:kbPk.B(c.response.clientDataJSON)});if(s2!==200)throw new Error(f.error_description||f.error);
E=b;$("pkcode").textContent=f.code;$("pkcode2").textContent=f.code;$("pkappr").hidden=false;$("pkmake").hidden=true;msg("");on();poll()}catch(e){on();msg(e.message||"Not added")}};
if($("pkf"))$("pkf").onsubmit=async e=>{e.preventDefault();if(!$("pw").value||!E)return;off();msg("Checking with your Mac…");const [s,j]=await post("/device",{op:"approve",user_code:$("pkcode").textContent,password:$("pw").value,account:R.acct});$("pw").value="";on();
if(s===200)return fin();msg(j.error_description||j.error||"Not approved")};`;
