// `kitebook open`: the owner's Mac (its runner, op login_link) asks for a single-use 5-minute sign-in link, /start#login=ll.<acct>.<secret>
// (a #fragment, so it is never in a request line or a log; the runner adds &trust=<k> for the browser's signing key, client/settings-sync.ts).
// The page posts it once and that browser gets a Better Auth session (src/auth.ts mintSession). Only hashes of links are stored.
import { sha256 } from "./ops.ts";
export const LOGIN_SCHEMA = "create table if not exists login_links(hash text primary key, expires integer, used integer default 0)";
type D = { sql: SqlStorage; acct: string; env?: any };
const rnd = (n: number) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const ttl = (d: D) => { const v = Number(d.env?.LOGIN_LINK_TTL); return Number.isFinite(v) && v > 0 ? v : 300; };
export const LINK_RE = /^ll\.([a-z0-9][a-z0-9-]{0,30})\.[A-Za-z0-9_-]{20,64}$/;
export const loginFns: Record<string, (d: D, ...a: any[]) => any> = {
  async linkNew(d) { const t = `ll.${d.acct}.${rnd(32)}`, exp = Date.now() + ttl(d) * 1000; d.sql.exec("delete from login_links where expires<?", Date.now() - 86400_000);
    d.sql.exec("insert into login_links values(?,?,0)", await sha256(t), exp); return { token: t, expires: exp }; },
  async linkUse(d, token: string) { // "ok" once; then "used"; "expired" after its 5 minutes; "unknown" otherwise
    const h = await sha256(String(token ?? "")), r = d.sql.exec("select * from login_links where hash=?", h).toArray()[0] as any;
    if (!r) return "unknown"; if (r.used) return "used"; if (r.expires < Date.now()) return "expired";
    return d.sql.exec("update login_links set used=1 where hash=? and used=0", h).rowsWritten ? "ok" : "used"; },
};
