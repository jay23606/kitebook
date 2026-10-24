// Ingress lockdown (src/ingress.ts): which listener a request came in on, what the public edge may reach, and when the lockdown bites.
// Run: bun test client/ingress.test.ts
import { test, expect } from "bun:test";
import { ingressOf, edgeAllowed, lockdownView, edgeGate, setIngressOwner, acctOfPath, queryToken, INGRESS_HEADER, EDGE_SIGNIN_OPS } from "../src/ingress.ts";

const STAMPED = { INGRESS_STAMPED: "1" };
const rq = (url: string, h: Record<string, string> = {}, init: RequestInit = {}) => new Request(url, { ...init, headers: h });

test("only a stamped listener makes a request local; no stamper = everything is edge", () => {
  expect(ingressOf(rq("http://127.0.0.1:7820/start", { [INGRESS_HEADER]: "local" }), STAMPED)).toBe("local");
  expect(ingressOf(rq("http://127.0.0.1:7821/start", { [INGRESS_HEADER]: "edge" }), STAMPED)).toBe("edge");
  expect(ingressOf(rq("http://127.0.0.1:7820/start"), STAMPED)).toBe("edge"); // no stamp: edge
  expect(ingressOf(rq("http://127.0.0.1:7820/start", { [INGRESS_HEADER]: "LOCAL" }), STAMPED)).toBe("edge");
  // Cloudflare Workers / a custom config without INGRESS_STAMPED: a client-sent stamp is ignored
  expect(ingressOf(rq("http://127.0.0.1:7820/start", { [INGRESS_HEADER]: "local" }), {})).toBe("edge");
});

test("Host and proxy headers can only downgrade a local request, never upgrade an edge one", () => {
  const L = { [INGRESS_HEADER]: "local" };
  expect(ingressOf(rq("http://kb.example.com/settings", L), STAMPED)).toBe("edge"); // public name on the local port (old tunnel / DNS rebinding)
  expect(ingressOf(rq("http://localhost:7820/settings", L), STAMPED)).toBe("local");
  expect(ingressOf(rq("http://[::1]:7820/settings", L), STAMPED)).toBe("local");
  for (const h of ["cf-connecting-ip", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip", "cf-ray"])
    expect(ingressOf(rq("http://127.0.0.1:7820/settings", { ...L, [h]: "127.0.0.1" }), STAMPED)).toBe("edge");
  // forged on the edge socket: workerd already replaced the stamp with "edge"; loopback Host + XFF etc. change nothing
  expect(ingressOf(rq("http://127.0.0.1:7821/settings", { [INGRESS_HEADER]: "edge", "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "localhost" }), STAMPED)).toBe("edge");
});

test("the edge allowlist: apps and OAuth yes, dashboard and admin no", () => {
  const q = new URLSearchParams(), ok = (p: string, m = "GET") => edgeAllowed(p, m, q);
  for (const p of ["/health", "/mcp", "/u/acme/mcp", "/v1", "/v1/read", "/v1/stream", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server/api/auth", "/.well-known/oauth-protected-resource/u/acme/mcp", "/api/auth/oauth2/authorize", "/api/auth/oauth2/token", "/api/auth/oauth2/register",
    "/api/auth/jwks", "/u/acme/api/auth/oauth2/token", "/consent", "/u/acme/consent", "/oauth/token", "/open", "/llms.txt", "/install.sh", "/runner-files/runner.ts", "/join/inv_abc.def",
    "/join/start", "/join/poll", "/claim", "/claim/start", "/claim/poll", "/api/auth/passkey/generate-authenticate-options", "/api/auth/passkey/verify-authentication"]) expect([p, ok(p)]).toEqual([p, true]);
  for (const p of ["/start", "/settings", "/admin/list", "/admin/login_link", "/approve/root.main.123", "/signup", "/api/auth/get-session", "/api/auth/sign-out",
    "/api/auth/passkey/generate-register-options", "/api/auth/passkey/verify-registration", "/api/auth/list-sessions", "/u/acme/start", "/v1/../settings", "/mcpx", "/healthz", "/runner-files/../x", "/join/approve", "/join", "/claim/approve", "/claimx", "/admin/claim_approve", "/admin/join_approve"])
    expect([p, ok(p)]).toEqual([p, false]);
  expect(ok("/", "GET")).toBe(true); expect(ok("/", "POST")).toBe(false);
});

test("/start on the edge: only the OAuth sign-in step and its sign-in calls", () => {
  const signed = new URLSearchParams({ client_id: "c", sig: "s", redirect_uri: "https://claude.ai/cb", exp: "1" });
  expect(edgeAllowed("/start", "GET", signed)).toBe(true);
  expect(edgeAllowed("/u/acme/start", "GET", signed)).toBe(true);
  expect(edgeAllowed("/start", "GET", new URLSearchParams({ client_id: "c" }))).toBe(false);
  expect(edgeAllowed("/start", "GET", new URLSearchParams({ next: "/settings" }))).toBe(false);
  for (const op of EDGE_SIGNIN_OPS) expect(edgeAllowed("/start", "POST", new URLSearchParams(), { op })).toBe(true);
  for (const op of ["status", "act", "mint", "nonce", "policy_set", "revoke", "ingress_set", "devices", "connection", "tunnel_act", undefined]) expect(edgeAllowed("/start", "POST", new URLSearchParams(), { op })).toBe(false);
});

test("lockdown: on for new installs where the owner still has a way in; an upgrade stays open until an owner device exists", () => {
  const v = (s: any, c: any) => lockdownView(s, { localListener: false, ownerDevice: false, multi: false, ...c }).enforced;
  expect(v("on", { localListener: true })).toBe(true);
  expect(v("on", { ownerDevice: true })).toBe(true);
  expect(v("on", {})).toBe(false); // Cloudflare-only, no device yet: locking now would lock the owner out
  expect(v("auto", { localListener: true })).toBe(false); // upgrade: open until...
  expect(v("auto", { localListener: true, ownerDevice: true })).toBe(true); // ...an owner device exists
  expect(v("off", { localListener: true, ownerDevice: true })).toBe(false);
  expect(v("on", { localListener: true, multi: true })).toBe(false); // public signup server
  expect(lockdownView("auto", { localListener: true, ownerDevice: false, multi: false }).why).toMatch(/owner device/);
});

test("edgeGate: 404 for hidden routes without a session, pass with one, pass when not enforced", async () => {
  let setting = "on", session = false, device = false;
  const dir = () => ({ ingressSetting: async () => ({ setting }) });
  setIngressOwner({ hasOwnerSession: async () => session, ownerDeviceExists: async () => device });
  const go = async (path: string, init: RequestInit = {}) => { const u = new URL("https://kb.example.com" + path); return await edgeGate(new Request(u.href, init), STAMPED, u, dir); };
  const r = await go("/settings"); expect(r?.status).toBe(404); expect(await r!.json()).toEqual({ ok: false, error: "not found" });
  expect((await go("/admin/list", { method: "POST", body: "{}" }))?.status).toBe(404);
  expect(await go("/mcp", { method: "POST", body: "{}" })).toBeNull();
  expect(await go("/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "login_ask" }) })).toBeNull();
  expect((await go("/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "status" }) }))?.status).toBe(404);
  session = true; expect(await go("/settings")).toBeNull(); session = false;
  setting = "auto"; expect(await go("/settings")).toBeNull(); device = true; expect((await go("/settings"))?.status).toBe(404);
  setting = "off"; expect(await go("/settings")).toBeNull();
  // a directory that can't be read fails closed
  const broken = () => ({ ingressSetting: async () => { throw new Error("down"); } });
  const u = new URL("https://kb.example.com/settings"); expect((await edgeGate(new Request(u.href), STAMPED, u, broken))?.status).toBe(404);
});

test("tenant routing and ?token= detection", () => {
  expect(acctOfPath("/u/acme/start")).toBe("acme"); expect(acctOfPath("/settings")).toBe("root"); expect(acctOfPath("/.well-known/oauth-authorization-server/u/acme/api/auth")).toBe("acme");
  expect(queryToken(new URL("https://x/v1/read?path=a&token=rk_1"))).toBe(true); expect(queryToken(new URL("https://x/v1/read?path=a"))).toBe(false);
});

// /connect hands out ${o}/device?user_code=... (verification_uri_complete), ${o}/token and ${o}/mcp: each must open from the public edge
// (owner, 2026-10-23 04:13: the approval page was 404 through the tunnel). Its POST checks its own credential; never a recovery code from the edge.
test("edge: every URL POST /connect returns is reachable; POST /device only without an admin_key", () => {
  const q = new URLSearchParams();
  for (const p of ["/connect", "/device", "/token", "/mcp"]) expect(edgeAllowed(p, p === "/device" ? "GET" : "POST", p === "/device" ? new URLSearchParams({ user_code: "BCDF-GHJK" }) : q)).toBe(true);
  expect(edgeAllowed("/device", "POST", q, { op: "approve", user_code: "BCDF-GHJK", presence: "x.y" })).toBe(true);
  expect(edgeAllowed("/device", "POST", q, { op: "view", user_code: "BCDF-GHJK" })).toBe(true); // devicePage still answers 401 without the owner
  expect(edgeAllowed("/device", "POST", q, { op: "approve", user_code: "BCDF-GHJK", admin_key: "guess" })).toBe(false);
  expect(edgeAllowed("/device", "POST", q)).toBe(false); expect(edgeAllowed("/device/x", "GET", q)).toBe(false);
});
