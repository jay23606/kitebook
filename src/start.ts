// Getting started, served by the server itself, so "give your agents the URL" is the whole setup:
//   GET  /start            the owner's page: web signup (OPEN_SIGNUP=1) or admin-key sign-in, then one copy-paste per client
//   GET  /u/<acct>/start   the same page for one hosted account (where that account's Better Auth sends a signed-out browser)
//   POST /start            JSON ops for that page: signup | signin | signout | link_signin | login_ask | login_poll | mint | status | revoke | nonce | act | ...
//                          (all but the sign-in ones need the session; every POST is same-origin JSON). Sessions are Better Auth's (src/auth.ts).
//                          act = the owner's Status-card action on a task: approve | reject | answer | cancel, and recovery for a failed, rejected,
//                          cancelled or stuck task: retry | retry_note {note} | handoff {agent, note?}; each with a one-time nonce from op nonce
//   GET  /install.sh       POSIX sh installer for the Mac runner: curl -fsSL <kitebook>/install.sh | sh -s -- <invite>
//   GET  /runner-files/<file>    the runner's client files, bundled into the Worker at build time, so nobody clones the repo
//   GET  /runner-files/manifest.txt   sha256 of each of those files (sha256sum -c format); its hash names the runner version
//   GET  /runner-files/manifest.sig   the release key's Ed25519 signature over it (scripts/sign-release.ts; 404 = unsigned release)
// Same hardening as the approval page (CSP nonce, no framing, no-store) and nothing here is CORS-enabled.
import { ROOT_ACCOUNT, isRoot, normAcct } from "../client/account.ts";
import { PRESENCE_JS } from "./presence-ui.ts";
import { normCode } from "./join.ts";
import { CLI } from "../client/brand.ts";
import { sha256 } from "./ops.ts";
import { PAGE_HEADERS, esc } from "./approve.ts";
import { owner, knobs, signupLimit, PRESETS } from "./oauth.ts";
import { acctHint, deviceCookies, sessionOwner, sessionCookies, setHint, clearCookie, uaLabel, sameOrigin } from "./session.ts";
import { authBase, PASSKEY_JS, mcpPath } from "./auth.ts";
import { appPrompt } from "./named.ts";
import { RELEASE_KEY } from "../client/release-key.ts";
import { OWNER_JS } from "./policy-ui.ts";
import { LINK_RE } from "./login.ts";
import { settingsPage } from "./settings.ts";
import { THEME_CSS, BASE_CSS, FOLD_CSS, FOLD_JS, WORKSPACE_CSS, WORKSPACE_JS, workspaceNav } from "./ui.ts";
import { ingressOf, lockdownFor, hasLocalListener, edgeRoutes } from "./ingress.ts";

// Every client file (minus tests), as text, picked up by Vite at build time: a new client module (e.g. setup.ts) ships with no edit here.
const RAW = import.meta.glob(["../client/*.ts", "../client/*.mjs", "!../client/*.test.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
export const CLIENT_FILES: Record<string, string> = Object.fromEntries(Object.entries(RAW).map(([k, v]) => [k.split("/").pop()!, v]));
// The runner manifest (client/integrity.ts): `sha256  name` per file, sorted; the version is the first 16 hex of its own sha256.
// install.sh embeds the version, so a manifest swapped in transit (or by a different Kitebook) is refused.
let MANIFEST: Promise<{ text: string; version: string }> | null = null;
export const runnerManifest = () => MANIFEST ??= (async () => {
  const text = (await Promise.all(Object.keys(CLIENT_FILES).sort().map(async f => `${await sha256(CLIENT_FILES[f])}  ${f}\n`))).join("");
  return { text, version: (await sha256(text)).slice(0, 16) };
})();
// The release signature is made offline (scripts/sign-release.ts writes release/manifest.sig, bundled here) or handed to the deploy
// (KITEBOOK_RUNNER_MANIFEST_SIG). The server never holds the private key and doesn't check the signature: the clients do, with the
// key they pin (client/release-key.ts, or a self-hoster's KITEBOOK_RUNNER_RELEASE_KEY, embedded into install.sh).
const SIG = Object.values(import.meta.glob("../release/manifest.sig", { query: "?raw", import: "default", eager: true }) as Record<string, string>)[0];
const manifestSig = (env: any) => String(env?.RUNNER_MANIFEST_SIG || SIG || "").trim();
const releaseKey = (env: any) => String(env?.RUNNER_RELEASE_KEY || RELEASE_KEY || "").trim();
const ACCT_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
type H = { dir(acct: string): any; acctOf(c: string | null | undefined): string; teq(a: string | null, b: string): Promise<boolean> };
const j = (b: any, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
// only bounce back into our own OAuth pages after sign-in (no open redirect)
const safeNext = (n: string | null, url: URL) => { if (!n || !/^\/(oauth\/authorize\?|device(\?|$)|approve\/[a-z0-9.-]+$|settings$)/.test(n)) return null; try { const u = new URL(n, url.origin); return u.origin === url.origin ? u.pathname + u.search : null; } catch { return null; } };

// What each client gets. Invites are claimed by the agent itself (Hark) or the installer (runner); coding agents get a token
// in a one-line command because their config can hold a header, but nothing else ever sees it.
const RUNNER_INVITE = { kind: "runner", verbs: ["read", "write", "delete", "dispatch"], paths: ["tasks/**", "shared/**", "repos/**", "kb/**"], hours: 24 }; // delete: repo mirroring; kb/**: memory sync + cache
const AGENTS: Record<string, { base: string; snippet: (o: string, t: string) => string }> = {
  "claude-code": { base: "claude-code", snippet: (o, t) => `claude mcp add --transport http kitebook ${o}/mcp --header "Authorization: Bearer ${t}" -s user` },
  codex: { base: "codex", snippet: (o, t) => envLine("codex", "KITEBOOK_CODEX_TOKEN", o, t) },
  pi: { base: "pi", snippet: (o, t) => envLine("pi", "KITEBOOK_PI_TOKEN", o, t) },
};
// Codex / Pi read the token from an env var. It goes into ~/.kitebook/agent-tokens.env (0600, the same file `kitebook connect` keeps), and
// ~/.zshrc gets only the one line that loads that file (once, the same marker kitebook connect uses), never the token itself: rc files are read
// by every process and copied by dotfile backups.
const envLine = (bin: string, v: string, o: string, t: string) => `(umask 077; mkdir -p ~/.kitebook && f=~/.kitebook/agent-tokens.env && { grep -v '^export ${v}=' "$f" 2>/dev/null; echo 'export ${v}=${t}'; } > "$f.new" && mv "$f.new" "$f" && chmod 600 "$f")`
  + ` && { grep -q '# Kitebook: agent tokens' ~/.zshrc 2>/dev/null || echo '[ -f "$HOME/.kitebook/agent-tokens.env" ] && . "$HOME/.kitebook/agent-tokens.env"  # Kitebook: agent tokens (kitebook connect)' >> ~/.zshrc; }`
  + ` && . ~/.kitebook/agent-tokens.env && ${bin} mcp add kitebook --url ${o}/mcp --bearer-token-env-var ${v}`;

async function mint(d: any, what: string, o: string) {
  if (what === "hark") { const r = await d.admin("invite", { space: "main", ...PRESETS.assistant, hours: 72 }); // safe preset: reads all, dispatches, writes only shared/** + kb/**
    return { snippet: `${o}${r.path}`, expires: r.expires, note: "Give Hark this link; it works once. Hark can read everything, send tasks to your Mac, and save files only in shared/ and kb/." }; }
  if (what === "runner") { const r = await d.admin("invite", { space: "main", ...RUNNER_INVITE });
    return { snippet: `curl -fsSL ${o}/install.sh | sh -s -- ${r.code}`, expires: r.expires, note: "Run this in Terminal on your Mac. It works once." }; }
  const a = AGENTS[what]; if (!a) throw new Error("mint: hark | runner | " + Object.keys(AGENTS).join(" | "));
  const taken = new Set((await d.admin("list", {})).peers.map((p: any) => p.name));
  let name = a.base; for (let i = 2; taken.has(name); i++) { if (i > 50) throw new Error("too many " + a.base + " connections; revoke some under Status"); name = `${a.base}-${i}`; }
  const { token } = await d.admin("peer", { name, kind: "coding_agent" });
  await d.admin("grant", { peer: name, space: "main", verbs: PRESETS.coding_agent.verbs, paths: PRESETS.coding_agent.paths }); // same safe preset; code goes in via git/change
  return { peer: name, snippet: a.snippet(o, token), note: `Run this once where ${a.base === "claude-code" ? "Claude Code" : a.base === "codex" ? "Codex" : "Pi"} runs. Its sign-in token is shown only now. Revoke it any time: Status → ⋯ next to ${name}.` };
}

// A page opened on the Mac itself (http://127.0.0.1:<port>) still shows cloud assistants the address they can reach: the built-in tunnel's,
// while it's up and heard from (client/tunnel.ts reports every few seconds). Anywhere else the page's own address is the public one.
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/;
async function publicUrl(h: H, url: URL): Promise<string | null> {
  if (!LOOPBACK.test(url.hostname)) return null;
  try { const t = (await h.dir(ROOT_ACCOUNT).admin("connection", {})).tunnel; return t?.state === "up" && t.url && Date.now() - t.heard < 60_000 ? t.url : null; } catch { return null; }
}
export async function startFetch(req: Request, env: any, url: URL, h: H): Promise<Response | null> {
  const p = url.pathname;
  if (p === "/install.sh" && req.method === "GET") {
    if (!/^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(url.origin)) return new Response("bad host\n", { status: 400 });
    const rk = releaseKey(env); if (rk && !/^ed25519:[A-Za-z0-9_-]{43}$/.test(rk)) return new Response("bad release key configured\n", { status: 500 });
    return new Response(installSh(url.origin, (await runnerManifest()).version, rk), { headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" } });
  }
  if (p === "/runner-files/manifest.txt" && req.method === "GET") { const m = await runnerManifest(); return new Response(m.text, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff", "x-relay-runner-version": m.version } }); }
  if (p === "/runner-files/manifest.sig" && req.method === "GET") { const sg = manifestSig(env); return sg ? new Response(sg + "\n", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" } }) : new Response("unsigned release\n", { status: 404 }); }
  const cf = p.match(/^\/runner-files\/([a-z0-9-]+\.(?:ts|mjs))$/);
  if (cf && req.method === "GET") { const s = CLIENT_FILES[cf[1]]; return s === undefined ? new Response("not found\n", { status: 404 }) : new Response(s, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" } }); }
  if (p === "/settings" && req.method === "GET") { // the Settings page (src/settings.ts); signed out -> sign in first, then come back here
    const ses = await sessionOwner(req, h.dir); if (!ses) return new Response(null, { status: 302, headers: { location: "/start?next=%2Fsettings", "cache-control": "no-store" } });
    const n = b64(16); return new Response(settingsPage({ acct: ses.acct, origin: url.origin, release: releaseKey(env) }, n), { headers: PAGE_HEADERS(n) });
  }
  const ua = p.match(/^\/u\/([a-z0-9][a-z0-9-]{1,30})\/start$/); // a hosted account's own sign-in page
  if (p !== "/start" && !ua) return null;
  const open = env?.OPEN_SIGNUP === "1";
  if (req.method === "GET") {
    const ses = await sessionOwner(req, h.dir), n = b64(16), hint = ua?.[1] ?? acctHint(req) ?? null;
    // signed out mid-connect: Better Auth sent the browser here with its signed authorization request; signed in, it goes straight back there
    const q = new URLSearchParams(url.searchParams); let oauth: string | null = null;
    if (q.get("client_id") && q.get("sig") && q.get("redirect_uri")) { for (const k of ["sig", "exp", "ba_iat", "ba_pl", "ba_param"]) q.delete(k); oauth = `${authBase(normAcct(ua?.[1]))}/oauth2/authorize?${q}`; }
    // one account (self-host): passkeys and sign-in requests need no account name; a Kitebook server with several asks for it (or remembers it)
    const multi = open || env?.HOSTED === "1";
    // fresh: a single-account Kitebook where nobody has signed in yet (no workspace), so the operator gets the first-sign-in steps, not "ask them"
    const fresh = !ses && !multi && !ua ? !(await h.dir(ROOT_ACCOUNT).hasSpace().catch(() => true)) : false;
    const state = { acct: ses?.acct ?? null, hint, multi, open, fresh, local: LOOPBACK.test(url.hostname), dcr: knobs(env).dcr, dcrMode: knobs(env).dcrMode, next: safeNext(url.searchParams.get("next"), url), oauth, origin: url.origin, pub: ses && isRoot(ses.acct) ? await publicUrl(h, url) : null };
    return new Response(startPage(state, n), { headers: { ...PAGE_HEADERS(n), link: `<${url.origin}/llms.txt>; rel="describedby"; type="text/markdown"` } });
  }
  if (req.method !== "POST") return j({ ok: false, error: "GET or POST" }, 405);
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return j({ ok: false, error: "send JSON" }, 415); // no cross-site form posts
  if (!sameOrigin(req, url)) return j({ ok: false, error: "cross-origin request refused" }, 403);
  const b: any = await req.json().catch(() => ({}));
  // a new owner session (Better Auth, 30 days, sliding; listed and removable in Settings, Devices & passkeys)
  const begin = async (d: any, extra: any = {}, acct?: string) => { await d.ensureMain().catch(() => {}); const r = j({ ok: true, result: extra }); // first sign-in on a fresh Kitebook: workspace main exists from here on
    for (const c of await d.baMint(url.origin, req.headers.get("user-agent") ?? "")) r.headers.append("set-cookie", c);
    if (acct) r.headers.append("set-cookie", setHint(url, acct)); return r; };
  if (b.op === "signup") {
    const lim = await signupLimit(env, req); // same per-IP budget as POST /signup
    if (!lim.ok) return j({ ok: false, error: `too many signups from your address; try again in ${Math.ceil(lim.retry_after / 60)} min` }, 429, { "retry-after": String(lim.retry_after) });
    if (!open) return j({ ok: false, error: "signup is closed on this Kitebook; ask its operator, or sign in with kitebook open on your Mac" }, 403);
    if (!ACCT_RE.test(b.account ?? "") || isRoot(b.account)) return j({ ok: false, error: "account: 2-31 chars, lowercase letters, digits, dashes" }, 400);
    const d = h.dir(b.account);
    try { const r = await d.createAccount(b.account, b.owner); await d.admin("space", { id: "main" }); return await begin(d, { account: r.account, admin_key: r.admin_key, space: "main", note: r.note }, r.account); }
    catch (e: any) { return j({ ok: false, error: String(e.message ?? e) }, 409); }
  }
  if (b.op === "signin") { // the recovery code: 20 tries per address per hour (it may be an operator-typed ADMIN_TOKEN, not a random key)
    const lim = await env.DIR.get(env.DIR.idFromName("oauth:global")).oauth("rate", `signin:ip:${req.headers.get("cf-connecting-ip") ?? "local"}`, 20) as { ok: boolean; retry_after: number };
    if (!lim.ok) return j({ ok: false, error: `Too many sign-in attempts from your address. Try again in ${Math.ceil(lim.retry_after / 60)} min, or use kitebook open on your Mac.` }, 429, { "retry-after": String(lim.retry_after) });
    const own = await owner(env, b.admin_key, h);
    return own ? await begin(own.dir, { account: own.acct }, own.acct) : j({ ok: false, error: "that recovery code is not valid" }, 401);
  }
  if (b.op === "signout") {
    const r = j({ ok: true, result: {} });
    for (const c of sessionCookies(req)) { await h.dir(c.acct).baSessionEnd(url.origin, { cookie: c.cookie }).catch(() => {}); r.headers.append("set-cookie", clearCookie(url, c.name)); }
    for (const c of deviceCookies(req)) { const e = await h.dir(c.acct).dev("sessEnd", c.secret).catch(() => null); if (e?.ba) await h.dir(c.acct).baSessionEnd(url.origin, { id: e.ba }).catch(() => {}); r.headers.append("set-cookie", `${c.name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${url.protocol === "https:" ? "; Secure" : ""}`); }
    return r;
  }
  // ---- the presence gate (src/devices.ts): what grants or widens access needs a fresh confirmation from one of the owner's devices. The
  // browser can't sign with a device key, so it asks (presence_ask: a short code), the owner runs `kitebook confirm <code>` on a device
  // (its Kitebook master password, or the optional fingerprint / face unlock shortcut), and this session holds a 5-minute window. Checked BEFORE the one-time nonce is used,
  // so the button still works after confirming. Revoking and turning things off are never gated.
  const gated = async (own: any, action: string) => { const g = await own.dir.dev("gate", { tenant: own.tenant, cred: own.cred, action }).catch((e: any) => ({ ok: false, why: String(e?.message ?? e) }));
    return g.ok ? null : j({ ok: false, error: `Confirm it's you first: run kitebook confirm on one of your computers (it asks for your Kitebook master password, or fingerprint / face unlock if you turned that shortcut on), then try again. (${g.why})`, presence: { needed: true, action } }, 428); };
  if (b.op === "presence_ask" || b.op === "presence_state") {
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    try { if (b.op === "presence_ask") { const rs = await own.dir.rpw("setting", own.tenant).catch(() => null);
        return j({ ok: true, result: { ...await own.dir.dev("ask", { tenant: own.tenant, cred: own.cred, action: String(b.action ?? "an owner action") }), command: "kitebook confirm", remote: !!(rs?.on && rs.devices > 0) } }); }
      return j({ ok: true, result: await own.dir.dev("askState", own.cred, String(b.id ?? "")) }); }
    catch (e: any) { return j({ ok: false, error: String(e?.message ?? e) }, 429); }
  }
  // the same confirmation with the master password typed in this browser (a phone): relayed over HTTPS to the owner's Mac, which checks it
  // and signs confirm:<code> itself (src/remote-pw.ts, client/remote-presence.ts); the password is never stored or checked here
  if (b.op === "presence_password") {
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    const q = await own.dir.dev("askOf", own.cred, String(b.id ?? "")); if (!q) return j({ ok: false, error: "that confirmation expired; try the button again" }, 404);
    const r = await own.dir.rpw("ask", { action: `confirm:${q.code}`, password: typeof b.password === "string" ? b.password : "", tenant: own.tenant, from: "presence prompt" }); b.password = "";
    if (!r.ok) return j({ ok: false, error: r.error, ...(r.wrong ? { wrong: true } : {}) }, r.status);
    try { return j({ ok: true, result: await own.dir.dev("confirm", { code: q.code, presence: r.presence, peer: r.peer }) }); } catch (e: any) { return j({ ok: false, error: String(e?.message ?? e) }, 400); }
  }
  // ...or with this phone's passkey (src/passkey.ts): a challenge bound to confirm:<code>, verified here, then the same 5-minute window
  if (b.op === "presence_passkey_challenge" || b.op === "presence_passkey") {
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    const q = await own.dir.dev("askOf", own.cred, String(b.id ?? "")); if (!q) return j({ ok: false, error: "that confirmation expired; try the button again" }, 404);
    if (b.op === "presence_passkey_challenge") return j({ ok: true, result: { ...await own.dir.pk("challenge", { action: `confirm:${q.code}`, tenant: own.tenant }), rp_id: url.hostname } });
    const v = await own.dir.pk("verify", { action: `confirm:${q.code}`, origin: url.origin, cred: b.passkey }); if (!v.ok) return j({ ok: false, error: `Your passkey didn't confirm it: ${v.why}` }, 401);
    try { return j({ ok: true, result: await own.dir.dev("confirmBy", { code: q.code, device: v.device }) }); } catch (e: any) { return j({ ok: false, error: String(e?.message ?? e) }, 400); }
  }
  // Settings -> More -> "Approve from other devices with my password" (default on). Either direction needs presence (owner, 2026-10-23).
  if (b.op === "remote_pw" || b.op === "remote_pw_set") {
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    if (b.op === "remote_pw") return j({ ok: true, result: await own.dir.rpw("setting", own.tenant) });
    const on = b.on === true, g = await gated(own, `remote_pw:${on ? "on" : "off"}`); if (g) return g;
    if (!await own.dir.actUse(own.cred, String(b.nonce ?? ""))) return j({ ok: false, error: "this button expired (each change works once, for 5 minutes); reload the page and try again" }, 403);
    return j({ ok: true, result: await own.dir.rpw("set", { on, tenant: own.tenant }) });
  }
  // Settings -> Devices: one row per machine (src/devices.ts). Approve is gated; revoke (ends its browser sessions and its runner) is not.
  // Master password (src/devices.ts): turning the shortcut off is never gated (safe direction); "Reset password" lets that computer set a new one for
  // 15 minutes, so it is gated like an approval. Setting or changing a password happens on the computer itself (kitebook password ...).
  if (b.op === "machines" || b.op === "machine_approve" || b.op === "machine_revoke" || b.op === "machine_rename" || b.op === "machine_shortcut_off" || b.op === "machine_password_reset") {
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    if (b.op === "machines") return j({ ok: true, result: { ...await own.dir.dev("list", own.tenant), this_device: own.device ?? null } });
    if (b.op === "machine_approve") { const g = await gated(own, `device_approve:${String(b.id ?? "")}`); if (g) return g; }
    if (b.op === "machine_password_reset") { const g = await gated(own, `device_password_reset:${String(b.id ?? "")}`); if (g) return g; }
    if (!await own.dir.actUse(own.cred, String(b.nonce ?? ""))) return j({ ok: false, error: "this button expired (each action works once, for 5 minutes); reload the page and try again" }, 403);
    try { const id = String(b.id ?? "");
      return j({ ok: true, result: b.op === "machine_approve" ? await own.dir.dev("approve", id) : b.op === "machine_rename" ? await own.dir.dev("rename", id, String(b.name ?? "")) : b.op === "machine_shortcut_off" ? await own.dir.dev("shortcut", { peer: "", id, on: false })
        : b.op === "machine_password_reset" ? await own.dir.dev("resetPassword", id) : await own.dir.deviceRevoke(id, "Settings") }); }
    catch (e: any) { return j({ ok: false, error: String(e?.message ?? e) }, 404); }
  }
  // Settings -> Devices: computers waiting to join (kitebook join, src/join.ts) with their name/OS/IP/place and the phishing warning.
  // Approve is gated (it grants a runner); deny is not.
  if (b.op === "joins" || b.op === "join_approve" || b.op === "join_deny") {
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    if (b.op === "joins") return j({ ok: true, result: { pending: await own.dir.join("pending", "join", own.tenant) } });
    const code = normCode(b.code); if (b.op === "join_approve") { const g = await gated(own, `join_approve:${code}`); if (g) return g; }
    if (!await own.dir.actUse(own.cred, String(b.nonce ?? ""))) return j({ ok: false, error: "this button expired (each action works once, for 5 minutes); reload the page and try again" }, 403);
    try { return j({ ok: true, result: await own.dir.join("decide", code, b.op === "join_approve", own.device ? `browser (${own.device})` : "browser") }); }
    catch (e: any) { return j({ ok: false, error: String(e?.message ?? e) }, 404); }
  }
  // ---- signing in without the recovery code (src/login.ts) ----
  const G = () => env.DIR.get(env.DIR.idFromName("oauth:global"));
  const ipLimit = async (what: string, n: number) => await G().oauth("rate", `${what}:ip:${req.headers.get("cf-connecting-ip") ?? "local"}`, n) as { ok: boolean; retry_after: number };
  if (b.op === "link_signin") { // the page posts the single-use link `kitebook open` opened (from its #login= fragment)
    const t = String(b.token ?? ""), m = t.match(LINK_RE); if (!m) return j({ ok: false, error: "That sign-in link isn't valid. Run kitebook open on your Mac again." }, 400);
    const d = h.dir(m[1]), r = await d.login("linkUse", t);
    if (r !== "ok") return j({ ok: false, error: r === "used" ? "That sign-in link was already used. Run kitebook open on your Mac again." : r === "expired" ? "That sign-in link expired (they work for 5 minutes). Run kitebook open on your Mac again." : "That sign-in link isn't valid. Run kitebook open on your Mac again." }, 410);
    return await begin(d, { account: m[1] }, m[1]);
  }
  if (b.op === "login_ask" || b.op === "login_poll") { // a sign-in request, approved with kitebook approve <code> on the Mac or in a browser already signed in
    try {
      if (b.op === "login_ask") {
        const lim = await ipLimit("login", knobs(env).connectIp); if (!lim.ok) return j({ ok: false, error: `Too many sign-in requests from your address. Try again in ${Math.ceil(lim.retry_after / 60)} min.` }, 429);
        const acct = String(b.account ?? "").trim() || (env?.OPEN_SIGNUP === "1" || env?.HOSTED === "1" ? "" : ROOT_ACCOUNT); if (!ACCT_RE.test(acct)) return j({ ok: false, error: "Type your Kitebook account name (letters, digits and dashes)." }, 400);
        const d = h.dir(acct), r = await d.oauth("loginNew", { label: uaLabel(req.headers.get("user-agent")) }, knobs(env)), reach = await d.connectNotify(r.space, r.id).catch(() => ({ runners: 0 }));
        return j({ ok: true, result: { poll: r.poll, code: r.code, expires: r.expires, runners: reach.runners } });
      }
      const m = String(b.poll ?? "").match(/^pc\.([a-z0-9][a-z0-9-]{0,30})\.[A-Za-z0-9_-]{20,64}$/); if (!m) return j({ ok: false, error: "That sign-in request isn't known. Send a new one." }, 400);
      const d = h.dir(m[1]), r = await d.oauth("connectPoll", { poll: b.poll, client_id: "login", redirect_uri: "", challenge: "" });
      return r.state === "approved" ? await begin(d, { state: "approved", account: m[1] }, m[1]) : j({ ok: true, result: { state: r.state, ...(r.error ? { error: r.error } : {}) } });
    } catch (e: any) { const msg = String(e?.message ?? e).replace(/^oauth:[a-z_]+:/, ""); return j({ ok: false, error: msg }, /Too many/.test(msg) ? 429 : 400); }
  }
  if (b.op === "devices" || b.op === "device_remove") { // browsers signed in (Better Auth sessions) + passkeys + waiting sign-ins; remove one browser
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    if (b.op === "device_remove" && !await own.dir.baSessionEnd(url.origin, { id: String(b.id ?? "") })) return j({ ok: false, error: "no such browser" }, 404);
    return j({ ok: true, result: { ...await own.dir.baDevices(url.origin, own.cred), logins: await own.dir.oauth("loginList"), auth_base: authBase(own.acct) } });
  }
  if (["passkey_remove", "login_decide", "recovery_new"].includes(b.op)) { // signed-in browser only (adding a passkey is Better Auth's own endpoint)
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    if (b.op === "recovery_new" || (b.op === "login_decide" && b.yes === true)) { const g = await gated(own, b.op === "recovery_new" ? "recovery_new" : `login_decide:${String(b.id ?? "")}`); if (g) return g; }
    if (!await own.dir.actUse(own.cred, String(b.nonce ?? ""))) return j({ ok: false, error: "this button expired (each action works once, for 5 minutes); reload the page and try again" }, 403);
    try {
      if (b.op === "passkey_remove") { if (!await own.dir.baPasskeyRemove(url.origin, String(b.id ?? ""))) return j({ ok: false, error: "no such passkey" }, 404); return j({ ok: true, result: await own.dir.baDevices(url.origin, own.cred) }); }
      if (b.op === "login_decide") return j({ ok: true, result: await own.dir.oauth("loginDecide", String(b.id ?? ""), b.yes === true) });
      // a new recovery code (the account key): shown once; the old one stops working. The operator's root account uses ADMIN_TOKEN instead.
      return j({ ok: true, result: { recovery_code: (await own.dir.admin("rotate_admin", {})).admin_key } });
    } catch (e: any) { return j({ ok: false, error: String(e?.message ?? e).replace(/^oauth:[a-z_]+:/, "") }, 400); }
  }
  if (b.op === "mint") {
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    { const g = await gated(own, `mint:${String(b.client ?? "")}`); if (g) return g; } // a new token or invite widens access
    try { await own.dir.ensureMain(); return j({ ok: true, result: await mint(own.dir, String(b.client ?? ""), url.origin) }); }
    catch (e: any) { return j({ ok: false, error: String(e.message ?? e) }, 400); }
  }
  if (b.op === "app_add") { // Settings -> Connected apps -> Add an app: a scoped key (shown once) + the prompt to paste into the app
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    { const g = await gated(own, `app_add:${String(b.name ?? "")}`); if (g) return g; } // a new key widens access
    if (!await own.dir.actUse(own.cred, String(b.nonce ?? ""))) return j({ ok: false, error: "this button expired (each action works once, for 5 minutes); reload the page and try again" }, 403);
    try { const r = await own.dir.admin("app_add", { name: b.name, choice: b.choice, days: b.days ?? null, by: "Settings" }), mcp = ((isRoot(own.acct) ? await publicUrl(h, url) : null) ?? url.origin) + mcpPath(own.acct);
      return j({ ok: true, result: { ...r, mcp, prompt: appPrompt(mcp) } }); }
    catch (e: any) { return j({ ok: false, error: String(e.message ?? e) }, 400); }
  }
  if (b.op === "status") { // read-only glance for the phone: peers + online, open tasks, needs-you, recent results
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    try { await own.dir.ensureMain(); const r = await own.dir.admin("status", {}); return j({ ok: true, result: { ...r, setup: setupState(r) } }); } catch (e: any) { return j({ ok: false, error: String(e.message ?? e) }, 500); }
  }
  if (b.op === "task") { // tap a result row: one task's headline, next action, summary, diff and test log (read-only)
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    try { return j({ ok: true, result: await own.dir.admin("task", { space: String(b.space ?? ""), task: String(b.task ?? "") }) }); } catch (e: any) { return j({ ok: false, error: String(e.message ?? e) }, 404); }
  }
  if (b.op === "presence") { // the Who's working panel, refreshed every few seconds while /start is open (read-only, every title: owner session)
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    try { return j({ ok: true, result: await own.dir.admin("presence", {}) }); } catch (e: any) { return j({ ok: false, error: String(e.message ?? e) }, 500); }
  }
  if (b.op === "revoke") { // end one connected client (all its grants and event streams); the same as admin.ts revoke <peer>
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    try { return j({ ok: true, result: await own.dir.admin("revoke", { peer: String(b.peer ?? "") }) }); } catch (e: any) { return j({ ok: false, error: String(e.message ?? e) }, 400); }
  }
  if (b.op === "nonce") { // one-time nonce for the next act, bound to this session (5 minutes)
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    return j({ ok: true, result: { nonce: await own.dir.actNonce(own.cred) } });
  }
  if (b.op === "act") { // approve | reject (the runner's live review page; a passkey runner only takes Reject here) | answer (needs_input) | steer {message} | cancel | retry | retry_note | handoff | ask_task (a quick ask -> a task)
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    if (!await own.dir.actUse(own.cred, String(b.nonce ?? ""))) return j({ ok: false, error: "this button expired (each action works once, for 5 minutes); reload the page and try again" }, 403);
    try { return j({ ok: true, result: await own.dir.admin("act", { space: String(b.space ?? "main"), task: String(b.task ?? ""), action: String(b.action ?? ""), answer: b.answer, reason: b.reason, note: b.note, agent: b.agent, message: b.message }) }); }
    catch (e: any) { const m = String(e.message ?? e); return j({ ok: false, error: m }, /no such task|no space/.test(m) ? 404 : /passkey/.test(m) ? 403 : /^(agent|note|action|answer|message):/.test(m) ? 400 : 409); }
  }
  // Permissions (src/policy.ts): read = what every app can do now + the audit list; writes need the session AND a one-time nonce, and a
  // policy change is signed in this browser (the server checks it against the owner keys registered here; the runner against its own pins)
  if (b.op === "policy") {
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    try { return j({ ok: true, result: await own.dir.admin("policy", b.space ? { space: String(b.space) } : {}) }); } catch (e: any) { return j({ ok: false, error: String(e.message ?? e) }, 404); }
  }
  if (b.op === "policy_set" || b.op === "owner_key" || b.op === "app_key" || b.op === "app_expiry" || b.op === "owner_cmd" || b.op === "autorun_key" || b.op === "autorun_set" || b.op === "experimental_set" || b.op === "dev_key" || b.op === "dev_set") { // the two switches: only here (session + nonce + the owner's signature); dev_*: their old names
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    // gated: everything here widens or rewrites owner rules, except removing a browser key, turning a switch off (an envelope without it),
    // and registering this browser's key with the trust proof `kitebook open` handed it (the Mac checks that proof itself)
    const safe = (b.op === "owner_key" && (b.remove || b.proof)) || ((b.op === "autorun_set" || b.op === "dev_set") && !b.envelope?.policy?.autorun && !b.envelope?.policy?.dev) || (b.op === "experimental_set" && !b.envelope?.policy?.experimental) || b.op === "autorun_key" || b.op === "dev_key";
    if (!safe) { const g = await gated(own, b.op); if (g) return g; }
    if (!await own.dir.actUse(own.cred, String(b.nonce ?? ""))) return j({ ok: false, error: "this button expired (each change works once, for 5 minutes); reload the page and try again" }, 403);
    const args = b.op === "owner_key" ? { key: b.key, label: b.label, remove: b.remove, proof: b.proof } : b.op === "app_key" ? { space: String(b.space ?? "main"), app: String(b.app ?? "") }
      : b.op === "app_expiry" ? { app: String(b.app ?? ""), days: b.days ?? null } : b.op === "owner_cmd" ? { space: String(b.space ?? "main"), cmd: b.cmd }
      : b.op === "autorun_key" || b.op === "dev_key" ? { space: String(b.space ?? "main") } : /^(autorun|dev|experimental)_set$/.test(b.op) ? { space: String(b.space ?? "main"), envelope: b.envelope, undo_of: b.undo_of ?? null }
      : { space: String(b.space ?? "main"), app: String(b.app ?? ""), envelope: b.envelope, access: b.access ?? null, undo_of: b.undo_of ?? null };
    try { return j({ ok: true, result: await own.dir.admin(b.op, args) }); }
    catch (e: any) { const m = String(e.message ?? e); return j({ ok: false, error: m }, /changed meanwhile|nothing to undo/.test(m) ? 409 : /^no (space|peer)/.test(m) ? 404 : 400); }
  }
  // Run tests (Settings -> Experimental, a task's card): the owner asks the Mac for a local CI run (client/ci.ts); session + nonce. Running the
  // project's own test command needs Experimental on (turning that on was the gated step)
  if (b.op === "ci_run") {
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(b.project ?? "")) || (b.branch != null && (!/^[A-Za-z0-9._\/-]{1,200}$/.test(String(b.branch)) || String(b.branch).includes("..")))) return j({ ok: false, error: "project (and an optional branch) of a project on your Mac" }, 400);
    if (!await own.dir.actUse(own.cred, String(b.nonce ?? ""))) return j({ ok: false, error: "this button expired (each change works once, for 5 minutes); reload the page and try again" }, 403);
    try { return j({ ok: true, result: await own.dir.admin("ci_run", { space: String(b.space ?? "main"), project: String(b.project), branch: b.branch ?? null }) }); } catch (e: any) { return j({ ok: false, error: String(e.message ?? e) }, /^no space/.test(String(e.message)) ? 404 : 400); }
  }
  // Settings -> Updates "Let apps update Kitebook" (relay_update's kill switch): session + nonce; turning it back on widens what apps can do (presence), off never gated
  if (b.op === "app_updates") {
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    if (typeof b.on !== "boolean") return j({ ok: false, error: "on: true | false" }, 400);
    if (b.on) { const g = await gated(own, "app_updates"); if (g) return g; }
    if (!await own.dir.actUse(own.cred, String(b.nonce ?? ""))) return j({ ok: false, error: "this button expired (each change works once, for 5 minutes); reload the page and try again" }, 403);
    try { return j({ ok: true, result: await own.dir.admin("app_updates", { space: String(b.space ?? "main"), on: b.on }) }); } catch (e: any) { return j({ ok: false, error: String(e.message ?? e) }, /^no space/.test(String(e.message)) ? 404 : 400); }
  }
  // Settings -> Instructions for your assistants (src/brief.ts): read with the session; save / Undo / accept / dismiss also need a nonce
  if (b.op === "brief" || b.op === "brief_set") {
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    if (b.op === "brief") { try { return j({ ok: true, result: await own.dir.admin("brief", b.space ? { space: String(b.space) } : {}) }); } catch (e: any) { return j({ ok: false, error: String(e.message ?? e) }, 404); } }
    if (b.action !== "dismiss") { const g = await gated(own, "brief_set"); if (g) return g; } // the owner's standing rules for assistants
    if (!await own.dir.actUse(own.cred, String(b.nonce ?? ""))) return j({ ok: false, error: "this button expired (each change works once, for 5 minutes); reload the page and try again" }, 403);
    try { return j({ ok: true, result: await own.dir.admin("brief_set", { space: String(b.space ?? "main"), action: String(b.action ?? ""), text: b.text, base: b.base, commit: b.commit, id: b.id }) }); }
    catch (e: any) { const m = String(e.message ?? e); return j({ ok: false, error: /^conflict on/.test(m) ? "These instructions changed meanwhile (another tab or an accepted suggestion). Reload to see them, then make your change again." : m }, /^conflict on/.test(m) ? 409 : /^no space|isn't in the history|already decided/.test(m) ? 404 : 400); }
  }
  // Settings -> Connection (No server / domain, client/tunnel.ts): read = the address + tunnel health; presses need the session AND a nonce
  if (b.op === "connection" || b.op === "tunnel_act") {
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    if (b.op === "connection") { try { return j({ ok: true, result: { ...await own.dir.admin("connection", {}), origin: url.origin, operator: isRoot(own.acct) } }); } catch (e: any) { return j({ ok: false, error: String(e.message ?? e) }, 500); } }
    if (!isRoot(own.acct)) return j({ ok: false, error: "only the server's operator runs its tunnel" }, 403);
    if (b.action !== "stop") { const g = await gated(own, "tunnel_act"); if (g) return g; } // security settings: what the public address exposes
    if (!await own.dir.actUse(own.cred, String(b.nonce ?? ""))) return j({ ok: false, error: "this button expired (each action works once, for 5 minutes); reload the page and try again" }, 403);
    try { return j({ ok: true, result: await own.dir.admin("tunnel_ask", { action: b.action, token: b.token, hostname: b.hostname }) }); } catch (e: any) { return j({ ok: false, error: String(e.message ?? e) }, 400); }
  }
  // Settings -> Connection -> Public address lockdown (src/ingress.ts): read = the setting, whether it bites now and why, and which listener
  // this page came in on. Turning it ON works from anywhere; turning it OFF (or back to auto) widens access, so only from this computer
  // (the local listener) or the server shell (kitebook admin ingress off), never from the public address.
  if (b.op === "ingress" || b.op === "ingress_set") {
    const own = await sessionOwner(req, h.dir); if (!own) return j({ ok: false, error: "sign in first" }, 401);
    const via = ingressOf(req, env), view = async () => ({ ...await lockdownFor(env, own.dir), via, local_listener: hasLocalListener(env), edge_routes: edgeRoutes().map(r => r.why) });
    if (b.op === "ingress") return j({ ok: true, result: await view() });
    const want = String(b.lockdown ?? "");
    if (!["on", "off", "auto"].includes(want)) return j({ ok: false, error: "lockdown: on | off | auto" }, 400);
    if (want !== "on" && via !== "local") return j({ ok: false, error: "turning the lockdown off works only on this computer's own Kitebook page (http://127.0.0.1) or with kitebook admin ingress off on the server" }, 403);
    if (want !== "on") { const g = await gated(own, "ingress_off"); if (g) return g; } // widens what the public address shows: presence (on is never gated)
    if (!await own.dir.actUse(own.cred, String(b.nonce ?? ""))) return j({ ok: false, error: "this button expired (each change works once, for 5 minutes); reload the page and try again" }, 403);
    await own.dir.ingressSet(want); return j({ ok: true, result: await view() });
  }
  return j({ ok: false, error: "op: signup | signin | signout | link_signin | login_ask | login_poll | passkey_login_begin | passkey_login | passkey_begin | passkey_add | passkey_remove | login_decide | recovery_new | devices | device_remove | mint | app_add | connect | app_expiry | autorun_key | autorun_set | experimental_set | ci_run | owner_cmd | status | revoke | nonce | act | policy | policy_set | owner_key | app_key | dev_key | dev_set | app_updates | connection | ingress | ingress_set | tunnel_act | brief | brief_set | presence_ask | presence_state | presence_password | presence_passkey_challenge | presence_passkey | remote_pw | remote_pw_set | machines | machine_approve | machine_revoke | machine_rename | machine_shortcut_off | machine_password_reset | joins | join_approve | join_deny" }, 400);
}
// The Get started checklist on /start ticks itself from real state: a runner online now, an assistant or coding agent that has
// connected at least once, a task that finished successfully. all = the checklist shrinks to one line.
export function setupState(st: any) {
  const sp: any[] = st?.spaces ?? [], peers = sp.flatMap(x => x.peers ?? []);
  const mac = peers.some(p => p.kind === "runner" && p.online), agent = peers.some(p => (p.kind === "assistant" || p.kind === "coding_agent") && !p.never_connected);
  const task = sp.some(x => (x.done_tasks ?? 0) > 0 || (x.recent ?? []).some((t: any) => t.state === "succeeded"));
  return { mac, agent, task, all: mac && agent && task };
}
const b64 = (n: number) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---------- the page ----------
// Step 3 of Get started: a first task the newcomer pastes into their assistant (small, safe, and easy to check on the result)
const SAMPLE = 'Use Kitebook to send my Mac a small coding task: in one of my projects, add a short "How to run it" section to the README. Tell me when it is done and what changed.';
// first sign-in in plain words: the one-step install (scripts/get.sh) already opened the browser signed in, and puts `kitebook open` on the Mac;
// a Kitebook server deployed by hand (Advanced) signs in with its ADMIN_TOKEN as the recovery code
const FIRST = (_o: string) => `On the Mac running Kitebook, open Terminal and type <code>${CLI} open</code>: it opens this page signed in. Set it up some other way (Cloudflare, by hand)? Paste the server's <code>ADMIN_TOKEN</code> (its recovery code) under <b>Use a recovery code</b>.`;
// Home: a full-window workspace with persistent navigation, grouped tasks and connected apps alongside them. One status sentence (#nowline), then one line per
// task that needs you (title + Approve), per running task (title + Cancel) and at most 3 recent ones (title · Done/Failed). Everything else
// about a task (review, reject, answer, steer, retry, hand-off, the next command, diff, test log, timeline, who's working on it) is on its own
// page, /start#task-<id> (#taskview, same document). Get started shows only the current step and goes away once done; the apps, the ways to
// connect and the agent links sit under Connection options. Tokens and layout: src/ui.ts.
const START_CSS = `.page{max-width:640px;margin:0 auto;padding:0 20px 64px}
header.top{display:flex;align-items:center;gap:20px;padding:16px 0 4px}header.top h1{font-size:20px;margin:0;flex:1}
header.top a,header.top button.link{color:var(--mut);text-decoration:none;font-size:16px}header.top a:hover,header.top button.link:hover{color:var(--fg)}
h2{font-size:24px;margin:0 0 8px}h3{font-size:17px;margin:24px 0 4px}p{margin:8px 0}.lead{font-size:18px;margin:4px 0 24px}.note{font-size:15px}
section{margin:40px 0}label{display:block;margin:16px 0 6px;color:var(--mut);font-size:15px}
.bar{display:flex;gap:12px;margin-top:20px}.bar>button{flex:1;background:var(--acc);color:var(--onacc)}.bar>button:hover{background:var(--acc2)}
.code{display:flex;gap:8px;align-items:flex-start;margin:8px 0}.code pre{flex:1;min-width:0}button.cp{flex:none;min-height:44px;padding:10px 16px;font-size:15px}
button.pri,.step button.main{background:var(--acc);color:var(--onacc)}button.pri:hover,.step button.main:hover{background:var(--acc2)}
.way{margin:16px 0}details>summary{color:var(--link)}
.nowline{font-size:22px;font-weight:600;line-height:1.3;margin:20px 0 12px}@media (max-width:560px){.nowline{font-size:20px}}
.row{display:flex;align-items:center;gap:12px;min-height:56px;padding:4px 0;border-top:1px solid var(--line)}.row.g{margin-top:8px}
.row>.t{flex:1;min-width:0;color:var(--fg);text-decoration:none;font-size:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}a.t:hover{text-decoration:underline}
.w{color:var(--mut);font-size:15px;white-space:nowrap}.w.need{color:var(--acc);font-weight:600}.w.bad{color:var(--danger);font-weight:600}
.row button{flex:none;min-height:40px;padding:8px 16px;font-size:15px}button.rv{background:none;color:var(--danger);font-weight:600}button.rv:hover{background:var(--soft)}
.row.one{border:0;min-height:0;padding:0;flex-wrap:wrap}.row.one>.t{white-space:normal}
#setup{margin:8px 0 24px}ol.steps{list-style:none;margin:0;padding:0}.step:not(.cur){display:none}.step p{margin:0 0 12px;font-size:18px}.step .act{display:flex;flex-wrap:wrap;gap:8px}.step .act>div,.step .act .note{flex-basis:100%;margin:0}
.tag{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
details#more{margin-top:24px;border-top:1px solid var(--line);padding-top:4px}details#more>summary{color:var(--mut)}#taskview details.fold>summary>span:first-child{flex:none;font-weight:600}#taskview details.fold>summary .v{font-weight:400;flex:1;min-width:0;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}details#more>summary>span:first-child{flex:none}details#more>summary .v{flex:1;min-width:0;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}details#more h3{margin-top:20px}
.tile{padding:8px 0}.tile h3{margin:16px 0 0}details#more .note{margin:4px 0}
.toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);max-width:min(92vw,600px);margin:0;background:var(--fg);color:var(--bg);padding:12px 18px;border-radius:12px;font-size:16px;font-weight:600;box-shadow:0 6px 24px rgba(0,0,0,.22);z-index:9}.toast:empty{display:none}
.devbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.devbar button{min-height:40px;padding:8px 14px}
#taskview h2{font-size:26px;line-height:1.25;margin:16px 0 4px}#taskview .sub{color:var(--mut);font-size:15px;margin:0 0 16px}a.back{font-size:16px;text-decoration:none}
.acts{display:flex;gap:8px;align-items:center;margin:12px 0;flex-wrap:wrap}.acts input{flex:1;min-width:180px;min-height:44px;padding:10px 12px;font-size:16px}.acts select{width:auto;min-height:44px;font-size:15px;padding:8px 12px}.acts button,.acts a.btn{min-height:44px;padding:10px 16px;font-size:15px}.acts small{color:var(--mut);font-size:15px;flex-basis:100%}
.next{font-size:16px;margin:12px 0;color:var(--mut);word-break:break-word}.next b{color:var(--fg)}.next .cmd{display:inline-flex;align-items:center;gap:8px;max-width:100%;vertical-align:middle}.next .cmd code{min-width:0;overflow-x:auto;white-space:nowrap}.next button{min-height:36px;padding:6px 12px;font-size:15px}
.detail details{border-top:1px solid var(--line)}.detail details>summary{font-weight:600;color:var(--fg)}.detail details pre{max-height:50vh;overflow:auto;margin:0 0 12px}
details.menu{position:relative}details.menu>summary{min-height:40px;padding:0 12px;border-radius:10px;font-size:20px;color:var(--mut)}details.menu>summary::before{display:none}
.pop{position:absolute;right:0;top:110%;background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:12px;min-width:220px;z-index:2;box-shadow:0 8px 28px rgba(0,0,0,.14)}.pop p{margin:0 0 10px;font-size:15px}.pop button{font-size:15px;min-height:40px;padding:8px 12px;margin:0 8px 0 0}button.rvq{background:none;color:var(--danger);padding:6px 0;min-height:0;font-weight:400}`;

function startPage(s: { acct: string | null; hint: string | null; multi: boolean; open: boolean; fresh?: boolean; local?: boolean; dcr: boolean; dcrMode: string; next: string | null; oauth: string | null; origin: string; pub?: string | null }, nonce: string) {
  const web = s.pub ?? s.origin; // what cloud assistants (Claude.ai, ChatGPT, any web agent) reach: the tunnel's public address when this page is open on the Mac itself
  const o = esc(s.origin), code = (id: string, text = "") => `<div class="code"><pre id="${id}">${esc(text)}</pre><button class="cp" data-for="${id}" aria-label="Copy">Copy</button></div>`;
  const card = (title: string, body: string) => `<section><h2>${title}</h2>${body}</section>`;
  const mintBtn = (what: string, label: string, cls = "") => `<button class="mint${cls}" data-client="${what}">${label}</button><p class="note" id="n-${what}" hidden></p><div id="c-${what}" hidden>${code("s-" + what)}</div>`;
  // one app under More: its name, one line, the command (Copy); the key fallback is one more button
  const app = (title: string, line: string, body: string) => `<div class="tile"><h3>${title}</h3><p class="note">${line}</p>${body}</div>`;
  // a Kitebook server on 127.0.0.1 / localhost with no tunnel up: coding agents on this computer reach it, cloud assistants can't
  const localOnly = s.local && !s.pub ? `<p class="warn localonly">This address only works on this computer, so cloud assistants can't reach it yet: turn on public access in Settings, or deploy it.</p>` : "";
  const LEAD = `<p class="lead">Your assistants ask, your Mac's coding agents do the work, and nothing runs until you approve.</p>`;
  const out = s.acct === null
    ? `<main class="out">
${s.open ? card("Create your account", `${LEAD}<label>Account name</label><input type="text" id="acct" autocomplete="username" placeholder="e.g. alice"><div class="bar"><button id="signup">Sign up</button></div>`) : ""}
${s.fresh ? card("First time here? Sign in as the owner", `${s.open ? "" : LEAD}<p>This Kitebook is new: nobody has signed in yet. ${FIRST(s.origin)}</p><p class="note">After that you're signed in for 30 days, and connecting your Mac puts a <code>kitebook</code> command on it (<code>kitebook open</code> signs any browser in later).</p>`) : ""}
${card(s.open ? "Already have an account?" : s.fresh ? "Signed in before?" : "Sign in", `${s.open || s.fresh ? "" : LEAD}${s.multi ? `<label for="acct2">Your Kitebook account name</label><input type="text" id="acct2" autocomplete="username" value="${esc(s.hint ?? "")}">` : ""}
<div class="bar"><button id="pkin">Sign in with a passkey</button></div><p class="note">No password needed. A passkey lives on your phone, laptop or password manager; add one in Settings once you're signed in.</p>
<div class="way"><b>On your Mac</b><p class="note">In Terminal, run <code>kitebook open</code>. It opens this page already signed in, and this browser stays signed in for 30 days.</p></div>
<details id="other"${s.fresh ? " open" : ""}><summary>Other ways to sign in</summary><div class="ways"><details id="askd"><summary>Not at your Mac's browser? Approve this browser from your Mac</summary><div class="bar"><button id="askgo">Send a sign-in request</button></div>
<div id="askwait" hidden><p class="st">Waiting for your OK. Code <code id="askcode"></code></p><p class="note">On your Mac, in Terminal:</p><pre id="askcmd"></pre><p class="note">Or approve it in a browser that's already signed in (Get started or Settings).</p></div></details>
<details id="rcbox"${s.fresh ? " open" : ""}><summary>Use a recovery code${s.multi ? "" : " (or this Kitebook's ADMIN_TOKEN)"}</summary><label for="key">${s.multi ? "Recovery code" : "Recovery code or ADMIN_TOKEN"}</label><input type="password" id="key" autocomplete="current-password"><div class="bar"><button id="signin">Sign in</button></div></details>${s.open ? "" : s.multi ? `<p class="note">New here? Signup on this Kitebook is by its operator. Ask them for an account.</p>` : s.fresh ? "" : `<details id="firstd"><summary>Run this Kitebook yourself and never signed in?</summary><p class="note">${FIRST(s.origin)}</p></details>`}</div></details>`)}
<div id="keybox" hidden><p class="st">You're in. This browser stays signed in for 30 days.</p><details id="rcsave"><summary>Save a recovery code (optional)</summary><p class="note">It signs you in if you ever lose every browser and passkey. It can't be shown again; a password manager is a good place.</p>${code("adminkey")}</details>
<div class="bar"><button id="cont">Continue</button></div></div></main>`
    : `<main id="home"><p id="nowline" class="nowline" role="status"></p><div id="devs"></div>
<section id="setup" hidden><div id="steps"><ol class="steps">
<li class="step cur" id="step-mac" aria-current="step"><p>Step 1 of 3 · Connect your Mac: run one line in Terminal. <span class="tag state">Now</span></p><div class="act">${mintBtn("runner", "Create install command", " main")}</div></li>
<li class="step" id="step-agent"><p>Step 2 of 3 · Connect an assistant, like Claude.ai, ChatGPT, Hark or Claude Code. <span class="tag state">Next</span></p>${localOnly}<div class="act"><button id="pick" class="main">Choose an app</button></div></li>
<li class="step" id="step-task"><p>Step 3 of 3 · Paste a first task into your assistant, then approve it here. <span class="tag state">Next</span></p><pre id="sample" hidden>${esc(SAMPLE)}</pre><div class="act"><button class="cp main" id="cp-sample" data-for="sample">Copy the request</button></div></li>
</ol></div></section>
<div class="workspace-grid"><div class="activity-column"><div id="stat" class="live"><p class="note">Loading…</p></div></div>
<aside class="workspace-context" aria-label="Connected apps and computers"><div class="context-heading"><h2>Connected</h2><a href="/settings#apps">Manage</a></div><div id="peers"><p class="note">Loading…</p></div><div><p class="note">Your assistants send tasks. Your coding agents work on your computer.</p><a class="context-link" href="#more">Connect another app</a></div></aside></div>
<details id="more" class="fold"><summary><span>Connection options</span><span class="v" id="more-n"></span></summary>
<p class="note">${isRoot(s.acct) ? "Signed in as the owner" : `Signed in to <b>${esc(s.acct)}</b>`} · <button class="link" id="showsteps">Show the setup steps</button></p>
<h3>Connect another app</h3>${localOnly}<div class="connect-grid">
${app("Claude.ai and ChatGPT", "Add a custom connector with this address, then approve it here once.", `${code("mcpurl", web + "/mcp")}${s.dcrMode === "off" ? `<p class="warn">Claude.ai and ChatGPT can't connect yet: this server doesn't let apps sign themselves up. Whoever runs it turns that on by removing <code>OAUTH_DCR=0</code>.</p>` : ""}`)}
${app("Hark", "Give Hark a one-time invite link.", mintBtn("hark", "Create Hark invite link"))}
${app("Claude Code", "Run this, then <code>/mcp</code> → Authenticate. No browser there? Create a key command.", `${code("cc-oauth", `claude mcp add --transport http kitebook ${s.origin}/mcp -s user`)}${mintBtn("claude-code", "Create Claude Code command")}`)}
${app("Codex", "Run this and approve in the browser it opens.", `${code("cx-oauth", `codex mcp add kitebook --url ${s.origin}/mcp && codex mcp login kitebook`)}${mintBtn("codex", "Create Codex command")}`)}
${app("Pi", "Run this, approve in the browser, then type <code>/reload</code> in Pi.", `${code("pi-oauth", `pi mcp add kitebook --url ${s.origin}/mcp && pi mcp login kitebook`)}${mintBtn("pi", "Create Pi command")}`)}
${app("Any other agent", `Point it at the setup guide (OpenAPI 3.1: <code>${o}/openapi.json</code>).`, code("guide", web + "/llms.txt"))}
</div><p class="note">For agents: <a href="/llms.txt">setup guide</a> · <a href="/openapi.json">OpenAPI</a> · connector address <code>${o}/mcp</code></p></details></main>
<main id="taskview" hidden></main>`;
  const data = JSON.stringify(s).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>${s.acct === null ? "Sign in" : "Workspace"} · Kitebook</title>
<link rel="alternate" type="text/markdown" href="/llms.txt">
<style>${THEME_CSS}${BASE_CSS}${FOLD_CSS}${START_CSS}${s.acct === null ? "" : WORKSPACE_CSS}</style></head><body${s.acct === null ? "" : ' class="workspace"'}>${s.acct === null ? "" : `<div class="workspace-shell">${workspaceNav("home")}<div class="workspace-main" id="workspace-content" tabindex="-1">`}<div class="page">
<header class="top">${s.acct === null ? "<h1>Kitebook</h1>" : `<div class="heading"><h1>Workspace</h1><p>Keep your agents and their work in view.</p></div><a id="settings" class="btn" href="/settings#apps">Manage apps</a><button id="signout" class="link">Sign out</button>`}</header>
${s.acct === null ? "" : `<div id="autorunbanner" class="warn devbar" role="status" hidden></div><div id="pwbanner" class="warn" role="status" hidden></div><div id="downbanner" class="warn" role="alert" hidden></div>`}${out}
${s.acct === null ? `<p class="note">For agents: <a href="/llms.txt">setup guide</a> · <a href="/openapi.json">OpenAPI</a> · connector address <code>${o}/mcp</code></p>` : ""}</div>
${s.acct === null ? "" : "</div></div>"}<p id="msg" class="toast" role="status" aria-live="polite"></p>
<script id="st" type="application/json">${data}</script>
<script nonce="${nonce}">
${FOLD_JS}
${s.acct === null ? "" : WORKSPACE_JS}
${OWNER_JS}
const S=JSON.parse(document.getElementById("st").textContent),$=id=>document.getElementById(id);
let mt=0;const msg=t=>{$("msg").textContent=t;clearTimeout(mt);if(t)mt=setTimeout(()=>{$("msg").textContent=""},15000)}; /* a toast: it never pushes the page around */
${PRESENCE_JS}
const post=async b=>{const r=await withPresence(()=>fetch("/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}));return await r.json()};
const done=()=>S.oauth?location.assign(S.oauth):S.next?location.assign(S.next):location.reload(); /* mid-connect: straight back to the app's approval */
// Copy that really copies: the clipboard API (https or localhost), else a hidden textarea + execCommand (plain-http Kitebook servers)
const copyText=async t=>{try{await navigator.clipboard.writeText(t);return true}catch(e){}try{const a=document.createElement("textarea");a.value=t;a.setAttribute("readonly","");a.style.position="fixed";a.style.opacity="0";document.body.append(a);a.select();const ok=document.execCommand("copy");a.remove();return ok}catch(e){return false}};
document.querySelectorAll("button.cp").forEach(b=>b.onclick=async()=>{if(await copyText($(b.dataset.for).textContent))b.textContent="Copied";else msg("Select the text and copy it by hand")});
if($("signup"))$("signup").onclick=async()=>{msg("Creating…");const r=await post({op:"signup",account:$("acct").value.trim()});if(!r.ok)return msg(r.error);msg("");
document.querySelectorAll("section").forEach(x=>x.hidden=true);$("adminkey").textContent=r.result.admin_key;$("keybox").hidden=false};
// ---- signing in without the recovery code: kitebook open's link (#login=…, used once), a passkey, or a request approved on the Mac ----
const enc=t=>new TextEncoder().encode(t),b64u=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
{const lk=location.hash.match(/^#login=(ll\\.[a-z0-9-]+\\.[A-Za-z0-9_-]+)(?:&trust=([A-Za-z0-9_-]{20,64}))?(&to=settings)?$/);if(lk){history.replaceState(null,"",location.pathname+location.search);msg("Signing in…");
/* trust: a secret only this browser and the Mac that made the link know; the page proves it when it registers its key, so the Mac trusts this browser by itself */
post({op:"link_signin",token:lk[1]}).then(r=>{if(!r.ok)return msg(r.error);try{if(lk[2])sessionStorage.setItem("relay-trust",lk[2])}catch(e){}if(lk[3])location.assign("/settings");else done()})}}
${PASSKEY_JS}
const acctName=()=>$("acct2")?$("acct2").value.trim():"";
if($("pkin"))$("pkin").onclick=async()=>{if(S.multi&&!acctName())return msg("Type your Kitebook account name first");try{await pkSignIn(S.multi?(acctName()===${JSON.stringify(ROOT_ACCOUNT)}?"/api/auth":"/u/"+acctName()+"/api/auth"):"/api/auth");done()}catch(e){msg(e.message)}};
if($("askgo"))$("askgo").onclick=async()=>{if(S.multi&&!acctName())return msg("Type your Kitebook account name first");msg("Sending…");const r=await post({op:"login_ask",account:acctName()});if(!r.ok)return msg(r.error);msg("");
$("askcode").textContent=r.result.code;$("askcmd").textContent="kitebook approve "+r.result.code;$("askwait").hidden=false;$("askgo").disabled=true;
if(r.result.runners===0&&!S.multi)msg("No Mac is connected to this Kitebook yet, so only a browser that's already signed in can approve this. First time? On the Mac running Kitebook, type kitebook open in Terminal.");
for(;;){await new Promise(x=>setTimeout(x,2000));const p=await post({op:"login_poll",poll:r.result.poll});if(!p.ok){$("askgo").disabled=false;return msg(p.error)}
if(p.result.state==="approved")return done();if(p.result.state!=="pending"){$("askgo").disabled=false;$("askwait").hidden=true;return msg(p.result.state==="denied"?"That sign-in was turned down.":p.result.state==="expired"?"That request expired. Send a new one.":"Not signed in: "+(p.result.error||p.result.state))}}};
if($("cont"))$("cont").onclick=()=>done(); /* the recovery code is optional: Continue never waits for it */
if($("signin"))$("signin").onclick=async()=>{msg("Checking…");const r=await post({op:"signin",admin_key:$("key").value.trim()});if(!r.ok)return msg(r.error);done()};
if($("key"))$("key").onkeydown=e=>{if(e.key==="Enter")$("signin").click()};
if($("signout"))$("signout").onclick=async()=>{await post({op:"signout"});location.reload()};
document.querySelectorAll("button.mint").forEach(b=>b.onclick=async()=>{const c=b.dataset.client;b.disabled=true;msg("");const r=await post({op:"mint",client:c});b.disabled=false;
if(!r.ok)return msg(r.error);$("s-"+c).textContent=r.result.snippet;$("n-"+c).textContent=r.result.note+(r.result.expires?" Good until "+when(r.result.expires)+".":"");$("n-"+c).hidden=false;$("c-"+c).hidden=false;b.textContent="Create another";
/* the line is the next thing to act on: its Copy becomes the one filled button, the mint button goes quiet */b.classList.remove("main");$("c-"+c).querySelector("button.cp").classList.add("pri")});
const when=x=>{const d=new Date(x);return isNaN(d)?String(x):d.toLocaleString([],{weekday:"short",hour:"numeric",minute:"2-digit"})};
// everything below is peer-written text, so it only ever goes in through textContent
const el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
const kindLabel=k=>({runner:"your Mac (runner)",coding_agent:"coding agent",assistant:"assistant",human:"person"})[k]||String(k||"app").replace(/_/g," ");
const ago=t=>{if(!t)return"never";const s=Math.max(0,Math.round((Date.now()-Date.parse(t))/1000));return s<90?s+" s ago":s<5400?Math.round(s/60)+" min ago":s<172800?Math.round(s/3600)+" h ago":Math.round(s/86400)+" d ago"};
const act=async(space,task,action,extra)=>{const n=await post({op:"nonce"});if(!n.ok)return msg(n.error);const r=await post({op:"act",space,task,action,nonce:n.result.nonce,...(extra||{})});msg(r.ok?(action==="approve"?"Approved, starting…":action==="reject"?"Rejected.":action==="answer"?"Answer sent. The agent resumes.":action==="steer"?"Sent. The agent reads it at its next turn.":action==="cancel"?"Cancelled.":"Done: "+r.result.note+"."):"Not done: "+r.error);stat(true)};
const btn=(label,cls,fn)=>{const b=el("button",cls,label);b.onclick=async e=>{e.stopPropagation();b.disabled=true;try{await fn()}finally{b.disabled=false}};return b};
// the ⋯ menu per connected app (under More): Revoke sits here, behind a confirm step
const appMenu=p=>{const d=el("details","menu"),sm=el("summary","","⋯"),pop=el("div","pop"),rv=el("button","rvq","Revoke…"),cf=el("div","cf");sm.title="More for "+p.name;sm.setAttribute("aria-label","More for "+p.name);cf.hidden=true;
cf.append(el("p","","Revoke "+p.name+"? It loses access right away. To use it again you connect it again."),btn("Yes, revoke","rv",async()=>{const q=await post({op:"revoke",peer:p.name});if(!q.ok)return msg(q.error);msg("Revoked "+p.name);d.open=false;stat(true)}),btn("Keep it","link",async()=>{cf.hidden=true;rv.hidden=false;d.open=false}));
rv.onclick=()=>{rv.hidden=true;cf.hidden=false};pop.append(rv,cf);d.append(sm,pop);return d};
// one line on Home: the title (opens the task's page) and one word or one button on the right
const row=(id,title,word,cls)=>{const r=el("div","row"),a=el("a","t",title);a.href="#task-"+encodeURIComponent(id);r.id="task-"+id;r.append(a);if(word)r.append(el("span","w"+(cls?" "+cls:""),word));return r};
const line=(a,b)=>{const r=el("div","row one"),l=el("span","t",a);r.append(l);if(b)r.append(el("span","w",b));return r};
// the ONE next action: open the PR / compare link, or copy the command (merge, retry, push, run the plan)
function nextBar(n){const nx=el("div","next");nx.append(el("b","","Next: "),el("span","",n.text+" "));if(n.url&&String(n.url).startsWith("https://")){const a=el("a","go",n.action==="open_pr"?"Open the pull request":"Open");a.href=n.url;a.rel="noreferrer";a.target="_blank";nx.append(a)}
else if(n.cmd){const c=el("span","cmd");c.append(el("code","",n.cmd),btn("Copy","cp",async()=>{msg(await copyText(n.cmd)?"Copied":"Select the command and copy it by hand")}));nx.append(c)}return nx}
const who=t=>t.agent?t.agent+(t.model?" ("+t.model+")":""):"runner's default agent";
const dur=s=>s<90?s+" s":s<5400?Math.round(s/60)+" min":Math.round(s/3600)+" h";
// one-tap recovery (failed, rejected, cancelled, stuck): Retry on the same branch, Retry with a note, Hand to another of the runner's agents
const recov=(sp,t)=>{const bar=el("div","acts"),rc=t.recover;if(rc.retried_as)bar.append(el("small","","Retried as "+rc.retried_as.id+" ("+rc.retried_as.state+")."));
const stop=t.stuck?" It is stopped first (its partial work stays on its branch).":"";
bar.append(btn("Retry","",async()=>{if(confirm("Retry "+t.title+" on the same branch?"+stop))await act(sp.space,t.id,"retry")}));
const i=el("input","ans");i.type="text";i.placeholder="Note for the agent (optional)";i.maxLength=2000;
bar.append(i,btn("Retry with note","",async()=>{if(!i.value.trim())return msg("Write a note first");if(!t.stuck||confirm("Retry "+t.title+" with your note?"+stop)){await act(sp.space,t.id,"retry_note",{note:i.value});i.value=""}}));
const ags=(rc.agents||[]).filter(a=>a!==rc.agent);if(ags.length){const s=el("select","ans");for(const a of ags){const o=el("option","",a);o.value=a;s.append(o)}
bar.append(s,btn("Hand to agent","",async()=>{if(confirm("Hand "+t.title+" to "+s.value+"? It continues on the same branch."+stop)){await act(sp.space,t.id,"handoff",{agent:s.value,note:i.value||undefined});i.value=""}}))}
return bar};
// live steering: a note for the running agent, delivered when its current turn ends (same session); says whether it arrived
const steerBar=(sp,t)=>{const bar=el("div","acts steer"),i=el("input","ans");i.type="text";i.placeholder="Tell the agent something (it reads it at its next turn)";i.maxLength=4000;i.setAttribute("aria-label","Steer "+t.title);
bar.append(i,btn("Send","",async()=>{if(!i.value.trim())return msg("Write a note for the agent first");await act(sp.space,t.id,"steer",{message:i.value});i.value=""}));
const st=t.steers;if(st&&st.last)bar.append(el("small","",st.pending?"Your note #"+st.last.n+" waits for the agent's next turn"+(st.pending>1?" ("+st.pending+" waiting)":"")+".":st.last.refused_at?"Note #"+st.last.n+" wasn't approved on your Mac, so the agent didn't get it.":"Note #"+st.last.n+" reached the agent "+ago(st.last.delivered_at)+"."));return bar};
/* master password (src/devices.ts): a LOCKED computer (installed with no terminal) shows its one-time setup link; one with only the fingerprint shortcut asks for a password */
let pwAt=0;async function pwBanner(){const b=$("pwbanner");if(!b||Date.now()-pwAt<60000)return;pwAt=Date.now();const r=await post({op:"machines"}).catch(()=>null);if(!r||!r.ok)return;
const ds=r.result.devices.filter(d=>d.state==="active"),out=[];
for(const d of ds.filter(d=>d.locked)){const p=el("p","",d.name+" is locked until it has a master password: ");if(d.setup){const a=el("a","","open its one-time setup link");a.href=d.setup.url;a.target="_blank";a.rel="noopener noreferrer";p.append(a,document.createTextNode(" on it, or run "))}else p.append(document.createTextNode("run "));p.append(el("code","","kitebook password set"),document.createTextNode(" there."));out.push(p)}
for(const d of ds.filter(d=>!d.locked&&!d.password)){const p=el("p","","Set a master password on "+d.name+": ");p.append(el("code","","kitebook password set"));out.push(p)}
b.hidden=!out.length;b.replaceChildren(...out)}
let LAST=null;const busy=box=>{const fo=document.activeElement;return!!box&&([...box.querySelectorAll("input.ans")].some(i=>i.value||i===fo)||(fo&&fo.tagName==="SELECT"&&box.contains(fo))||!!box.querySelector("details.menu[open]"))}; /* never redraw under a half-typed note, an open picker or an open ⋯ menu */
async function stat(force){pwBanner().catch(()=>{});const box=$("stat");if(!box)return;if(!force&&(busy(box)||busy($("taskview"))||busy($("peers"))))return;
const r=await post({op:"status"}).catch(()=>null);if(!r||!r.ok){box.replaceChildren(el("p","note",r?r.error:"can't reach the server"));return}
LAST=r.result;autorunBanner(LAST.spaces);downBanner(LAST.spaces);nowLine(LAST.spaces);home(LAST.spaces);peers(LAST.spaces);setup(LAST.setup);if(TV)taskView()}
// Home: only what can be acted on now. A task that needs you: title + Approve; running: title + Cancel; then at most 3 recent ones.
function home(spaces){const out=[],attention=[],running=[],recent=[],many=spaces.length>1,ws=sp=>many?" · "+sp.space:"";let rec=[];
for(const sp of spaces){if(sp.paused)out.push(el("p","warn","Paused: no new tasks are accepted until you resume "+(many?"workspace "+sp.space:"this workspace")+"."));
for(const p of sp.peers)if(p.phone_on){const w=el("p","warn",p.name+" asks only in its Mac dialog, so approvals can wait unseen. "),a=el("a","","Turn on phone approvals");a.href="/settings#approvals";w.append(a);out.push(w)}
for(const t of sp.needs_you){const x=row(t.id,t.title,t.approved?"starting…":t.state==="needs_input"?"question":null,t.approved?"":"need");if(!t.approved||t.state==="needs_input")x.classList.add("need");
if(!t.approved&&t.state!=="needs_input"){if(t.review&&!t.passkey)x.append(btn("Approve","pri",()=>act(sp.space,t.id,"approve")));else if(t.review){const a=el("a","btn pri","Approve");a.href=t.review;x.append(a)}}
else if(t.state==="needs_input"){const a=el("a","btn pri","Answer");a.href="#task-"+encodeURIComponent(t.id);x.append(a)}(t.approved&&t.state!=="needs_input"?running:attention).push(x)}
for(const t of sp.open){if(sp.needs_you.some(n=>n.id===t.id))continue;const x=row(t.id,t.title,t.stuck?"stuck?":t.state==="running"?(t.elapsed_s!=null?dur(t.elapsed_s):"running")+ws(sp):t.state==="queued"?"queued"+ws(sp):String(t.state).replace(/_/g," "),t.stuck?"need":"");
x.append(btn("Cancel","rv",async()=>{if(confirm("Cancel "+t.title+"? A running agent is stopped; its partial work stays on its branch."))await act(sp.space,t.id,"cancel")}));running.push(x)}
for(const q of sp.quick||[])if(!q.done)running.push(row(q.id,q.question,"answering…"));
rec=rec.concat(sp.recent.map(t=>({sp,t})),(sp.quick||[]).filter(q=>q.done).map(q=>({sp,t:q,q:1})))}
rec.sort((a,b)=>(Date.parse(b.t.updated)||0)-(Date.parse(a.t.updated)||0));
rec.slice(0,3).forEach(({t,q},i)=>{const h=t.result_headline,o=q?(t.needs_task&&!t.ran_as_task?"needs changes":t.state==="succeeded"?"answered":t.state):h?h.label:t.state==="succeeded"?"Done":t.state;
const x=row(t.id,q?t.question:t.title,String(o).replace(/^./,c=>c.toUpperCase()),/fail|reject/i.test(o)?"bad":/needs/.test(o)?"need":"");recent.push(x)});
const notices=out.length;const group=(title,items,cls)=>{if(!items.length)return;const g=el("section","task-group"+(cls?" "+cls:"")),h=el("h2","",title);h.append(el("span","group-count",String(items.length)));g.append(h,...items);out.push(g)};
group("Needs your attention",attention,"attention");group("In progress",running);group("Recent activity",recent);
if(!attention.length&&!running.length){const e=el("div","workspace-empty");e.append(el("h3","",recent.length?"All caught up":"Your workspace is ready"),el("p","",recent.length?"No tasks are waiting for you. Your next task will appear here.":"Send a task from a connected assistant. You can review it here before your coding agent starts."));if(!recent.length){const a=el("a","","Connect an assistant");a.href="#more";e.append(a)}out.splice(notices,0,e)}
$("stat").replaceChildren(...out)}
// More -> Your Mac and apps: one line each, with ⋯ (Revoke); never-used ones say so
function peers(spaces){const box=$("peers");if(!box)return;const out=[];
for(const sp of spaces)for(const p of sp.peers){const run=p.kind==="runner",x=line(p.name,(run?(p.online?"online":"offline, last seen "+ago(p.last_seen)):p.never_connected?"not connected yet":kindLabel(p.kind)+(p.online?", in use now":", last used "+ago(p.last_seen)))+(p.approval_unreachable?" · approvals can't reach you: "+p.approval_unreachable:""));
if(p.updated){const u=p.updated,n=el("span","w",u.result==="installed"?"updated to "+u.to+" "+ago(u.at):"tried "+u.to+", went back");n.id="updated-"+p.name;n.title=u.why||"";x.append(n)}x.append(appMenu(p));out.push(x)}
if(!out.length)out.push(el("p","note","No apps connected yet."));box.replaceChildren(...out);
/* More's one-line summary: who is connected, so the closed fold already answers "is my Mac / my app there?" */
const ps=spaces.flatMap(sp=>sp.peers),nm=ps.slice(0,3).map(p=>p.name).join(", ")+(ps.length>3?" +"+(ps.length-3):"");const mn=$("more-n");if(mn)mn.textContent=(nm?nm+" · ":"")+"connect an app"}
// the one sentence at the top: what needs you, what's running, and whether the Mac is there
function nowLine(spaces){const n=$("nowline");if(!n)return;let need=0,run=0,wait=0;const macs=[];for(const sp of spaces){need+=sp.needs_you.filter(t=>!t.approved||t.state==="needs_input").length;for(const t of sp.open){if(t.state==="running")run++;else if(t.state!=="awaiting_approval"&&t.state!=="needs_input")wait++}
for(const p of sp.peers)if(p.kind==="runner"&&!p.never_connected)macs.push(p)}const pl=(k,a,b)=>k+" "+(k===1?a:b),parts=[];if(need)parts.push(pl(need,"task needs you","tasks need you"));if(run)parts.push(run+" running");if(wait)parts.push(wait+" waiting to start");
const on=macs.filter(m=>m.online);parts.push(!macs.length?"no Mac connected yet":on.length===macs.length?(macs.length===1?macs[0].name+" is online":"your Macs are online"):macs.length===1?macs[0].name+" is offline, tasks wait for it":(macs.length-on.length)+" of your Macs offline");
for(const m of macs)if(m.approval_unreachable)parts.push("approvals can't reach you from "+m.name);if(!need&&!run&&!wait&&on.length)parts.unshift("All quiet");n.dataset.state=need?"attention":!on.length?"offline":"online";n.textContent=parts.join(" · ").replace(/^./,c=>c.toUpperCase())}
// a Mac whose runner has been down 10+ min (src/health.ts: stopped / unreachable): one line on top with what happened and the one next step
function downBanner(spaces){const b=$("downbanner");if(!b)return;const out=[];for(const sp of spaces||[])for(const p of sp.peers||[]){const h=p.health;if(!h||!(h.state==="stopped"||h.state==="unreachable")||!(h.down_s>=600))continue;
const x=el("p","",h.line+" ");if(h.next)x.append(el("strong","",h.next));out.push(x)}b.hidden=!out.length;b.replaceChildren(...out)}
// Run tasks without asking on (Settings): a banner above everything while it lasts, with Turn off right there (signed in this browser, like the switch)
function autorunBanner(spaces){const b=$("autorunbanner");if(!b)return;const on=(spaces||[]).filter(x=>x.autorun);b.hidden=!on.length;if(!on.length)return b.replaceChildren();
const u=on.map(x=>x.autorun.until).filter(Boolean),t=el("span","","Running your apps' tasks without asking"+(u.length?" until "+new Date(Math.min(...u)).toLocaleString([],{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):"")+".");
const off=btn("Turn off","rv",async()=>{try{for(const x of on)await OWN.autorun(S.acct,x.space,false);msg("Tasks ask you again.");stat(true)}catch(e){msg(e.message)}});off.id="autorunoff";b.replaceChildren(t,document.createTextNode(" "),off)}
// Get started: only the current step shows (one sentence, one button); the steps tick themselves from the status read (setup = {mac, agent,
// task, all}). Once all three are done it disappears for good in this browser (a Mac that's asleep doesn't bring it back); More -> Show the setup steps.
const SK="kitebook-setup-done:"+S.acct,NUM={mac:"1",agent:"2",task:"3"};
function setup(st){if(!$("setup")||!st)return;let cur=null;for(const k in NUM){const e=$("step-"+k),d=!!st[k];if(!d&&!cur)cur=k;e.classList.toggle("done",d);e.classList.toggle("cur",cur===k);
if(cur===k)e.setAttribute("aria-current","step");else e.removeAttribute("aria-current");e.querySelector(".tag").textContent=d?"Done":cur===k?"Now":"Next"}
let seen=false;try{seen=localStorage.getItem(SK)==="1";if(st.all&&!seen){localStorage.setItem(SK,"1");msg("You're set up. Your tasks show up here.")}}catch(e){}$("setup").hidden=!S.showSteps&&(st.all||seen||!cur)}
if($("showsteps"))$("showsteps").onclick=()=>{S.showSteps=true;$("setup").hidden=false;$("more").open=false;scrollTo(0,0)};
if($("pick"))$("pick").onclick=()=>{$("more").open=true;$("mcpurl").scrollIntoView({behavior:"smooth",block:"center"})};
// sign-in requests waiting for this owner: one line each, Approve / Deny (actionable now, so on Home)
async function devs(){const box=$("devs");if(!box)return;const r=await post({op:"devices"});if(!r.ok)return box.replaceChildren(el("p","note",r.error));const out=[],R=r.result;
const act=async(b,ok)=>{const n=await post({op:"nonce"});if(!n.ok)return msg(n.error);const x=await post({...b,nonce:n.result.nonce});if(!x.ok)return msg(x.error);msg(ok);devs()};
if(R.readd_passkey){const w=el("p","warn");const a=el("a","","Add your passkey again in Settings");a.href="/settings#devices";w.append(el("span","","Kitebook's sign-in was updated, so your passkey needs adding once more. "),a);out.push(w)}
for(const l of R.logins||[]){const w=el("div","row");w.append(el("span","t","Sign-in request: "+l.label+", code "+l.code),btn("Approve","okl pri",()=>act({op:"login_decide",id:l.id,yes:true},"Approved. That browser is signed in now.")),btn("Deny","nol rv",()=>act({op:"login_decide",id:l.id,yes:false},"Turned down.")));out.push(w)}
box.replaceChildren(...out)}
// ---- a task's own page (/start#task-<id>): everything about it, and every action on it ----
let TV=null,TVD=null,TVP=0;const find=id=>{for(const sp of (LAST&&LAST.spaces)||[]){for(const k of ["needs_you","open","recent","quick"]){const t=(sp[k]||[]).find(x=>x.id===id);if(t)return{sp,t,k:k==="open"&&sp.needs_you.some(n=>n.id===id)?"needs_you":k,n:sp.needs_you.find(n=>n.id===id)}}}return null};
function seekTask(){const m=location.hash.match(/^#task-(.+)$/),id=m?decodeURIComponent(m[1]):null;if(id!==TV){TV=id;TVD=null}if($("home"))$("home").hidden=!!TV;if($("taskview"))$("taskview").hidden=!TV;if(TV)taskView();else scrollTo(0,0)}
addEventListener("hashchange",seekTask);
function taskView(){const box=$("taskview");if(!box||!TV)return;if(busy(box))return;const f=find(TV),o=[],back=el("a","back","← Home");back.href="#";o.push(back);
if(!f){o.push(el("h2","",TV),el("p","sub",LAST?"Not among your open or recent tasks.":"Loading…"))}
else{const{sp,t,k}=f,n=f.n||(k==="needs_you"?t:null),q=k==="quick";o.push(el("h2","",q?t.question:t.title));
const sub=q?[(t.done?(t.state==="succeeded"?"answered"+(t.answer_s!=null?" in "+t.answer_s+" s":""):t.state):"answering…")+(t.agent?" by "+t.agent+(t.warm?" (warm)":""):""),t.from+" → "+t.target]
:[k==="open"?who(t)+" · "+(t.doing||t.phase||t.state)+(t.elapsed_s!=null?" for "+dur(t.elapsed_s):"")+" · last activity "+ago(t.last_activity||t.updated):k==="needs_you"?(n.why||t.state):t.result_headline?[t.result_headline.label,...t.result_headline.lines.slice(1,-1)].join(" · ")+" · "+ago(t.updated):(t.headline||t.state)+(t.branch?" · "+t.branch:"")+" · "+ago(t.updated)];
if(t.from)sub.push(t.from+" → "+t.target);
if(t.auto==="autorun"||t.auto==="dev_mode")sub.push("ran without asking");if(t.ci)sub.push("tests "+(t.ci.state==="passed"?"passed":t.ci.state==="failed"?"failed":t.ci.state)+(t.ci.passed!=null?" ("+t.ci.passed+(t.ci.failed?", "+t.ci.failed+" failed":"")+")":""));if(t.stuck)sub.unshift(t.stuck.label);if(q&&t.needs_task)sub.push("needs changes");if(q&&t.ran_as_task)sub.push("ran as a task");o.push(el("p","sub",sub.join(" · ")));
if(t.stuck)o.push(el("p","w need","stuck?"));
if(sp.experimental&&t.project&&t.branch&&!q&&k==="recent"){const rb=btn("Run tests","sec",async()=>{try{const n=await post({op:"nonce"});if(!n.ok)throw new Error(n.error);const x=await post({op:"ci_run",space:sp.space,project:t.project,branch:t.branch,nonce:n.result.nonce});if(!x.ok)throw new Error(x.error);msg("Your Mac runs the tests next.")}catch(e){msg(e.message)}});rb.id="runtests";o.push(rb)}
const pr=el("p","note pres");pr.hidden=true;o.push(pr);
if(n&&!n.approved){if(n.state==="needs_input"){if(n.question)o.push(el("pre","",n.question));const bar=el("div","acts"),i=el("input","ans");i.type="text";i.placeholder="Your answer";i.maxLength=8000;
bar.append(i,btn("Answer","pri",async()=>{if(!i.value.trim())return msg("Write an answer first");await act(sp.space,t.id,"answer",{answer:i.value});i.value=""}));o.push(bar)}
else{const bar=el("div","acts");if(n.review&&!n.passkey)bar.append(btn("Approve","pri",()=>act(sp.space,t.id,"approve")));if(n.review){const a=el("a","btn rvw",n.passkey?"Approve with passkey":"Review");a.href=n.review;bar.append(a)}
if(n.review)bar.append(btn("Reject","rv",async()=>{if(confirm("Reject "+t.title+"?"))await act(sp.space,t.id,"reject")}));o.push(bar)}}
if(k==="open"){if(t.state==="running")o.push(steerBar(sp,t)); /* steering is for a running agent; before it starts there's nobody to read the note */
const c=el("div","acts");c.append(btn("Cancel task","rv",async()=>{if(confirm("Cancel "+t.title+"? A running agent is stopped; its partial work stays on its branch."))await act(sp.space,t.id,"cancel")}));o.push(c)}
if(q){if(t.answer)o.push(el("pre","",t.answer));if(!t.ran_as_task&&t.state==="succeeded"){const c=el("div","acts");c.append(btn("Run as a task","",async()=>{if(confirm("Run this as a task on "+t.target+"? It works on its own branch, and the Mac asks you first."))await act(sp.space,t.id,"ask_task")}));o.push(c)}}
if(t.result_headline)o.push(nextBar(t.result_headline.next));if(t.recover)o.push(recov(sp,t));
if(k==="recent"){const vd=btn("View diff","link vdiff",async()=>{const d=box.querySelector(".detail details.diff");if(d){d.open=true;d.scrollIntoView({block:"start"})}else msg("No diff for this task (it changed no files in a project).")});vd.dataset.task=t.id;const p=el("p","");p.append(vd);o.push(p)}}
const dt=el("div","detail");o.push(dt);box.replaceChildren(...o);if(f&&f.k!=="quick")detail(f.sp.space,TV,dt);tvPresence()}
// the task in detail (summary, diff, test log, timeline): fetched once per visit, kept while the page redraws
async function detail(space,id,dt){if(TVD&&TVD.id===id)return fill(dt,TVD.d);const r=await post({op:"task",space,task:id}).catch(()=>null);if(TV!==id)return;
if(!r||!r.ok)return dt.replaceChildren(el("p","note",r?r.error:"can't reach the server"));TVD={id,d:r.result};fill(dt,r.result)}
function fill(dt,d){const o=[el("p","note","Task "+d.id+" · from "+d.from+" to "+d.target+(d.project?" · project "+d.project:""))];
/* each part is a fold whose header already says the gist: the summary's first line, the diff's size, the test log's last line */
const sec=(name,text,cls,v)=>{if(!text)return;const s=el("details","fold"+(cls?" "+cls:"")),h=el("summary");h.append(el("span","",name));if(v)h.append(el("span","v",v));s.append(h,el("pre","",text));o.push(s)};
const ls=x=>String(x||"").split("\\n").map(l=>l.trim()).filter(Boolean),df=ls(d.diff),nf=df.filter(l=>l.startsWith("+++ ")).length,ad=df.filter(l=>/^[+](?![+][+] )/.test(l)).length,rm=df.filter(l=>/^-(?!-- )/.test(l)).length;
sec("Summary",d.summary,"",ls(d.summary)[0]);sec("Changes",d.diff,"diff",nf+" file"+(nf===1?"":"s")+" · +"+ad+" −"+rm);sec("Test log",d.tests_log,"",ls(d.tests_log).slice(-1)[0]);if(d.timeline&&d.timeline.length)sec("Timeline",d.timeline.map(e=>new Date(e.at).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})+"  "+e.text).join("\\n"),"",d.timeline.length+" step"+(d.timeline.length===1?"":"s"));dt.replaceChildren(...o)}
// who's working on this task right now (op presence: the Mac's own words), refreshed every 5 s while the page is open
async function tvPresence(){if(!TV||Date.now()-TVP<4000)return;TVP=Date.now();const r=await post({op:"presence"}).catch(()=>null),p=document.querySelector("#taskview .pres");if(!p||!r||!r.ok)return;
const s=r.result.spaces.flatMap(x=>x.sessions).find(x=>x.task===TV);p.hidden=!s;if(s)p.textContent=s.line+(s.who?" · on "+s.who:"")}
if(S.acct){seekTask();stat();devs();OWN.read().then(st=>OWN.ready(S.acct,st.owner_keys)).catch(()=>{});/* a Kitebook server open browser registers its key now, so the Mac trusts it right away */
setInterval(()=>{if(!document.hidden)devs()},15000);setInterval(()=>{if(!document.hidden)stat()},15000);setInterval(()=>{if(!document.hidden&&TV)tvPresence()},5000)}
if(S.acct&&(S.oauth||S.next)){msg("Signed in. Returning to the approval page…");location.assign(S.oauth||S.next)}
</script></body></html>`;
}

// ---------- the Mac runner installer ----------
// POSIX sh (dash-clean): sh -n passes, no bashisms. The invite comes as $1 or KITEBOOK_INVITE and is never echoed; the fallback
// claim hands it to bun through the environment, not a command line.
export function installSh(o: string, ver: string, key = "") {
  return `#!/bin/sh
# Kitebook runner installer, served by ${o}
#   curl -fsSL ${o}/install.sh | sh -s -- <invite>          (or: KITEBOOK_INVITE=<invite> sh install.sh)
# 1. finds bun, or installs it from bun.sh after asking
# 2. fetches runner version ${ver} from this Kitebook, checks the manifest's release signature${key ? ` (key ${key})` : " (no release key pinned: legacy, warns)"},
#    then every file against its sha256 manifest, installs it read-only
#    into ~/.kitebook/versions/${ver} and points ~/.kitebook/current at it (a mismatch installs nothing)
# 3. claims the invite and writes ~/.kitebook/runner.json (mode 600)   4. macOS: starts the runner at login (launchd)
# Already set up? Run it without an invite to reinstall the pinned runner files (keeps runner.json).
# 5. puts one \`kitebook\` command on your PATH (~/.local/bin/kitebook, no sudo): kitebook status | restart | update | logs | stop | start | settings
# 6. one question: also let the coding agents found here (Pi, Codex, Claude Code, Cursor, Gemini CLI, opencode, GitHub Copilot CLI, Grok CLI) use Kitebook [Y/n]: each gets
#    its own notes folder and can't send tasks (change it in Settings); written into each agent's own MCP config, no browser step, no token shown
# Env: KITEBOOK_HOME (default ~/.kitebook)  KITEBOOK_BIN_DIR (where the kitebook command goes, default ~/.local/bin)  KITEBOOK_NAME (runner name, default this computer's name)
#      KITEBOOK_RELEASE_KEY=ed25519:... (pin your own release key, e.g. a self-hosted Kitebook's; checked before anything installs)
#      KITEBOOK_YES=1 (install bun without asking)  KITEBOOK_NO_LAUNCHD=1 (set up only, don't start it)  KITEBOOK_NO_OPEN=1 (don't open the signed-in page)  KITEBOOK_FORCE=1 (replace an existing runner.json)
#      KITEBOOK_VERBOSE=1 (also print file paths, versions and each step; otherwise it ends with a 3-line summary)
#      KITEBOOK_AGENTS=0 (don't connect coding agents) | KITEBOOK_AGENTS=1 (connect them without asking; KITEBOOK_YES=1 does too)
set -eu
# RELAY_* (the names from before the rename to Kitebook) still work; an install from before it moves to the new folder names first
for _v in $(env | sed -n 's/^RELAY_\\([A-Za-z0-9_]*\\)=.*/\\1/p'); do eval "[ -n \\"\\\${KITEBOOK_$_v+x}\\" ] || export KITEBOOK_$_v=\\"\\$RELAY_$_v\\""; done
for _p in ".relay-runner:.kitebook" ".relay:.kitebook-kb"; do _o=$HOME/\${_p%%:*}; _n=$HOME/\${_p#*:}
  if [ -d "$_o" ] && [ ! -L "$_o" ] && [ ! -e "$_n" ]; then mv "$_o" "$_n" && { ln -s "$_n" "$_o" || mv "$_n" "$_o"; }; fi; done
KITEBOOK_URL='${o}'
RUNNER_VERSION='${ver}'
RELEASE_KEY_PIN='${key}'
RELEASE_KEY="\${KITEBOOK_RELEASE_KEY:-$RELEASE_KEY_PIN}"
INVITE="\${1:-\${KITEBOOK_INVITE:-}}"
KITEBOOK_INVITE=; RELAY_INVITE=
DIR="\${KITEBOOK_HOME:-$HOME/.kitebook}"
CFG="$DIR/runner.json"
say() { printf 'kitebook: %s\\n' "$*" >&2; }
vsay() { if [ "\${KITEBOOK_VERBOSE:-}" = 1 ]; then say "$@"; fi; }   # details: paths, hashes, each step
sum() { printf '%s\\n' "$*" >&2; }                                 # the 3-line summary at the end
die() { say "$*"; exit 1; }
case "$INVITE" in */join/*) INVITE=\${INVITE##*/join/} ;; esac
[ -n "$INVITE" ] || [ -f "$CFG" ] || die "missing invite. Open $KITEBOOK_URL/start, choose Connect your Mac, and run the line it gives you."
case "$INVITE" in inv_*|"") ;; *) die "that is not an invite (they start with inv_). Get one at $KITEBOOK_URL/start (Connect your Mac)" ;; esac
case "$RELEASE_KEY" in "") ;; ed25519:*[!A-Za-z0-9_:-]*) die "KITEBOOK_RELEASE_KEY must look like ed25519:<base64url>" ;; ed25519:?*) ;; *) die "KITEBOOK_RELEASE_KEY must look like ed25519:<base64url>" ;; esac
command -v curl >/dev/null 2>&1 || die "curl is needed"
if command -v sha256sum >/dev/null 2>&1; then SHA=sha256sum; elif command -v shasum >/dev/null 2>&1; then SHA="shasum -a 256"; else die "sha256sum or shasum is needed to check the runner files"; fi

# 1. bun
BUN=$(command -v bun 2>/dev/null || true)
if [ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"; fi
if [ -z "$BUN" ]; then
  ans=n
  if [ "\${KITEBOOK_YES:-}" = 1 ]; then ans=y
  else printf 'kitebook: the runner needs bun (https://bun.sh). Install it now? [y/N] ' >&2; read -r ans 2>/dev/null </dev/tty || ans=n
  fi
  case "$ans" in
    y|Y|yes|YES) curl -fsSL https://bun.sh/install | bash >&2 ;;
    *) die "install bun first (curl -fsSL https://bun.sh/install | bash), then run this again" ;;
  esac
  BUN="$HOME/.bun/bin/bun"; [ -x "$BUN" ] || die "bun did not install"
fi

# the one question, asked now so the rest runs on its own: the coding agents found here can use Kitebook too (step 6)
AG=; AGN=
for a in pi codex claude cursor gemini opencode copilot grok; do
  if command -v "$a" >/dev/null 2>&1 || { [ "$a" = cursor ] && { command -v cursor-agent >/dev/null 2>&1 || [ -d "$HOME/.cursor" ]; }; }; then
    case "$a" in pi) n=Pi ;; codex) n=Codex ;; claude) n="Claude Code" ;; cursor) n=Cursor ;; gemini) n="Gemini CLI" ;; copilot) n="GitHub Copilot CLI" ;; grok) n="Grok CLI" ;; *) n=opencode ;; esac
    AG="$AG $a"; if [ -z "$AGN" ]; then AGN="$n"; else AGN="$AGN, $n"; fi
  fi
done
case "$AGN" in *", "*) AGN=$(printf '%s' "$AGN" | sed 's/\\(.*\\), /\\1 and /') ;; esac
WIRE=
if [ -n "$AG" ] && [ "\${KITEBOOK_AGENTS:-}" != 0 ]; then
  if [ "\${KITEBOOK_YES:-}" = 1 ] || [ "\${KITEBOOK_AGENTS:-}" = 1 ]; then WIRE=1
  else
    printf 'kitebook: also let %s use Kitebook? Each gets its own notes folder and can'"'"'t send tasks; you can change that in Settings. [Y/n] ' "$AGN" >&2
    ans=y; read -r ans 2>/dev/null </dev/tty || { ans=y; printf '\\n' >&2; }
    case "$ans" in n|N|no|NO|No) ;; *) WIRE=1 ;; esac
  fi
fi

# 2. runner files, straight from this Kitebook (no git clone), verified before anything runs or switches
umask 077
# a first install that fails at the claim (used or expired invite) removes the read-only files it just put down, so nothing is left behind
FRESH=; [ -e "$DIR/current" ] || [ -f "$CFG" ] || FRESH=1
NEWDIR=; [ -d "$DIR" ] || NEWDIR=1
undo() { [ -n "$FRESH" ] || return 0; chmod -R u+w "$DIR/versions" 2>/dev/null || true; rm -rf "$DIR/versions" "$DIR/current" "$DIR/client"
  if [ -n "\${BIN:-}" ] && grep -q '^# Kitebook CLI' "$BIN/kitebook" 2>/dev/null; then rm -f "$BIN/kitebook"; fi
  if [ -n "$NEWDIR" ]; then rmdir "$DIR" 2>/dev/null || true; fi; say "removed the runner files this run had installed in $DIR"; }
mkdir -p "$DIR/versions"
V="$DIR/versions/$RUNNER_VERSION"
TMP="$DIR/versions/.tmp-$RUNNER_VERSION-$$"
SIGNED=
rm -rf "$TMP"; mkdir -p "$TMP"
bail() { chmod -R u+w "$TMP" 2>/dev/null || true; rm -rf "$TMP"; die "$*"; }
curl -fsSL "$KITEBOOK_URL/runner-files/manifest.txt" -o "$TMP/manifest.txt" || bail "could not download the runner manifest from $KITEBOOK_URL"
GOT=$($SHA < "$TMP/manifest.txt" | cut -c1-16)
[ "$GOT" = "$RUNNER_VERSION" ] || bail "manifest mismatch: expected runner version $RUNNER_VERSION, the manifest is $GOT. Refusing to install; nothing changed"
# release signature, checked before any runner file is fetched. bun (not the downloaded files, which aren't trusted yet) verifies it.
curl -fsS "$KITEBOOK_URL/runner-files/manifest.sig" -o "$TMP/manifest.sig" 2>/dev/null || rm -f "$TMP/manifest.sig"
if [ -n "$RELEASE_KEY" ]; then
  [ -f "$TMP/manifest.sig" ] || bail "release signature refused: the manifest is unsigned (no manifest.sig), but release key $RELEASE_KEY is pinned. Refusing to install; nothing changed"
  WHY=$(RK="$RELEASE_KEY" D="$TMP" "$BUN" -e '
const fs = require("fs"), c = require("crypto"), e = process.env, k = e.RK, t = fs.readFileSync(e.D + "/manifest.txt", "utf8"), s = fs.readFileSync(e.D + "/manifest.sig", "utf8").trim().split(" ");
if ((s.length !== 2 && !(s.length === 3 && /^[0-9]{1,15}$/.test(s[2]))) || !s[0].startsWith("ed25519:")) { console.log("manifest.sig is malformed"); process.exit(1); }
if (s[0] !== k) { console.log("the manifest is signed by " + s[0].slice(0, 20) + "..., not the pinned release key " + k.slice(0, 20) + "..."); process.exit(1); }
let ok = false; try { const pk = c.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(k.slice(8), "base64url")]), format: "der", type: "spki" });
  ok = c.verify(null, Buffer.from((s.length === 3 ? "relay-runner-manifest:v2\\nrelease " + s[2] + "\\n" : "relay-runner-manifest:v1\\n") + t), pk, Buffer.from(s[1], "base64url")); } catch (x) { console.log("bad release key or signature: " + x.message); process.exit(1); }
if (!ok) { console.log("bad signature (the manifest was changed after signing, or signed for another release)"); process.exit(1); }
' 2>&1) || bail "release signature refused: $WHY. Refusing to install; nothing changed"
  vsay "manifest signed by the pinned release key $RELEASE_KEY"; SIGNED=" (signed release)"
else
  # said once, here: init (called with --installer below) doesn't repeat it
  say "WARNING: UNSIGNED INSTALL. no release key is pinned, so these runner files are trusted only because $KITEBOOK_URL sent them (a Kitebook server that is compromised could send other code). To pin one: KITEBOOK_RELEASE_KEY=ed25519:..."
fi
while read -r h f; do
  case "$f" in ""|*[!a-z0-9.-]*) bail "bad file name in the runner manifest" ;; esac
  curl -fsSL "$KITEBOOK_URL/runner-files/$f" -o "$TMP/$f" || bail "could not download $f from $KITEBOOK_URL"
done < "$TMP/manifest.txt"
BAD=$(cd "$TMP" && $SHA -c manifest.txt 2>/dev/null | grep -v ': OK$' || true)
[ -z "$BAD" ] || bail "integrity check failed (sha256 differs from the manifest): $(echo "$BAD" | tr '\\n' ' '). Refusing to install; nothing changed"
if [ -d "$V" ]; then chmod -R u+w "$V"; rm -rf "$V"; fi
mv "$TMP" "$V"; chmod 444 "$V"/*; chmod 555 "$V"
ln -sfn "versions/$RUNNER_VERSION" "$DIR/current"
if [ -d "$DIR/client" ] && [ ! -L "$DIR/client" ]; then rm -rf "$DIR/client"; fi
ln -sfn current "$DIR/client"
for old in "$DIR"/versions/.tmp-*; do [ -e "$old" ] || continue; chmod -R u+w "$old"; rm -rf "$old"; done
vsay "runner $RUNNER_VERSION verified and installed read-only in $V (current -> it)"
RUNNER="$DIR/current/runner.ts"
# the one \`kitebook\` command for the owner (kitebook status / restart / update / logs / stop / start, plus every kitebook op): a tiny wrapper on
# PATH, no sudo. It runs the verified, read-only install (current/cli.ts), so it follows updates; a \`kitebook\` that isn't ours is left alone.
BIN="\${KITEBOOK_BIN_DIR:-$HOME/.local/bin}"; RELAYCMD=
if [ -e "$BIN/kitebook" ] && ! grep -q '^# Kitebook CLI' "$BIN/kitebook" 2>/dev/null; then say "left $BIN/kitebook alone (it isn't Kitebook's); run Kitebook's commands as: $BUN $DIR/current/cli.ts status"
elif mkdir -p "$BIN" 2>/dev/null && printf '#!/bin/sh\\n# Kitebook CLI, installed by %s/install.sh: kitebook status | restart | update | logs | stop | start | doctor, and every kitebook op\\nexport KITEBOOK_RUNNER_CONFIG="\${KITEBOOK_RUNNER_CONFIG:-%s}"\\nexec "%s" "%s/current/cli.ts" "$@"\\n' "$KITEBOOK_URL" "$CFG" "$BUN" "$DIR" > "$BIN/kitebook.tmp" && chmod 755 "$BIN/kitebook.tmp" && mv "$BIN/kitebook.tmp" "$BIN/kitebook"; then
  case ":$PATH:" in *":$BIN:"*) RELAYCMD=kitebook ;; *) RELAYCMD="$BIN/kitebook"; case "$BIN" in "$HOME"/*) RELAYCMD="~/\${BIN#"$HOME"/}/kitebook" ;; esac; vsay "$BIN is not on your PATH; add it (e.g. echo 'export PATH=\"$BIN:\\$PATH\"' >> ~/.zprofile) to type just kitebook" ;; esac
  vsay "installed the kitebook command at $BIN/kitebook"
fi
# the command's name before the rename: a relay wrapper of ours becomes a shim that says so and runs kitebook
if [ -f "$BIN/relay" ] && grep -q '^# Relay CLI' "$BIN/relay" 2>/dev/null && [ -f "$BIN/kitebook" ]; then
  printf '#!/bin/sh\\n# Kitebook CLI (old name): relay is now kitebook; this forwards to it\\necho "note: the relay command is now kitebook (Relay was renamed Kitebook); relay still works for now, but use kitebook" >&2\\nexec "%s" "$@"\\n' "$BIN/kitebook" > "$BIN/relay.tmp" && chmod 755 "$BIN/relay.tmp" && mv "$BIN/relay.tmp" "$BIN/relay"
fi
# a fresh login shell must find it: client/cli-path.ts adds ~/.local/bin to the shell's rc files once when it doesn't, else prints the exact fix
if [ -n "$RELAYCMD" ] && [ -f "$DIR/current/cli-path.ts" ]; then CPJ=$(KITEBOOK_BIN_DIR="$BIN" "$BUN" "$DIR/current/cli-path.ts" verify "$CFG" || true); case "$CPJ" in *'"on_path":true'*) RELAYCMD=kitebook ;; esac; fi
MANAGE=; [ -z "$RELAYCMD" ] || MANAGE="; check or restart it with: $RELAYCMD status"

# 3. claim the invite -> runner.json
if [ -f "$CFG" ] && [ "\${KITEBOOK_FORCE:-}" != 1 ]; then
  say "$CFG already exists; keeping it. To replace it, get a new invite at $KITEBOOK_URL/start (Connect your Mac) and run: curl -fsSL $KITEBOOK_URL/install.sh | KITEBOOK_FORCE=1 sh -s -- <invite>"
elif [ -z "$INVITE" ]; then
  undo; die "no invite and no $CFG. Get one at $KITEBOOK_URL/start (Connect your Mac)"
elif grep -q '"init"' "$RUNNER"; then
  # this Kitebook's runner has its own first-run setup
  set -- init "$KITEBOOK_URL" "$INVITE" --out "$CFG" --installer
  if [ -n "\${KITEBOOK_NAME:-}" ]; then set -- "$@" --name "$KITEBOOK_NAME"; fi
  if [ "\${KITEBOOK_FORCE:-}" = 1 ]; then set -- "$@" --force; fi
  KITEBOOK_RELEASE_KEY="$RELEASE_KEY" "$BUN" "$RUNNER" "$@" || { undo; die "runner init failed (nothing else was changed). Used or expired invite? Get a new one at $KITEBOOK_URL/start (Connect your Mac)"; }
  set --
else
  # older runner without init: claim here. The invite goes to bun via the environment, never argv.
  KITEBOOK_URL="$KITEBOOK_URL" KITEBOOK_INVITE="$INVITE" KITEBOOK_CFG="$CFG" KITEBOOK_NAME="\${KITEBOOK_NAME:-}" "$BUN" -e '
const e = process.env, os = require("os"), fs = require("fs");
const base = ((e.KITEBOOK_NAME || os.hostname().split(".")[0] || "mac").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28).replace(/^(none|localhost|unknown)$/, "")) || "mac";
let j;
for (let i = 1; i <= 9; i++) {
  const name = i === 1 ? base : base + "-" + i;
  const r = await fetch(e.KITEBOOK_URL + "/join/" + e.KITEBOOK_INVITE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  j = await r.json().catch(() => ({ error: "HTTP " + r.status }));
  if (j.ok || !/taken/.test(j.error ?? "")) break;
}
if (!j.ok) { console.error("kitebook: invite not accepted: " + j.error + ". Get a new one at " + e.KITEBOOK_URL + "/start (Connect your Mac)"); process.exit(1); }
const mac = process.platform === "darwin";
const c = { url: e.KITEBOOK_URL, token: j.result.token, space: j.result.space, approve: mac ? "dialog" : "phone" };
if (!mac) c.ntfy = { topic: "kitebook-" + crypto.randomUUID().replace(/-/g, "") };
fs.writeFileSync(e.KITEBOOK_CFG, JSON.stringify(c, null, 2) + "\\n", { mode: 0o600 }); fs.chmodSync(e.KITEBOOK_CFG, 0o600);
console.error("kitebook: joined as runner \\"" + j.result.name + "\\" (workspace " + j.result.space + "); approvals: " + c.approve);
if (c.ntfy) console.error("kitebook: approve on your phone: install the ntfy app and subscribe to https://ntfy.sh/" + c.ntfy.topic + " (keep that name private)");
' || { undo; die "could not claim the invite"; }
fi
INVITE=
[ -f "$CFG" ] || die "no $CFG was written"
# 6. the coding agents (the answer from the start): one connection each, written into the agent's own MCP config (kitebook connect does
# the same later); a failure is reported in the summary line and never stops the install
if [ -n "$WIRE" ]; then
  KITEBOOK_RUNNER_CONFIG="$CFG" "$BUN" "$DIR/current/runner.ts" connect "$CFG" $AG --installer >&2 || true
fi

# the master password (client/password.ts): asked here only when a person is at a terminal (hidden, twice; it never leaves this computer).
# No terminal (an agent or a script ran this): nothing is asked; the computer stays LOCKED, and the summary says how its person unlocks it.
PWASK=; if [ "\${KITEBOOK_NO_TTY:-}" != 1 ] && [ "\${KITEBOOK_PASSWORD_STEP:-}" != 0 ] && (exec </dev/tty) 2>/dev/null; then PWASK=1; fi
PWLINE=
pwstep(){ if [ -n "$PWASK" ]; then PWLINE=$(KITEBOOK_RUNNER_CONFIG="$CFG" "$BUN" "$DIR/current/cli.ts" password set --installer "$@" 2>/dev/null || true)
  elif [ "\${KITEBOOK_PASSWORD_STEP:-}" != 0 ] && [ "\${1:-}" = --wait ]; then PWLINE=$(KITEBOOK_RUNNER_CONFIG="$CFG" KITEBOOK_NO_TTY=1 "$BUN" "$DIR/current/cli.ts" password set --installer --wait 2>/dev/null || true); fi; }
# 4. start it, then the summary's last two lines: what was installed, what to do next (init printed the connected line)
RUN="\${RELAYCMD:-kitebook} run"   # the runner in the foreground (kitebook run = bun current/runner.ts runner.json)
TOPIC=$(sed -n 's/.*"topic": *"\\([A-Za-z0-9_-]*\\)".*/\\1/p' "$CFG" | head -n 1)
PHONE=; [ -z "$TOPIC" ] || PHONE="approve tasks on your phone: in the ntfy app, subscribe to $TOPIC (keep the name private)"
# off macOS with no phone: approvals wait on the server's /start page (Status) and kitebook approve on this computer
[ -n "$PHONE" ] || [ "$(uname -s)" = Darwin ] || PHONE="approve each task on $KITEBOOK_URL/start (Status) or with \${RELAYCMD:-kitebook} approve"
PWNEXT="; then set its master password: \${RELAYCMD:-kitebook} password set (or \${RELAYCMD:-kitebook} password link for a one-time link)"
if [ "\${KITEBOOK_NO_LAUNCHD:-}" = 1 ]; then
  pwstep; [ -z "$PWLINE" ] || PWNEXT=
  sum "✓ Installed the Kitebook runner $RUNNER_VERSION$SIGNED (not started)$MANAGE"
  sum "Next: start it with: $RUN\${PHONE:+, then $PHONE}$PWNEXT"; [ -z "$PWLINE" ] || sum "$PWLINE"
elif [ "$(uname -s)" = Darwin ]; then
  if [ "\${KITEBOOK_VERBOSE:-}" = 1 ]; then "$BUN" "$RUNNER" install "$CFG"; else "$BUN" "$RUNNER" install "$CFG" >/dev/null; fi || die "couldn't start the runner at login; see what's wrong with: \${RELAYCMD:-kitebook} doctor"
  vsay "launchd: dev.kitebook.runner, logs in ~/Library/Logs/kitebook-runner.log"
  sum "✓ Installed the Kitebook runner $RUNNER_VERSION$SIGNED; it runs now and starts at login$MANAGE"
  sum "Next: send a task from your assistant; \${PHONE:-you approve it in a dialog on this Mac}"
  pwstep --wait; [ -z "$PWLINE" ] || sum "$PWLINE"
  # sign this Mac's browser in to the server (remembered 30 days), so an agent's "mcp login" here is one Approve click: no key, no phone
  if [ "\${KITEBOOK_NO_OPEN:-}" != 1 ]; then
    if "$BUN" "$RUNNER" open >/dev/null 2>&1; then sum "✓ Opened your Kitebook in the browser, signed in"; else sum "Open your Kitebook page, signed in, any time with: \${RELAYCMD:-kitebook} open"; fi
  fi
else
  sum "✓ Installed the Kitebook runner $RUNNER_VERSION$SIGNED (not macOS, so it doesn't start at login by itself)$MANAGE"
  pwstep; [ -z "$PWLINE" ] || PWNEXT=
  sum "Next: start it with: $RUN (or as a systemd user service)\${PHONE:+, then $PHONE}$PWNEXT"; [ -z "$PWLINE" ] || sum "$PWLINE"
fi
`;
}
