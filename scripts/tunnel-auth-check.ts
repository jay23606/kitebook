// Sign-in through a tunnel, the way the owner's browser reaches a Mac-hosted Kitebook: https://<public host> at the edge, then plain HTTP
// to the server on 127.0.0.1 with Host: <public host> and X-Forwarded-Proto: https (cloudflared). Regression check for auth-500: on plain
// workerd every /api/auth/* call answered a bare 500 there (Better Auth was built with the http origin and refused it).
//   BASE=http://127.0.0.1:<port> HOST=<public name> [RUNNER=<runner token>] [STATE=<file>] bun scripts/tunnel-auth-check.ts probe|register|signin
//   probe     /api/auth/ok, get-session, passkey options (GET) and a bad passkey answer (POST) all answer JSON, never 500; plain http on a
//             public name gets a JSON "needs https" error, not a crash
//   register  probe + the owner signs in with a kitebook open link (RUNNER) and adds a software passkey, saved in STATE
//   signin    probe + the passkey in STATE (added before an upgrade) signs a fresh browser in as the owner
// Prints "PASS tunnel: ..." lines; exits 1 on the first failure.
import "../client/brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, writeFileSync } from "fs";
import { SoftPasskey } from "./soft-passkey.ts";
const BASE = process.env.BASE!, HOST = process.env.HOST!, RUNNER = process.env.RUNNER ?? "", STATE = process.env.STATE ?? "", mode = process.argv[2] ?? "probe";
if (!BASE || !HOST || !["probe", "register", "signin"].includes(mode)) { console.error("usage: BASE=http://127.0.0.1:<port> HOST=<public name> [RUNNER=..] [STATE=file] bun scripts/tunnel-auth-check.ts probe|register|signin"); process.exit(2); }
const ORIGIN = "https://" + HOST;
const pass = (m: string) => console.log("PASS tunnel: " + m);
const die = (m: string, x?: any): never => { console.log("FAIL tunnel: " + m + (x !== undefined ? " :: " + (typeof x === "string" ? x : JSON.stringify(x)).slice(0, 800) : "")); process.exit(1); };
const ok = (c: any, m: string, x?: any) => c ? pass(m) : die(m, x);
// a browser behind the tunnel: its cookie jar, Origin on writes; every request carries what cloudflared adds
class Browser {
  jar = new Map<string, string>();
  async go(path: string, init: RequestInit = {}, tunnel = true) {
    const h = new Headers(init.headers); h.set("host", HOST); h.set("user-agent", "Mozilla/5.0 (Macintosh) Safari/605");
    if (tunnel) { h.set("x-forwarded-proto", "https"); h.set("cf-visitor", '{"scheme":"https"}'); h.set("cf-connecting-ip", "203.0.113.7"); }
    if (this.jar.size) h.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (init.method && init.method !== "GET") h.set("origin", tunnel ? ORIGIN : "http://" + HOST);
    const r = await fetch(BASE + path, { ...init, headers: h, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(";"), i = kv.indexOf("="); const k = kv.slice(0, i), v = kv.slice(i + 1); if (/max-age=0/i.test(c) || v === "") this.jar.delete(k); else this.jar.set(k, v); }
    return r;
  }
  post(path: string, body: any, tunnel = true) { return this.go(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, tunnel); }
  signedIn() { return [...this.jar.keys()].some(k => /^(__Secure-)?relay-[a-z0-9-]+\.session_token$/.test(k)); }
}
const body = async (r: Response) => { const t = await r.text(); try { return { j: JSON.parse(t), t }; } catch { return { j: null as any, t }; } };

// ---- probe ----
const b0 = new Browser(), seen: string[] = [];
for (const p of ["/api/auth/ok", "/api/auth/get-session", "/api/auth/passkey/generate-authenticate-options"]) {
  const r = await b0.go(p), x = await body(r); seen.push(`${p} ${r.status}`);
  if (r.status >= 500 || (x.j === null && x.t !== "null")) die(`GET ${p} through the tunnel answers (no 500)`, `${r.status} ${x.t.slice(0, 200)}`);
}
const ao: any = await (await b0.go("/api/auth/passkey/generate-authenticate-options")).json();
ok(ao?.rpId === HOST && !!ao.challenge, `the auth endpoints answer through the tunnel (${seen.join(", ")}); passkey options name ${HOST}`, ao);
const bad = await b0.post("/api/auth/passkey/verify-authentication", { response: { id: "x", rawId: "x", type: "public-key", response: {} } }), badx = await body(bad);
ok(bad.status >= 400 && bad.status < 500 && badx.j, "a bad passkey answer through the tunnel: a JSON 4xx, not a 500", `${bad.status} ${badx.t.slice(0, 200)}`);
// an endpoint the public edge serves (src/ingress.ts): with the lockdown on, /api/auth/ok is the edge 404 and never reaches Better Auth
const plain = await new Browser().go("/api/auth/passkey/generate-authenticate-options", {}, false), px = await body(plain);
ok(plain.status !== 500 || (px.j && px.j.error), "plain http on a public name: a JSON answer that says what's wrong, never a bare 500", `${plain.status} ${px.t.slice(0, 200)}`);

// ---- register: kitebook open link, then a passkey from that signed-in browser ----
if (mode === "register") {
  if (!RUNNER || !STATE) die("register needs RUNNER and STATE");
  const lr: any = await (await fetch(BASE + "/v1/login_link", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + RUNNER }, body: "{}" })).json();
  const tok = String(lr?.result?.url ?? "").match(/#login=(ll\.[a-z0-9-]+\.[A-Za-z0-9_-]+)/)?.[1] ?? die("runner login_link", lr);
  const owner = new Browser(), li: any = await (await owner.post("/start", { op: "link_signin", token: tok })).json();
  ok(li.ok && owner.signedIn(), "kitebook open through the tunnel signs the browser in", { li, jar: [...owner.jar.keys()] });
  const ro: any = await (await owner.go("/api/auth/passkey/generate-register-options?name=Kitebook")).json();
  const pk = new SoftPasskey(ORIGIN, HOST), vr = await owner.post("/api/auth/passkey/verify-registration", { response: await pk.create(ro), name: "tunnel laptop" });
  ok(ro?.rp?.id === HOST && vr.status === 200, `a passkey for ${HOST} is added through the tunnel`, `${vr.status} ${(await vr.text()).slice(0, 300)}`);
  writeFileSync(STATE, JSON.stringify(await pk.save()), { mode: 0o600 });
}
// ---- signin: the saved passkey (from before an upgrade) signs a fresh browser in ----
if (mode === "signin") {
  if (!STATE) die("signin needs STATE");
  const pk = await SoftPasskey.load(JSON.parse(readFileSync(STATE, "utf8"))), fresh = new Browser();
  const o: any = await (await fresh.go("/api/auth/passkey/generate-authenticate-options")).json();
  const va = await fresh.post("/api/auth/passkey/verify-authentication", { response: await pk.get(o) });
  const me: any = fresh.signedIn() ? await (await fresh.go("/api/auth/get-session")).json() : null;
  ok(va.status === 200 && me?.user?.email === "owner@relay.invalid", "the owner's existing passkey signs in through the tunnel (same account, data kept)", `${va.status} ${JSON.stringify(me).slice(0, 200)}`);
  writeFileSync(STATE, JSON.stringify(await pk.save()), { mode: 0o600 }); // the signature counter moved on
}
