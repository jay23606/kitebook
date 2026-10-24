// Kitebook Worker: stateless front door. Auth via the Dir object, then route to the space's Durable Object.
//   POST /v1/<op>        HTTPS/JSON (core API)
//   GET  /v1/stream      WebSocket: live events + ops on one hibernatable socket (runners)
//   POST /mcp            MCP streamable_http (JSON responses)
//   POST /admin/<cmd>    admin, Bearer ADMIN_TOKEN only
//   GET|POST /approve/<acct>.<space>.<id>   one-time phone review page for a runner's approval (no token: the id is the capability)
//   /api/auth/*, /consent, /.well-known/oauth-*   owner sign-in + OAuth 2.1 (PKCE, CIMD, DCR, refresh, revoke) on Better Auth, per account (auth.ts);
//                        hosted accounts: /u/<acct>/api/auth/*, /u/<acct>/consent, /u/<acct>/mcp, /u/<acct>/start
//   /authorize, /token, /register   short aliases of the account's OAuth endpoints; /authorize?name=<app> connects an app by name (named.ts)
//   /oauth/*, /device    the device grant and the original token format (oauth.ts)
//   GET|POST /start, GET /install.sh, GET /runner-files/<file>   getting started: owner page, Mac runner installer, runner files (start.ts)
// Split: the Dir object and account helpers live in src/dir.ts, the MCP JSON-RPC handler in src/mcp.ts.
import { ROOT_ACCOUNT, isRoot } from "../client/account.ts";
import { OPS, READ_OPS, openapi, jsonSchema, sha256, type Peer, type Res } from "./ops.ts";
import { guide, joinGuide } from "./guide.ts";
import { CODES, typeOf } from "./events.ts";
import { approvePage, PAGE_HEADERS } from "./approve.ts";
import { oauthFetch, wwwAuth, signupLimit, grantSummary } from "./oauth.ts";
import { authRoute, looksJwt, jwtAcct, mcpPath } from "./auth.ts";
import { startFetch } from "./start.ts";
import { shortAlias, NAME_HOWTO, appPrompt } from "./named.ts";
import { openFetch } from "./open.ts";
import { claimGate, joinFetch, joinOp, joinAdmin } from "./join.ts";
import { sessionOwner, sameOrigin } from "./session.ts";
import { SERVER_BUILD } from "./build.ts";
import { ingressOf, edgeGate, queryToken, QUERY_TOKEN_HINT } from "./ingress.ts";
import { Space } from "./space.ts";
import { ACCT_RE, spaceStub, dirStub, acctOf, type Cap, json, b64url, Dir } from "./dir.ts";
import { type EvCall, serverInfo, mcp, mcpNameMismatch, mcpStatus, mcpBaseRevision } from "./mcp.ts";
import * as DL from "./devlog.ts";
export { Space, Dir, serverInfo };

// constant-time-ish compare: equal-length digests, xor-accumulated
async function teq(a: string | null, b: string) { if (a == null) return false; const x = await sha256(a), y = await sha256(b); let d = 0; for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i); return d === 0 && x.length === y.length; }

// Behind a TLS tunnel or proxy (cloudflared -> plain workerd on 127.0.0.1, scripts/serve.sh) a request arrives as http://<public host>
// although the visitor used https; the edge says so in X-Forwarded-Proto (Cloudflare also in CF-Visitor). Every origin built from req.url
// (Better Auth's baseURL, issuer and passkey origin, /start links, same-origin checks) must be the https one the browser sees: with the
// http one, Better Auth's MCP plugin refuses to start and every /api/auth/* call failed (auth-500). Loopback stays as it is (local tools).
export const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;
export function publicRequest(req: Request): Request {
  const u = new URL(req.url); if (u.protocol !== "http:" || LOOPBACK_HOST.test(u.hostname)) return req;
  const xfp = (req.headers.get("x-forwarded-proto") ?? "").split(",")[0].trim().toLowerCase();
  let vis = ""; try { vis = String(JSON.parse(req.headers.get("cf-visitor") ?? "{}")?.scheme ?? ""); } catch {}
  if (xfp !== "https" && vis !== "https") return req;
  u.protocol = "https:"; return new Request(u.href, req);
}

// Every request gets a request id. An unhandled error or a 500 from any route is kept in the account's recent-errors ring (src/devlog.ts:
// route, status, message, stack, request id; redacted) and the 500 answers plain JSON carrying that id ({ok:false, error, request_id}), so
// the owner or, with Experimental on, their assistant (op relay_logs) can look it up instead of pasting `kitebook logs server`.
const credAcct = (req: Request, url: URL): string => { const ar = authRoute(url.pathname); if (ar) return ar; const u = url.pathname.match(/^\/u\/([a-z0-9][a-z0-9-]{1,30})\//); if (u) return u[1];
  const b = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token"); return looksJwt(b) ? jwtAcct(b!) ?? ROOT_ACCOUNT : acctOf(b); };
const srcOf = (url: URL) => authRoute(url.pathname) || /\/(oauth|device|consent)\b|\/api\/auth\//.test(url.pathname) ? "auth" : "server";
async function keepErr(env: Env, acct: string, e: DL.Entry) { try { await dirStub(env, ACCT_RE.test(acct) ? acct : ROOT_ACCOUNT).devlogPut([e]); } catch (x) { console.error("devlog", x); } }
async function with500(res: Response, env: Env, req: Request, url: URL, id: string): Promise<Response> {
  const text = await res.text().catch(() => ""); let body: any = null; try { body = JSON.parse(text); } catch {}
  if (!res.headers.get("x-kitebook-logged")) await keepErr(env, credAcct(req, url), { level: "error", source: srcOf(url), route: `${req.method} ${url.pathname}`, status: res.status, request_id: id,
    msg: String(body?.error_description ?? body?.error ?? body?.message ?? (text.trim().slice(0, 1500) || `${res.status} with an empty body`)) });
  const h = new Headers(res.headers); h.set("x-request-id", id); h.delete("x-kitebook-logged"); h.set("content-type", "application/json"); h.delete("content-length");
  const out = body && typeof body === "object" && !Array.isArray(body) ? { ...body, request_id: body.request_id ?? id } : { ok: false, error: text.trim().slice(0, 2000) || "internal error", request_id: id };
  return new Response(JSON.stringify(out), { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const id = DL.rid(), url = new URL(req.url); let res: Response;
    try { res = await front(req, env, id); }
    catch (e: any) { // nothing below caught it: before this, workerd answered a bare 500
      console.error(`unhandled: ${req.method} ${url.pathname} (${id}):`, e?.stack ?? e);
      await keepErr(env, credAcct(req, url), DL.fromError(e, { source: srcOf(url), route: `${req.method} ${url.pathname}`, request_id: id }));
      return new Response(JSON.stringify({ ok: false, error: "internal error", request_id: id }), { status: 500, headers: { "content-type": "application/json", "x-request-id": id } });
    }
    return res.status >= 500 && res.status !== 503 && res.webSocket == null ? await with500(res, env, req, url, id) : res;
  },
} satisfies ExportedHandler<Env>;

async function front(req0: Request, env: Env, reqId: string): Promise<Response> {
    const req = publicRequest(req0), url = new URL(req.url);
    // ?build=1 from this computer only (the local listener, src/ingress.ts): which commit the server runs, so an update can tell the server
    // took the new code (client/host-upgrade.ts serverSync). Plain /health, and anything through the edge, stays {ok:true} (no version to the world).
    if (url.pathname === "/health") { const local = ingressOf(req0, env) === "local", r = json(url.searchParams.has("build") && local ? { ok: true, commit: SERVER_BUILD.commit } : { ok: true });
      if (local) { r.headers.set("x-kitebook-build", SERVER_BUILD.commit ?? "unknown"); r.headers.set("x-kitebook-mcp-revision", await mcpBaseRevision()); r.headers.set("cache-control", "no-store"); } return r; }
    // ingress lockdown (src/ingress.ts): from the public edge, only what apps and the OAuth dance need; the rest is 404 without the
    // owner's session. Which listener it came in on is the listener's own stamp, never Host or X-Forwarded-* (they can only downgrade).
    const edge = ingressOf(req0, env) === "edge";
    if (edge) { const g = await edgeGate(req, env, url, a => dirStub(env, a)); if (g) return g; }
    const cg = await claimGate(env, url, edge, { dir: (a: string) => dirStub(env, a) }); if (cg) return cg; // a remote server nobody has claimed yet (src/claim.ts)
    const jn = await joinFetch(req, env, url, { dir: (a: string) => dirStub(env, a) }); if (jn) return jn; // kitebook join / kitebook login <url>: codes + polling (src/join.ts)
    // the device grant (POST /connect's code) and its rt. refresh tokens, at any token path an app may use: the original token endpoint (oauth.ts)
    if (req.method === "POST" && /^(\/u\/[a-z0-9-]+)?(\/token|\/api\/auth\/oauth2\/token)$/.test(url.pathname)) {
      const t = await req.clone().text().catch(() => ""), f = (() => { try { return /json/.test(req.headers.get("content-type") ?? "") ? JSON.parse(t) : Object.fromEntries(new URLSearchParams(t)); } catch { return {}; } })();
      if (f.grant_type === "urn:ietf:params:oauth:grant-type:device_code" || (f.grant_type === "refresh_token" && /^rt\./.test(f.refresh_token ?? ""))) {
        const u2 = new URL(url.href); u2.pathname = "/oauth/token"; const r2 = new Request(u2.href, { method: "POST", headers: req.headers, body: t });
        return (await oauthFetch(r2, env, u2, { dir: (a: string) => dirStub(env, a), global: () => env.DIR.get(env.DIR.idFromName("oauth:global")), acctOf, teq }))!; }
    }
    const sa = shortAlias(url.pathname); // /authorize, /token, /register: the short names naive clients guess (src/named.ts)
    if (sa) { const h = new Headers(req.headers); h.set("x-kitebook-request-id", reqId); return await dirStub(env, sa.acct).fetch(new Request(url.origin + sa.path + url.search, new Request(req, { headers: h }))); }
    const ar = authRoute(url.pathname); // an account's Better Auth: sign-in, OAuth endpoints + metadata, the consent page
    if (ar) { const h = new Headers(req.headers); h.set("x-kitebook-request-id", reqId); return await dirStub(env, ar).fetch(new Request(req, { headers: h })); }
    const um = url.pathname.match(/^\/u\/([a-z0-9][a-z0-9-]{1,30})\/mcp$/); // a hosted account's own MCP URL (its own issuer); self-host is /mcp
    const forced = um ? um[1] : null; if (um) url.pathname = "/mcp";
    const oa = await oauthFetch(req, env, url, { dir: (a: string) => dirStub(env, a), global: () => env.DIR.get(env.DIR.idFromName("oauth:global")), acctOf, teq });
    if (oa) return oa;
    const opn = await openFetch(req, env, url, { dir: (a: string) => dirStub(env, a) }); // kitebook open's device-signed one-time link (src/open.ts)
    if (opn) return opn;
    const st = await startFetch(req, env, url, { dir: (a: string) => dirStub(env, a), acctOf, teq });
    if (st) return st;
    const md = (t: string) => new Response(t, { headers: { "content-type": "text/markdown; charset=utf-8", link: `<${url.origin}/openapi.json>; rel="service-desc", <${url.origin}/llms.txt>; rel="describedby", <${url.origin}/start>; rel="help"` } });
    // a person opening the bare URL in a browser lands on /start; agents (fetchers send no Sec-Fetch-Dest: document) get the guide
    // (a browser without Sec-Fetch-* still asks for text/html first; agents ask for markdown, JSON or */*)
    if (req.method === "GET" && url.pathname === "/" && (req.headers.get("sec-fetch-dest") === "document" || /^\s*text\/html/i.test(req.headers.get("accept") ?? ""))) return Response.redirect(url.origin + "/start", 302);
    if (req.method === "GET" && ["/", "/llms.txt", "/setup", "/setup.md"].includes(url.pathname)) return md(guide(url.origin));
    if (url.pathname === "/openapi.json") return json(openapi(url.origin));
    // The token comes in the Authorization header only. ?token= links were removed (auth spec v2): a credential in a URL is written to proxy,
    // tunnel and browser logs and synced with bookmarks. A request that still sends one gets a 401 saying how to send it instead.
    const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
    if (!bearer && queryToken(url) && (/^\/(v1|mcp)\b/.test(url.pathname) || um)) return new Response(JSON.stringify({ ok: false, error: "unauthorized", hint: QUERY_TOKEN_HINT }),
      { status: 401, headers: { "content-type": "application/json", "cache-control": "no-store", "www-authenticate": wwwAuth(url.origin, url.pathname === "/mcp" ? mcpPath(forced ?? ROOT_ACCOUNT) : null, false, undefined) } });

    // new account: operator-only (ADMIN_TOKEN), or open to anyone when OPEN_SIGNUP=1
    if (url.pathname === "/signup" && req.method === "POST") {
      const b: any = await req.json().catch(() => ({})), op = !!env.ADMIN_TOKEN && await teq(bearer, env.ADMIN_TOKEN);
      if (!op) { // everyone but the operator is rate limited per IP, whether signup is open or not (no name probing either)
        const lim = await signupLimit(env, req);
        if (!lim.ok) return new Response(JSON.stringify({ ok: false, error: `too many signups from your address; try again in ${Math.ceil(lim.retry_after / 60)} min` }), { status: 429, headers: { "content-type": "application/json", "retry-after": String(lim.retry_after) } });
      }
      if ((env as any).OPEN_SIGNUP !== "1" && !op) return json({ ok: false, error: "signup is closed on this Kitebook; ask its operator" }, 403);
      if (!ACCT_RE.test(b.account ?? "") || isRoot(b.account)) return json({ ok: false, error: "account: 2-31 chars, lowercase letters, digits, dashes" }, 400);
      try {
        const d = dirStub(env, b.account), r = await d.createAccount(b.account, b.owner); await d.admin("space", { id: "main" }); // every account starts with space main
        return json({ ok: true, result: { ...r, space: "main", start: `${url.origin}/start`,
          next: `Open ${url.origin}/start, sign in with that recovery code (Use a recovery code), and connect your agents from there (Get started)` } });
      }
      catch (e: any) { return json({ ok: false, error: String(e.message ?? e) }, 409); }
    }

    // Phone review page. The id names its account and space so the front door can route without a token; the page itself is
    // the capability (random, single decision, 5-minute life). Decisions are JSON POSTs only, so a link preview or a
    // cross-site form can't decide anything, and nothing here is CORS-enabled.
    const apm = url.pathname.match(/^\/approve\/([a-z0-9][a-z0-9-]{0,30})\.([a-z0-9-]{1,40})\.([0-9a-f]{36})$/);
    if (apm) {
      const st = spaceStub(env, apm[1], apm[2]), a = await st.askView(apm[3]);
      if (!a) return new Response("This approval link is invalid.\n", { status: 404, headers: { "cache-control": "no-store" } });
      // dialog-path pages (owner_only) were never sent anywhere: only the account owner's signed-in session sees or decides them
      if (a.owner_only && (await sessionOwner(req, ac => dirStub(env, ac)))?.acct !== apm[1]) return req.method === "GET" && !(req.headers.get("accept") ?? "").includes("application/json") && url.searchParams.get("format") !== "json"
        ? new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><p>This approval is for the account owner. <a href="/start?next=${encodeURIComponent(url.pathname)}">Sign in on /start</a>, then open it again.</p>`, { status: 401, headers: { ...PAGE_HEADERS(b64url(16)) } })
        : json({ ok: false, error: "sign in on /start as this account's owner first" }, 401);
      if (req.method === "GET") {
        if (url.searchParams.get("format") === "json" || (req.headers.get("accept") ?? "").includes("application/json")) return new Response(JSON.stringify({ ok: true, result: a }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
        const n = b64url(16); return new Response(approvePage(a, n), { headers: PAGE_HEADERS(n) });
      }
      if (req.method === "POST") {
        if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return json({ ok: false, error: "send JSON" }, 415);
        if (!sameOrigin(req, url)) return json({ ok: false, error: "cross-origin request refused" }, 403);
        const r = await st.askDecide(apm[3], await req.json().catch(() => ({})));
        return r.status === 200 ? json({ ok: true, result: { state: r.state } }) : json({ ok: false, error: r.error }, r.status);
      }
      return json({ ok: false, error: "GET or POST" }, 405);
    }
    const jm = url.pathname.match(/^\/join\/(inv_[A-Za-z0-9_.-]+)$/), jwt = looksJwt(bearer); // jwt: a Better Auth access token (its issuer names the account)
    const acct = jwt ? forced ?? jwtAcct(bearer!) ?? ROOT_ACCOUNT : acctOf(jm ? jm[1] : bearer);
    const dir = dirStub(env, acct);
    if (jm) {
      const h = await sha256(jm[1]);
      if (req.method === "GET") { const inv = await dir.invite(h); return inv ? md(joinGuide(url.origin, jm[1], inv)) : new Response("This invite is invalid, used, or expired. Ask the human for a new one.\n", { status: 410 }); }
      if (req.method === "POST") {
        const b: any = await req.json().catch(() => ({}));
        try { const r: any = await dir.redeem(h, b.name, b.webhook); return json({ ok: true, result: { ...r, mcp: `${url.origin}/mcp`, api: `${url.origin}/v1`, stream: `${url.origin.replace(/^http/, "ws")}/v1/stream?space=${r.space}`, guide: `${url.origin}/llms.txt`, note: "token is shown once; store it as a secret" } }); }
        catch (e: any) { return json({ ok: false, error: String(e.message ?? e) }, 400); }
      }
    }
    const am = url.pathname.match(/^\/admin\/([a-z0-9_]+)$/); // digits: selftest_500
    if (am) {
      const ok = isRoot(acctOf(bearer)) ? !!env.ADMIN_TOKEN && await teq(bearer, env.ADMIN_TOKEN) : bearer?.startsWith("ak.") && await dir.isAdmin(await sha256(bearer));
      if (!ok) return json({ ok: false, error: "unauthorized" }, 401);
      // admin selftest_500: an unhandled error on purpose (smoke, and an operator checking that errors reach Settings / relay_logs)
      if (am[1] === "selftest_500") { const b: any = await req.json().catch(() => ({})); throw new Error(`selftest 500: ${String(b.note ?? "forced by the operator").slice(0, 500)}`); }
      try { const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {}; const result: any = /^(claim|join)_/.test(am[1]) ? await joinAdmin(dir, am[1], body, env, acct) : await (dir as any).admin(am[1], body); return json({ ok: true, result }); }
      catch (e: any) { return json({ ok: false, error: String(e.message ?? e) }, 400); }
    }

    // every call checks its credential live: a peer token, an old-format OAuth token (its grant), or a Better Auth JWT (its grant, auth.ts)
    const got: any = !bearer || bearer.startsWith("ak.") ? null : jwt ? await dir.authJwt(url.origin, bearer) : await dir.auth(await sha256(bearer));
    const auth = got && !got.error ? got : null, why: string | undefined = got?.error;
    // RFC 9728 / MCP auth: a 401 points clients at the protected-resource metadata, which names this account's authorization server
    // read the unread request body first: answering before it is consumed makes workerd drop the keep-alive connection, and a proxy
    // (cf dev's vite, a self-host reverse proxy) that reuses it fails the client's next request with "fetch failed". Small, sized bodies
    // only: an unauthenticated caller doesn't get to make us read megabytes (a big one just costs that connection)
    if (!auth) { const cl = req.headers.get("content-length"); if (cl && +cl <= 65536) await req.arrayBuffer().catch(() => {}); return new Response(JSON.stringify({ ok: false, error: "unauthorized", hint: why ? `${why}; see ${url.origin}/llms.txt` : bearer ? `this token isn't valid here (revoked, rotated, or for another Kitebook). Ask the owner for a new invite (${url.origin}/join/<code>) or sign in again with OAuth; see ${url.origin}/llms.txt` : `send Authorization: Bearer <token>. No token? ${NAME_HOWTO(url.origin)}; see ${url.origin}/llms.txt` }),
      { status: 401, headers: { "content-type": "application/json", "www-authenticate": wwwAuth(url.origin, url.pathname === "/mcp" ? mcpPath(forced ?? acct) : null, !!bearer, why) } }); }
    const { peer, caps } = auth as { peer: Peer; caps: Cap[] };
    const spaceFor = (s?: string) => {
      if (s) { if (!caps.some(c => c.space === s)) throw [403, `no access to workspace ${s}`]; return s; }
      if (caps.length === 1) return caps[0].space;
      throw [400, "space is required: name the workspace (you have access to " + caps.map(c => c.space).join(", ") + ")"];
    };
    const call = async (op: string, args: any = {}): Promise<Res> => {
      // can: what this connection may do, in plain words, so an agent can tell its human exactly what was approved
      if (op === "whoami") return { ok: true, result: { ...peer, account: acct, spaces: caps, can: caps.map(c => grantSummary(peer.name, c.verbs, c.paths)).join(" ") } };
      if (op === "mcp_status") { try { const spaces = args.space ? [spaceFor(args.space)] : caps.map(c => c.space).slice(0, 5);
        for (const s of spaces) { const r = await call("describe", { space: s }); if (!r.ok) return r; }
        return { ok: true, result: await mcpStatus(args, call) }; } catch (e: any) { if (Array.isArray(e)) return { ok: false, status: e[0], error: e[1] }; throw e; } }
      // "Approve on my phone / Mac" for a new app connection (src/oauth.ts connectNew): only a runner of the request's workspace reads
      // it (connect_get: the code, the app, what it would get) and passes on the owner's answer (connect_decide, bound to its nonce)
      // `kitebook open` on the owner's Mac: the runner (which refuses a request from its own agents) asks for a single-use 5-minute sign-in
      // link; it carries the secret in the #fragment, so the link never shows up in a request line or a log
      if (op === "login_link") {
        if (peer.kind !== "runner") return { ok: false, status: 403, error: "only the owner's Mac (a runner) makes sign-in links" };
        const t = await dir.login("linkNew"); return { ok: true, result: { url: `${url.origin}/start#login=${t.token}`, expires: t.expires } };
      }
      // the installer / `kitebook connect` on the owner's Mac: connect a coding agent found there (Pi, Codex, Claude Code...) with the safe
      // default (its own kb/<name> folder, no task sending), since the install itself was the owner's approval. The token goes straight
      // into that agent's own MCP config (client/agents-connect.ts), never printed.
      if (op === "agent_connect") {
        if (peer.kind !== "runner") return { ok: false, status: 403, error: "only the owner's Mac (a runner) connects its coding agents" };
        const g = await dir.dev("gate", { action: `agent_connect:${String(args.agent ?? "")}`, presence: args.presence ?? null, peer: peer.name }); // minting an agent token widens access
        if (!g.ok) return { ok: false, status: 428, error: `connecting a coding agent needs your presence on this device (kitebook connect asks for it): ${g.why}` };
        try { const s = spaceFor(args.space); return { ok: true, result: await dir.admin("agent_peer", { agent: String(args.agent ?? ""), space: s, by: peer.name }) }; }
        catch (e: any) { return Array.isArray(e) ? { ok: false, status: e[0], error: e[1] } : { ok: false, status: 400, error: String(e?.message ?? e) }; }
      }
      // kitebook app add <name> on the owner's Mac: a scoped key for an app with only an API-key field (Settings' Add an app), presence-gated
      if (op === "app_add") {
        if (peer.kind !== "runner") return { ok: false, status: 403, error: "only the owner's Mac (a runner) adds apps by key" };
        const g = await dir.dev("gate", { action: `app_add:${String(args.name ?? "")}`, presence: args.presence ?? null, peer: peer.name });
        if (!g.ok) return { ok: false, status: 428, error: `adding an app needs your presence on this device (kitebook app add asks for it): ${g.why}` };
        try { const r = await dir.admin("app_add", { name: args.name, choice: args.access ?? args.choice, days: args.days ?? null, space: spaceFor(args.space), by: peer.name }), mcp = url.origin + mcpPath(acct);
          return { ok: true, result: { ...r, mcp, prompt: appPrompt(mcp) } }; }
        catch (e: any) { return Array.isArray(e) ? { ok: false, status: e[0], error: e[1] } : { ok: false, status: 400, error: String(e?.message ?? e) }; }
      }
      // a refusal from the master-password functions (an error crossing the Durable Object boundary keeps only its message): proof missing -> 428
      const pwErr = (e: any) => { const m = String(e?.message ?? e); return { ok: false as const, status: /presence refused|needs the old one/.test(m) ? 428 : /master password on this computer first/.test(m) ? 409 : /can't give itself one/.test(m) ? 403 : 400, error: m }; };
      // ---- device identity (src/devices.ts). Only a runner token speaks for a machine; agent and assistant tokens never get here. ----
      // device_enroll: the runner registers this machine's device + presence public keys at start (the first one a tenant sees is its owner)
      if (["device_enroll", "device_list", "device_approve", "device_revoke", "device_rename", "presence_confirm", "device_password", "device_password_reset", "device_shortcut", "device_setup", "presence_remote_take", "presence_remote_reply"].includes(op)) {
        if (peer.kind !== "runner") return { ok: false, status: 403, error: "only a Kitebook device (its runner) manages devices and confirms presence; agent and app tokens can't" };
        try {
          if (op === "device_enroll") return { ok: true, result: await dir.dev("enroll", { peer: peer.name, peerKind: peer.kind, name: args.name, os: args.os, pubkey: String(args.pubkey ?? ""), presence_key: args.presence_key ?? undefined, password_key: args.password_key ?? undefined }) };
          // the master password (src/devices.ts setPassword / setupLink / shortcut): this machine's own keys; a locked or reset device sets its
          // first password without proof, otherwise an assertion from a key it already has. Also for a pending device (a laptop that joined
          // without a terminal), so it isn't stuck locked after approval.
          try {
            if (op === "device_password") return { ok: true, result: await dir.dev("setPassword", { peer: peer.name, password_key: String(args.password_key ?? ""), via: args.via, presence: args.presence ?? null }) };
            if (op === "device_setup") return { ok: true, result: await dir.dev("setupLink", { peer: peer.name, url: String(args.url ?? ""), expires: Number(args.expires) }) };
          } catch (e: any) { return pwErr(e); }
          const mine = await dir.dev("byPeer", peer.name);
          if (!mine || mine.state !== "active") return { ok: false, status: 403, error: mine ? "this device waits for approval on one of your other devices (or kitebook admin on the server)" : "this machine isn't enrolled as a device yet (start its runner once)" };
          if (op === "device_list") return { ok: true, result: { ...await dir.dev("list"), me: mine.id, pending_confirmations: await dir.dev("pending") } };
          if (op === "device_revoke") return { ok: true, result: await dir.deviceRevoke(String(args.id ?? ""), peer.name) }; // never gated: the safe direction
          if (op === "device_rename") return { ok: true, result: await dir.dev("rename", String(args.id ?? ""), String(args.name ?? "")) };
          if (op === "device_approve") { const id = String(args.id ?? ""), g = await dir.dev("gate", { action: `device_approve:${id}`, presence: args.presence ?? null, peer: peer.name });
            if (!g.ok) return { ok: false, status: 428, error: `approving a device needs your presence (kitebook devices approve asks for it): ${g.why}` };
            return { ok: true, result: await dir.dev("approve", id) }; }
          // the master password typed on another device (src/remote-pw.ts): this runner fetches it once and answers with its own assertion
          if (op === "presence_remote_take") return { ok: true, result: await dir.rpw("take", { id: String(args.id ?? ""), peer: peer.name }) };
          if (op === "presence_remote_reply") return { ok: true, result: await dir.rpw("reply", { id: String(args.id ?? ""), peer: peer.name, ok: args.ok === true, presence: typeof args.presence === "string" ? args.presence : undefined, error: args.error, wrong: args.wrong === true, locked: args.locked === true }) };
          if (op === "presence_confirm") return { ok: true, result: await dir.dev("confirm", { code: String(args.code ?? ""), presence: String(args.presence ?? ""), peer: peer.name }) };
          // the Touch ID / Windows Hello shortcut: off for any device is never gated (safe direction); on only for this machine, with its password
          if (op === "device_shortcut") { try { return { ok: true, result: await dir.dev("shortcut", { peer: peer.name, on: args.on === true, id: args.id ? String(args.id) : undefined, presence_key: args.presence_key, presence: args.presence ?? null }) }; }
            catch (e: any) { return pwErr(e); } }
          // a trusted device resets another device's forgotten master password (it may set a new one for 15 minutes): presence-gated here
          if (op === "device_password_reset") { const id = String(args.id ?? ""), g = await dir.dev("gate", { action: `device_password_reset:${id}`, presence: args.presence ?? null, peer: peer.name });
            if (!g.ok) return { ok: false, status: 428, error: `resetting a master password needs your presence on this device (kitebook devices reset-password asks for it): ${g.why}` };
            if (id === mine.id) return { ok: false, status: 400, error: "this is the device you're on: kitebook password change sets a new one here (with the old one or your shortcut); a forgotten one is reset from another device or the server shell" };
            return { ok: true, result: await dir.dev("resetPassword", id) }; }
          return { ok: false, status: 404, error: "device_enroll | device_list | device_approve | device_revoke | device_rename | presence_confirm | device_password | device_password_reset | device_shortcut | device_setup" };
        } catch (e: any) { return { ok: false, status: 400, error: String(e?.message ?? e) }; }
      }
      if (op === "connect_get" || op === "connect_decide") {
        if (peer.kind !== "runner") return { ok: false, status: 403, error: "only a runner passes on connection approvals" };
        try { const r = await dir.oauth("connectGet", String(args.id ?? "")); if (!caps.some(c => c.space === r.space)) return { ok: false, status: 404, error: "No such connection request." };
          if (op === "connect_decide" && args.yes === true) { const g = await dir.dev("gate", { action: `connect:${r.id}`, presence: args.presence ?? null, peer: peer.name });
            if (!g.ok) return { ok: false, status: 428, error: `approving a connection needs your presence on this device (kitebook approve asks for it): ${g.why}` }; }
          return { ok: true, result: op === "connect_get" ? r : await dir.oauth("connectDecide", { id: r.id, nonce: String(args.nonce ?? ""), yes: args.yes === true, by: peer.name }) }; }
        catch (e: any) { const m = String(e?.message ?? e).match(/^oauth:([a-z_]+):(.*)$/s); return { ok: false, status: m?.[1] === "invalid_grant" ? 409 : 400, error: m ? m[2] : "internal error" }; }
      }
      if (op.startsWith("join_")) return await joinOp(dir, peer, op, args); // approve / deny a machine waiting to join (src/join.ts)
      if (op === "revoke_self") { try { return { ok: true, result: await dir.revokeSelf(peer) }; } catch (e: any) { return { ok: false, status: 400, error: String(e?.message ?? e) }; } }
      try {
        const s = spaceFor(args.space);
        if (op === "approval_wait" && typeof args.id === "string") args = { ...args, id: args.id.split(".").pop() }; // full page id -> local id
        const r = await spaceStub(env, acct, s).run(peer, op, args, reqId) as Res;
        if (!r.ok && r.status >= 500) r.error = `${r.error} (request_id ${reqId}: the owner, or you while Experimental is on, can look it up with relay_logs)`;
        if (op === "approval_page" && r.ok) { const id = `${acct}.${s}.${r.result.id}`; r.result = { ...r.result, id, path: `/approve/${id}` }; }
        return r;
      }
      catch (e: any) { if (Array.isArray(e)) return { ok: false, status: e[0], error: e[1] };
        console.error(`op ${op} (${reqId}):`, e?.stack ?? e); await keepErr(env, acct, DL.fromError(e, { source: "server", route: `op ${op}`, request_id: reqId }));
        return { ok: false, status: 500, error: `internal error (request_id ${reqId}: the owner, or you while Experimental is on, can look it up with relay_logs)`, logged: true }; }
    };
    const out = (r: Res) => r.ok ? json(r) : r.status >= 500 ? new Response(JSON.stringify({ ok: false, error: r.error, request_id: reqId }), { status: r.status, headers: { "content-type": "application/json", ...(r.logged ? { "x-kitebook-logged": "1" } : {}) } }) : r.retry_after ? new Response(JSON.stringify({ ok: false, error: r.error, retry_after: r.retry_after }), { status: r.status, headers: { "content-type": "application/json", "retry-after": String(r.retry_after) } }) : json({ ok: false, error: r.error }, r.status);

    if (url.pathname === "/v1/stream") {
      let s: string; try { s = spaceFor(url.searchParams.get("space") ?? undefined); } catch (e: any) { return json({ ok: false, error: e[1] }, e[0]); }
      const h = new Headers(req.headers); h.set("x-relay-peer", JSON.stringify(peer));
      return spaceStub(env, acct, s).fetch(new Request(req.url, { headers: h }));
    }
    if (url.pathname === "/mcp") {
      if (req.method === "GET") return new Response("SSE not offered; use POST", { status: 405 });
      if (req.method === "DELETE") return new Response(null, { status: 204 });
      const body: any = await req.json().catch(() => null);
      // MCP Events run in the space's Durable Object, scoped to this peer's token, space and verbs.
      const evSpace = (params: any): string | { code: number; message: string; data: any } => {
        if (!typeOf(params?.name)) return { code: CODES.NotFound, message: "NotFound", data: { kind: "event" } };
        try { return spaceFor(params?.arguments?.space); }
        catch (e: any) { return e[0] === 403 ? { code: CODES.Forbidden, message: "Forbidden", data: { reason: e[1] } } : { code: CODES.InvalidParams, message: "InvalidParams", data: { reason: e[1] } }; }
      };
      const ev: EvCall = async (method, params) => { const s = evSpace(params); return typeof s === "string" ? await spaceStub(env, acct, s).events(peer, method, params) : { error: s }; };
      const msgs = Array.isArray(body) ? body : [body ?? {}];
      let infoP: Promise<any> | null = null; // the account title costs a Dir read, so only initialize/server/discover pay it
      const info = () => (infoP ??= dir.title().catch(() => null).then((t: any) => serverInfo(env, t)));
      const bad = msgs.find(m => mcpNameMismatch(req, m));
      if (bad) return json({ jsonrpc: "2.0", id: bad.id ?? null, error: { code: CODES.HeaderMismatch, message: "HeaderMismatch", data: { header: "Mcp-Name" } } }, 400);
      if (!Array.isArray(body) && body?.method === "events/stream" && body.id !== undefined) { // push: the response is an SSE stream
        const s = evSpace(body.params); if (typeof s !== "string") return json({ jsonrpc: "2.0", id: body.id, error: s });
        return spaceStub(env, acct, s).fetch(new Request("https://space/events/stream", { method: "POST",
          headers: { "content-type": "application/json", "x-relay-peer": JSON.stringify(peer) }, body: JSON.stringify({ id: body.id, params: body.params ?? {} }) }));
      }
      if (Array.isArray(body)) { const outs = (await Promise.all(body.map(m => mcp(m, call, ev, info)))).filter(Boolean); return outs.length ? json(outs) : new Response(null, { status: 202 }); }
      const o = await mcp(body ?? {}, call, ev, info); return o ? json(o) : new Response(null, { status: 202 });
    }
    if (url.pathname === "/v1") return json({ ops: Object.fromEntries(Object.entries(OPS).map(([k, d]) => [k, { desc: d.desc, params: jsonSchema(d) }])) });
    const m = url.pathname.match(/^\/v1\/([a-z_]+)$/);
    if (m && req.method === "POST") return out(await call(m[1], await req.json().catch(() => ({}))));
    // GET for read-only ops, for agents that can only fetch URLs: /v1/read?path=x&space=y (numbers/bools auto-typed)
    if (m && req.method === "GET") {
      if (!READ_OPS.includes(m[1])) return json({ ok: false, error: `${m[1]} needs POST` }, 405);
      const args: any = {};
      for (const [k, v] of url.searchParams) if (k !== "token") args[k] = /^-?\d+$/.test(v) && OPS[m[1]]?.params[k]?.[0] === "number" ? Number(v) : v === "true" ? true : v === "false" ? false : v;
      return out(await call(m[1], args));
    }
    return json({ ok: false, error: "not found" }, 404);
}
