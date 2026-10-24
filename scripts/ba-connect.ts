// Smoke helper: an MCP client connecting to one account of a running Kitebook the way Pi / Codex / Claude Code do (src/auth.ts), with the
// owner's browser (a curl cookie jar) answering Kitebook's consent page. Prints one JSON line:
//   { consent: <the page was shown>, status, redirect, peer, space, granted, access_token, refresh_token, client_id, error? }
//   bun scripts/ba-connect.ts <base> <acct|root> <jar|-> <client_id|register:<name>> <redirect_uri> '<consent json>' [--page <file>] [--origin <origin>]
// client_id "register:<name>" registers a public client first (DCR); "name:<agent>/<name>" connects by name (src/named.ts): <base>/authorize?name=..,
// no client_id anywhere, the code goes back to <base>/token without one either. consent json: the page's POST body (choice, folder, dispatch, name,
// replace, space, verbs, paths, deny). --page saves the consent page's HTML; --origin sends that Origin on the consent POST (cross-site checks).
import "../client/brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
const [base, acct, jar, cid0, redirect, body0, ...rest] = process.argv.slice(2);
const opt = (k: string) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
const pre = acct === "root" ? "" : `/u/${acct}`, mcp = base + pre + "/mcp", as = base + pre + "/api/auth";
const out = (o: any) => { console.log(JSON.stringify(o)); process.exit(0); };
const cookies = (): string => { if (!jar || jar === "-") return ""; try { return require("fs").readFileSync(jar, "utf8").split("\n").filter((l: string) => l && (!l.startsWith("#") || l.startsWith("#HttpOnly_"))).map((l: string) => l.split("\t")).filter((f: string[]) => f.length >= 7).map((f: string[]) => `${f[5]}=${f[6]}`).join("; "); } catch { return ""; } };
const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as any).toString("base64url");
const nav = (u: string) => fetch(u, { redirect: "manual", headers: { cookie: cookies(), accept: "text/html", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "user-agent": "Mozilla/5.0 (Macintosh) Chrome/140" } });
let clientId = cid0;
if (cid0.startsWith("register:")) {
  // each test app signs up from its own address (as real apps do behind Cloudflare), so the per-IP sign-up limit, which the smoke
  // tests on its own, doesn't run out across the many apps the smoke connects from this one machine
  const ip = `203.0.113.${1 + Math.floor(Math.random() * 254)}`;
  const r = await fetch(as + "/oauth2/register", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ client_name: cid0.slice(9), redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  const j: any = await r.json(); if (!j.client_id) out({ error: "register", status: r.status, body: j }); clientId = j.client_id;
}
const v = b64u(crypto.getRandomValues(new Uint8Array(32))), ch = b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
const named = cid0.startsWith("name:"), q = new URLSearchParams({ response_type: "code", ...(named ? { agent: cid0.slice(5).split("/")[0], name: cid0.slice(5).split("/")[1] ?? "" } : { client_id: clientId }), redirect_uri: redirect, scope: "openid offline_access relay", state: "smoke", code_challenge: ch, code_challenge_method: "S256", resource: mcp });
let r = await nav((named ? base + pre + "/authorize?" : as + "/oauth2/authorize?") + q); if (named && r.status === 302) { const l0 = new URL(r.headers.get("location") ?? "", base); clientId = l0.searchParams.get("client_id") ?? ""; if (l0.pathname.endsWith("/oauth2/authorize")) r = await nav(l0.href); }
let loc = r.headers.get("location") ?? "", consent = false, extra: any = {};
if (r.status !== 302) out({ error: "authorize", status: r.status, body: (await r.text()).slice(0, 400), client_id: clientId });
let u = new URL(loc, base);
if (u.pathname === pre + "/start" || u.pathname === "/start") out({ error: "signed out", status: 401, redirect: u.href, client_id: clientId });
if (u.pathname === pre + "/consent") {
  const pg = await nav(u.href), html = await pg.text(), l2 = pg.headers.get("location");
  if (pg.status === 302 && l2) u = new URL(l2); // an app with a live grant: no page
  else {
    consent = true; if (opt("--page")) require("fs").writeFileSync(opt("--page")!, html);
    const cr = await fetch(base + pre + "/consent", { method: "POST", headers: { "content-type": "application/json", cookie: cookies(), origin: opt("--origin") ?? base }, body: JSON.stringify({ ...JSON.parse(body0 || "{}"), oauth_query: u.search.slice(1) }) });
    const cj: any = await cr.json().catch(() => ({})); extra = { peer: cj.peer, space: cj.space, granted: cj.granted };
    if (!cj.redirect) out({ error: cj.error_description ?? cj.error ?? "consent", status: cr.status, consent, client_id: clientId });
    u = new URL(cj.redirect);
  }
}
if (!u.searchParams.get("code")) out({ error: u.searchParams.get("error") ?? "no code", redirect: u.href, consent, status: 400, client_id: clientId, ...extra });
const t = await fetch(named ? base + pre + "/token" : as + "/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: u.searchParams.get("code")!, redirect_uri: redirect, ...(named ? {} : { client_id: clientId }), code_verifier: v, resource: mcp }) });
const tj: any = await t.json();
out({ consent, status: t.status, redirect: u.href, client_id: clientId, ...extra, access_token: tj.access_token, refresh_token: tj.refresh_token, token_client_id: tj.client_id, redirect_client_id: u.searchParams.get("client_id"), expires_in: tj.expires_in, ...(tj.error ? { error: tj.error_description ?? tj.error } : {}) });
