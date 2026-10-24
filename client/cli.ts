#!/usr/bin/env bun
// kitebook CLI: the no-MCP adapter. Works from any shell (dots, Grok, CI, Hark's sandbox).
// Env: KITEBOOK_URL, KITEBOOK_TOKEN, optional KITEBOOK_SPACE, KITEBOOK_CACHE (default ~/.cache/kitebook)
//   kitebook <op> [--key value ...]       any op, JSON out (kitebook ops to list them)
// On the machine that runs Kitebook (install.sh puts this command on PATH as ~/.local/bin/kitebook), the owner's service commands, in plain words
// (they wrap launchd on macOS / systemd --user on Linux via client/service.ts, so nobody types launchctl; no token needed):
//   kitebook status                       server + runner (+ tunnel) up/down, version
//   kitebook restart [server|runner|tunnel|all]  kitebook stop|start [server|runner|tunnel|all]   kitebook logs [server|runner|tunnel] [-n 60] [-f]
//   kitebook tunnel [status|restart|url|token <token> <hostname>|quick]   the built-in tunnel (No server / domain): public address, health
//   kitebook update [--channel dev]       update to the newest signed release (no prompt; unsigned: one click in Settings); a git checkout: --channel dev follows origin/dev (on a dev branch)   kitebook pin <sha|runner-version|->
//   kitebook password [status|set|change|link|shortcut on|off]   your master password: the way to confirm it's you on this computer (Touch ID /
//                                      Windows Hello is an optional shortcut next to it). No terminal: kitebook password link prints a one-time local link
//   kitebook confirm [<code>]           confirm it's you (master password, or its Touch ID / Windows Hello shortcut) for what a browser waits to approve; no code: list
//   kitebook devices [list|approve <id>|revoke <id>|rename <id> <name>|reset-password <id>]   the machines of your Kitebook (approve asks for your presence)
//   kitebook join <server> [--name n]     add this computer (laptop, cloud VM) to a Kitebook by code: approve it on one of your devices with
//                                      kitebook approve <ABCD-EFGH> (shows its name/OS/IP/place; asks for your presence) or Settings -> Devices
//   kitebook login <server> [--secret]    claim a remote server that starts unclaimed: this computer becomes its owner device once the same code
//                                      is approved on the server's shell (kitebook owner approve <code>) or with the KITEBOOK_OWNER_CLAIM secret
//   kitebook owner [status|pending|approve <code>|deny <code>|reset|reset-password [<device id>]]   on the server's shell: the remote claim (reset
//                                      reopens it); reset-password: a forgotten master password (that device may set a new one for 15 minutes)
//   kitebook approve [<task|code> yes|no] what waits for your approval on this computer, answered here (no phone)   kitebook open   this Kitebook's page in your browser, signed in
//   kitebook settings                     Settings in your browser, signed in (connected apps, devices, approvals, release key, recovery: all by click)
//   kitebook experimental [status|on|off] Experimental: status reads it (checked against the browsers this Mac trusts); on/off open the switch in Settings (kitebook dev: old name)
//   kitebook app add <name> [--access tasks|read|folder] [--days n]   a key for an app that only has an API-key field (Muse...), + the prompt to paste
//   kitebook connect [pi codex claude ...] let the coding agents on this computer use Kitebook (their own folder, no task sending; no browser step)
//   kitebook release-key create|show|rotate   the release key, kept in your keychain   kitebook release sign   sign your Kitebook checkout's runner release
//   kitebook doctor [--test-push]         the runner's checks   (config: --config, KITEBOOK_RUNNER_CONFIG, default ~/.kitebook/runner.json)
//   kitebook cat <path>                   read through the sha cache, raw content out
//   kitebook put <path> [--if_match sha]  write stdin to path
//   kitebook watch [--since n]            stream events (WebSocket)
//   kitebook ask "question" [--to mac] [--project p] [--agent pi]   quick read-only answer from the Mac's warm agent, streamed (no worktree);
//                                      kitebook ask --task <ask id> [instructions] runs an answered ask as a normal task
//   kitebook cancel <id> [--reason r]     cancel one task (queued: dropped; running: agent killed, partial work kept; awaiting approval: withdrawn)
//   kitebook cancel --all [--peer p] [--target t] [--reason r]   cancel every open task you're party to (optionally one dispatcher/target)
//   kitebook login --device <kitebook url> [--name n] [--role runner] [--space main] [--scope "read write dispatch"] [--client relay-cli] [--print]
//                                      OAuth device sign-in: prints a code, the owner approves it at <url>/device, tokens land in
//                                      KITEBOOK_CREDENTIALS (default ~/.config/kitebook/credentials.json, 0600). Without KITEBOOK_TOKEN the CLI then
//                                      uses (and silently refreshes) the saved login for KITEBOOK_URL.
//   kitebook token                        a current access token from the saved login (refreshed if near expiry), for scripts
//   kitebook logout                       revoke the saved login's refresh token (ends the grant) and forget it
//   kitebook kb search <words> [--scope s] [--k n] [--kinds a,b] [--ollama-model m]   shared knowledge base (keyword + semantic)
//   kitebook kb add <text> [--kind k] [--scope s] [--key k] [--origin o]                 one entry (stdin if text is -); kitebook unreachable ->
//                                      queued in ~/.kitebook-kb/outbox (key outbox:<uuid> unless --key), sent in order later (runner or next CLI kb call)
//   kitebook kb flush                     send the queued outbox notes and ~/.kitebook-kb/kb-inbox/*.md now (exit 1 if still offline)
//   kitebook kb import <dir|file> [--scope s] [--origin hark-memory] [--kind memory] [--exclude glob,glob] [--include glob]
//                                      chunk + redact + upsert a markdown folder (key = path#chunk), forget removed chunks; the
//                                      personal-info denylist (USER.md, people/, *address*...) applies unless --include names them
//   kitebook kb export <dir>              every kb/ file as markdown (for a git backup)
//   kitebook keygen [--force]             make this peer's Ed25519 signing key at KITEBOOK_SIGNING_KEY (default ~/.config/kitebook/signing-key.json, 0600)
//                                      and print the public key for the runner owner: bun runner.ts trust add runner.json <peer> <pubkey>
//   kitebook pubkey                       print the public key again
//   kitebook task_create ...              signed automatically when that key file exists (--unsigned to skip; KITEBOOK_SIGNING_KEY=off disables)
//                                      signs only KB notes written by you or the target runner (its synced memory); KITEBOOK_KB_TRUST=a,b
//                                      or --kb-trust a,b adds authors, the rest are left out and listed on stderr
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import * as S from "./sign.ts";

const URL_ = (process.env.KITEBOOK_URL ?? "http://localhost:5173").replace(/\/+$/, ""), SPACE = process.env.KITEBOOK_SPACE;
let H: Record<string, string> = { "content-type": "application/json" };

// ---- OAuth: device sign-in + saved, auto-refreshed login (src/oauth.ts is the server side) ----
const CREDS = process.env.KITEBOOK_CREDENTIALS ?? join(homedir(), ".config", "kitebook", "credentials.json");
const loadCreds = (): Record<string, any> => existsSync(CREDS) ? JSON.parse(readFileSync(CREDS, "utf8")) : {};
function saveCreds(c: Record<string, any>) { mkdirSync(dirname(CREDS), { recursive: true }); writeFileSync(CREDS, JSON.stringify(c, null, 1), { mode: 0o600 }); chmodSync(CREDS, 0o600); }
const tokenPost = async (base: string, body: Record<string, string>) => {
  const r = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  return [r.status, await r.json()] as [number, any];
};
function remember(base: string, client: string, t: any) {
  const c = loadCreds(); c[base] = { client_id: client, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000, scope: t.scope }; saveCreds(c);
}
async function login(base: string, kv: any) {
  base = base.replace(/\/+$/, ""); const client = kv.client ?? "relay-cli";
  const scope = [kv.scope ?? "read write dispatch", kv.space ? `space:${kv.space}` : "", kv.role ? `role:${kv.role}` : ""].filter(Boolean).join(" ");
  const r = await fetch(`${base}/oauth/device_authorization`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: client, scope, ...(kv.name ? { name: kv.name } : {}) }) });
  const d: any = await r.json(); if (!r.ok) throw new Error(`device_authorization: ${d.error_description ?? d.error}`);
  console.error(`To sign in, open ${d.verification_uri_complete}\nand approve code ${d.user_code} there, signed in (expires in ${Math.round(d.expires_in / 60) || 1} min).`);
  let every = d.interval;
  for (const end = Date.now() + d.expires_in * 1000; Date.now() < end;) {
    await Bun.sleep(every * 1000);
    const [st, t] = await tokenPost(base, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: d.device_code, client_id: client });
    if (st === 200) { remember(base, client, t); console.error(`signed in (${t.scope}); saved to ${CREDS}`); if (kv.print) console.log(t.access_token); return; }
    if (t.error === "authorization_pending") continue;
    if (t.error === "slow_down") { every += 5; continue; } // RFC 8628 3.5
    throw new Error(`login: ${t.error_description ?? t.error}`);
  }
  throw new Error("login: the code expired; run login again");
}
let fromSaved = false;
async function savedToken(base = URL_, force = false): Promise<string | undefined> {
  const e = loadCreds()[base]; if (!e) return undefined; fromSaved = true;
  if (!force && e.expires_at - 60_000 > Date.now()) return e.access_token;
  const [st, t] = await tokenPost(base, { grant_type: "refresh_token", refresh_token: e.refresh_token, client_id: e.client_id }); // rotates: the old refresh token is now spent
  if (st !== 200) throw new Error(`saved login for ${base} no longer works (${t.error_description ?? t.error}); run kitebook login --device ${base}`);
  remember(base, e.client_id, t); return t.access_token;
}
async function auth() {
  const tok = process.env.KITEBOOK_TOKEN || await savedToken();
  if (!tok) { console.error(`set KITEBOOK_TOKEN, or sign in: kitebook login --device ${URL_}`); process.exit(2); }
  H = { authorization: `Bearer ${tok}`, "content-type": "application/json" }; return tok;
}

export async function call(op: string, args: any = {}) {
  if (SPACE && args.space === undefined) args.space = SPACE; // ops that don't take a space ignore it
  const post = () => fetch(`${URL_}/v1/${op}`, { method: "POST", headers: H, body: JSON.stringify(args) }).catch((e: any) => { // name the URL instead of a bare ECONNREFUSED
    throw new Error(`can't reach the server at ${URL_} (${e?.code ?? e?.message ?? e}). ${process.env.KITEBOOK_URL ? "Check KITEBOOK_URL" : "KITEBOOK_URL isn't set, so this is the local `cf dev` default; export KITEBOOK_URL=https://<your Kitebook>"}`); });
  let r = await post();
  if (r.status === 401 && fromSaved) { // saved access token revoked or clock skew: refresh once (throws "run kitebook login" if the grant is gone)
    H = { ...H, authorization: `Bearer ${await savedToken(URL_, true)}` }; r = await post(); }
  const j: any = await r.json().catch(() => null);
  if (!j) throw new Error(`${op}: ${URL_} answered HTTP ${r.status}, not like a Kitebook server. Check KITEBOOK_URL (the server's base URL)`);
  if (!j.ok) throw new Error(`${op}: ${j.error}${j.hint ? `\nhint: ${j.hint}` : ""}`); // the server's hint says what to do (e.g. a revoked token)
  return j.result;
}

function parse(argv: string[]) {
  const pos: string[] = [], kv: any = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2), v = argv[i + 1];
      let val: any = v;
      if (v === undefined || v.startsWith("--")) { val = true; } else { i++; try { if (/^[\[{0-9]|^(true|false)$/.test(v)) val = JSON.parse(v); } catch {} }
      kv[k] = val;
    } else pos.push(argv[i]);
  }
  return { pos, kv };
}

// The server ignores args an op doesn't take, so a typo (--title on change) used to vanish silently: warn on stderr, still send.
// The op listing is cached for an hour (per kitebook URL), so this doesn't add a request to every call (polling loops, rate limits).
async function opParams(fresh = false): Promise<any> {
  const f = join(CACHE, `ops-${Bun.hash(URL_).toString(36)}.json`);
  if (!fresh) try { const c = JSON.parse(readFileSync(f, "utf8")); if (Date.now() - c.at < 3600_000) return c.ops; } catch {}
  const j: any = await (await fetch(`${URL_}/v1`, { headers: H })).json(), ops: any = {};
  for (const [k, v] of Object.entries<any>(j.ops ?? {})) ops[k] = { params: { properties: v?.params?.properties ?? {} } };
  try { mkdirSync(CACHE, { recursive: true }); writeFileSync(f, JSON.stringify({ at: Date.now(), ops })); } catch {}
  return ops;
}
async function warnUnknown(op: string, kv: any) {
  try { const unknown = (ops: any) => { const p = ops?.[op]?.params?.properties; return p && Object.keys(p).length ? [p, Object.keys(kv).filter(k => !(k in p) && k !== "space")] as const : null; };
    let u = unknown(await opParams()); if (u?.[1].length) u = unknown(await opParams(true)); // a flag the cached listing lacks: re-check (kitebook upgraded)
    if (!u) return; const [props, bad] = u;
    if (bad.length) console.error(`warning: ${op} doesn't take ${bad.map(k => "--" + k).join(", ")} (ignored); it takes: ${Object.keys(props).filter(k => k !== "space").map(k => "--" + k).join(" ")}`);
  } catch {} // best effort: never block the call on the op listing
}

// sha-keyed cache: objects are immutable, so a cached blob never goes stale; we only ask "is path still at sha X?"
const CACHE = process.env.KITEBOOK_CACHE ?? join(homedir(), ".cache", "kitebook");
const idxFile = () => join(CACHE, `${SPACE ?? "default"}.index.json`);
async function cachedRead(path: string) {
  mkdirSync(join(CACHE, "objects"), { recursive: true });
  const idx = existsSync(idxFile()) ? JSON.parse(readFileSync(idxFile(), "utf8")) : {};
  const have = idx[path] && existsSync(join(CACHE, "objects", idx[path])) ? idx[path] : undefined;
  const r = await call("read", { path, if_none_match: have });
  if (r.unchanged) return readFileSync(join(CACHE, "objects", have));
  const body = r.content_base64 !== undefined ? Buffer.from(r.content_base64, "base64") : Buffer.from(r.content ?? "", "utf8");
  writeFileSync(join(CACHE, "objects", r.sha), body); // cache raw bytes, so binary files round-trip
  idx[path] = r.sha; writeFileSync(idxFile(), JSON.stringify(idx));
  return body;
}

// owner service verbs: these names are not kitebook ops, so `kitebook <op>` stays unambiguous (status is also an op: here the local
// `kitebook status` wins and prints the op's verdict as its health line; scripts call POST /v1/status)
const OWNER = new Set(["password", "touchid", "join", "confirm", "devices", "run", "status", "restart", "update", "logs", "stop", "start", "pin", "doctor", "approve", "owner", "open", "settings", "connect", "app", "agents", "uninstall", "release-key", "release", "dev", "experimental", "tunnel"]);
function runnerConfig(argv: string[]) {
  const i = argv.indexOf("--config"); if (i >= 0) { const c = argv[i + 1]; argv.splice(i, 2); return c; }
  return process.env.KITEBOOK_RUNNER_CONFIG || join(process.env.KITEBOOK_HOME || join(homedir(), ".kitebook"), "runner.json");
}

const MAIN = import.meta.main || (globalThis as any).__relayEntry === "cli"; // run directly, or from the kitebook binary (client/kitebook-bin.ts)
if (MAIN) (await import("./rebrand.ts")).migrateDirs(); // an install from before the rename: its folders move to the new names first (client/rebrand.ts)
// kitebook, kitebook help, kitebook --help: the short help (client/brand.ts); the long list of workspace commands is kitebook ops
if (MAIN && ([undefined, "help"].includes(process.argv[2]) && !process.argv[3] || ["--help", "-h"].includes(process.argv[2]))) { const { HELP } = await import("./brand.ts"); console.log(HELP); process.exit(0); }
if (MAIN && process.argv[2] === "help" && process.argv[3]) {
  const { OPS } = await import("../src/ops.ts"), op = process.argv[3];
  if (!Object.hasOwn(OPS, op)) {
    const distance = (a: string, b: string) => { const row = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i++) { let prev = row[0]; row[0] = i; for (let j = 1; j <= b.length; j++) { const old = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = old; } } return row[b.length]; };
    const closest = Object.keys(OPS).map(k => [k, distance(op, k)] as const).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([k]) => k);
    console.error(`unknown op ${op}; closest: ${closest.join(", ")}`); process.exit(1);
  }
  const meta = OPS[op];
  console.log(`${op}\n${meta.desc}`);
  for (const [name, [type, desc, required]] of Object.entries(meta.params)) console.log(`  ${name}: ${type}${required ? " (required)" : " (optional)"} — ${desc}`);
  process.exit(0);
}
if (MAIN && OWNER.has(process.argv[2] ?? "")) {
  const argv = process.argv.slice(2), cfg = runnerConfig(argv);
  if (argv.includes("--help") || argv.includes("-h")) { const { HELP, CLI } = await import("./brand.ts"); console.log(HELP.split("\n").filter(l => l.includes(`${CLI} ${argv[0]}`)).join("\n") || HELP); process.exit(0); }
  if (argv[0] === "agents") { const C = await import("./agents-connect.ts"); process.exit(await C.connectCli([cfg, ...(argv.includes("--list") ? ["--detect"] : argv.slice(1))])); } // = kitebook connect
  if (argv[0] === "run") { const p = Bun.spawn([process.execPath, join(dirname(import.meta.path), "runner.ts"), cfg], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }); process.exit(await p.exited); } // the runner in this terminal (no service manager)
  if (argv[0] === "uninstall") { const U = await import("./uninstall.ts"); process.exit(await U.uninstallCli(cfg, argv.slice(1))); }
  if (argv[0] === "open" || argv[0] === "settings") { const L = await import("./local-approve.ts"); process.exit(await L.openCli([...argv.slice(1), ...(argv[0] === "settings" ? ["--settings"] : [])])); } // the browser, signed in (asks the running runner)
  if (argv[0] === "tunnel") { const T = await import("./tunnel.ts"); process.exit(await T.tunnelCli(argv.slice(1))); } // the built-in tunnel (No server / domain)
  if (argv[0] === "experimental" || argv[0] === "dev") { const D = await import("./experimental-cli.ts"); process.exit(await D.experimentalCli(cfg, argv.slice(1))); } // Experimental: status here; on/off is the switch in Settings. dev: its old name
  if (argv[0] === "app") { if (argv[1] !== "add") { console.error("kitebook app add <name> [--access tasks|read|folder] [--days 1|7|30]"); process.exit(2); } const D = await import("./device.ts"); process.exit(await D.appAddCli([cfg, ...argv.slice(2)])); } // Settings' Add an app, from the Mac
  if (argv[0] === "connect") { const C = await import("./agents-connect.ts"); process.exit(await C.connectCli([cfg, ...argv.slice(1)])); } // Pi / Codex / Claude Code... -> Kitebook, no browser step
  if (argv[0] === "release-key" || argv[0] === "release") { const R = await import("./release-cli.ts"); process.exit(await R.releaseCli(argv)); }
  if (argv[0] === "confirm" || argv[0] === "devices") { const DV = await import("./device.ts"); process.exit(await (argv[0] === "confirm" ? DV.confirmCli : DV.devicesCli)(argv.slice(1))); } // this machine as a device (client/device.ts)
  // the master password (client/password.ts): set / change / link / shortcut on|off; kitebook touchid on|off = kitebook password shortcut
  if (argv[0] === "password" || argv[0] === "touchid") { const P = await import("./password.ts"); process.exit(await P.passwordCli(argv[0] === "touchid" ? ["shortcut", ...argv.slice(1)] : argv.slice(1), cfg)); }
  if (argv[0] === "join") { const J = await import("./join.ts"); process.exit(await J.joinCli(argv.slice(1))); } // this computer joins a Kitebook by code (client/join.ts)
  // a join code (ABCD-EFGH, consonants only, with its dash) is a machine waiting to join, or an app's connection code (POST /connect; its
  // alphabet also has L); anything else is a task / connection ask
  if (argv[0] === "approve" && /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/i.test(argv[1] ?? "")) { const J = await import("./join.ts"); process.exit(await J.approveJoinCli(argv.slice(1), cfg)); }
  if (argv[0] === "approve") { if (!argv[1]) await (await import("./join.ts")).pendingJoins(cfg); const L = await import("./local-approve.ts"); process.exit(await L.approveCli(argv.slice(1))); } // asks are per machine; no token
  if (argv[0] === "owner" && [undefined, "status", "pending", "approve", "deny", "reset", "reset-password"].includes(argv[1])) { const J = await import("./join.ts"); process.exit(await J.ownerCli(argv.slice(1))); } // the server shell's claim (client/join.ts)
  if (argv[0] === "owner") { const P = await import("./policy.ts"); console.error(P.OWNER_PIN_GONE); process.exit(2); } // older: owner list|pin|remove
  if (argv[0] === "doctor") { const S = await import("./setup.ts"); process.exit(await S.doctorCmd([cfg, ...argv.slice(1)])); }
  if (argv[0] === "pin" && !existsSync(cfg)) { console.error(`kitebook: no runner config at ${cfg} (install the runner from your Kitebook's /start, Connect your Mac; or --config <runner.json>)`); process.exit(1); }
  const { service } = await import("./service.ts"); process.exit(await service(cfg, argv, { plain: true }));
}

if (MAIN) {
  const [op, ...rest] = process.argv.slice(2);
  const { pos, kv } = parse(rest);
  try {
    if (op === "login" && typeof kv.device !== "string" && /^https?:\/\//.test(pos[0] ?? "")) { const J = await import("./join.ts"); process.exit(await J.claimCli(rest)); } // claim a remote server (client/join.ts)
    if (op === "login") { if (typeof kv.device !== "string") { console.error("usage: kitebook login --device <kitebook url> [--name n] [--role runner] [--space <workspace>] [--scope <what it can do, e.g. read,write,dispatch>]"); process.exit(2); } await login(kv.device, kv); process.exit(0); }
    if (op === "logout") {
      const c = loadCreds(), e = c[URL_]; if (!e) { console.error("no saved login for " + URL_); process.exit(1); }
      await fetch(`${URL_}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: e.refresh_token, token_type_hint: "refresh_token", client_id: e.client_id }) });
      delete c[URL_]; saveCreds(c); console.error("signed out of " + URL_); process.exit(0);
    }
    if (op === "keygen") { const pub = S.keygen(S.keyPath(), !!kv.force); console.error(`signing key saved to ${S.keyPath()} (0600). Give the runner owner this public key:`); console.log(pub); process.exit(0); }
    if (op === "pubkey") { console.log(S.loadKey().pub); process.exit(0); }
    const TOKEN = await auth().catch(async (e: any) => { // kb add while offline must not die on a saved-login refresh
      if (op === "kb" && pos[0] === "add" && (await import("./outbox.ts")).isOffline(e)) return null; throw e; });
    if (op === "token") { console.log(TOKEN); process.exit(0); }
    if (!op || op === "ops") {
      const r = await fetch(`${URL_}/v1`, { headers: H }); const j: any = await r.json();
      for (const [k, d] of Object.entries<any>(j.ops)) console.log(k.padEnd(14), d.desc);
    } else if (op === "cat") process.stdout.write(await cachedRead(pos[0] ?? kv.path));
    else if (op === "put") console.log(JSON.stringify(await call("write", { path: pos[0], content: await Bun.stdin.text(), ...kv }), null, 1));
    else if (op === "kb") {
      const KB = await import("./kb.ts"), sub = pos[0], arg = pos.slice(1).join(" "), list = (v: any) => v == null ? undefined : Array.isArray(v) ? v : String(v).split(",");
      const show = (r: any) => console.log(JSON.stringify(r, null, 1));
      if (sub === "search") { const om = kv["ollama-model"], qv = om ? await KB.embedQuery({ model: om, url: kv["ollama-url"] }, arg) : null;
        show(await call("kb_search", { query: arg, scope: kv.scope, k: kv.k, kinds: list(kv.kinds), ...(qv ? { query_vector: qv, embed_model: KB.ollamaModel({ model: om }) } : {}) })); }
      else if (sub === "add") { // offline-first (client/outbox.ts): unreachable Kitebook -> queued in ~/.kitebook-kb/outbox, sent later in order
        const O = await import("./outbox.ts"), note = { text: arg === "-" || !arg ? await Bun.stdin.text() : arg, kind: kv.kind, scope: kv.scope, key: kv.key, origin: kv.origin, title: kv.title };
        const queue = () => { const q = O.enqueue(note, URL_, SPACE); console.error(q.note); show(q); };
        if (TOKEN === null) queue(); // saved login couldn't refresh: offline
        else try { if ((await O.drainOutbox(call, URL_, SPACE, (...a) => console.error(...a))).offline) queue(); else show(await call("kb_add", note)); } // older queued notes first: order holds
        catch (e: any) { if (!O.isOffline(e)) throw e; queue(); } }
      else if (sub === "flush") { const O = await import("./outbox.ts"), log = (...a: any[]) => console.error(...a); // send queued notes + the kb-inbox now
        const o = await O.drainOutbox(call, URL_, SPACE, log), i = o.offline ? null : await O.publishInbox(call, log); show({ outbox: o, inbox: i, waiting: O.depth() }); if (o.offline || i?.offline) process.exit(1); }
      else if (sub === "import") show(await KB.publish(call, { path: arg, scope: kv.scope, kind: kv.kind ?? "memory", origin: kv.origin, exclude: list(kv.exclude), include: list(kv.include) }, kv.origin ?? "import"));
      else if (sub === "export") show(await KB.exportTo(call, KB.expand(arg || "kb-export")));
      else { console.error("usage: kitebook kb search <words> | add <text> | flush | import <dir> | export <dir>"); process.exit(2); }
    }
    else if (op === "cancel") {
      if (kv.all) console.log(JSON.stringify(await call("cancel_all", { peer: kv.peer, target: kv.target, reason: kv.reason }), null, 1));
      else if (pos[0] ?? kv.id) console.log(JSON.stringify(await call("task_cancel", { id: pos[0] ?? kv.id, reason: kv.reason }), null, 1));
      else { console.error("usage: kitebook cancel <task id> [--reason why] | kitebook cancel --all [--peer <sender name>] [--target <runner name>] [--reason why]"); process.exit(2); }
    }
    else if (op === "ask") { // quick ask: the answer streams to stdout as the Mac's agent writes it; the footer on stderr says how to run it as a task
      if (kv.task) { console.log(JSON.stringify(await call("ask_to_task", { id: String(kv.task), instructions: pos.join(" ") || kv.instructions }), null, 1)); process.exit(0); }
      const q = pos.join(" ") || kv.question; if (!q || q === true) { console.error('usage: kitebook ask "question" [--to <runner>] [--project p | --repo url] [--agent pi|claude|codex|gemini|cursor|copilot|opencode|grok] [--json]\n       kitebook ask --task <ask id> [instructions]   run an answered ask as a normal task'); process.exit(2); }
      let r = await call("ask", { question: String(q), ...Object.fromEntries(["to", "project", "repo", "agent", "model", "timeout"].filter(k => kv[k] !== undefined).map(k => [k, kv[k]])), wait: 1 });
      let shown = ""; const say = (x: string) => { if (kv.json) return; if (x.startsWith(shown)) process.stdout.write(x.slice(shown.length)); else process.stdout.write((shown ? "\n" : "") + x); shown = x; };
      for (let n = 0; !r.done && n < 6000; n++) { if (r.partial) say(r.partial); await Bun.sleep(250); r = await call("ask_get", { id: r.id }); }
      if (kv.json) { console.log(JSON.stringify(r, null, 1)); process.exit(r.state === "succeeded" ? 0 : 1); }
      if (r.state === "succeeded") { say(r.answer ?? ""); process.stdout.write("\n");
        console.error(`(${r.agent ?? "agent"}${r.answer_s != null ? `, ${r.answer_s} s` : ""}${r.session?.warm ? ", warm session" : ""} · ${r.needs_task ? "needs changes: " : ""}run it as a task: kitebook ask --task ${r.id})`); }
      else { if (shown) process.stdout.write("\n"); console.error(`${r.state}: ${r.error ?? ""}`); process.exit(1); }
    }
    else if (op === "mcp" && pos[0] === "check") console.log(JSON.stringify(await call("mcp_status", {
      ...(kv["known-tool-revision"] ? { known_tool_revision: String(kv["known-tool-revision"]) } : {}),
      ...(kv["known-instructions-revision"] ? { known_instructions_revision: String(kv["known-instructions-revision"]) } : {}) }), null, 1));
    else if (op === "sessions") { // the owner's local agent sessions (sessions_search / session_get / session_send; the owner allows each app in Settings)
      const sub = pos[0], show = (r: any) => console.log(JSON.stringify(r, null, 1)), pick = (ks: string[]) => Object.fromEntries(ks.filter(k => kv[k] !== undefined).map(k => [k, kv[k]]));
      if (sub === "search") show(await call("sessions_search", { query: pos.slice(1).join(" "), ...pick(["agent", "cwd", "since", "limit", "to"]) }));
      else if (sub === "status" && pos[1] && pos[2]) show(await call("session_status", { agent: pos[1], session_id: pos[2], ...(kv.to ? { runner: kv.to } : {}) }));
      else if (sub === "get" && pos[1] && pos[2]) show(await call("session_get", { agent: pos[1], id: pos[2], ...pick(["last", "to"]) }));
      else if (sub === "send" && pos[1] && pos[2]) show(await call("session_send", { agent: pos[1], id: pos[2], text: pos.slice(3).join(" ") || kv.text, ...pick(["mode", "project", "repo", "cwd", "model", "to"]) }));
      else { console.error("usage: kitebook sessions search [words] [--agent codex|claude|pi|gemini|copilot|opencode|cursor] [--cwd <folder>] [--since 2d]\n       kitebook sessions status <agent> <id> [--to <runner>]\n       kitebook sessions get <agent> <id> [--last 20]\n       kitebook sessions send <agent> <id> <text> [--mode steer] [--cwd <folder> | --project p]"); process.exit(2); }
    }
    else if (op === "watch") {
      const q = new URLSearchParams({ ...(SPACE ? { space: SPACE } : {}), ...(kv.since !== undefined ? { since: String(kv.since) } : {}) });
      const ws = new WebSocket(`${URL_.replace(/^http/, "ws")}/v1/stream?${q}`, { headers: { authorization: H.authorization } } as any);
      ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); if (d.event) console.log(JSON.stringify(d.event)); };
      ws.onclose = () => process.exit(0);
      await new Promise(() => {});
    } else {
      if (op === "task_create" && kv.instructions === "-") kv.instructions = await Bun.stdin.text();
      const kbTrust = [process.env.KITEBOOK_KB_TRUST, kv["kb-trust"]].filter(Boolean).join(",").split(",").map(x => x.trim()).filter(Boolean); delete kv["kb-trust"];
      if (op === "task_create" || op === "change") await warnUnknown(op, kv); // before signing adds its own fields
      if (op === "task_create" && !kv.unsigned && process.env.KITEBOOK_SIGNING_KEY !== "off" && existsSync(S.keyPath())) { // end-to-end signature (client/sign.ts)
        const parent = kv.continue_from ? await call("task_get", { id: kv.continue_from }) : undefined;
        // the KB notes to attach, fetched here so their ids + hashes + authors are signed too; only authors we trust (R8): a note any
        // write:kb peer wrote (a Codex token, a chat assistant) must not ride inside a signed auto-run
        const from = (await call("whoami")).name, dropped: { id: string; author: string | null }[] = [];
        const kb = await S.pickKb(call, kv, parent, { trusted: new Set([from, String(kv.target), ...kbTrust]), dropped });
        if (dropped.length) console.error(`kb: left ${dropped.length} note(s) out of the signed task (author not trusted: ${dropped.map(d => `${d.id} by ${d.author ?? "unknown"}`).join(", ")}); KITEBOOK_KB_TRUST=<name,...> to include an author`);
        Object.assign(kv, S.signCreate(kv, { from, key: S.loadKey(), parent, kb }));
      }
      delete kv.unsigned;
      if (op !== "task_create" && op !== "change") await warnUnknown(op, kv);
      if (pos[0]) { const k = op.startsWith("task_") ? "id" : ["grep", "glob"].includes(op) ? "pattern" : "path"; kv[k] ??= pos[0]; }
      console.log(JSON.stringify(await call(op, kv), null, 1));
    }
  } catch (e: any) { console.error(e.message); process.exit(1); }
}
