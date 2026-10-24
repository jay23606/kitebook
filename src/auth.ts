// Owner sign-in and app sign-in (OAuth 2.1) on Better Auth, one instance per account Dir, on that Dir's own SQLite (docs/AUTH-ARCHITECTURE.md).
//   Better Auth owns the protocol: the owner's browser session (30 days, sliding; one cookie relay-<acct>.session_token), passkeys
//   (@better-auth/passkey), OAuth 2.1 + PKCE + refresh rotation + RFC 7009 revoke (@better-auth/mcp on @better-auth/oauth-provider),
//   Client ID Metadata Documents (@better-auth/cimd) with dynamic client registration as the fallback for clients that don't do CIMD yet.
//   Kitebook keeps the policy: the consent page (3 presets) writes a grant (an oauth_families row: the app's peer, its space, its verbs),
//   and every /mcp, /v1, WebSocket and events call checks that grant live (src/index.ts -> Dir.authJwt), so removing an app stops its
//   still-valid access token at once. Better Auth's own consent memory is switched off (its consent row is deleted as soon as the code is
//   issued): an app is asked about every time, unless it has a grant the owner can see (and remove) in Settings.
// Paths: self-host (account root) = /api/auth/*, /consent, /mcp. Hosted accounts get their own issuer: /u/<acct>/api/auth/*, /u/<acct>/consent,
// /u/<acct>/mcp (one Better Auth per account Dir, so one account's keys, clients and sessions never mix with another's).
// Owner sign-in has three ways, all ending in the same Better Auth session (minted by relayMint below, never reachable from outside):
//   kitebook open on the Mac (a single-use 5-minute /start#login= link from the runner), a passkey, or a sign-in request approved with
//   kitebook approve <code> on the Mac (or from a browser already signed in). The recovery code only bootstraps a hosted account.
import { ROOT_ACCOUNT, ACCT_SRC, acctPath, isRoot } from "../client/account.ts";
import { deviceFns } from "./devices.ts";
import { deviceCookies } from "./session.ts";
import type { Kysely } from "kysely";
import { decodeJwt } from "jose";
import { GrantTokens } from "./auth-grants.ts";
type Lib = typeof import("./auth-lib.ts"); // the Better Auth stack, imported on first use (ba() below)
let LIB: Promise<Lib> | null = null;
const lib = () => LIB ??= import("./auth-lib.ts");
import { sha256 } from "./ops.ts";
import * as DL from "./devlog.ts";
import { privateIp, resolvesPublic } from "./events.ts";
import { PAGE_HEADERS, esc } from "./approve.ts";
import { OWNER_JS } from "./policy-ui.ts";
import { NAMED_SCHEMA, namedAuthorize, namedToken, noteCode, autoInfo, sweepAuto, cleanName } from "./named.ts";
import { OAUTH_FNS, killFamily, grantSummary, knobs, rateHit, authPage, consentBody, consentJs, slug, VERBS } from "./oauth.ts";

export const OWNER_EMAIL = "owner@relay.invalid"; // one owner per account; Better Auth wants an email-shaped id (no email feature is ever on)
const ACCT = ACCT_SRC;
export const authBase = (acct: string) => acctPath(acct, "/api/auth");
export const mcpPath = (acct: string) => acctPath(acct, "/mcp");
const consentPath = (acct: string) => acctPath(acct, "/consent");
export const startPath = (acct: string) => acctPath(acct, "/start"); // signed out: Better Auth sends the browser here, with its signed request
// which account a path or a token belongs to (hosted: /u/<acct>/...; self-host: root)
export const acctOfPath = (p: string) => p.match(new RegExp(`^(?:/\\.well-known/oauth-[a-z-]+)?/u/(${ACCT})/`))?.[1] ?? ROOT_ACCOUNT;
export function jwtAcct(token: string): string | null {
  try { const iss = String(decodeJwt(token).iss ?? ""); const m = new URL(iss).pathname.match(new RegExp(`^/u/(${ACCT})/api/auth$`)); return m ? m[1] : new URL(iss).pathname === "/api/auth" ? ROOT_ACCOUNT : null; } catch { return null; }
}
export const looksJwt = (t: string | null | undefined) => !!t && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t);
// the owner's Better Auth session cookie(s) on this request: [acct, cookie header part]
export const SESSION_COOKIE_RE = new RegExp(`^(?:__Secure-)?relay-(${ACCT})\\.session_token$`);
const json = (b: any, status = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...h } });
const rnd = (n: number) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Scopes an MCP client may ask for. The scope string decides nothing (the grant does); older clients' saved scopes stay accepted ("relay" from before the Kitebook rename).
const SCOPES = ["openid", "profile", "offline_access", "kitebook", "relay", "preset:assistant", "preset:coding_agent", "preset:runner", "read", "write", "delete", "dispatch"];

type D = { sql: SqlStorage; acct: string; env: any; ctx: DurableObjectState; admin(cmd: string, a: any): Promise<any>; space(id: string): any };
type BA = { auth: any; db: Kysely<any>; origin: string; mint: string; L: Lib };
const cache = new WeakMap<object, { origin: string; p: Promise<BA> }>();

const meta = (d: D, k: string, make: () => string) => { // generated once and kept in this Dir (a self-hoster configures no secret)
  const r = d.sql.exec("select v from acct where k=?", "ba:" + k).toArray()[0] as any; if (r) return r.v as string;
  const v = make(); d.sql.exec("insert into acct values(?,?)", "ba:" + k, v); return v;
};

// CIMD: the server fetches the client's metadata document (its https client_id). That fetch must never reach this Kitebook's own network:
// https only, a public host name (no localhost/.local/.internal, no private or loopback IP literal), every address it resolves to public
// (DNS over HTTPS, the same guard as event webhooks), no redirects followed. On Workers the platform adds its own; on workerd self-host
// the config's public-only outbound network is a second wall. KITEBOOK_EVENTS_TEST=1 (smoke only): https://*.test documents are answered here.
export async function cimdUrlOk(raw: string, testMode: boolean): Promise<string | null> {
  let u: URL; try { u = new URL(raw); } catch { return "not a URL"; }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (u.protocol !== "https:") return "must be https";
  if (u.username || u.password) return "must not carry credentials";
  if (testMode && host.endsWith(".test")) return null;
  if (host === "localhost" || /(^|\.)(localhost|local|internal|localdomain|home\.arpa|test|invalid|example)$/.test(host) || (!host.includes(".") && !host.includes(":"))) return "not a public host";
  if ((/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) && privateIp(host)) return "a private or loopback address";
  if (!await resolvesPublic(u, { allowLoopback: false })) return "resolves to a private or loopback address (or doesn't resolve)";
  return null;
}
function cimdFetch(d: D) {
  const test = d.env?.EVENTS_ALLOW_LOOPBACK === "1";
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" || input instanceof URL ? String(input) : input.url, why = await cimdUrlOk(href, test);
    if (why) { d.sql.exec("insert or replace into acct values('ba:cimd_refused',?)", JSON.stringify({ url: href.slice(0, 200), why, at: Date.now() })); return new Response("refused: " + why, { status: 400 }); }
    const u = new URL(href);
    if (test && u.hostname.endsWith(".test")) { // smoke: a CIMD client served in-process (redirect from the document's own name)
      const doc = { client_id: u.href, client_name: decodeURIComponent(u.pathname.split("/").pop()!.replace(/\.json$/, "")) || "CIMD Test Client", client_uri: u.origin, redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
      return new Response(JSON.stringify(doc), { headers: { "content-type": "application/json", "cache-control": "max-age=300" } });
    }
    const r = await fetch(input as any, { ...init, redirect: "manual", signal: AbortSignal.timeout(5000) });
    return r.status >= 300 && r.status < 400 ? new Response("redirect refused", { status: 502 }) : r;
  };
}

function options(d: D, origin: string, db: Kysely<any>, mint: string, L: Lib) {
  const { createAuthEndpoint, APIError, setSessionCookie, kyselyAdapter, jwt, passkey, mcp, cimd } = L;
  const host = new URL(origin).hostname, base = authBase(d.acct), k = knobs(d.env), dcr = k.dcrMode !== "off";
  // the one internal way to start a session: /start (kitebook open link, kitebook approve, recovery code, hosted signup) asks this Dir, and the Dir
  // calls this endpoint in-process with its own secret. Dir.fetch refuses the path from outside.
  const relay = () => ({ id: "relay", endpoints: {
    relayMint: createAuthEndpoint("/relay/mint", { method: "POST" }, async (ctx: any) => {
      if (ctx.headers?.get("x-relay-mint") !== mint) throw new APIError("FORBIDDEN", { message: "internal" });
      const ia = ctx.context.internalAdapter;
      const user = (await ia.findUserByEmail(OWNER_EMAIL))?.user ?? await ia.createUser({ email: OWNER_EMAIL, name: "Kitebook owner", emailVerified: true });
      const session = await ia.createSession(user.id);
      await setSessionCookie(ctx, { session, user });
      return ctx.json({ ok: true, session: session.id });
    }) } });
  return {
    appName: "Kitebook", baseURL: origin, basePath: base, secret: meta(d, "secret", () => rnd(32)),
    database: kyselyAdapter(db, { type: "sqlite" }), trustedOrigins: [origin],
    telemetry: { enabled: false }, logger: { level: "error" }, // sqlite keeps string[] columns as JSON TEXT; the schema check warns about it on every start
    session: { expiresIn: 30 * 86400, updateAge: 86400 }, // 30 days, sliding: a browser used once a month stays signed in
    advanced: { cookiePrefix: `relay-${d.acct}`, ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    // dynamic client registration per IP per hour (Cloudflare sets cf-connecting-ip; local dev shares one bucket); the rest is unlimited
    rateLimit: { enabled: true, window: 60, max: 600, customRules: { "/oauth2/register": { window: 3600, max: k.dcrIp }, "/oauth2/token": { window: 60, max: 300 }, "/oauth2/authorize": { window: 60, max: 300 }, "/oauth2/consent": { window: 60, max: 300 }, "/oauth2/revoke": { window: 60, max: 300 } } },
    plugins: [
      jwt({ jwt: { issuer: origin + base } }),
      passkey({ rpID: host, rpName: "Kitebook", origin }),
      mcp({ loginPage: startPath(d.acct), consentPage: consentPath(d.acct), resource: origin + mcpPath(d.acct), scopes: SCOPES,
        grantTypes: ["authorization_code", "refresh_token"], accessTokenExpiresIn: k.accessTtl, refreshTokenExpiresIn: k.refreshTtl,
        customTokenResponseFields: ({ grantType }: any) => grantType === "client_credentials" ? {} : { refresh_token_expires_in: k.refreshTtl }, // each rotation starts a fresh 30 days
        allowDynamicClientRegistration: dcr, allowUnauthenticatedClientRegistration: dcr, clientRegistrationDefaultApplicationType: "infer" } as any),
      cimd({ fetchClientMetadataResource: cimdFetch(d), metadataProfile: "mcp-2026-07-28" } as any),
      relay(),
    ],
  } as any;
}

// Migrate first, then construct: Better Auth checks the schema once per adapter and caches a mismatch, so it must never see an empty DB.
// One instance per (Dir, origin); every request waits for the one-time migration.
export function ba(d: D, origin: string): Promise<BA> {
  const c = cache.get(d); if (c && c.origin === origin) return c.p;
  const p = (async () => {
    const L = await lib(), db = new L.Kysely<any>({ dialect: new L.DurableObjectSqliteDialect(d.ctx.storage.sql as any) }), mint = rnd(24), opts = options(d, origin, db, mint, L);
    await (await L.getMigrations({ ...opts, database: { db, type: "sqlite" } })).runMigrations(); // migrations want the raw Kysely; runtime uses the adapter
    return { auth: L.betterAuth(opts), db, origin, mint, L };
  })();
  p.catch(() => cache.delete(d)); cache.set(d, { origin, p }); return p;
}

// ---------- Dir side ----------
// a new owner session: the Set-Cookie headers for it (never leaves this Dir except as those headers)
export async function mintSession(d: D, origin: string, ua?: string): Promise<string[]> {
  const b = await ba(d, origin), r = await b.auth.handler(new Request(origin + authBase(d.acct) + "/relay/mint", { method: "POST", headers: { "x-relay-mint": b.mint, origin, "content-type": "application/json", ...(ua ? { "user-agent": ua } : {}) }, body: "{}" }));
  if (!r.ok) throw new Error("couldn't start a session: " + r.status);
  return r.headers.getSetCookie();
}
export async function sessionOf(d: D, origin: string, cookie: string): Promise<{ id: string; user: string } | null> {
  if (!cookie) return null; const b = await ba(d, origin);
  const s = await b.auth.api.getSession({ headers: new Headers({ cookie }) }).catch(() => null);
  return s?.session ? { id: s.session.id, user: s.user.id } : null;
}
export async function sessionEnd(d: D, origin: string, a: { id?: string; cookie?: string }) {
  const b = await ba(d, origin); let id = a.id;
  if (!id && a.cookie) id = (await sessionOf(d, origin, a.cookie))?.id;
  if (!id) return false;
  const n = await b.db.deleteFrom("session").where("id", "=", id).executeTakeFirst();
  d.sql.exec("delete from act_nonces where sess=?", id);
  return Number(n.numDeletedRows ?? 0) > 0;
}
const uaLabel = (u: string) => (/iPhone|iPad/.test(u) ? "iPhone" : /Android/.test(u) ? "Android" : /Mac/.test(u) ? "Mac" : /Windows/.test(u) ? "Windows" : /Linux/.test(u) ? "Linux" : "Browser")
  + ", " + (/Firefox/.test(u) ? "Firefox" : /Edg/.test(u) ? "Edge" : /Chrome|Chromium/.test(u) ? "Chrome" : /Safari/.test(u) ? "Safari" : "browser");
// Settings, Devices & passkeys: the browsers signed in (Better Auth sessions), the passkeys, and whether an old passkey from before the
// update needs adding again (passkeys can't be carried over: a different credential store and user handle)
export async function devices(d: D, origin: string, mine: string) {
  const b = await ba(d, origin), now = new Date();
  const ss = await b.db.selectFrom("session").select(["id", "userAgent", "createdAt", "updatedAt", "expiresAt"]).orderBy("updatedAt", "desc").execute();
  const pk = await b.db.selectFrom("passkey").select(["id", "name", "createdAt"]).orderBy("createdAt").execute();
  let legacy = 0; try { legacy = Number((d.sql.exec("select count(*) n from passkeys").one() as any).n); } catch {} // the table only exists on Kitebook servers from before
  const iso = (x: any) => new Date(x).toISOString();
  return { devices: ss.filter((s: any) => new Date(s.expiresAt) > now).map((s: any) => ({ id: s.id, label: uaLabel(String(s.userAgent ?? "")), created: iso(s.createdAt), last: iso(s.updatedAt), expires: Date.parse(iso(s.expiresAt)), this: s.id === mine })),
    passkeys: pk.map((p: any) => ({ id: p.id, label: p.name || "Passkey", created: iso(p.createdAt) })), readd_passkey: legacy > 0 && pk.length === 0 };
}
export async function passkeyRemove(d: D, origin: string, id: string) {
  const b = await ba(d, origin), r = await b.db.deleteFrom("passkey").where("id", "=", String(id ?? "")).executeTakeFirst(); return Number(r.numDeletedRows ?? 0) > 0;
}
// After the owner removes an app (or it ends itself): Better Auth's refresh tokens and consent for that client go too, so the next sign-in asks again.
export async function forgetClient(d: D, origin: string | null, clientId: string) {
  if (!clientId) return; const o = origin ?? (d.sql.exec("select v from acct where k='ba:origin'").toArray()[0] as any)?.v; if (!o) return;
  const b = await ba(d, o);
  for (const t of ["oauthRefreshToken", "oauthAccessToken", "oauthConsent"]) await b.db.deleteFrom(t).where("clientId", "=", clientId).execute().catch(() => {});
}
// The live grant behind an access token: the newest family of this client made by consent, its peer still connected and not past its end date.
function liveFamily(d: D, clientId: string) {
  return d.sql.exec("select f.id from oauth_families f join peers p on p.id=f.peer_id where f.client_id=? and f.source='consent' and f.revoked=0 and p.revoked=0 and (p.expires is null or p.expires>?) order by f.created desc limit 1", clientId, Date.now()).toArray()[0] as any;
}
// Resource-server check for /mcp, /v1, the WebSocket and events: the JWT (this Dir's own JWKS, in-process; issuer; audience = this account's
// /mcp; expiry), then its immutable issuing grant, every call. A removed app gets 401 here at once, whatever its token's expiry says.
export async function authJwt(d: D, origin: string, token: string): Promise<{ peer: any; caps: any[] } | { error: string }> {
  const b = await ba(d, origin); let c: any;
  try { ({ payload: c } = await b.L.jwtVerify(token, b.L.createLocalJWKSet(await b.auth.api.getJwks()), { issuer: origin + authBase(d.acct), audience: origin + mcpPath(d.acct) })); }
  catch (e: any) { // jose checks the signature, issuer and audience before expiry, so an expired token's payload is ours: a removed app hears "removed"
    if (e?.code !== "ERR_JWT_EXPIRED") return { error: "this token isn't valid here" };
    return { error: await new GrantTokens(d.sql).get("access", token, true) ? "this sign-in expired; the app refreshes it by itself, or sign it in again" : REMOVED }; }
  const f = await new GrantTokens(d.sql).get("access", token);
  if (!f || f.client_id !== String(c.azp ?? c.client_id ?? "")) return { error: REMOVED };
  const r = await OAUTH_FNS.authFamily(d, f.id);
  return r ?? { error: REMOVED };
}
const REMOVED = "this app's access was removed (or has ended). Sign it in again to ask for access";

// ---------- requests the front door hands to the Dir (Dir.fetch) ----------
const html = (b: string, n: string) => new Response(b, { headers: PAGE_HEADERS(n) });
export async function authFetch(d: D, req: Request): Promise<Response> {
  const url = new URL(req.url), p = url.pathname, o = url.origin;
  if (p.endsWith("/relay/mint")) return json({ error: "not found" }, 404); // internal only (mintSession)
  try {
    const b = await ba(d, o); // inside the try: a Better Auth that can't be built answers in JSON and logs why (it was a bare workerd 500)
    if (!(d.sql.exec("select 1 from acct where k='ba:origin' and v=?", o).toArray().length)) d.sql.exec("insert or replace into acct values('ba:origin',?)", o); // for revocations made without a request
    if (p === consentPath(d.acct)) return await consent(d, b, req, url);
    d.sql.exec(NAMED_SCHEMA); // connect by name (src/named.ts)
    // the bare RFC 8414 / OIDC discovery paths naive clients try first: the same metadata as /.well-known/<kind>/api/auth
    if (/^\/\.well-known\/(oauth-authorization-server|openid-configuration)$/.test(p) && isRoot(d.acct)) return await withDevice(await b.auth.handler(new Request(`${o}/.well-known/oauth-authorization-server${authBase(d.acct)}`, { method: req.method, headers: req.headers })), o);
    if (p.endsWith("/oauth2/authorize") && req.method === "GET") { const r = await namedAuthorize(d, b, req, url, authBase(d.acct), SCOPES, m => dcrRefusal(m, knobs(d.env).dcrMode)); if (r) return r; }
    const nt = p.endsWith("/oauth2/token") && req.method === "POST" ? await namedToken(d, b, req, knobs(d.env).refreshTtl) : null; // a code without a client_id
    if (p.endsWith("/oauth2/authorize") && req.method === "GET" && !/^https?:\/\//.test(url.searchParams.get("client_id") ?? "") && /^rc_/.test(url.searchParams.get("client_id") ?? ""))
      return new Response(OLD_CLIENT, { status: 400, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    if (p.endsWith("/oauth2/register") && req.method === "POST") { // who may sign itself up (registering grants nothing; the owner's consent does)
      const why = dcrRefusal(await req.clone().json().catch(() => ({})), knobs(d.env).dcrMode); if (why) return json({ error: "access_denied", error_description: why }, 403);
    }
    const tr = nt?.req ?? req;
    // Bind at code issuance, not by whichever grant happens to be newest when an exchange finishes.
    let binding: { id: string; client_id: string } | null = null;
    if (p.endsWith("/oauth2/token") && req.method === "POST") {
      const raw = await tr.clone().text(), form = (tr.headers.get("content-type") ?? "").includes("application/json") ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw));
      const kind = form.grant_type === "authorization_code" ? "code" : form.grant_type === "refresh_token" ? "refresh" : null;
      binding = kind ? await new GrantTokens(d.sql).get(kind, String(kind === "code" ? form.code ?? "" : form.refresh_token ?? "")) : null;
      if (!binding || (form.client_id && form.client_id !== binding.client_id)) return json({ error: "invalid_grant", error_description: "This sign-in has ended or predates this update. Connect the app again." }, 400);
    }
    const r = nt ? await nt.after(await b.auth.handler(tr)) : await b.auth.handler(tr);
    if (binding && r.ok) {
      const tokens: any = await r.clone().json(), claims = decodeJwt(tokens.access_token), bound = new GrantTokens(d.sql);
      if (String(claims.azp ?? claims.client_id ?? "") !== binding.client_id) throw new Error("OAuth token client mismatch");
      await bound.keep("access", tokens.access_token, binding.id, Number(claims.exp) * 1000);
      if (tokens.refresh_token) await bound.keep("refresh", tokens.refresh_token, binding.id, Date.now() + knobs(d.env).refreshTtl * 1000);
    }
    if (p.includes("/.well-known/oauth-authorization-server") && r.ok) return await withDevice(r, o);
    if (p.endsWith("/oauth2/register") && r.status < 300) await sweepClients(d, b).catch(() => {}); // every registration sweeps the ones never used
    if (r.status === 429 && r.headers.get("x-retry-after")) { const h = new Headers(r.headers); h.set("retry-after", r.headers.get("x-retry-after")!); return new Response(r.body, { status: 429, headers: h }); }
    if (r.status >= 500) { // Better Auth answered a 500 itself (it caught the exception): keep what it said for Experimental's recent errors
      const body = await r.clone().text().catch(() => ""); DL.put(d.sql, [{ level: "error", source: "auth", route: `${req.method} ${p}`, status: r.status, msg: `Better Auth answered ${r.status}: ${body.slice(0, 1500) || "(empty body)"}`, request_id: req.headers.get("x-kitebook-request-id") }], DL.envSecrets(d.env));
      const h = new Headers(r.headers); h.set("x-kitebook-logged", "1"); return new Response(body, { status: r.status, headers: h }); }
    return r;
  } catch (e: any) {
    if (e?.statusCode || e?.status) return json({ error: e.body?.code ?? e.status, error_description: e.body?.message ?? e.message }, e.statusCode ?? 400);
    console.error(`auth error: ${req.method} ${p} (origin ${o}):`, e?.stack ?? e); // the server log (workerd's stderr) gets the real exception
    try { DL.put(d.sql, [DL.fromError(e, { source: "auth", route: `${req.method} ${p}`, status: /must use HTTPS/i.test(String(e?.message)) ? 400 : 500, request_id: req.headers.get("x-kitebook-request-id") ?? undefined })], DL.envSecrets(d.env)); } catch {} // Experimental's recent errors
    if (/must use HTTPS/i.test(String(e?.message))) return json({ error: "https_required", error_description: `Sign-in needs this Kitebook's https address; this request came in as ${o}. Put it behind an https tunnel or proxy that sends X-Forwarded-Proto: https, or use http://127.0.0.1 on this computer.` }, 400);
    return json({ error: "server_error", error_description: String(e?.message ?? e) }, 500, { "x-kitebook-logged": "1" });
  }
}
// the pairing flow (POST /connect, RFC 8628 without a client_id; src/oauth.ts) in the metadata: its endpoint and grant type
async function withDevice(r: Response, o: string): Promise<Response> {
  const j: any = await r.clone().json().catch(() => null); if (!j || typeof j !== "object") return r;
  const gt = Array.isArray(j.grant_types_supported) ? j.grant_types_supported : [], dg = "urn:ietf:params:oauth:grant-type:device_code";
  const h = new Headers(r.headers); h.delete("content-length");
  return new Response(JSON.stringify({ ...j, device_authorization_endpoint: `${o}/connect`, grant_types_supported: gt.includes(dg) ? gt : [...gt, dg] }), { status: r.status, headers: h });
}
export const OLD_CLIENT = "This app signed up with Kitebook before its sign-in was updated. Remove the app's Kitebook connection and add it again (for example: pi mcp login kitebook, codex mcp login kitebook, or /mcp -> Authenticate in Claude Code). It signs up again by itself; what you allowed it before is kept in Settings until you remove it there.\n";
// Dynamic client registration policy (OAUTH_DCR): "public" (default, a self-hosted Mac): an app may sign itself up only as a public client
// (no secret; PKCE anyway) returning to this computer (http loopback) or to an https address; "all" (HOSTED=1 or OAUTH_DCR=1): any valid one,
// e.g. Claude.ai / ChatGPT asking for a secret; "off" (OAUTH_DCR=0): none (an app publishing a Client ID Metadata Document needs no sign-up).
export const dcrHelp = (off: boolean) => (off ? "Apps can't sign themselves up on this Kitebook." : "This Kitebook lets an app sign itself up as a public client (no client secret) that returns to this computer (http://127.0.0.1, http://[::1] or http://localhost) or to an https address, or as Claude.ai or ChatGPT (with a client secret, returning only to claude.ai / chatgpt.com).")
  + " Apps that publish their details at an https address (most current MCP clients) connect without signing up. Whoever runs this Kitebook can allow every other app with a client secret with OAUTH_DCR=1.";
// Claude.ai and ChatGPT register with a client secret. Their callbacks are on their own https hosts, so a registration that names only those
// hosts is allowed by default too: the code can only ever go back to them, and registering still grants nothing without the owner's consent.
const CLOUD_HOSTS = ["claude.ai", "claude.com", "chatgpt.com", "chat.openai.com"];
const cloudOnly = (uris: any[]) => uris.length > 0 && uris.every(u => { try { const x = new URL(String(u)); return x.protocol === "https:" && CLOUD_HOSTS.includes(x.hostname); } catch { return false; } });
export function dcrRefusal(m: any, mode: "off" | "public" | "all"): string | null {
  if (mode === "off") return dcrHelp(true);
  if (mode === "all") return null;
  const method = m?.token_endpoint_auth_method ?? "none", uris: any[] = Array.isArray(m?.redirect_uris) ? m.redirect_uris : [];
  const plain = uris.every(u => { try { const x = new URL(String(u)); return x.protocol === "https:" || (x.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(x.hostname)); } catch { return true; } }); // a bad URL is Better Auth's to refuse
  if (method !== "none" && ["client_secret_basic", "client_secret_post"].includes(method) && cloudOnly(uris)) return null;
  return method !== "none" || !plain ? dcrHelp(false) : null;
}
// clients that registered themselves and were never approved are deleted after OAUTH_CLIENT_UNUSED_TTL (registering grants nothing)
async function sweepClients(d: D, b: BA) {
  await sweepAuto(d, b).catch(() => {});
  const cut = new Date(Date.now() - knobs(d.env).clientUnused * 1000), used = new Set((d.sql.exec("select distinct client_id from oauth_families").toArray() as any[]).map(r => r.client_id));
  const all = await b.db.selectFrom("oauthClient").select(["clientId", "createdAt"]).execute().catch(() => [] as any[]); // dates are stored as text or numbers: compare here
  for (const c of all as any[]) { const t = typeof c.createdAt === "number" ? c.createdAt : Date.parse(String(c.createdAt));
    if (t < cut.getTime() && !used.has(c.clientId) && !/^https:\/\//.test(c.clientId)) await b.db.deleteFrom("oauthClient").where("clientId", "=", c.clientId).execute(); }
}

// The consent page Better Auth sends a signed-in owner to (/consent?<signed authorization request>). Asked every time, unless this app
// already has a live grant (shown in Settings): then the code is issued right away under that grant. Approve writes the grant first,
// then hands the decision to Better Auth's /oauth2/consent as the same browser request (its signed-query checks run).
async function consent(d: D, b: BA, req: Request, url: URL): Promise<Response> {
  const ses = await b.auth.api.getSession({ headers: req.headers }).catch(() => null);
  if (req.method === "GET") {
    if (!ses) return Response.redirect(`${url.origin}${startPath(d.acct)}?${url.searchParams}`, 302);
    const q = url.searchParams, clientId = q.get("client_id") ?? "", client = await clientInfo(b, clientId);
    if (!client) return new Response("This app isn't known to this Kitebook. Start connecting again from the app.\n", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
    const family = liveFamily(d, clientId);
    if (family) { // known app (a grant the owner can see and remove in Settings): no page
      const r = await forward(b, req, url, true), to = await grantCode(d, clientId, family.id, r.url); return to ? Response.redirect(to, 302) : json(r.body, r.status);
    }
    const pol: any = await d.admin("policy", { space: "main" }).then((r: any) => r.spaces[0]).catch(() => null);
    const runners: any[] = pol?.runners ?? [], machine = (runners.find(r => r.online) ?? runners[0])?.name ?? null;
    const plan = (() => { try { return OAUTH_FNS.namePlan(d, slug(client.name), true, clientId); } catch { return null; } })(), n = rnd(16);
    const ui = { c: { id: clientId, name: client.name, self: client.self, auto: autoInfo(d, clientId) }, redirect: q.get("redirect_uri") ?? "", acct: d.acct, projects: pol?.projects ?? [], plan, machine, query: url.search.slice(1), space: "main" };
    return html(authPage("Connect " + client.name, consentBody(ui), OWNER_JS + consentJs, n), n);
  }
  if (req.method !== "POST") return json({ error: "GET or POST" }, 405);
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return json({ error: "send JSON" }, 415);
  const og = req.headers.get("origin"); if (og && og !== url.origin) return json({ error: "cross-origin request refused" }, 403);
  if (!ses) return json({ error: "sign in first", error_description: "Sign in to your Kitebook first (kitebook open on your Mac, or a passkey)." }, 401);
  const a: any = await req.json().catch(() => ({})), q = new URLSearchParams(String(a.oauth_query ?? "")), clientId = q.get("client_id") ?? "";
  const client = await clientInfo(b, clientId); if (!client) return json({ error: "invalid_client", error_description: "This app isn't known to this Kitebook. Start connecting again from the app." }, 400);
  if (a.deny) { const r = await forward(b, req, url, false, a.oauth_query); return json({ ok: true, redirect: r.url }, r.url ? 200 : r.status); }
  { // the presence gate (src/devices.ts): approving an app widens access, so this session needs a fresh confirmation from an owner device
    const act = `consent:${clientId}`, creds = [ses.session.id]; for (const c of deviceCookies(req)) if (c.acct === d.acct) { const x = await deviceFns.sessGet(d as any, c.secret).catch(() => null); if (x) creds.push("ds:" + x.id); }
    let why = ""; for (const c of creds) { const g = await deviceFns.gate(d as any, { cred: c, action: act }); if (g.ok) { why = ""; break; } why = g.why ?? "confirm first"; }
    if (why) return json({ error: "presence_required", error_description: `Confirm it's you first: run kitebook confirm on one of your computers, then approve again. (${why})`, presence: { needed: true, action: act } }, 428);
  }
  const lim = rateHit(d.sql, "grants", knobs(d.env).grantsHour); // per account: a stolen session can't mint grants without end
  if (!lim.ok) return json({ error: "rate_limited", error_description: `too many new connections for this account; try again in ${Math.ceil(lim.retry_after / 60)} min` }, 429);
  const { consentChoice } = await import("./oauth.ts");
  let ch: { verbs: string[]; paths: string[] };
  try { ch = a.choice && a.choice !== "custom" ? consentChoice(a.choice, a.folder, a.dispatch === true) : { verbs: (Array.isArray(a.verbs) ? a.verbs : ["read"]).filter((v: string) => VERBS.includes(v)), paths: Array.isArray(a.paths) && a.paths.length ? a.paths.map(String) : ["**"] }; }
  catch (e: any) { return json({ error: "invalid_request", error_description: String(e?.message ?? e).replace(/^oauth:[a-z_]+:/, "") }, 400); }
  if (!ch.verbs.length) return json({ error: "invalid_request", error_description: "Pick at least one thing it can do." }, 400);
  const kind = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(q.get("redirect_uri") ?? "") ? "coding_agent" : "assistant"; // a CLI returns to this computer
  let g: { family: string; name: string };
  try { g = await OAUTH_FNS.grant(d, { name: slug(cleanName(String(a.name || client.name))), kind, space: String(a.space || "main"), verbs: ch.verbs, paths: ch.paths, client_id: clientId, source: "consent", ...(typeof a.replace === "boolean" ? { replace: a.replace } : {}) }); }
  catch (e: any) { const m = String(e?.message ?? e).match(/^oauth:([a-z_]+):(.*)$/s); return json({ error: m?.[1] ?? "invalid_request", error_description: m?.[2] ?? String(e?.message ?? e) }, m?.[1] === "rate_limited" ? 429 : 400); }
  const r = await forward(b, req, url, true, a.oauth_query);
  if (!r.url) { await killFamily(d, g.family, "consent not completed"); return json(r.body, r.status); }
  return json({ ok: true, redirect: await grantCode(d, clientId, g.family, r.url), peer: g.name, space: String(a.space || "main"), granted: grantSummary(client.name, ch.verbs, ch.paths) });
}
async function clientInfo(b: BA, clientId: string): Promise<{ name: string; self: boolean } | null> {
  if (!clientId) return null;
  const c: any = await b.db.selectFrom("oauthClient").selectAll().where("clientId", "=", clientId).executeTakeFirst().catch(() => null);
  if (!c) return null;
  const name = String(c.name ?? c.clientName ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").replace(/\s+/g, " ").trim().slice(0, 60) || "MCP client";
  // a CIMD client's name comes from a document at its own https address (the host is shown); a self-registered one names itself
  return { name, self: !/^https:\/\//.test(clientId) };
}
async function grantCode(d: D, clientId: string, family: string, to: string | undefined) {
  if (to) { const code = new URL(to).searchParams.get("code"); if (code) await new GrantTokens(d.sql).keep("code", code, family, Date.now() + 15 * 60_000); }
  return noteCode(d, clientId, to);
}
// Better Auth's own consent endpoint, as this browser (cookie + origin); then its consent row goes, so the next sign-in comes back to us.
async function forward(b: BA, req: Request, url: URL, accept: boolean, query = url.search.slice(1)): Promise<{ url?: string; status: number; body: any }> {
  const r = await b.auth.handler(new Request(url.origin + authBase(acctOfPath(url.pathname)) + "/oauth2/consent", { method: "POST",
    headers: { cookie: req.headers.get("cookie") ?? "", origin: url.origin, "content-type": "application/json", "user-agent": req.headers.get("user-agent") ?? "" }, body: JSON.stringify({ accept, oauth_query: query }) }));
  const body: any = await r.json().catch(() => ({})), clientId = new URLSearchParams(query).get("client_id") ?? "";
  if (clientId) await b.db.deleteFrom("oauthConsent").where("clientId", "=", clientId).execute().catch(() => {});
  return { url: body?.url ?? body?.redirect_uri ?? undefined, status: r.status, body };
}

// ---------- the front door (src/index.ts): which requests go to an account's Better Auth ----------
export function authRoute(p: string): string | null { // the account whose Dir answers this path, or null (not an auth path)
  if (p === "/consent" || p.startsWith("/api/auth/") || p === "/api/auth") return ROOT_ACCOUNT;
  const m = p.match(new RegExp(`^/u/(${ACCT})/(?:api/auth(?:/.*)?|consent)$`)); if (m) return m[1];
  if (p.startsWith("/.well-known/oauth-authorization-server") || p.startsWith("/.well-known/oauth-protected-resource") || p.startsWith("/.well-known/openid-configuration")) return acctOfPath(p);
  return null;
}
export { sha256, esc };

// Page script for passkeys (/start sign-in, Settings add): Better Auth's JSON options to WebAuthn and back, no library in the page.
export const PASSKEY_JS = String.raw`const pkB=s=>Uint8Array.from(atob(String(s).replace(/-/g,"+").replace(/_/g,"/")+"===".slice((String(s).length+3)%4)),c=>c.charCodeAt(0)),pkU=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const pkJson=c=>{const r=c.response,o={id:c.id,rawId:pkU(c.rawId),type:c.type,authenticatorAttachment:c.authenticatorAttachment||undefined,clientExtensionResults:c.getClientExtensionResults?c.getClientExtensionResults():{}};
o.response=r.attestationObject?{clientDataJSON:pkU(r.clientDataJSON),attestationObject:pkU(r.attestationObject),transports:r.getTransports?r.getTransports():[]}:{clientDataJSON:pkU(r.clientDataJSON),authenticatorData:pkU(r.authenticatorData),signature:pkU(r.signature),userHandle:r.userHandle?pkU(r.userHandle):undefined};return o};
const pkErr=async(r,what)=>{let j={};try{j=await r.json()}catch(e){}const m=String(j.message||j.code||r.status);return new Error(/FRESH/i.test(m)?"For safety, adding a passkey needs a sign-in from today: run kitebook open on your Mac, then add it.":/not found|NOT_FOUND|PASSKEY/i.test(m)?what+": this passkey isn't on this Kitebook. Sign in another way, then add it in Settings.":what+": "+m)};
async function pkSignIn(base){const r0=await fetch(base+"/passkey/generate-authenticate-options",{credentials:"same-origin"});if(!r0.ok)throw await pkErr(r0,"Passkey sign-in stopped");const o=await r0.json();
let c;try{c=await navigator.credentials.get({publicKey:{...o,challenge:pkB(o.challenge),allowCredentials:(o.allowCredentials||[]).map(x=>({...x,id:pkB(x.id)}))}})}catch(e){throw new Error("Passkey sign-in stopped: "+e.message)}
const r=await fetch(base+"/passkey/verify-authentication",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({response:pkJson(c)})});if(!r.ok)throw await pkErr(r,"Passkey not accepted")}
async function pkAdd(base,name){const r0=await fetch(base+"/passkey/generate-register-options?name="+encodeURIComponent(name),{credentials:"same-origin"});if(!r0.ok)throw await pkErr(r0,"Passkey not added");const o=await r0.json();
let c;try{c=await navigator.credentials.create({publicKey:{...o,challenge:pkB(o.challenge),user:{...o.user,id:pkB(o.user.id)},excludeCredentials:(o.excludeCredentials||[]).map(x=>({...x,id:pkB(x.id)}))}})}catch(e){throw new Error("Passkey not added: "+e.message)}
const r=await fetch(base+"/passkey/verify-registration",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({response:pkJson(c),name:navigator.platform||"Passkey"})});if(!r.ok)throw await pkErr(r,"Passkey not added")}`;
