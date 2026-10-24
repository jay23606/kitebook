// Connect by name (connect-any-app, 2026-10-22): an app that only knows this Kitebook's address can sign in with OAuth without registering
// first. /authorize?name=Muse&redirect_uri=...&code_challenge=...&code_challenge_method=S256 (client_id is optional: an unknown plain one (not a 32-letter id Better Auth issued) is
// read as the name; no name at all and the owner types one on the consent page). The first such request registers a public client on the
// fly (no secret, PKCE S256 required, bound to that redirect address, https or loopback only), keyed internally; registering grants
// nothing, the owner still approves on the consent page (with presence), which shows the name and where approving sends the browser.
//   Same name + same redirect again: the same client (a loopback port may change, RFC 8252). Same name, another redirect: a separate
//   client named <name>-2, shown as such, never sharing the first one's grant. 10 new ones per account per hour; unapproved ones go after 15 min.
//   The token endpoint takes the code (or refresh token) without a client_id, or with the name as one: the code tells which client it was
//   issued to (auto_map). The issued client_id rides back on the redirect and the token response, for clients that keep it (spec).
import { normAcct, acctPath } from "../client/account.ts";
import { PAGE_HEADERS, esc } from "./approve.ts";
import { rateHit, slug } from "./oauth.ts";
import { sha256 } from "./ops.ts";

export const NAMED_SCHEMA = `create table if not exists auto_clients(client_id text primary key, name text, name_key text, redirect_uri text, created integer, unnamed integer default 0);
create table if not exists auto_map(hash text primary key, client_id text, expires integer);`;
export const AUTO_TTL = 15 * 60_000, AUTO_PER_HOUR = 10;
const LOOP = ["127.0.0.1", "[::1]", "localhost"];

// where a named app may be sent back to: https anywhere public-looking, or http on this computer (loopback). null = fine.
export function redirectWhy(r: string): string | null {
  let u: URL; try { u = new URL(r); } catch { return "redirect_uri is missing or isn't a full address (https://... or http://127.0.0.1:<port>/...)"; }
  if (u.username || u.password || u.hash) return "redirect_uri must not carry a user, password or #fragment";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && LOOP.includes(u.hostname)) return null;
  return "redirect_uri must be https, or http on this computer (127.0.0.1, [::1] or localhost)";
}
// the redirect an auto client is bound to, for matching: a loopback port is the app's to change each run (RFC 8252 7.3)
export const redirectKey = (r: string) => { try { const u = new URL(r); return LOOP.includes(u.hostname) && u.protocol === "http:" ? `${u.protocol}//${u.hostname}${u.pathname}${u.search}` : u.href; } catch { return r; } };
export const hostOf = (r: string) => { try { return new URL(r).host; } catch { return ""; } };
// the name an app gave (or the owner types): plain text, no controls, 40 chars
export const cleanName = (s: string) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);

// The naming convention (owner, 2026-10-22): an app sends its TYPE (agent: muse, hark, claude...) and its OWN name (name: Luna, Hark);
// the connection is "<agent>-<name>" (muse-luna, hark-hark), lowercase [a-z0-9-], at most 40, deduped -2 when the grant is made. Only one
// of them: that one alone. Never the owner's name.
export const NAME_HOWTO = (o: string) => `To connect: POST ${o}/connect {"agent":"<your type, e.g. muse>","name":"<your own name>"}, show the owner the link it returns, then poll ${o}/token for the token (no client ID, redirect or registration needed). Apps that can take a redirect: ${o}/authorize?agent=<type>&name=<your name>&redirect_uri=...&code_challenge=...&code_challenge_method=S256. Or an app key: Settings → Connected apps → Add an app`;
export const nameSlug = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
export function connName(agent: string, name: string): string {
  const a = nameSlug(agent), n = nameSlug(name);
  return (a && n ? `${a}-${n}` : a || n).slice(0, 40).replace(/-+$/, "");
}
// plain words for a person (a browser) or JSON for a program, same text
export function namedErr(req: Request, status: number, error: string, text: string): Response {
  if (/text\/html/.test(req.headers.get("accept") ?? "")) { const n = crypto.randomUUID().replace(/-/g, "");
    return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kitebook: can't connect</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px"><h1 style="font-size:22px">This app can't connect yet</h1><p>${esc(text)}</p></body>`, { status, headers: PAGE_HEADERS(n) }); }
  return new Response(JSON.stringify({ error, error_description: text }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export const howTo = (o: string) => NAME_HOWTO(o) + ".";

type D = { sql: SqlStorage; acct: string; env: any };
type B = { auth: any; db: any };
const row = (d: D, q: string, ...a: any[]) => d.sql.exec(q, ...a).toArray()[0] as any;
export const autoOf = (d: D, id: string) => id ? row(d, "select * from auto_clients where client_id=?", id) ?? null : null;
async function baClient(b: B, id: string) { return id ? await b.db.selectFrom("oauthClient").select(["clientId", "redirectUris"]).where("clientId", "=", id).executeTakeFirst().catch(() => null) : null; }

// unapproved auto clients (no grant ever made with them) go after 15 minutes
export async function sweepAuto(d: D, b: B, now = Date.now()) {
  const used = new Set((d.sql.exec("select distinct client_id from oauth_families").toArray() as any[]).map(r => r.client_id));
  for (const r of d.sql.exec("select client_id from auto_clients where created<?", now - AUTO_TTL).toArray() as any[]) if (!used.has(r.client_id)) {
    await b.db.deleteFrom("oauthClient").where("clientId", "=", r.client_id).execute().catch(() => {}); d.sql.exec("delete from auto_clients where client_id=?", r.client_id); }
  d.sql.exec("delete from auto_map where expires<?", now);
}

// GET /authorize (or the account's /oauth2/authorize) with a name instead of a registered client: null = not ours (a registered or CIMD client)
export async function namedAuthorize(d: D, b: B, req: Request, url: URL, base: string, scopes: string[], refusal: (m: any) => string | null): Promise<Response | null> {
  const q = url.searchParams, cid = q.get("client_id") ?? "";
  if (/^https?:\/\//.test(cid) || /^rc_/.test(cid)) return null; // a Client ID Metadata Document, or an old client (its own message)
  if (cid && await baClient(b, cid)) return null; // a registered client
  if (/^[A-Za-z]{32}$/.test(cid)) return null; // the shape Better Auth issues: a client that was swept or removed, not a name (its invalid_client tells the app to register again)
  const o = url.origin, red = q.get("redirect_uri") ?? "", why = redirectWhy(red);
  if (why) return namedErr(req, 400, "invalid_request", `${why}. ${howTo(o)}`);
  if (!q.get("code_challenge") || q.get("code_challenge_method") !== "S256") return namedErr(req, 400, "invalid_request", `PKCE is required: send code_challenge with code_challenge_method=S256. ${howTo(o)}`);
  if ((q.get("response_type") ?? "code") !== "code") return namedErr(req, 400, "unsupported_response_type", "response_type must be code");
  const given = connName(q.get("agent") || cid, q.get("name") ?? ""), host = hostOf(red), rk = redirectKey(red);
  const label = given || nameSlug(LOOP.some(h => host.startsWith(h)) ? "app" : host.replace(/^www\./, "").split(".")[0]) || "app", key = label;
  await sweepAuto(d, b);
  let id: string | null = null;
  for (const r of d.sql.exec("select client_id, redirect_uri from auto_clients where name_key=? order by created", key).toArray() as any[])
    if (redirectKey(r.redirect_uri) === rk && await baClient(b, r.client_id)) { id = r.client_id; break; }
  if (!id) {
    const lim = rateHit(d.sql, "autoreg", Number(d.env?.OAUTH_NAMED_PER_HOUR) > 0 ? Number(d.env.OAUTH_NAMED_PER_HOUR) : AUTO_PER_HOUR);
    if (!lim.ok) return namedErr(req, 429, "rate_limited", `Too many new apps tried to connect to this Kitebook in the last hour. Try again in ${Math.ceil(lim.retry_after / 60)} min.`);
    // same name from another address: a separate app, named so (Muse-2), so the owner sees it isn't the Muse already connected
    const n = Number((row(d, "select count(*) as n from auto_clients where name_key=?", key) ?? { n: 0 }).n);
    const shown = n ? `${label}-${n + 1}` : label;
    // the same registration (and policy) as dynamic client registration: public, PKCE, this one redirect
    const body = { client_name: shown, redirect_uris: [red], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: scopes.join(" ") };
    const no = refusal(body); if (no) return namedErr(req, 403, "access_denied", no);
    let c: any; try { c = await b.auth.api.registerOAuthClient({ body }); } catch (e: any) { return namedErr(req, 400, "invalid_request", `couldn't register this app: ${e?.body?.error_description ?? e?.message ?? e}`); }
    id = String(c?.client_id ?? ""); if (!id) return namedErr(req, 500, "server_error", "couldn't register this app");
    d.sql.exec("insert into auto_clients values(?,?,?,?,?,?)", id, shown, key, red, Date.now(), given ? 0 : 1);
  }
  const next = new URLSearchParams(q); next.delete("name"); next.delete("agent"); next.set("client_id", id); next.set("response_type", "code");
  return new Response(null, { status: 302, headers: { location: `${o}${base}/oauth2/authorize?${next}`, "cache-control": "no-store" } });
}

// what the consent page says about an auto client: where approving sends the browser, other apps by that name, whether the owner names it
export function autoInfo(d: D, id: string): { redirect: string; host: string; others: string[]; unnamed: boolean } | null {
  const a = autoOf(d, id); if (!a) return null;
  const others = (d.sql.exec("select redirect_uri from auto_clients where name_key=? and client_id<>?", a.name_key, id).toArray() as any[]).map(r => hostOf(r.redirect_uri)).filter(Boolean);
  return { redirect: a.redirect_uri, host: hostOf(a.redirect_uri), others: [...new Set(others)], unnamed: !!a.unnamed };
}
// the redirect carrying a code back to an auto client: remember which client the code is for, and tell the app its client_id
export async function noteCode(d: D, clientId: string, to: string | undefined): Promise<string | undefined> {
  if (!to || !autoOf(d, clientId)) return to;
  try { const u = new URL(to), code = u.searchParams.get("code"); if (!code) return to;
    d.sql.exec("insert or replace into auto_map values(?,?,?)", await sha256("c:" + code), clientId, Date.now() + 15 * 60_000);
    if (!u.searchParams.has("client_id")) u.searchParams.set("client_id", clientId); return u.href; } catch { return to; }
}
// POST token: a request without a (registered) client_id gets the one its code / refresh token was issued to
export async function namedToken(d: D, b: B, req: Request, refreshTtl: number): Promise<{ req: Request; after: (r: Response) => Promise<Response> }> {
  const same = { req, after: async (r: Response) => r };
  if (/^Basic\s/i.test(req.headers.get("authorization") ?? "")) return same;
  const ct = req.headers.get("content-type") ?? "", isJson = ct.includes("application/json"), raw = await req.clone().text().catch(() => "");
  let p: Record<string, string>; try { p = isJson ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw)); } catch { return same; }
  let cid = String(p.client_id ?? "");
  if (!cid || (!/^https?:\/\//.test(cid) && !await baClient(b, cid))) {
    const k = p.grant_type === "authorization_code" ? "c:" + (p.code ?? "") : p.grant_type === "refresh_token" ? "r:" + (p.refresh_token ?? "") : "";
    const m = k.length > 2 ? row(d, "select client_id from auto_map where hash=? and expires>?", await sha256(k), Date.now()) : null;
    if (m) { cid = m.client_id; p = { ...p, client_id: cid }; }
  }
  if (!autoOf(d, cid)) return { ...same, req: p.client_id === cid ? req : rebuild(req, p, isJson) };
  return { req: rebuild(req, p, isJson), after: async (r: Response) => {
    if (!r.ok) return r; const j: any = await r.clone().json().catch(() => null); if (!j || typeof j !== "object") return r;
    if (j.refresh_token) d.sql.exec("insert or replace into auto_map values(?,?,?)", await sha256("r:" + j.refresh_token), cid, Date.now() + refreshTtl * 1000);
    const h = new Headers(r.headers); h.delete("content-length"); return new Response(JSON.stringify({ ...j, client_id: j.client_id ?? cid }), { status: r.status, headers: h });
  } };
}
const rebuild = (req: Request, p: Record<string, string>, isJson: boolean) => {
  const h = new Headers(req.headers); h.delete("content-length");
  return new Request(req.url, { method: "POST", headers: h, body: isJson ? JSON.stringify(p) : new URLSearchParams(p).toString() });
};

// the short root paths naive clients guess: /authorize, /token, /register (and /u/<acct>/... on a hosted Kitebook) -> the account's Better Auth
export function shortAlias(p: string): { acct: string; path: string } | null {
  const m = p.match(/^(?:\/u\/([a-z0-9][a-z0-9-]{1,30}))?\/(authorize|token|register)$/); if (!m) return null;
  const acct = normAcct(m[1]), base = acctPath(acct, "/api/auth");
  return { acct, path: `${base}/oauth2/${m[2]}` };
}

// ---- Add an app (Settings → Connected apps, kitebook app add): a scoped bearer key for an agent that only has an API-key field ----
// The same three choices as the pairing page; the key is shown once, revocable (Remove), with the same end-date choices as other apps.
export const APP_CHOICES: Record<string, { verbs: string[]; paths: (n: string) => string[]; say: string }> = {
  // the documented assistant preset (oauth.ts PRESETS.assistant): read all, save only to shared memory (shared/** + kb/**), send tasks
  tasks: { verbs: ["read", "write", "dispatch"], paths: () => ["**", "write:shared/**", "write:kb/**"], say: "read everything, save to shared memory (shared/ and kb/), send tasks" },
  read: { verbs: ["read"], paths: () => ["**"], say: "read only" },
  folder: { verbs: ["read", "write", "dispatch"], paths: n => [`kb/${n}/**`], say: "its own folder + send tasks" },
};
export const appPrompt = (mcp: string) => `Build a custom integration to my Kitebook MCP server at ${mcp} (Streamable HTTP). Auth: Authorization: Bearer <key> — ask me for it through your secure credential flow. Test whoami and tools/list, then save it as a skill.`;
