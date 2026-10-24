// The owner's browser session, for /start, /settings, the consent and /device pages and owner-only review pages. Better Auth keeps it
// (src/auth.ts): one HttpOnly SameSite=Lax cookie per account, relay-<acct>.session_token (Secure, as __Secure-…, on https), 30 days,
// sliding. The cookie name routes it to its account's Dir; the Dir's Better Auth checks it. Everything a session can do is a JSON POST
// with a same-origin check, so a cross-site form or link preview can't act on it. /admin never takes a session.
import { SESSION_COOKIE_RE } from "./auth.ts";
import { resolveOwner, registerOwnerProvider, DEFAULT_TENANT, type Owner } from "./principal.ts";
import { DEV_COOKIE_RE } from "./devices.ts";
import { deviceIdp } from "./identity.ts";

// One-time action nonces for the owner's Status-card actions (approve/reject/answer/cancel) and Settings changes: minted for one session,
// used once, 5 min. On top of the cookie + same-origin + JSON checks, so a replayed or scripted request without a fresh nonce decides nothing.
export const ACT_SCHEMA = "create table if not exists act_nonces(hash text primary key, sess text, expires integer)";
export const ACCT_HINT = "relay_acct";

const cookies = (req: Request) => (req.headers.get("cookie") ?? "").split(/;\s*/).filter(Boolean).map(p => { const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1)] as [string, string]; });
// the account name this browser last signed in to (not a secret: on a hosted Kitebook it fills in /start's account for a passkey or a sign-in request)
export const acctHint = (req: Request) => { const v = cookies(req).find(([k]) => k === ACCT_HINT)?.[1] ?? null; return v && /^[a-z0-9][a-z0-9-]{1,30}$/.test(v) ? v : null; };
// the accounts this request carries a session cookie for, each with the cookie header to hand its Dir
export const sessionCookies = (req: Request) => cookies(req).flatMap(([k, v]) => { const m = k.match(SESSION_COOKIE_RE); return m ? [{ acct: m[1], name: k, cookie: `${k}=${v}` }] : []; });
// the owner behind this request's session, or null (src/principal.ts: a device-minted browser session first, then a Better Auth one;
// a hosted module may register more). dir(acct) returns that account's Dir stub. cred: the session id that one-time action nonces and
// the presence window are bound to ("ds:<id>" for a device session).
export async function sessionOwner(req: Request, dir: (acct: string) => any): Promise<Owner | null> { return await resolveOwner(req, dir); }
// the device sessions this request carries (kb-dev-<acct>=kbd.<acct>.<secret>; HttpOnly, SameSite=Strict, set by /open)
export const deviceCookies = (req: Request) => cookies(req).flatMap(([k, v]) => { const m = k.match(DEV_COOKIE_RE); return m && v.startsWith(`kbd.${m[1]}.`) ? [{ acct: m[1], name: k, secret: v }] : []; });
registerOwnerProvider({ name: "device-session", async resolve(req, dir) {
  for (const c of deviceCookies(req)) { const d = dir(c.acct), p = await deviceIdp.verify(d, c.acct, { secret: c.secret }); // src/identity.ts
    if (p.ok) return { acct: c.acct, dir: d, via: "device", cred: "ds:" + p.subject.session, tenant: p.subject.user, device: p.subject.device }; }
  return null; } });
registerOwnerProvider({ name: "better-auth-session", async resolve(req, dir) {
  const origin = new URL(req.url).origin;
  for (const c of sessionCookies(req)) { const d = dir(c.acct), s = await d.baSession(origin, c.cookie).catch(() => null); if (s) return { acct: c.acct, dir: d, via: "session", cred: s.id, tenant: DEFAULT_TENANT, device: null }; }
  return null; } });
const flags = (url: URL) => `HttpOnly; SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}`;
export const setHint = (url: URL, acct: string) => `${ACCT_HINT}=${acct}; Path=/; Max-Age=${365 * 86400}; ${flags(url)}`;
export const clearCookie = (url: URL, name: string) => `${name}=; Path=/; Max-Age=0; ${flags(url)}`;
// a short label ("Mac, Chrome") from the User-Agent; only ever shown to the owner
export const uaLabel = (ua: string | null) => { const u = ua ?? ""; return (/iPhone|iPad/.test(u) ? "iPhone" : /Android/.test(u) ? "Android" : /Mac/.test(u) ? "Mac" : /Windows/.test(u) ? "Windows" : /Linux/.test(u) ? "Linux" : "Browser")
  + ", " + (/Firefox/.test(u) ? "Firefox" : /Edg/.test(u) ? "Edge" : /Chrome|Chromium/.test(u) ? "Chrome" : /Safari/.test(u) ? "Safari" : "browser"); };
// Browsers send Origin on every POST fetch; a mismatch is a cross-site request. Missing Origin (curl, old clients) is allowed
// because without the cookie (which a cross-site request carries only on top-level GETs) nothing session-backed happens.
export const sameOrigin = (req: Request, url: URL) => { const o = req.headers.get("origin"); return !o || o === url.origin; };

// Dir side (d.sql): action nonces, bound to a Better Auth session id
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, "0")).join("");
export const sessionFns = {
  async actNonce(d: { sql: SqlStorage }, sess: string) {
    const n = "an." + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    d.sql.exec("delete from act_nonces where expires<?", Date.now());
    if ((d.sql.exec("select count(*) n from act_nonces where sess=?", sess).one() as any).n >= 50) d.sql.exec("delete from act_nonces where hash in (select hash from act_nonces where sess=? order by expires limit 10)", sess);
    d.sql.exec("insert into act_nonces values(?,?,?)", await sha(n), sess, Date.now() + 5 * 60_000); return n;
  },
  async actUse(d: { sql: SqlStorage }, sess: string, n: string) {
    if (typeof n !== "string" || !n.startsWith("an.") || n.length > 80) return false;
    return d.sql.exec("delete from act_nonces where hash=? and sess=? and expires>?", await sha(n), sess, Date.now()).rowsWritten > 0;
  },
};
