// Ingress lockdown (auth spec v2, phase 1): the public edge (requests through a tunnel or reverse proxy) serves only what agents, assistants
// and the OAuth dance need; the dashboard, Settings, /admin and every other route answer the same 404 as an unknown path unless the request
// carries an owner browser session. Nothing here authenticates anyone: it only decides which routes the public may even see. Every route
// still checks its own credential as before.
//
// Which listener a request came in on. Coming from 127.0.0.1 proves nothing (cloudflared and local agents connect from there too), and a
// client controls Host and X-Forwarded-*. So trust comes from the listener itself:
//   plain workerd (selfhost/config.capnp): two sockets, `http` (local: the Mac's runner, its agents, its own browser) and `edge` (the only
//     one a tunnel or proxy should point at). Each socket injects x-kitebook-ingress (local | edge), and workerd removes whatever value the
//     client sent first, so nobody can forge it. The config also binds INGRESS_STAMPED=1: only then is the header believed.
//   cf dev (development only): the dev server's own middleware (vite.config.ts) stamps the same header on every request it passes on
//     (edge when the request as it arrived had a public Host or a proxy's headers).
//   Cloudflare Workers / a custom config without the stamp: there is no local listener, so every request is edge.
// Headers may only ever DOWNGRADE trust: a stamped-local request whose Host isn't a loopback name, or that carries a proxy's marks
// (cf-connecting-ip, x-forwarded-for, forwarded, ...), came through a tunnel or proxy still pointed at the local port (an install from
// before the edge listener, a named tunnel set up by hand, a DNS-rebinding page) and is treated as edge.
// SaaS: nothing here names an owner. The setting lives per account (tenant key, default "owner"), and who counts as the owner is the
// IngressOwner seam below (the device-identity phase and a hosted module fill it in).

export const INGRESS_HEADER = "x-kitebook-ingress";
export type Ingress = "local" | "edge";
import { ROOT_ACCOUNT } from "../client/account.ts";
import { DEFAULT_TENANT } from "./principal.ts"; // one tenant key with device identity (src/principal.ts)
export { DEFAULT_TENANT };
export const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;
// a proxy or tunnel in between (each of these is added by cloudflared, ngrok, nginx, Caddy, Traefik or Cloudflare itself)
export const PROXY_MARKS = ["cf-connecting-ip", "cf-ray", "cf-visitor", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "true-client-ip", "cdn-loop", "via", "ngrok-trace-id"];
// the dev server (`cf dev`) only: Vite replaces import.meta.env.DEV with false in every build (`cf build`: workerd and Cloudflare)
const DEV_SERVER = (() => { try { return (import.meta.env.DEV as unknown) === true; } catch { return false; } })();

// this server has a local listener (two sockets on workerd, or the dev server); without one every request is edge
export const hasLocalListener = (env: any) => env?.INGRESS_STAMPED === "1" || DEV_SERVER;
export function ingressOf(req: Request, env: any): Ingress {
  if (!hasLocalListener(env)) return "edge";
  if (req.headers.get(INGRESS_HEADER) !== "local") return "edge";
  let host = ""; try { host = new URL(req.url).hostname; } catch { return "edge"; }
  if (!LOOPBACK.test(host)) return "edge"; // Host only downgrades: a public name on the local port came through a proxy or a rebinding page
  // the dev server checks proxy headers itself, on the request as it arrived (vite.config.ts): its Workers runtime adds cf-connecting-ip
  // and x-forwarded-host to every request it passes on
  if (env?.INGRESS_STAMPED === "1" && PROXY_MARKS.some(h => req.headers.has(h))) return "edge";
  return "local";
}

// ---------- the public edge allowlist ----------
const ACCT = "[a-z0-9][a-z0-9-]{1,30}", U = `(?:/u/${ACCT})?`;
// Each group in plain words, so adding a route is a deliberate, reviewed line. The labels are short (Settings lists them, and the Worker
// bundle has a size budget); in full: /health is what the tunnel helper probes; /mcp and /v1 (+ /v1/stream) need a token or OAuth access
// token; the passkey routes only sign an existing passkey in to approve an app (never register one); /consent needs the owner's session
// itself; /oauth/* keeps existing app connections refreshing; /open is a device-signed one-time link and its assets; an invite's code is its
// credential (single use); join/claim ask with a code and poll (device-key-signed; an owner device or the server shell approves); the
// installer and runner files are public source; agent docs carry no account data.
const EDGE_ROUTES: [RegExp, string][] = [
  [/^\/health$/, "health check"],
  [new RegExp(`^${U}/mcp$`), "MCP (token or OAuth)"],
  [/^\/v1(\/[a-z_]+)?$/, "the API (token)"],
  [new RegExp(`^/\\.well-known/(oauth-authorization-server|oauth-protected-resource|openid-configuration)(${U}(/api/auth|/mcp)?)?$`), "OAuth metadata"],
  [new RegExp(`^${U}/api/auth/(oauth2/[a-z-]+|mcp/[a-z-]+|jwks|token|\\.well-known/[a-z-]+)$`), "OAuth endpoints"],
  [new RegExp(`^${U}/api/auth/passkey/(generate-authenticate-options|verify-authentication)$`), "passkey sign-in to approve an app"],
  [new RegExp(`^${U}/consent$`), "the app consent page"],
  [new RegExp(`^${U}/(authorize|token|register)$|^/connect$`), "OAuth short names, /connect"],
  [/^\/oauth\/(token|revoke|register|authorize|device_authorization)$/, "older OAuth endpoints"],
  [/^\/open(\/[A-Za-z0-9._-]+)?$/, "kitebook open links"],
  [/^\/join\/inv_[A-Za-z0-9_.-]+$/, "invite links"],
  [/^\/(join|claim)\/(start|poll)$|^\/claim$/, "kitebook join / login by code"],
  [/^\/(install\.sh|runner-files\/[a-z0-9.-]+)$/, "the runner installer"],
  [/^\/(llms\.txt|openapi\.json|setup|setup\.md)$/, "agent docs"],
];
// The one dashboard page the edge serves without a session: the sign-in step of an OAuth connection (Better Auth sends a signed-out browser
// to /start with its signed authorization request) and the sign-in calls that page makes. Signed in, the owner's session opens the rest.
export const EDGE_SIGNIN_OPS = ["link_signin", "login_ask", "login_poll", "login_password", "signin"];
const START = new RegExp(`^${U}/start$`);
// The approval page POST /connect and the device grant hand out (verification_uri). Its GET is a page; its POST (view / approve / deny)
// still checks its own credential in src/oauth.ts devicePage: the owner device's master-password (presence) assertion bound to that one
// code, or the owner's session. A recovery code (admin_key) is never tried from the public edge (no guessing it from the internet): that
// needs this computer or a signed-in owner.
const DEVICE = /^\/device$/;
export const oauthSigninQuery = (q: URLSearchParams) => !!(q.get("client_id") && q.get("sig") && q.get("redirect_uri"));
// true = the public may reach this path (it still checks its own credential). body: the parsed JSON of a POST /start, if any
export function edgeAllowed(path: string, method: string, q: URLSearchParams, body?: any): boolean {
  if (path === "/" && method === "GET") return true; // the agent guide (a browser is sent on to /start, which is then 404)
  if (EDGE_ROUTES.some(([re]) => re.test(path))) return true;
  if (DEVICE.test(path)) return method === "GET" || (method === "POST" && !!body && body.admin_key == null);
  if (START.test(path)) return method === "GET" ? oauthSigninQuery(q) : method === "POST" && EDGE_SIGNIN_OPS.includes(String(body?.op ?? ""));
  return false;
}
export const edgeRoutes = () => [...EDGE_ROUTES, [DEVICE, "the app approval page /connect links to (master password)"] as [RegExp, string]].map(([re, why]) => ({ path: re.source, why }));

// ---------- the setting ----------
// ingress.lockdown per account and tenant (acct key `ingress:lockdown:<tenant>`): "on" | "off"; absent = "auto". A new install writes "on"
// when its directory is created (src/dir.ts); an install from before this phase has no key, so it stays open ("auto") until an owner
// device exists, and nobody is locked out by the upgrade. "on" only bites where the owner still has a way in that doesn't need the public
// dashboard: a local listener (this computer) or an owner device (`kitebook open` -> /open). A server strangers sign up on (OPEN_SIGNUP /
// HOSTED) shows its signup page publicly, so it isn't locked here; a hosted module brings its own policy.
export type Lockdown = "on" | "off" | "auto";
export const lockdownKey = (tenant = DEFAULT_TENANT) => `ingress:lockdown:${tenant}`;
export type LockdownView = { setting: Lockdown; enforced: boolean; why: string };
export function lockdownView(setting: Lockdown, c: { localListener: boolean; ownerDevice: boolean; multi: boolean }): LockdownView {
  if (c.multi) return { setting, enforced: false, why: "public signup keeps the sign-in page public" };
  if (setting === "off") return { setting, enforced: false, why: "turned off: the dashboard is public (sign-in still needed)" };
  if (setting === "auto") return c.ownerDevice ? { setting, enforced: true, why: "on: your owner device is set up" }
    : { setting, enforced: false, why: "off until this computer is your owner device" };
  if (c.localListener || c.ownerDevice) return { setting, enforced: true, why: "on: open the dashboard on this computer" };
  return { setting, enforced: false, why: "waiting: no local listener or owner device yet (locking would lock you out)" };
}
export const multiAccount = (env: any) => env?.OPEN_SIGNUP === "1" || env?.HOSTED === "1";

// ---------- who the owner is: the seam the device-identity phase (and a hosted module) fills in ----------
// hasOwnerSession: this request carries a live owner browser session: sessionOwner runs src/principal.ts's providers (a device session
// minted by `kitebook open` -> /open first, then the legacy Better Auth session; a hosted module registers its own). ownerDeviceExists: the
// tenant has had an owner device (src/devices.ts `enforced`, the same flag that turns the presence gate on; it stays set after the last
// device is revoked, so the lockdown never quietly reopens), absent before the first runner enrolls, so "auto" stays open on an upgrade.
export interface IngressOwner {
  hasOwnerSession(req: Request, dir: (acct: string) => any): Promise<boolean>;
  ownerDeviceExists(dir: any, tenant: string): Promise<boolean>;
}
let owner: IngressOwner = {
  async hasOwnerSession(req, dir) { const { sessionOwner } = await import("./session.ts"); return !!(await sessionOwner(req, dir).catch(() => null)); }, // lazy: keeps this module free of the auth stack
  async ownerDeviceExists(dir, tenant) { return !!(await dir.dev("enforced", tenant).catch(() => false)); },
};
export const ingressOwner = () => owner;
export function setIngressOwner(o: Partial<IngressOwner>) { owner = { ...owner, ...o }; }

// the account whose setting a public path falls under (hosted: /u/<acct>/...; else the operator's root account)
export const acctOfPath = (p: string) => p.match(new RegExp(`^(?:/\\.well-known/[a-z-]+)?/u/(${ACCT})(?:/|$)`))?.[1] ?? ROOT_ACCOUNT;
// owner_device: what the IngressOwner seam saw (Settings and the smoke can tell "no owner device yet" from "public signup wins")
export async function lockdownFor(env: any, dir: any): Promise<LockdownView & { owner_device: boolean }> {
  const st = await dir.ingressSetting(DEFAULT_TENANT).catch(() => ({ setting: "on" as Lockdown })); // can't read it: fail closed
  const od = await owner.ownerDeviceExists(dir, DEFAULT_TENANT);
  return { ...lockdownView(st.setting, { localListener: hasLocalListener(env), ownerDevice: od, multi: multiAccount(env) }), owner_device: od };
}

// The gate the front door (src/index.ts) runs first on every edge request: null = go on; else the same 404 an unknown path gets, so a
// prober can't tell a hidden route from a missing one.
export const NOT_FOUND = () => new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } });
export async function edgeGate(req: Request, env: any, url: URL, dir: (acct: string) => any): Promise<Response | null> {
  let body: any;
  if (req.method === "POST" && (START.test(url.pathname) || DEVICE.test(url.pathname))) { const cl = Number(req.headers.get("content-length") ?? 0); if (cl <= 65536) body = await req.clone().json().catch(() => null); }
  if (edgeAllowed(url.pathname, req.method, url.searchParams, body)) return null;
  if (!(await lockdownFor(env, dir(acctOfPath(url.pathname)))).enforced) return null;
  if (await owner.hasOwnerSession(req, dir)) return null;
  return NOT_FOUND();
}

// ?token= links were removed (spec: "no ?token= links"): a credential in a URL lands in proxy, tunnel and browser logs. A request that
// still sends one gets a 401 that says how to send it instead, never a silent pass.
export const QUERY_TOKEN_HINT = "?token= in the URL is no longer accepted (URLs end up in logs). Send the token as a header: Authorization: Bearer <token>, or connect with OAuth";
export const queryToken = (url: URL) => url.searchParams.has("token");
