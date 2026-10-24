// Device identity (auth phase "device identity", /workspace auth spec v2): a DEVICE is a machine with Kitebook installed. Its runner makes
// two P-256 keypairs at first start (client/keystore.ts): the device key (no prompt: signs `kitebook open` links, same identity as the
// runner peer) and the presence key (every signature needs the human: Secure Enclave + user-presence ACL, a Keychain item no app may read
// silently, Windows Hello, or a local OS password prompt). The server keeps one row per device and never sees a private key.
//   devices          id, tenant, name, os, pubkey (device key), presence_key, peer (its runner), state active|pending, created, last_seen, revoked
//   device_sessions  a browser session minted by a device (`kitebook open` -> /open): HttpOnly SameSite=Strict cookie kb-dev-<acct>; dies with the device
//   device_jti       single-use ids of open tokens and presence assertions (replay cache)
//   presence_asks    a browser session asked for presence: a short code the owner confirms with `kitebook confirm <code>` on a device
//   presence_ok      the 5-minute presence window a confirmed browser session holds for back-to-back approvals
// The gate (gate()) is on for a tenant from its first owner device on (acct key devices:ever:<tenant>), so an upgrade before the runner
// enrolls changes nothing and revoking every device never turns it off again (re-enroll is approved from the server shell).
import { sha256 } from "./ops.ts";
import { claimStrategy, DEFAULT_TENANT } from "./principal.ts";
export const DEVICE_SCHEMA = `
create table if not exists devices(id text primary key, tenant text not null default '${DEFAULT_TENANT}', name text, os text, pubkey text unique, presence_key text, peer text, state text default 'active', via text, created integer, last_seen integer, revoked integer default 0, password_key text, pw_at integer, pw_via text, pw_reset integer, setup text);
create table if not exists device_sessions(hash text primary key, id text unique, tenant text not null default '${DEFAULT_TENANT}', device text, created integer, last_seen integer, expires integer, ua text, ba text);
create table if not exists device_jti(jti text primary key, expires integer);
create table if not exists presence_asks(id text primary key, tenant text not null default '${DEFAULT_TENANT}', cred text, code text, action text, expires integer, state text);
create table if not exists presence_ok(cred text primary key, tenant text not null default '${DEFAULT_TENANT}', device text, until integer);`;
// master password (owner direction 2026-10-22): a second presence key per device, Argon2id-wrapped by the device's own master password
// (client/password.ts). The server only ever sees its PUBLIC half and verifies signatures with it, exactly like the Touch ID / Windows Hello
// key in presence_key, which is now the optional shortcut. A device with neither key is LOCKED: nothing that grants or widens access works.
//   password_key  the password presence key (p256:...)        pw_at / pw_via  when and how it was set (terminal | setup-link | join | ...)
//   pw_reset      until when the device may set a new password without proving the old one (kitebook owner reset-password, 15 min)
//   setup         {url, expires} of the one-time local setup link a locked install printed, shown in Settings / Get started until it expires
export const DEVICE_MIGRATE = [ // a server from before (the columns are in DEVICE_SCHEMA / JOIN_SCHEMA for a new one)
  "alter table devices add column password_key text", "alter table devices add column pw_at integer", "alter table devices add column pw_via text",
  "alter table devices add column pw_reset integer", "alter table devices add column setup text", "alter table device_joins add column password_key text"];
export const OWNER_VIA = ["first_run", "migrated", "claim"]; // how an owner's own first computer got its row (not a join / a pending runner)
export const PW_RESET_TTL = 15 * 60_000, SETUP_URL_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}\/setup-password#t=[A-Za-z0-9_-]{32,64}$/;
export const KEY_RE = /^p256:[A-Za-z0-9_-]{86,88}$/; // raw uncompressed P-256 point (65 bytes), base64url
export const OPEN_TTL = 60_000, PRESENCE_WINDOW = 5 * 60_000, SESSION_IDLE = 30 * 86400_000, ASSERT_SKEW = 120_000;
export const devCookie = (acct: string) => `kb-dev-${acct}`;
export const DEV_COOKIE_RE = /^kb-dev-([a-z0-9][a-z0-9-]{0,30})$/;
type D = { sql: SqlStorage; acct: string; env?: any; admin?: (cmd: string, a: any) => Promise<any> };
const rnd = (n: number) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const b64d = (s: string) => { const t = String(s).replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(t + "=".repeat((4 - t.length % 4) % 4)), c => c.charCodeAt(0)); };
const te = new TextEncoder();
// ECDSA P-256 / SHA-256, signature as raw r||s (WebCrypto's format; CryptoKit's rawRepresentation)
export async function verifyP256(pub: string, sig: string, msg: string): Promise<boolean> {
  try { if (!KEY_RE.test(pub)) return false; const k = await crypto.subtle.importKey("raw", b64d(pub.slice(5)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const s = b64d(sig); if (s.length !== 64) return false; return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, s, te.encode(msg)); } catch { return false; }
}
// Signed blobs are "<b64url(JSON payload)>.<b64url(sig)>"; the signature covers "<domain>.<b64url(JSON payload)>" so an open token can never
// pass as a presence assertion (or the reverse).
export const OPEN_DOMAIN = "kitebook-open:v1", PRESENCE_DOMAIN = "kitebook-presence:v1";
export function parseSigned(t: string): { p: any; raw: string; sig: string } | null {
  const m = String(t ?? "").match(/^([A-Za-z0-9_-]{10,1200})\.([A-Za-z0-9_-]{80,90})$/); if (!m) return null;
  try { return { p: JSON.parse(new TextDecoder().decode(b64d(m[1]))), raw: m[1], sig: m[2] }; } catch { return null; }
}
const ever = (d: D, tenant: string) => !!d.sql.exec("select 1 from acct where k=?", `devices:ever:${tenant}`).toArray().length;
const row = (d: D, id: string) => d.sql.exec("select * from devices where id=?", String(id ?? "")).toArray()[0] as any;
const setupOf = (r: any) => { try { const s = r.setup ? JSON.parse(r.setup) : null; return s && !r.password_key && s.expires > Date.now() ? s : null; } catch { return null; } };
// presence: any key that can confirm (password or shortcut); locked: neither (a no-terminal install before its human set the password)
const view = (r: any, sessions = 0) => ({ id: r.id, name: r.name, os: r.os, state: r.revoked ? "revoked" : r.state, via: r.via, peer: r.peer, fingerprint: String(r.pubkey).slice(5, 17),
  presence: !!(r.presence_key || r.password_key), password: !!r.password_key, password_at: r.pw_at ?? null, password_via: r.pw_via ?? null, shortcut: !!r.presence_key,
  passkey: r.via === "passkey", locked: r.via !== "passkey" && !r.presence_key && !r.password_key, password_reset: r.pw_reset > Date.now() ? r.pw_reset : null, setup: setupOf(r), created: r.created, last_seen: r.last_seen, sessions });
const useJti = (d: D, jti: string, exp: number) => { d.sql.exec("delete from device_jti where expires<?", Date.now()); try { d.sql.exec("insert into device_jti values(?,?)", jti, exp); return true; } catch { return false; } };
const clean = (s: any, n = 60) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").trim().slice(0, n);

export const deviceFns: Record<string, (d: D, ...a: any[]) => any> = {
  // the runner (its token is the peer) registers this machine. Same keys again = a heartbeat. A revoked device stays revoked.
  // A new row takes the presence keys it is sent (as join does); an existing row never gains one here: adding a key to a device widens what
  // it can approve, so that goes through setPassword / shortcut (proof from a key it has, or the server shell's reset window).
  async enroll(d, a: { peer: string; peerKind: string; name?: string; os?: string; pubkey: string; presence_key?: string; password_key?: string; tenant?: string }) {
    const tenant = a.tenant ?? DEFAULT_TENANT;
    if (!KEY_RE.test(a.pubkey ?? "")) throw new Error("pubkey: p256:<base64url raw point>");
    if (a.presence_key != null && !KEY_RE.test(a.presence_key)) throw new Error("presence_key: p256:<base64url raw point>");
    if (a.password_key != null && !KEY_RE.test(a.password_key)) throw new Error("password_key: p256:<base64url raw point>");
    const cur = d.sql.exec("select * from devices where pubkey=?", a.pubkey).toArray()[0] as any;
    if (cur) {
      if (cur.peer !== a.peer || cur.tenant !== tenant) throw new Error("this device key belongs to another machine");
      if (cur.revoked) return { ...view(cur), note: "this device was revoked; make a new key and have it approved" };
      d.sql.exec("update devices set last_seen=?, name=coalesce(?,name), os=coalesce(?,os) where id=?", Date.now(), a.name ? clean(a.name) : null, a.os ? clean(a.os, 40) : null, cur.id);
      return view(row(d, cur.id));
    }
    const active = Number((d.sql.exec("select count(*) n from devices where tenant=? and state='active' and revoked=0", tenant).one() as any).n);
    const wasEver = ever(d, tenant), how = claimStrategy().decide({ tenant, ever: wasEver, active, peerKind: a.peerKind });
    const id = "dev_" + rnd(9), t = Date.now();
    d.sql.exec("insert into devices(id,tenant,name,os,pubkey,presence_key,password_key,pw_at,pw_via,peer,state,via,created,last_seen) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", id, tenant, clean(a.name || a.peer), clean(a.os, 40), a.pubkey, a.presence_key ?? null,
      a.password_key ?? null, a.password_key ? t : null, a.password_key ? "install" : null, a.peer, how === "owner" ? "active" : "pending", how === "owner" ? (d.sql.exec("select 1 from spaces limit 1").toArray().length ? "migrated" : "first_run") : "join", t, t);
    if (how === "owner") d.sql.exec("insert or replace into acct values(?, '1')", `devices:ever:${tenant}`);
    return view(row(d, id));
  },
  async list(d, tenant = DEFAULT_TENANT) {
    const n = new Map((d.sql.exec("select device, count(*) n from device_sessions where tenant=? and expires>? group by device", tenant, Date.now()).toArray() as any[]).map(r => [r.device, Number(r.n)]));
    return { devices: (d.sql.exec("select * from devices where tenant=? order by created", tenant).toArray() as any[]).map(r => view(r, n.get(r.id) ?? 0)), gate: ever(d, tenant) };
  },
  async get(d, id: string) { const r = row(d, id); return r ? view(r) : null; },
  async tenantOf(d, id: string) { return (row(d, id)?.tenant as string | undefined) ?? null; }, // the user a device belongs to (src/identity.ts)
  async byPeer(d, peer: string) { const r = d.sql.exec("select * from devices where peer=? and revoked=0 order by state='active' desc, created desc limit 1", String(peer ?? "")).toArray()[0] as any; return r ? view(r) : null; },
  async approve(d, id: string) { const r = row(d, id); if (!r || r.revoked) throw new Error("no such device"); if (r.state === "active") return view(r);
    d.sql.exec("update devices set state='active' where id=?", r.id); d.sql.exec("insert or replace into acct values(?, '1')", `devices:ever:${r.tenant}`); return view(row(d, r.id)); },
  async rename(d, id: string, name: string) { const r = row(d, id); if (!r) throw new Error("no such device"); const n = clean(name); if (!n) throw new Error("name: 1-60 characters");
    d.sql.exec("update devices set name=? where id=?", n, r.id); return view(row(d, r.id)); },
  // never gated (the safe direction): the device's browser sessions and presence windows end now; the caller ends its runner token and
  // the Better Auth sessions it minted (returned as ba)
  async revoke(d, id: string) { const r = row(d, id); if (!r) throw new Error("no such device");
    const ba = (d.sql.exec("select ba from device_sessions where device=? and ba is not null", r.id).toArray() as any[]).map(x => String(x.ba));
    d.sql.exec("update devices set revoked=1 where id=?", r.id); d.sql.exec("delete from device_sessions where device=?", r.id); d.sql.exec("delete from presence_ok where device=?", r.id);
    return { ...view(row(d, r.id)), ba, peer: r.peer }; },
  // the server shell's way back in after every device was revoked or lost: approve a waiting device even with the gate on (ADMIN_TOKEN)
  // ---- `kitebook open`: the device's one-time token -> a browser session tied to that device ----
  // t = signed {v:1, k:"open", a:<acct>, d:<device>, j:<jti>, e:<exp ms>, n:sha256(<CLI nonce>)}; "ok" once, else bad|used|expired|nonce|device
  async openUse(d, t: string, nonce: string): Promise<{ state: string; device?: any }> {
    const s = parseSigned(t); if (!s || s.p?.v !== 1 || s.p.k !== "open" || s.p.a !== d.acct || typeof s.p.j !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(s.p.j)) return { state: "bad" };
    const r = row(d, s.p.d); if (!r || r.revoked || r.state !== "active") return { state: "device" };
    if (!await verifyP256(r.pubkey, s.sig, `${OPEN_DOMAIN}.${s.raw}`)) return { state: "bad" };
    const exp = Number(s.p.e), t0 = Date.now(); if (!(exp > 0) || exp - t0 > OPEN_TTL + 5000) return { state: "bad" }; // never longer-lived than 60 s
    if (!useJti(d, "o:" + s.p.j, Math.max(exp, t0) + 600_000)) return { state: "used" };
    if (exp < t0) return { state: "expired" };
    if (typeof nonce !== "string" || nonce.length < 16 || nonce.length > 128 || await sha256(nonce) !== s.p.n) return { state: "nonce" }; // burned too: the token works once, right or wrong
    d.sql.exec("update devices set last_seen=? where id=?", t0, r.id);
    return { state: "ok", device: view(r) };
  },
  async sessNew(d, device: string, ua: string, ba: string | null) { const r = row(d, device); if (!r || r.revoked || r.state !== "active") throw new Error("no such device");
    const secret = `kbd.${d.acct}.${rnd(32)}`, id = "ds_" + rnd(9), t = Date.now();
    d.sql.exec("delete from device_sessions where expires<?", t);
    d.sql.exec("insert into device_sessions values(?,?,?,?,?,?,?,?,?)", await sha256(secret), id, r.tenant, r.id, t, t, t + SESSION_IDLE, clean(ua, 200), ba); return { secret, id, max_age: SESSION_IDLE / 1000 }; },
  async sessGet(d, secret: string) { if (!/^kbd\.[a-z0-9-]+\.[A-Za-z0-9_-]{40,50}$/.test(secret ?? "")) return null;
    const h = await sha256(secret), t = Date.now(), s = d.sql.exec("select s.*, v.name dname from device_sessions s join devices v on v.id=s.device where s.hash=? and s.expires>? and v.revoked=0 and v.state='active'", h, t).toArray()[0] as any;
    if (!s) return null; if (t - s.last_seen > 60_000) d.sql.exec("update device_sessions set last_seen=?, expires=? where hash=?", t, t + SESSION_IDLE, h); // sliding, written at most once a minute
    return { id: s.id, device: s.device, tenant: s.tenant, name: s.dname }; },
  async sessEnd(d, secret: string) { const h = await sha256(String(secret ?? "")), s = d.sql.exec("select id, ba from device_sessions where hash=?", h).toArray()[0] as any; if (!s) return null;
    d.sql.exec("delete from device_sessions where hash=?", h); d.sql.exec("delete from presence_ok where cred=?", "ds:" + s.id); return { id: s.id, ba: s.ba }; },
  // ---- the presence gate ----
  // assertion = signed {v:1, k:"presence", a:<acct>, d:<device>, act:<action>, c:<random>, t:<ms>} by the device's PRESENCE key, single use, ±2 min
  async assert(d, assertion: string, action: string, peer?: string | null): Promise<{ ok: boolean; why?: string; device?: string; by?: string }> {
    const s = parseSigned(assertion); if (!s || s.p?.v !== 1 || s.p.k !== "presence" || s.p.a !== d.acct || typeof s.p.c !== "string" || s.p.c.length < 16) return { ok: false, why: "not a presence assertion" };
    const r = row(d, s.p.d); if (!r || r.revoked || r.state !== "active") return { ok: false, why: "the device that signed it isn't an active owner device" };
    if (!r.presence_key && !r.password_key) return { ok: false, why: "that device is locked: it has no master password yet (kitebook password set on it, or its setup link)" };
    if (peer != null && r.peer !== peer) return { ok: false, why: "signed by another machine's device key" };
    if (s.p.act !== action) return { ok: false, why: `it confirms "${clean(s.p.act, 80)}", not "${action}"` };
    if (Math.abs(Date.now() - Number(s.p.t)) > ASSERT_SKEW) return { ok: false, why: "too old (presence confirmations last 2 minutes); confirm again" };
    // any active presence key of the device: the master password key, or the optional Touch ID / Windows Hello shortcut
    let by = ""; for (const [k, n] of [[r.password_key, "password"], [r.presence_key, "shortcut"]]) if (k && await verifyP256(k, s.sig, `${PRESENCE_DOMAIN}.${s.raw}`)) { by = n; break; }
    if (!by) return { ok: false, why: "bad signature" };
    if (!useJti(d, "p:" + s.p.c, Date.now() + 2 * ASSERT_SKEW)) return { ok: false, why: "already used" };
    return { ok: true, device: r.id, by };
  },
  // ---- the master password key (client/password.ts) ----
  // set or replace it. Proof needed: a presence assertion from a key the device already has (action device_password:<first 16 of the new
  // key>), unless the device is the owner's own first computer with no key at all (a locked install: its setup link or terminal sets the
  // first one) or the server shell / another trusted device opened a reset window (resetPassword). A computer that JOINED without a
  // password (a cloud VM that only runs agents) can't give itself one: that would let anything holding its runner token turn it into an
  // approver; the owner allows it from another device first (the same reset window). The residual risk of the locked first computer
  // (anything holding its runner token could set it first) is why pw_via and pw_at are shown in Settings: "set from the setup link at 03:12".
  async setPassword(d, a: { peer: string; password_key: string; via?: string; presence?: string | null }) {
    const r = d.sql.exec("select * from devices where peer=? and revoked=0 order by state='active' desc, created desc limit 1", String(a.peer ?? "")).toArray()[0] as any;
    if (!r) throw new Error("this machine isn't enrolled as a device yet (start its runner once)");
    if (!KEY_RE.test(a.password_key ?? "")) throw new Error("password_key: p256:<base64url raw point>");
    if (r.password_key === a.password_key) return view(r);
    const none = !r.presence_key && !r.password_key, open = none && OWNER_VIA.includes(r.via), reset = Number(r.pw_reset) > Date.now();
    if (none && !open && !reset) throw new Error(`this computer joined without a master password, so it can't give itself one: allow it from one of your other computers first (Settings -> Devices -> Allow a password, or kitebook devices reset-password ${r.id}), then run kitebook password set on it within 15 minutes`);
    if (!open && !reset) {
      if (!a.presence) throw new Error("changing the master password needs the old one (or your Touch ID / Windows Hello shortcut): kitebook password change");
      const g = await deviceFns.assert(d, a.presence, `device_password:${a.password_key.slice(5, 21)}`, r.peer); if (!g.ok) throw new Error("presence refused: " + g.why);
    }
    const via = clean(a.via ?? "terminal", 20) || "terminal";
    d.sql.exec("update devices set password_key=?, pw_at=?, pw_via=?, pw_reset=null, setup=null where id=?", a.password_key, Date.now(), reset ? via + " (after reset)" : via, r.id);
    return view(row(d, r.id));
  },
  // forgotten password: drops the device's password key and lets it set a new one for 15 minutes without the old one. Called from the
  // server shell (ADMIN_TOKEN: kitebook owner reset-password) or from another trusted device (presence-gated by the caller, src/index.ts).
  // The Touch ID shortcut, if on, stays (it still confirms meanwhile).
  async resetPassword(d, id: string) { const r = row(d, id); if (!r || r.revoked) throw new Error("no such device");
    const until = Date.now() + PW_RESET_TTL; d.sql.exec("update devices set password_key=null, pw_reset=? where id=?", until, r.id); return { ...view(row(d, r.id)), reset_until: until }; },
  // the optional shortcut. Off is never gated (the safe direction); on needs a presence assertion from the master password key (the
  // baseline comes first: a device without a master password can't add a shortcut)
  async shortcut(d, a: { peer: string; on: boolean; presence_key?: string; presence?: string | null; id?: string }) {
    const r = a.id ? row(d, a.id) : d.sql.exec("select * from devices where peer=? and revoked=0 order by state='active' desc, created desc limit 1", String(a.peer ?? "")).toArray()[0] as any;
    if (!r || r.revoked) throw new Error("no such device");
    if (!a.on) { d.sql.exec("update devices set presence_key=null where id=?", r.id); return view(row(d, r.id)); }
    if (a.id && r.peer !== a.peer) throw new Error("a shortcut is turned on from that computer itself (kitebook password shortcut on)");
    if (!KEY_RE.test(a.presence_key ?? "")) throw new Error("presence_key: p256:<base64url raw point>");
    if (!r.password_key) throw new Error("set a master password on this computer first (kitebook password set); Touch ID / Windows Hello is only a shortcut next to it");
    const g = await deviceFns.assert(d, String(a.presence ?? ""), `device_shortcut:${a.presence_key!.slice(5, 21)}`, r.peer); if (!g.ok) throw new Error("presence refused: " + g.why);
    d.sql.exec("update devices set presence_key=? where id=?", a.presence_key, r.id); return view(row(d, r.id));
  },
  // the setup link a locked install printed (http://127.0.0.1:<port>/setup-password#t=...), shown in Settings / Get started until it expires
  async setupLink(d, a: { peer: string; url: string; expires: number }) {
    const r = d.sql.exec("select * from devices where peer=? and revoked=0 order by created desc limit 1", String(a.peer ?? "")).toArray()[0] as any;
    if (!r) throw new Error("this machine isn't enrolled as a device yet (start its runner once)");
    if (r.password_key) return view(r);
    if (!SETUP_URL_RE.test(String(a.url ?? ""))) throw new Error("url: http://127.0.0.1:<port>/setup-password#t=<token>");
    const exp = Math.min(Number(a.expires) || 0, Date.now() + PW_RESET_TTL + 60_000);
    d.sql.exec("update devices set setup=? where id=?", JSON.stringify({ url: a.url, expires: exp }), r.id); return view(row(d, r.id));
  },
  async enforced(d, tenant = DEFAULT_TENANT) { return ever(d, tenant); },
  // gate: ok when the tenant has no owner device yet (nothing to confirm with), or a fresh assertion for exactly this action, or this
  // browser session's 5-minute window. need: true = ask the human (presence_ask -> kitebook confirm <code>).
  async gate(d, a: { tenant?: string; cred?: string | null; action: string; presence?: string | null; peer?: string | null }) {
    const tenant = a.tenant ?? DEFAULT_TENANT; if (!ever(d, tenant)) return { ok: true, why: "no owner device yet" };
    if (a.presence) { const r = await deviceFns.assert(d, a.presence, a.action, a.peer ?? null); return r.ok ? { ok: true } : { ok: false, need: true, why: r.why }; }
    if (a.cred) { const w = d.sql.exec("select p.until from presence_ok p join devices v on v.id=p.device where p.cred=? and p.tenant=? and p.until>? and v.revoked=0", a.cred, tenant, Date.now()).toArray()[0]; if (w) return { ok: true }; }
    return { ok: false, need: true, why: "confirm on one of your devices first" };
  },
  async ask(d, a: { tenant?: string; cred: string; action: string }) {
    const t = Date.now(), A = "BCDFGHJKMNPQRSTVWXZ", code = [...crypto.getRandomValues(new Uint8Array(6))].map(b => A[b % A.length]).join(""), id = "pa_" + rnd(12);
    d.sql.exec("delete from presence_asks where expires<?", t - 600_000);
    if (Number((d.sql.exec("select count(*) n from presence_asks where cred=? and state='open' and expires>?", a.cred, t).one() as any).n) >= 5) throw new Error("too many open confirmations; finish or wait for one");
    d.sql.exec("insert into presence_asks values(?,?,?,?,?,?, 'open')", id, a.tenant ?? DEFAULT_TENANT, a.cred, code, clean(a.action, 120), t + PRESENCE_WINDOW);
    return { id, code, action: clean(a.action, 120), expires: t + PRESENCE_WINDOW };
  },
  async askState(d, cred: string, id: string) { const r = d.sql.exec("select state, expires from presence_asks where id=? and cred=?", String(id ?? ""), cred).toArray()[0] as any;
    return { state: !r ? "unknown" : r.state === "open" && r.expires < Date.now() ? "expired" : r.state }; },
  // the same, confirmed by a phone's passkey (src/passkey.ts verify checked the assertion for confirm:<code> first, in src/start.ts)
  async confirmBy(d, a: { code: string; device: string }) {
    const code = String(a.code ?? "").toUpperCase(), q = d.sql.exec("select * from presence_asks where code=? and state='open' and expires>?", code, Date.now()).toArray()[0] as any;
    if (!q) throw new Error(`nothing waits for confirmation with code ${code || "?"}`);
    d.sql.exec("update presence_asks set state='confirmed' where id=?", q.id); d.sql.exec("insert or replace into presence_ok values(?,?,?,?)", q.cred, q.tenant, a.device, Date.now() + PRESENCE_WINDOW);
    return { confirmed: q.action, code, until: Date.now() + PRESENCE_WINDOW };
  },
  async askOf(d, cred: string, id: string) { const r = d.sql.exec("select code, action from presence_asks where id=? and cred=? and state='open' and expires>?", String(id ?? ""), cred, Date.now()).toArray()[0] as any; return r ? { code: r.code, action: r.action } : null; },
  async pending(d, tenant = DEFAULT_TENANT) { return (d.sql.exec("select code, action, expires from presence_asks where tenant=? and state='open' and expires>? order by expires", tenant, Date.now()).toArray() as any[]); },
  // `kitebook confirm <code>` on a device: its presence assertion (action "confirm:<CODE>") opens the asking session's 5-minute window
  async confirm(d, a: { code: string; presence: string; peer: string }) {
    const code = String(a.code ?? "").toUpperCase(), q = d.sql.exec("select * from presence_asks where code=? and state='open' and expires>?", code, Date.now()).toArray()[0] as any;
    if (!q) throw new Error(`nothing waits for confirmation with code ${code || "?"}`);
    const r = await deviceFns.assert(d, a.presence, `confirm:${code}`, a.peer); if (!r.ok) throw new Error("presence refused: " + r.why);
    d.sql.exec("update presence_asks set state='confirmed' where id=?", q.id);
    d.sql.exec("insert or replace into presence_ok values(?,?,?,?)", q.cred, q.tenant, r.device, Date.now() + PRESENCE_WINDOW);
    return { confirmed: q.action, code, until: Date.now() + PRESENCE_WINDOW };
  },
};
