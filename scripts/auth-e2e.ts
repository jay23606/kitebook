// End-to-end check of Kitebook's sign-in on Better Auth (src/auth.ts) against a running Kitebook (cf dev, or plain workerd self-host):
// discovery, the owner's sign-in (kitebook open, passkey with a software authenticator, a sign-in request approved from a signed-in
// browser), apps connecting by DCR and CIMD through Kitebook's consent page (3 presets) to /mcp and /v1, consent asked every time unless the
// app has a grant, live grant checks (removal stops an unexpired token at once, WebSocket included), refresh, revoke, the CIMD SSRF guard,
// a CIMD client shared by two installs, hosted per-account issuers, and old clients told what to do. Prints "PASS ..." lines (smoke.sh
// counts them); exits 1 on the first failure.
//   BASE=http://127.0.0.1:<port> RUNNER=<runner token for space main> ADMIN=<admin token> [HOSTED_ACCT=<new account name>] [QUICK=1] bun scripts/auth-e2e.ts
import "../client/brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
const BASE = process.env.BASE!, RUNNER = process.env.RUNNER!, ADMIN = process.env.ADMIN ?? "", QUICK = process.env.QUICK === "1";
if (!BASE || !RUNNER) throw new Error("BASE=http://127.0.0.1:<port> RUNNER=<runner token>");
const te = new TextEncoder();
const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as any).toString("base64url");
const unb = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const sha = async (b: Uint8Array | string) => new Uint8Array(await crypto.subtle.digest("SHA-256", (typeof b === "string" ? te.encode(b) : b) as any));
let n = 0; const pass = (m: string) => { n++; console.log("PASS auth: " + m); };
const die = (m: string, x?: any): never => { console.log("FAIL auth: " + m + (x !== undefined ? " :: " + (typeof x === "string" ? x : JSON.stringify(x)).slice(0, 800) : "")); process.exit(1); };
const ok = (c: any, m: string, x?: any) => c ? pass(m) : die(m, x);
// plain workerd sometimes closes a kept-alive socket just as bun reuses it (never under cf dev): retry once, the request never reached the app
const go = (u: string, init: RequestInit) => fetch(u, init).catch((e: any) => { if (e?.code !== "ECONNRESET") throw e; console.log("note: ECONNRESET on " + u + ", retried once"); return fetch(u, { ...init, keepalive: false }); });

// a browser: a cookie jar, Origin on writes, navigation headers on GETs
class Browser {
  jar = new Map<string, string>(); ua: string;
  constructor(ua = "Mozilla/5.0 (Macintosh) Chrome/140") { this.ua = ua; }
  async go(path: string, init: RequestInit = {}) {
    const h = new Headers(init.headers); h.set("user-agent", this.ua); if (this.jar.size) h.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (init.method && init.method !== "GET") h.set("origin", BASE); else if (!h.has("accept")) { h.set("accept", "text/html,application/xhtml+xml"); h.set("sec-fetch-mode", "navigate"); h.set("sec-fetch-dest", "document"); }
    const r = await go(path.startsWith("http") ? path : BASE + path, { ...init, headers: h, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(";"), i = kv.indexOf("="); const k = kv.slice(0, i), v = kv.slice(i + 1); if (/max-age=0/i.test(c) || v === "") this.jar.delete(k); else this.jar.set(k, v); }
    return r;
  }
  post(path: string, body: any) { return this.go(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
  start(body: any) { return this.post("/start", body).then(r => r.json() as any); }
  signedIn() { return [...this.jar.keys()].some(k => /relay-[a-z0-9-]+\.session_token$/.test(k)); }
}
const v1 = async (tok: string, op: string, body: any = {}) => { const r = await go(BASE + "/v1/" + op, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; };

// ---- a software passkey (scripts/soft-passkey.ts) ----
import { SoftPasskey } from "./soft-passkey.ts";

// ---- 0. discovery, the way an MCP client does it ----
async function discover(mcp: string) {
  const r0 = await go(BASE + mcp, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) });
  const wa = r0.headers.get("www-authenticate") ?? ""; if (r0.status !== 401 || !/resource_metadata="([^"]+)"/.test(wa)) die(`${mcp} without a token: 401 + resource_metadata`, wa);
  const prm: any = await (await go(wa.match(/resource_metadata="([^"]+)"/)![1], {})).json();
  const iss = prm.authorization_servers?.[0], asm: any = await (await go(String(iss).replace(/^(https?:\/\/[^/]+)(.*)$/, "$1/.well-known/oauth-authorization-server$2"), {})).json();
  return { prm, iss, asm };
}
const { prm, iss, asm } = await discover("/mcp");
ok(prm.resource === BASE + "/mcp" && iss === BASE + "/api/auth", "discovery: /mcp 401 names its protected-resource metadata (RFC 9728), which names this Kitebook's Better Auth as the issuer", prm);
ok(asm.issuer === iss && asm.client_id_metadata_document_supported === true && !!asm.registration_endpoint && asm.code_challenge_methods_supported?.includes("S256") && asm.authorization_response_iss_parameter_supported,
  "authorization server metadata (RFC 8414): CIMD supported, DCR as the fallback, PKCE S256, iss on the callback", asm);

// ---- 1. the owner signs in: kitebook open (the runner's single-use link) ----
const link = async () => { const r = await v1(RUNNER, "login_link"); if (!r.body.ok) die("runner login_link", r.body); return String(r.body.result.url).match(/#login=(ll\.[a-z0-9-]+\.[A-Za-z0-9_-]+)/)![1]; };
const owner = new Browser(), lk = await link();
const so = await owner.go("/settings"); ok(so.status === 302 && /\/start\?next=/.test(so.headers.get("location") ?? ""), "signed out: Settings sends the browser to /start first", so.status);
const li = await owner.start({ op: "link_signin", token: lk });
ok(li.ok && owner.signedIn() && [...owner.jar.keys()].includes("relay-root.session_token"), "kitebook open: the link signs the browser in with a Better Auth session (one cookie, relay-root.session_token)", { li, jar: [...owner.jar.keys()] });
const again = await new Browser().start({ op: "link_signin", token: lk }); ok(!again.ok && /already used/.test(again.error), "the same link a second time: refused in plain words (single use)", again);
ok((await owner.go("/settings")).status === 200, "the session opens Settings");
const me: any = await (await owner.go("/api/auth/get-session")).json(); ok(me?.user?.email === "owner@relay.invalid" && me?.session?.expiresAt && Date.parse(me.session.expiresAt) > Date.now() + 29 * 86400_000, "the session is the account owner's, for 30 days", me);

// ---- 2. passkey: added from the signed-in browser, then signs a fresh browser in with no account name ----
const host = new URL(BASE).hostname, pk = new SoftPasskey(BASE, host);
const anonRo = await new Browser().go("/api/auth/passkey/generate-register-options"); ok(anonRo.status === 401, "adding a passkey without a session: refused", anonRo.status);
const ro: any = await (await owner.go("/api/auth/passkey/generate-register-options?name=Kitebook")).json(); ok(!!ro.challenge && ro.rp?.id === host, "passkey registration options for this Kitebook (signed-in only)", ro);
const vr = await owner.post("/api/auth/passkey/verify-registration", { response: await pk.create(ro), name: "test laptop" });
ok(vr.status === 200, "passkey added (attestation verified)", await vr.text());
const fresh = new Browser("Mozilla/5.0 (iPhone) Safari/605"), ao: any = await (await fresh.go("/api/auth/passkey/generate-authenticate-options")).json(); ok(!!ao.challenge, "passkey sign-in options with no account name", ao);
const bad = await fresh.post("/api/auth/passkey/verify-authentication", { response: await pk.get(ao, true) }); ok(bad.status >= 400 && !fresh.signedIn(), "a tampered passkey signature is refused", bad.status);
const ao2: any = await (await fresh.go("/api/auth/passkey/generate-authenticate-options")).json();
const va = await fresh.post("/api/auth/passkey/verify-authentication", { response: await pk.get(ao2) }); ok(va.status === 200 && fresh.signedIn(), "the owner signs in with the passkey (ES256)", await va.text());
ok((await fresh.go("/settings")).status === 200, "the passkey session opens Settings");
const dv = await owner.start({ op: "devices" });
ok(dv.ok && dv.result.passkeys.some((p: any) => p.label === "test laptop") && dv.result.devices.length >= 2 && dv.result.devices.some((d: any) => d.this && /Mac/.test(d.label)) && dv.result.devices.some((d: any) => /iPhone/.test(d.label)) && dv.result.readd_passkey === false,
  "Settings lists the browsers signed in (this one marked) and the passkey", dv);

// ---- 3. a sign-in request approved from a browser already signed in (kitebook approve <code> on the Mac is the smoke's keyless section) ----
const third = new Browser("Mozilla/5.0 (Windows) Firefox/140"), ask = await third.start({ op: "login_ask", account: "root" });  // open signup (and hosted) need the account named: there is no default "root"
ok(ask.ok && /^[A-Z]{4}-[A-Z]{4}$/.test(ask.result.code) && !("phone" in ask.result), "a sign-in request: a code to approve with kitebook approve (no phone path)", ask);
const lst = await owner.start({ op: "devices" }), lr = lst.result.logins.find((l: any) => l.code === ask.result.code); ok(!!lr, "the signed-in browser sees the request waiting", lst.result.logins);
const nn = (await owner.start({ op: "nonce" })).result.nonce, dec = await owner.start({ op: "login_decide", id: lr.id, yes: true, nonce: nn }); ok(dec.ok, "approved from the signed-in browser", dec);
const pl = await third.start({ op: "login_poll", poll: ask.result.poll }); ok(pl.ok && pl.result.state === "approved" && third.signedIn(), "the waiting browser gets its own session", pl);
const thirdId = (await owner.start({ op: "devices" })).result.devices.find((d: any) => /Windows/.test(d.label))?.id;
const rmd = await owner.start({ op: "device_remove", id: thirdId }); ok(rmd.ok && (await third.go("/settings")).status === 302, "Settings signs that browser out (its session is gone)", rmd);

// ---- 4. apps: DCR (Pi / Codex / Claude Code today) and CIMD, through Kitebook's consent page ----
const pkce = async () => { const v = b64u(crypto.getRandomValues(new Uint8Array(32))); return { v, c: b64u(await sha(v)) }; };
const authz = (a: any, clientId: string, redirect: string, p: { c: string }, state: string, mcp = "/mcp") => a.authorization_endpoint + "?" + new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, scope: "openid offline_access kitebook", state, code_challenge: p.c, code_challenge_method: "S256", resource: BASE + mcp });
const token = (a: any, form: Record<string, string>) => go(a.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
async function connect(label: string, clientId: string, redirect: string, body: any, br: Browser, o: { a?: any; mcp?: string; consent?: string; expectPage?: boolean } = {}) {
  const a = o.a ?? asm, mcp = o.mcp ?? "/mcp", cpath = o.consent ?? "/consent", p = await pkce();
  const r = await br.go(authz(a, clientId, redirect, p, "st-" + label, mcp)); let loc = r.headers.get("location") ?? "", cb: string;
  if (o.expectPage === false) { // Better Auth keeps no consent of its own: it always asks Kitebook's page, which answers at once for an app with a grant
    const c = new URL(loc, BASE).pathname === cpath ? await br.go(new URL(loc, BASE).pathname + new URL(loc, BASE).search) : r; loc = c.headers.get("location") ?? "";
    ok(c.status === 302 && loc.startsWith(redirect), `${label}: an app with a grant in Settings signs in again with no consent page`, { st: c.status, loc }); cb = loc; }
  else {
    ok(r.status === 302 && new URL(loc, BASE).pathname === cpath, `${label}: signed in, authorize goes to Kitebook's consent page`, { st: r.status, loc, body: r.status !== 302 ? await r.text() : "" });
    const pg = await br.go(new URL(loc, BASE).pathname + new URL(loc, BASE).search), html = await pg.text();
    ok(pg.status === 200 && /Read everything, save to shared memory, send tasks \(recommended\)/.test(html) && /Just this folder/.test(html) && /send tasks to your Mac/.test(html) && /Read only/.test(html) && !/account key|admin key|owner pin/i.test(html), `${label}: the consent page shows the 3 choices in plain words`);
    const cr = await br.post(cpath, { ...body, oauth_query: new URL(loc, BASE).search.slice(1) }), cj: any = await cr.json();
    ok(cr.status === 200 && typeof cj.redirect === "string" && cj.redirect.startsWith(redirect) && /can/.test(cj.granted ?? ""), `${label}: Approve (${body.choice}) writes the grant and sends the browser back to the app`, cj); cb = cj.redirect;
  }
  const back = new URL(cb); ok(back.searchParams.get("state") === "st-" + label && !!back.searchParams.get("code") && back.searchParams.get("iss") === a.issuer, `${label}: code + state + iss (RFC 9207) on the callback`, cb);
  const tr = await token(a, { grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: redirect, client_id: clientId, code_verifier: p.v, resource: BASE + mcp });
  const t: any = await tr.json(); ok(tr.status === 200 && t.access_token?.split(".").length === 3 && !!t.refresh_token, `${label}: token (PKCE) -> JWT access token + refresh token`, t);
  return { ...t, code: back.searchParams.get("code"), verifier: p.v };
}
const mcpCall = async (tok: string, method: string, params?: any, mcp = "/mcp") => { const r = await go(BASE + mcp, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }) }); return { status: r.status, www: r.headers.get("www-authenticate") ?? "", body: await r.json().catch(() => ({})) as any }; };

// signed out: Better Auth sends the browser to /start with its signed request; /start sends it straight back once signed in
const reg = await go(asm.registration_endpoint, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" }, body: JSON.stringify({ client_name: "Pi", redirect_uris: ["http://127.0.0.1:53682/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
const rc: any = await reg.json(); ok(reg.status === 201 || reg.status === 200, "DCR: a public loopback client (Pi) registers itself, no secret; registering grants nothing", rc);
const pso = await new Browser().go(authz(asm, rc.client_id, "http://127.0.0.1:53682/callback", await pkce(), "x")), sloc = new URL(pso.headers.get("location") ?? "/", BASE);
const sp = await (await new Browser().go(sloc.pathname + sloc.search)).text();
ok(pso.status === 302 && sloc.pathname === "/start" && sloc.searchParams.get("sig") && /"oauth":"\/api\/auth\/oauth2\/authorize\?[^"]*client_id=/.test(sp) && !/"oauth":"[^"]*sig=/.test(sp),
  "signed out: authorize -> /start, which returns to the app's approval right after sign-in", { st: pso.status, loc: sloc.href });
const pi = await connect("Pi (DCR)", rc.client_id, "http://127.0.0.1:53682/callback", { choice: "folder", folder: "kb/pi" }, owner);
const init = await mcpCall(pi.access_token, "initialize"); ok(init.status === 200 && init.body.result?.protocolVersion, "Pi: /mcp initialize with the token", init.body);
const who = await v1(pi.access_token, "whoami");
ok(who.status === 200 && /^pi(-\d+)?$/.test(who.body.result.name) && who.body.result.kind === "coding_agent" && JSON.stringify(who.body.result.spaces) === '[{"space":"main","verbs":["read","write"],"paths":["kb/pi/**"]}]',
  
  "Pi: /v1 takes the token too; access = Just this folder (kb/pi/**), from the consent, not the scope string", who.body);
const PI = who.body.result.name;
const w1 = await v1(pi.access_token, "write", { path: "kb/pi/notes.md", content: "hi" }), w2 = await v1(pi.access_token, "write", { path: "shared/x.md", content: "no" });
ok(w1.body.ok && !w2.body.ok, "Pi: writing inside kb/pi works, outside is refused (checked per call)", [w1.body, w2.body]);
const rf = await token(asm, { grant_type: "refresh_token", refresh_token: pi.refresh_token, client_id: rc.client_id, resource: BASE + "/mcp" }), rfj: any = await rf.json();
ok(rf.status === 200 && rfj.access_token && rfj.refresh_token !== pi.refresh_token && (await v1(rfj.access_token, "whoami")).status === 200, "Pi: refresh rotates the refresh token, and the new access token works", rfj);
const replay = await token(asm, { grant_type: "authorization_code", code: pi.code, redirect_uri: "http://127.0.0.1:53682/callback", client_id: rc.client_id, code_verifier: pi.verifier, resource: BASE + "/mcp" });
ok(replay.status >= 400, "Pi: the same authorization code twice is refused", replay.status);
const rfx = await token(asm, { grant_type: "refresh_token", refresh_token: rfj.refresh_token, client_id: rc.client_id, resource: BASE + "/mcp" });
ok(rfx.status >= 400, "Pi: a replayed code also ends the tokens it led to (RFC 6749 4.1.2)", rfx.status);
const pi2 = await connect("Pi again", rc.client_id, "http://127.0.0.1:53682/callback", {}, owner, { expectPage: false });
ok((await v1(pi2.access_token, "whoami")).body.result?.name === PI, "Pi again: the same connection, not a new one");

// WebSocket (runners' /v1/stream) and events take the same live check
const ws = await new Promise<string>(res => { const s = new WebSocket(BASE.replace(/^http/, "ws") + "/v1/stream?space=main", { headers: { authorization: "Bearer " + pi2.access_token } } as any);
  s.onopen = () => { s.close(); res("open"); }; s.onerror = () => res("error"); setTimeout(() => res("timeout"), 8000); });
ok(ws === "open", "Pi: the WebSocket stream opens with the token", ws);

// CIMD: client_id is the https URL of the app's metadata document; no registration step
const cimdId = "https://cimd.test/Claude%20Test.json";
const cl = await connect("CIMD app", cimdId, "http://127.0.0.1/callback", { choice: "read" }, owner);
const who2 = await v1(cl.access_token, "whoami");
ok(/^claude-test(-\d+)?$/.test(who2.body.result?.name) && JSON.stringify(who2.body.result.spaces[0].verbs) === '["read"]' && /change nothing|Can't: .*change files/.test(who2.body.result.can), "CIMD: the metadata document is fetched (its name is the app's), access = Read only", who2.body);
const evil = await owner.go(authz(asm, cimdId, "http://evil.example/cb", await pkce(), "s"));
ok(evil.status >= 400 || !/evil\.example/.test(evil.headers.get("location") ?? ""), "CIMD: a redirect address not in the app's document is refused", { st: evil.status, loc: evil.headers.get("location") });
// a CIMD client shared by two installs (two computers, one client_id): the second joins the same connection, removing it ends both
const cl2 = await connect("CIMD second install", cimdId, "http://127.0.0.1/callback", {}, owner, { expectPage: false });
const CT = who2.body.result.name, pol = await owner.start({ op: "policy", space: "main" }), apps = pol.result.spaces[0].apps.filter((a: any) => a.name === CT);
ok(apps.length === 1 && (await v1(cl2.access_token, "whoami")).body.result?.name === CT, "CIMD shared by two installs: one connection in Settings, both sign-ins use it", apps);

// CIMD SSRF: a client_id whose document would be fetched from this Kitebook's own network is refused before any fetch
for (const bad of ["https://127.0.0.1/c.json", "https://localhost/c.json", "https://10.1.2.3/c.json", "https://[::1]/c.json", "https://169.254.169.254/latest.json", "https://localtest.me/c.json", "http://cimd.test/plain-http.json"]) {
  const r = await owner.go(authz(asm, bad, "http://127.0.0.1/callback", await pkce(), "s")), loc = r.headers.get("location") ?? "";
  ok(r.status >= 400 || (r.status === 302 && !/\/consent\?/.test(loc) && !/code=/.test(loc)), `CIMD SSRF guard: ${bad} is refused (no consent, no code)`, { st: r.status, loc, body: r.status >= 400 ? (await r.text()).slice(0, 200) : "" });
}
const { cimdUrlOk }: any = await import(("../src/" + "auth.ts") as string).catch(() => ({ cimdUrlOk: null }));
if (cimdUrlOk) ok(await cimdUrlOk("https://localtest.me/x.json", false) && await cimdUrlOk("https://127.0.0.1/x.json", false) && await cimdUrlOk("https://192.168.1.5/x.json", false) && await cimdUrlOk("https://example.internal/x.json", false) && !await cimdUrlOk("https://cimd.test/x.json", true),
  "CIMD SSRF guard (unit): loopback-resolving names, private and loopback IPs and internal names are refused");

// ---- 5. consent memory: asked every time unless the app has a grant the owner can see; removal is immediate ----
const rm = await owner.start({ op: "revoke", peer: PI }); ok(rm.ok, "the owner removes Pi in Settings", rm);
const dead = await mcpCall(pi2.access_token, "tools/list");
ok(dead.status === 401 && /removed/.test(JSON.stringify(dead.body)) && /invalid_token/.test(dead.www), "Pi's unexpired token is refused at once on /mcp, in plain words", dead);
ok((await v1(rfj.access_token, "whoami")).status === 401, "and on /v1 (every Pi token, not just one)");
const ws2 = await new Promise<string>(res => { const s = new WebSocket(BASE.replace(/^http/, "ws") + "/v1/stream?space=main", { headers: { authorization: "Bearer " + pi2.access_token } } as any);
  s.onopen = () => { s.close(); res("open"); }; s.onerror = () => res("refused"); s.onclose = () => res("refused"); setTimeout(() => res("timeout"), 8000); });
ok(ws2 === "refused", "and on the WebSocket stream", ws2);
const rf2 = await token(asm, { grant_type: "refresh_token", refresh_token: pi2.refresh_token, client_id: rc.client_id, resource: BASE + "/mcp" }); ok(rf2.status >= 400, "Pi's refresh token is gone too", rf2.status);
const pi3 = await connect("Pi after removal", rc.client_id, "http://127.0.0.1:53682/callback", { choice: "read" }, owner); // the consent page again
ok((await v1(pi3.access_token, "whoami")).body.result?.spaces?.[0]?.verbs?.join() === "read", "Pi after removal: asked again, and gets what the owner picked this time");
// access tokens live 4 s in the smoke: refresh both installs first, so "stops" means revoke_self ended them, not that they expired
const renew = async (c: any) => { const r: any = await (await token(asm, { grant_type: "refresh_token", refresh_token: c.refresh_token, client_id: cimdId, resource: BASE + "/mcp" })).json(); return r.access_token ? r : c; };
Object.assign(cl, await renew(cl)); Object.assign(cl2, await renew(cl2)); ok((await v1(cl2.access_token, "whoami")).status === 200, "the second install's fresh token works before revoke_self");
const self = await v1(cl.access_token, "revoke_self"); ok(self.body.ok && (await v1(cl2.access_token, "whoami")).status === 401, "an app ends its own access (revoke_self): every install's token stops", self.body);
const cl3 = await connect("CIMD after revoke_self", cimdId, "http://127.0.0.1/callback", { choice: "folder", folder: "kb/claude-test" }, owner);
const rv = await go(asm.revocation_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: cl3.refresh_token, token_type_hint: "refresh_token", client_id: cimdId }) });
const rf3 = await token(asm, { grant_type: "refresh_token", refresh_token: cl3.refresh_token, client_id: cimdId, resource: BASE + "/mcp" }); ok(rv.status === 200 && rf3.status >= 400, "RFC 7009: the app revokes its refresh token; it no longer refreshes", [rv.status, rf3.status]);
const forged = await mcpCall(pi3.access_token.slice(0, -6) + "AAAAAA", "tools/list"); ok(forged.status === 401, "a token with a broken signature: 401", forged.status);
// an access end date set in Settings ends the grant too (the next sign-in asks again)
const exp = await owner.start({ op: "app_expiry", app: (await v1(pi3.access_token, "whoami")).body.result.name, days: 1, nonce: (await owner.start({ op: "nonce" })).result.nonce }); ok(exp.ok, "Settings: Pi keeps access 1 day", exp);
// once expired: a live app's token says "expired" (it refreshes by itself), a removed app's says "removed" (refreshing won't help)
const gr: any = await (await go(asm.registration_endpoint, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.8" }, body: JSON.stringify({ client_name: "Gone", redirect_uris: ["http://127.0.0.1:53683/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) })).json();
const gone = await connect("Gone", gr.client_id, "http://127.0.0.1:53683/callback", { choice: "read" }, owner);
const grm = await owner.start({ op: "revoke", peer: (await v1(gone.access_token, "whoami")).body.result.name }); ok(grm.ok, "the owner removes another app (Gone)", grm);
const expOf = (t: string) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()).exp * 1000;
await new Promise(r => setTimeout(r, Math.max(0, Math.max(expOf(gone.access_token), expOf(pi3.access_token)) - Date.now() + 1100)));
const xLive = await mcpCall(pi3.access_token, "tools/list"), xGone = await mcpCall(gone.access_token, "tools/list");
ok(xLive.status === 401 && /expired/.test(JSON.stringify(xLive.body)) && xGone.status === 401 && /removed/.test(JSON.stringify(xGone.body)), "an expired token: 'sign-in expired' for a connected app, 'access was removed' for a removed one", [xLive.body, xGone.body]);

// ---- 6. installs from before: old app ids get a plain-words next step ----
const old = await go(BASE + "/oauth/authorize?client_id=rc_old&redirect_uri=http://127.0.0.1/cb&response_type=code", {}), ot = await old.text();
ok(old.status === 400 && /signed up with Kitebook before its sign-in was updated\. Remove the app's Kitebook connection and add it again/.test(ot), "an app id from before the update: told in plain words to remove and add the app (it signs up again by itself)", ot);
const oc = await go(BASE + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code&code=ac.root.x&client_id=rc_old" });
ok(oc.status === 400 && /add it again/.test(JSON.stringify(await oc.json())), "the old token endpoint says the same for a new authorization code");

if (!QUICK && ADMIN) {
  // ---- 7. hosted: each account is its own issuer (/u/<acct>/...), so tokens never cross accounts ----
  const A = process.env.HOSTED_ACCT ?? "hb" + Math.floor(Math.random() * 1e6);
  const su: any = await (await go(BASE + "/signup", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + ADMIN }, body: JSON.stringify({ account: A }) })).json(); if (!su.ok) die("hosted signup", su);
  const h = await discover(`/u/${A}/mcp`);
  ok(h.prm.resource === `${BASE}/u/${A}/mcp` && h.iss === `${BASE}/u/${A}/api/auth` && h.asm.issuer === h.iss, `hosted: account ${A} has its own MCP URL and issuer (/u/${A}/api/auth)`, h.prm);
  const hb = new Browser(), hs = await hb.start({ op: "signin", admin_key: su.result.admin_key });
  ok(hs.ok && hb.jar.has(`relay-${A}.session_token`), "hosted: the recovery code (made at signup) starts that account's session; it's that account's cookie", [...hb.jar.keys()]);
  const hso = await new Browser().go(authz(h.asm, "https://cimd.test/Hosted%20App.json", "http://127.0.0.1/callback", await pkce(), "s", `/u/${A}/mcp`));
  ok(new URL(hso.headers.get("location") ?? "/", BASE).pathname === `/u/${A}/start`, "hosted: signed out, the account's own sign-in page", hso.headers.get("location"));
  const ht = await connect("hosted CIMD app", "https://cimd.test/Hosted%20App.json", "http://127.0.0.1/callback", { choice: "folder", folder: "kb/hosted" }, hb, { a: h.asm, mcp: `/u/${A}/mcp`, consent: `/u/${A}/consent` });
  const hw = await mcpCall(ht.access_token, "initialize", undefined, `/u/${A}/mcp`); ok(hw.status === 200, "hosted: the token works on its account's MCP URL", hw);
  ok((await v1(ht.access_token, "whoami")).body.result?.account === A, "hosted: /v1 routes the token to its own account (from its issuer)");
  ok((await mcpCall(pi3.access_token, "tools/list", undefined, `/u/${A}/mcp`)).status === 401, "hosted: a self-host (root) token is refused on another account's MCP URL");
}
console.log(`auth e2e: ${n} checks passed`);
