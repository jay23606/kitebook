// First-run helpers shared by runner.ts: `init` (claim an invite, write runner.json), `doctor` (check a config, print fixes),
// and the pieces the runner itself uses so they agree with doctor: agent presets, repo discovery, approval-mode resolution.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, readdirSync, statSync } from "fs";
import { join, resolve, dirname } from "path";
import { homedir, hostname } from "os";
import { agentSources, mergeSync, chunksOf, filesOf, syncStateFile } from "./kb.ts";
import { ADAPTERS, build } from "./agent-adapters.ts";
import * as PL from "./platform.ts";

export const RUNNER = resolve(import.meta.dir, "runner.ts");
const cmdFor = (sub: string, cfg: string) => `bun ${RUNNER} ${sub} ${cfg}`;
// What a token may do, in plain words for init/doctor output: verbs and path globs stay in runner.json and the API (docs/glossary.md).
export const canDo = (verbs: string[] = [], paths: string[] = []) => `can ${verbs.map(v => v === "dispatch" ? "send tasks" : v).join(", ") || "do nothing"} in ${paths.map(p => p === "**" ? "every folder" : p.replace(/\/\*\*$/, "/")).join(" ") || "no folders"}`;

// Built-in agent presets. {session} is a session file kept per task branch, so follow-ups resume the same conversation.
export const PRESETS: Record<string, string[]> = {
  pi: ["pi", "-p", "--session", "{session}", "{prompt}"],
  // checked adapters (client/agent-adapters.ts): codex, claude, gemini, cursor (cursor-agent), copilot, opencode, grok; the runner builds the
  // final argv from each CLI's --help (here: the documented flags, e.g. codex exec --sandbox workspace-write, never the removed --full-auto)
  ...Object.fromEntries(Object.keys(ADAPTERS).map(n => [n, build(n, null).argv])),
};
// Pi moved to @earendil-works/pi-coding-agent (1.x); the old @mariozechner package stopped at 0.73 (no `pi mcp`, no --no-mcp)
export const INSTALL_HINT: Record<string, string> = { pi: "npm i -g @earendil-works/pi-coding-agent",
  ...Object.fromEntries(Object.entries(ADAPTERS).map(([n, a]) => [n, a.install])) };
const tilde = (p: string) => p.replace(/^~(?=$|\/)/, homedir());
export const DEFAULT_ROOTS = ["~/Desktop", "~/code", "~/Developer"];    // used when runner.json has no "roots" (older configs)
export const INIT_ROOTS = ["~/code", "~/src", "~/projects", "~/dev"];   // what `init` writes (override with --roots)

// Zero-config projects: every git repo (one or two levels deep) under `roots` becomes a project named by its folder.
// Explicit entries in runner.json win. Nothing outside roots is ever reachable.
export const DEFAULT_VERIFY = ["bun test", "npm test", "pnpm test", "yarn test", "pytest", "cargo test", "go test ./...", "make test"];
export function discover(c: any): Record<string, any> {
  const out: Record<string, any> = {};
  const roots: string[] = (c.roots ?? DEFAULT_ROOTS).map(tilde);
  const isRepo = (d: string) => existsSync(join(d, ".git"));
  const add = (d: string) => { const n = d.split("/").pop()!.replace(/[^\w.-]/g, "-"); if (!out[n]) out[n] = { path: d, agent: c.defaultAgent ?? "pi", verify: DEFAULT_VERIFY, push: "never", auto: true }; };
  for (const r of roots) { try {
    for (const e of readdirSync(r, { withFileTypes: true })) { if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue; const d = join(r, e.name);
      if (isRepo(d)) add(d); else try { for (const e2 of readdirSync(d, { withFileTypes: true })) if (e2.isDirectory() && !e2.name.startsWith(".") && e2.name !== "node_modules" && isRepo(join(d, e2.name))) add(join(d, e2.name)); } catch {} }
  } catch {} }
  return { ...out, ...(c.projects ?? {}) };
}

// Which ways the runner can actually ask the owner. An unset `approve` used to mean "terminal", which under launchd reads EOF
// and silently rejects every task. Now: unset = the Mac dialog (plus phone when ntfy is set), phone-only off macOS, and the
// terminal only when stdin is a real TTY. Returns the ways, or a rejection reason that names the exact fix.
// "browser": no push and no dialog; the owner approves on /start (Status, an owner-only review page) or with `kitebook approve` on this
// machine. The installer's default off macOS, so a Linux box never pushes approvals through the public ntfy.sh unless asked (--phone).
// When the owner didn't pick a way (approve unset, or auto asking about an untrusted sender) and nothing else can ask here (no desktop
// dialog, no terminal, no phone: a headless box, a service on Windows/Linux with no desktop), the review page is the safe fallback:
// tasks wait there (and for kitebook approve) instead of being refused; `fallback` carries the warning doctor and the runner print.
// A way the owner chose explicitly that can't work here (approve=phone without a topic, terminal under a service) stays an error.
export type Ways = { ways: ("phone" | "dialog" | "terminal" | "browser")[]; mode: string; fallback?: string };
export function approvalWays(c: any, cfgPath: string, o: { darwin?: boolean; tty?: boolean; from?: string } = {}): Ways | { error: string } {
  // darwin = this machine has a desktop dialog (osascript on macOS, zenity / notify-send on a Linux desktop, a message box on Windows; platform.ts)
  const darwin = o.darwin ?? PL.dialogKind() !== null, tty = o.tty ?? !!process.stdin.isTTY, phone = !!c.ntfy?.topic;
  const unset = c.approve === undefined || c.approve === null || c.approve === "";
  let mode = unset ? (darwin ? (phone ? "dialog+phone" : "dialog") : phone ? "phone" : tty ? "terminal" : "")
    : c.approve === "auto" ? (phone ? "phone" : "dialog") : String(c.approve); // auto reaching here = untrusted sender
  const ways: ("phone" | "dialog" | "terminal" | "browser")[] = [];
  if (mode === "browser") return { ways: ["browser"], mode };
  if (/phone/.test(mode) && phone) ways.push("phone");
  if (/dialog/.test(mode) && darwin) ways.push("dialog");
  if (!ways.length && (mode === "terminal" || /dialog/.test(mode)) && tty) ways.push("terminal"); // no desktop dialog: the terminal you're at
  if (ways.length) return { ways, mode };
  if (unset || c.approve === "auto") return { ways: ["browser"], mode: "browser", fallback: `no approval method is set and this machine has no desktop dialog, no terminal and no phone, so tasks wait for you on ${c.url ? `${String(c.url).replace(/\/+$/, "")}/start` : "the server's /start page"} (Status) or kitebook approve. To choose that for good: ${cmdFor("set", cfgPath)} approve browser   (or approve phone for a push to your phone)` };
  const why = /phone/.test(mode) && !phone ? `approve=${mode} but runner.json has no ntfy.topic`
    : mode === "terminal" ? "approve=terminal but the runner has no terminal (it runs under launchd/systemd or with stdin closed)"
    : /dialog/.test(mode) ? `approve=${mode} needs a desktop dialog and there is no terminal to fall back to`
    : `approve=${mode} can't ask anyone here`;
  return { error: `${why}, so nobody can approve tasks here. Fix on the runner machine: ${cmdFor("set", cfgPath)} approve ${darwin ? "dialog" : "browser"}${darwin ? "" : "   (then approve tasks on the server's /start page or with kitebook approve)"}` };
}

// Resolve an agent's executable the way the runner will (its PATH, which under launchd is the PATH saved at install time).
export function agentBin(c: any, name: string): { bin: string | null; found: string | null } {
  const a = c.agents?.[name] ?? PRESETS[name]; const argv = !a ? null : Array.isArray(a) ? a : a.argv;
  if (!argv?.[0]) return { bin: null, found: null };
  return { bin: argv[0], found: Bun.which(argv[0], { PATH: PL.envPath() }) };
}
// doctor: the adapter's --help, synchronously (15 s cap), run through build(); null = fine (or no help to read)
function helpIssue(a: string): string | null { try {
  const p = PL.spawnSync(ADAPTERS[a].helpArgv ?? [ADAPTERS[a].bin, "--help"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15000, env: process.env as any });
  const h = p.stdout.toString() + "\n" + p.stderr.toString(); return h.trim() ? build(a, h).issue : null; } catch { return null; } }
export const usedAgents = (c: any) => [...new Set([c.defaultAgent ?? "pi", ...Object.values<any>(discover(c)).map(p => p.agent ?? c.defaultAgent ?? "pi")])];
export const agentFix = (name: string, bin: string | null, cfgPath: string) => bin == null
  ? `agent "${name}" is not defined: use one of ${Object.keys(PRESETS).join(", ")} or add it under "agents" in runner.json`
  : `agent "${name}" needs \`${bin}\`, which isn't on this runner's PATH. Install it (${INSTALL_HINT[name] ?? "see the agent's docs"}${name === "grok" ? "; it installs into ~/.grok/bin, which only .bashrc gets: add that folder to your PATH" : ""}), then from a shell where \`which ${bin}\` works run: ${cmdFor("install", cfgPath)} (the service keeps the PATH it was installed with)`;

// One line for "the server said no" / "the server isn't there", with the command that fixes it.
export function whoamiFix(url: string, e: { status?: number; error?: string; network?: string; notRelay?: boolean }, cfgPath: string) {
  if (e.network) return `can't reach the server at ${url} (${e.network}). Check "url" in ${cfgPath} and that \`curl ${url}/health\` answers {"ok":true}`;
  if (e.notRelay) return `${url} answered, but not like a Kitebook server (no JSON from /v1/whoami). Check "url" in ${cfgPath}: it's the server's base URL, e.g. https://kitebook.example.com`;
  if (e.status === 401 || e.error === "unauthorized") return `the server at ${url} rejected this runner's token (revoked, rotated, or for another Kitebook). Get a new runner invite: open ${url}/start -> Connect your Mac -> Create install command, and run that line in Terminal with KITEBOOK_FORCE=1 so it replaces this config (curl -fsSL ${url}/install.sh | KITEBOOK_FORCE=1 sh -s -- <invite>), or claim it here: bun ${RUNNER} init ${url} <invite-url> --force. Or remove it from this Mac: kitebook uninstall --config ${cfgPath}`;
  return `whoami failed at ${url}: ${e.error ?? e.status}`;
}

// The runner's peer name from --name or this computer's name. Containers and fresh Linux boxes report hostnames like "(none)",
// "localhost" or "" (the review saw `none-`), so those fall back to "mac"; "Toms-MacBook-Pro.local" -> "toms-macbook-pro".
export function runnerName(raw: string | null | undefined): string {
  const n = String(raw ?? "").split(".")[0].toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 32).replace(/[-_]+$/, "");
  return !n || /^(none|localhost|unknown|null|undefined)$/.test(n) ? "mac" : n;
}
// Where the owner approves, in words, for the doctor summary
const approvalWhere = (c: any, cfgPath: string) => { const a = approvalWays(c, cfgPath, { tty: false }); if ("error" in a) return "once approvals are fixed";
  return a.ways.map(w => w === "phone" ? "on your phone (ntfy app)" : w === "dialog" ? "in a dialog on this Mac" : w === "browser" ? `on ${c.url}/start (Status) or with kitebook approve` : "in this terminal").join(" or "); };
export const isLaunchd = () => process.env.KITEBOOK_LAUNCHD === "1" || !!process.env.KITEBOOK_SERVICE; // under launchd, systemd or Kitebook's supervisor (client/supervise.ts)

// ---- init: claim an invite and write runner.json, so nobody hand-edits it ----
// pre.claimed: the runner credentials kitebook join / kitebook login <url> already got by approval (client/join.ts), instead of an invite
export async function initCmd(argv: string[], pre?: { claimed: { name: string; token: string; space: string; verbs: string[]; paths: string[] } }): Promise<number> {
  const flags: Record<string, string> = {}, pos: string[] = [];
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { const [k, v] = a.slice(2).split("="); flags[k] = v ?? (["force", "phone", "no-install", "verbose", "installer"].includes(k) ? "1" : argv[++i]); } else pos.push(a); }
  const usage = `usage: bun ${RUNNER} init <kitebook-url> <invite-url-or-code> [--name mac] [--roots ~/code,~/work] [--out ~/.kitebook/runner.json] [--approve dialog|phone|dialog+phone|browser] [--phone] [--force] [--no-install] [--release-key ed25519:...] [--verbose]`;
  // C9 short output: the last 3 lines say what was installed, whether it's connected and what to do next; file paths, the access
  // details and kb sync come with --verbose (or KITEBOOK_VERBOSE=1). --installer = install.sh is calling: it prints the install line
  // and the next step itself (after launchd), so init prints only the connected line and doesn't repeat the release-key note.
  const vb = flags.verbose === "1" || process.env.KITEBOOK_VERBOSE === "1", fromSh = flags.installer === "1";
  let [url, invite] = pos;
  if (url && !invite && /\/join\/inv_/.test(url)) { invite = url; url = ""; }
  if (pre) invite = "inv_approved"; // approved by code: no invite to claim (the match below just passes)
  if (!invite) { console.error(usage); return 2; }
  const m = invite.match(/^(https?:\/\/[^/]+)?\/?(?:join\/)?(inv_[A-Za-z0-9_.-]+)$/) ?? invite.match(/^(https?:\/\/.+?)\/join\/(inv_[A-Za-z0-9_.-]+)$/);
  if (!m) { console.error(`that doesn't look like an invite (expected https://<kitebook>/join/inv_... or inv_...)\n${usage}`); return 2; }
  url = (url || m[1] || "").replace(/\/+$/, ""); const code = m[2];
  if (!/^https?:\/\//.test(url)) { console.error(`kitebook url must start with https:// (or http:// for a local Kitebook)\n${usage}`); return 2; }
  const out = resolve(tilde(flags.out ?? "~/.kitebook/runner.json"));
  if (existsSync(out) && !flags.force) { console.error(`${out} already exists (an invite is single-use, so nothing was claimed). Check it with: ${cmdFor("doctor", out)}\nor replace it with --force`); return 1; }
  // pinned install first: fetch + verify the server's runner files into ~/.kitebook/versions/<v> (current -> it).
  // A mismatch stops here, before the single-use invite is claimed. A Kitebook server without a manifest (older) only warns.
  let R = RUNNER, installNote = "", undo = () => {}, relKey = "", ver = "";
  if (!flags["no-install"]) { const I = await import("./integrity.ts"), h = I.home(), had = existsSync(join(h, "current")) || existsSync(join(h, "versions"));
    // a first install whose claim then fails (used/expired invite) takes its read-only tree back out (plain rm -rf can't)
    if (!had) undo = () => { for (const p of ["versions", "current", "client"]) try { I.rmTree(join(h, p)); } catch {} };
    // release key: --release-key / KITEBOOK_RELEASE_KEY (the owner's terminal; install.sh passes the key it checked with) over the built-in one
    relKey = String(flags["release-key"] ?? process.env.KITEBOOK_RELEASE_KEY ?? "") || I.BUILTIN_KEY;
    if (relKey && !I.validKey(relKey)) { console.error(`--release-key / KITEBOOK_RELEASE_KEY must look like ed25519:<base64url>; nothing was claimed`); return 2; }
    try { const v = await I.installVersion(url, { key: relKey }); R = join(I.home(), "current", "runner.ts"); ver = v.version; installNote = `runner ${v.version} verified against the server's manifest${relKey ? ", signed by the pinned release key," : ""} and installed read-only (${v.dir}; current -> it)`; if (v.warning && !fromSh) console.error(v.warning); }
    catch (e: any) { if (/mismatch|release signature/.test(e.message)) { console.error(`${e.message}\nRefusing to set up; the invite was not claimed.`); return 1; } installNote = `runner files not installed (${e.message}); running from ${dirname(RUNNER)}`; } }
  const name = runnerName(flags.name ?? hostname());
  // claim (kitebook join / login: already approved, the credentials came with the approval)
  let inv: any;
  if (pre) inv = pre.claimed; else {
    let r: Response; try { r = await fetch(`${url}/join/${code}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); }
    catch (e: any) { undo(); console.error(whoamiFix(url, { network: e.message ?? String(e) }, out).replace(/Check "url" in \S+/, "Check the server URL")); return 1; }
    const j: any = await r.json().catch(() => null);
    if (!j) { undo(); console.error(`${url} answered ${r.status} but not like a Kitebook server. Check the server URL.`); return 1; }
    if (!j.ok) { undo(); const taken = /taken/.test(j.error ?? "");
      console.error(`couldn't claim the invite: ${j.error}. ${taken ? `Pick another name: add --name ${name}-2 (the invite is still unused).` : `Ask the owner for a new one: ${url}/start -> Connect your Mac -> Create install command (invites work once and expire)`}`); return 1; }
  inv = j.result; }
  // agents: first installed of pi, codex, claude becomes the default
  const found = Object.keys(PRESETS).filter(a => Bun.which(PRESETS[a][0], { PATH: PL.withAgentDirs(PL.envPath()) }));
  const roots = flags.roots ? flags.roots.split(",").map(s => s.trim()).filter(Boolean) : INIT_ROOTS;
  const darwin = PL.dialogKind() !== null; // a desktop dialog here (macOS, a Linux desktop, Windows)
  const approve = flags.approve ?? (flags.phone ? (darwin ? "dialog+phone" : "phone") : darwin ? "dialog" : "browser"); // no public ntfy.sh push unless --phone
  const cfg: any = { url, token: inv.token, space: inv.space, approve, requireSignedAuto: true, access: "worktree", defaultAgent: found[0] ?? "pi", roots, maxParallel: 2, maxMinutes: 30 };
  if (relKey) cfg.releaseKey = relKey; // the key the installer checked with (the official one, or a self-hoster's): every update after this is held to it, no step for the owner
  if (/phone/.test(approve)) cfg.ntfy = { topic: "kitebook-" + crypto.randomUUID().replace(/-/g, ""), server: "https://ntfy.sh" };
  // the owner's browser keys (they sign Settings changes), pinned now like install.sh itself is trusted at first install; later ones by themselves (kitebook open) or Trust in Settings
  try { const { validOwnerKey } = await import("./policy.ts"); const r: any = await (await fetch(`${url}/v1/policy`, { method: "POST", headers: { authorization: `Bearer ${inv.token}`, "content-type": "application/json" }, body: JSON.stringify({ space: inv.space }) })).json();
    const ks = (r.result?.owner_keys ?? []).map((k: any) => String(k.key)).filter(validOwnerKey); if (ks.length) cfg.ownerKeys = ks; } catch {} // an older Kitebook has no policy op: nothing pinned
  const kbSrc = agentSources(discover(cfg)); if (kbSrc.length) cfg.kb = { sync: kbSrc }; // agent instructions (AGENTS.md, CLAUDE.md, Pi skills...) -> shared KB
  mkdirSync(resolve(out, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(out, JSON.stringify(cfg, null, 2), { mode: 0o600 }); chmodSync(out, 0o600); // holds the token
  const { stampOwnerEdit } = await import("./guard.ts"); stampOwnerEdit(out);
  const projects = Object.entries<any>(discover(cfg));
  const say = (l: string) => console.log(l), approveLine = cfg.ntfy ? `approve tasks on your phone: in the ntfy app, subscribe to ${cfg.ntfy.topic} (or open https://ntfy.sh/${cfg.ntfy.topic}; keep the name private)` : approve === "browser" ? `you approve each task on ${url}/start (Status) or with kitebook approve on this computer` : "you approve each task in a dialog on this Mac";
  if (vb) { // the details, for whoever wants them
    say(`connected this computer to ${url} as runner "${inv.name}" (workspace "${inv.space}"; it ${canDo(inv.verbs, inv.paths)})`);
    say(`wrote ${out} (mode 600: it holds the runner token)`);
    if (installNote) say(installNote);
    say(`approval: ${approve}`);
    say(cfg.ownerKeys ? `this Mac trusts ${cfg.ownerKeys.length} browser(s) you signed in to Kitebook with: permissions you set there apply here (a browser you open with kitebook open is trusted by itself)` : `no browser trusted yet: the one kitebook open opens is trusted by itself (Settings shows which ones)`);
    say(kbSrc.length ? `kb sync: ${kbSrc.length} agent instruction source(s) (${[...new Set(kbSrc.map(e => e.origin))].join(", ")}); review with: bun ${RUNNER} kb detect ${out}` : `kb sync: no agent instruction files found yet (later: bun ${RUNNER} kb detect ${out} --apply)`);
    if (!inv.verbs?.includes("delete")) say(`note: this runner isn't allowed to delete files, so "mirror": true won't work. Get a fresh install command from ${url}/start (Connect your Mac): it can delete in repos/`);
    say(`check anytime: bun ${R} doctor ${out}`);
  }
  // the summary: at most 3 lines (from install.sh only the connected one; install.sh adds the installed line and the next step)
  const agents = found.length ? `coding agent${found.length > 1 ? "s" : ""}: ${found.join(", ")}` : `no coding agent found yet (install one: ${INSTALL_HINT.pi})`;
  const projs = projects.length ? `project${projects.length > 1 ? "s" : ""}: ${projects.map(([k]) => k).slice(0, 6).join(", ")}${projects.length > 6 ? ", ..." : ""}` : `no projects yet (put a git repo in ${roots[0]})`;
  if (!fromSh) say(`${ver ? `✓ Installed the Kitebook runner (version ${ver})` : "✓ Set up the Kitebook runner"} · ${agents} · ${projs}`);
  say(`✓ Connected this computer to ${url} as "${inv.name}"${fromSh ? ` · ${agents} · ${projs}` : ""}`);
  if (!fromSh) say(`Next: start it with bun ${R} install ${out} (starts at login), then ${approveLine}`); // launchd, systemd --user or Kitebook's supervisor
  return 0;
}

// ---- doctor: check everything a first run needs, print one fix per problem ----
export async function doctorCmd(argv: string[]): Promise<number> {
  const cfgPath = resolve(argv.find(a => !a.startsWith("--")) ?? "runner.json");
  // C9: the check lines stay (ok / FIX + the exact command), file paths and per-source detail only with --verbose (or KITEBOOK_VERBOSE=1),
  // and it ends with a 3-line summary: is it set up, is it connected, what to do next.
  const vb = argv.includes("--verbose") || process.env.KITEBOOK_VERBOSE === "1", at = (p: string) => vb ? ` ${p}` : "";
  let bad = 0, checks = 0, firstFix = ""; const ok = (s: string) => { checks++; console.log(`ok   ${s}`); }, warn = (s: string, f: string) => { checks++; console.log(`WARN ${s}\n     -> ${f}`); }, fix = (s: string, f: string) => { bad++; checks++; firstFix ||= f; console.log(`FIX  ${s}\n     -> ${f}`); }, info = (s: string) => console.log(`--   ${s}`), detail = (s: string) => { if (vb) info(s); };
  let c: any;
  try { c = JSON.parse(readFileSync(cfgPath, "utf8")); } catch (e: any) {
    fix(existsSync(cfgPath) ? `${cfgPath} isn't valid JSON (${e.message})` : `no config at ${cfgPath}`, `create one with: bun ${RUNNER} init <kitebook-url> <invite-url>`); return 1; }
  ok(`config${at(cfgPath)}`);
  try { const mode = statSync(cfgPath).mode & 0o777; if (mode & 0o077) fix(`config is readable by others (mode ${mode.toString(8)}) and holds a token`, `chmod 600 ${cfgPath}`); } catch {}
  for (const k of ["url", "token", "space"]) if (!c[k]) fix(`"${k}" is missing`, `rerun: bun ${RUNNER} init <kitebook-url> <invite-url> --force`);
  let me: any = null;
  if (c.url && c.token) {
    const url = String(c.url).replace(/\/+$/, "");
    try { const h = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) }); const hj: any = await h.json().catch(() => null);
      if (hj?.ok) ok(`kitebook reachable at ${url}`); else fix(`${url}/health didn't answer {"ok":true}`, whoamiFix(url, { notRelay: true }, cfgPath)); }
    catch (e: any) { fix(`kitebook unreachable`, whoamiFix(url, { network: e.message }, cfgPath)); }
    try { const r = await fetch(`${url}/v1/whoami`, { method: "POST", headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000) });
      const j: any = await r.json().catch(() => null);
      if (j?.ok) { me = j.result; ok(`token accepted: runner "${me.name}" (${me.kind})`); }
      else if (j) fix(`token rejected`, whoamiFix(url, { status: r.status, error: j.error }, cfgPath)); }
    catch {}
    if (me && c.space) { const cap = me.spaces?.find((s: any) => s.space === c.space);
      if (!cap) fix(`token has no access to workspace "${c.space}"`, `set "space" in ${cfgPath} to one of: ${(me.spaces ?? []).map((s: any) => s.space).join(", ") || `(none: get a fresh install command from ${url}/start -> Connect your Mac)`}`);
      else { ok(`workspace "${c.space}": this runner ${canDo(cap.verbs, cap.paths)}`);
        if (Object.values<any>(c.projects ?? {}).some(p => p.mirror) && !cap.verbs.includes("delete")) fix(`a project has "mirror": true but this runner isn't allowed to delete files`, `get a fresh runner invite (it can delete in repos/): ${url}/start -> Connect your Mac -> Create install command, then run that line with KITEBOOK_FORCE=1 (curl -fsSL ${url}/install.sh | KITEBOOK_FORCE=1 sh -s -- <invite>)`); } }
  }
  // agents
  for (const a of usedAgents(c)) { const { bin, found } = agentBin(c, a); if (!found) { fix(`agent ${a} not found`, agentFix(a, bin, cfgPath)); continue; }
    // a checked adapter must also list the flags its run needs (an installed Codex that rejects our flags fails every task): read its --help
    const iss = !c.agents?.[a] && Object.hasOwn(ADAPTERS, a) ? helpIssue(a) : null;
    if (iss) fix(`agent ${a}: found, but can't run tasks`, iss); else ok(`agent ${a}: ${vb ? found : "found"}`); }
  // Codex: live connection or one CLI run per turn, and whether its sandbox can start here (the nested-Seatbelt bug, client/live-codex.ts)
  if (agentBin(c, "codex").found && !c.agents?.codex) { const LC = await import("./live-codex.ts"), Q = await import("./runner-ask.ts");
    if (c.live === false || c.live?.codex === false || process.env.KITEBOOK_LIVE === "0") info(`codex: one CLI run per turn (live connection switched off in ${vb ? cfgPath : "runner.json"})`);
    else if (await LC.driver.available()) ok(`codex: live connection (codex app-server): steering reaches a running turn, cancel interrupts it, warm quick asks`);
    else info(`codex: one CLI run per turn (${LC.driver.why?.() ?? "no app-server"}); updating Codex turns on the live connection (npm i -g @openai/codex)`);
    const nested = await Q.seatbeltNested();
    if (nested) fix(`this runner runs inside another macOS sandbox, so no sandbox can start under it (quick asks and Codex fail with "sandbox_apply: Operation not permitted")`, `run the runner as its login service, not from inside a sandboxed app or agent: kitebook restart runner`);
    else if (nested === false) ok(`codex sandbox: quick asks run Codex inside Kitebook's read-only sandbox with Codex's own sandbox off (macOS sandboxes don't nest); tasks keep Codex's own workspace sandbox`); }
  // projects
  const projects = Object.entries<any>(discover(c));
  if (!projects.length) fix(`no projects: no git repos under ${(c.roots ?? DEFAULT_ROOTS).join(", ")}`, `clone a repo there, or point roots elsewhere: ${cmdFor("set", cfgPath)} roots ~/code,~/work   (tasks without a project still run in a scratch dir)`);
  else { ok(`${projects.length} project(s): ${projects.map(([k]) => k).slice(0, 12).join(", ")}${projects.length > 12 ? ", ..." : ""}`);
    for (const [k, p] of projects) if (!existsSync(join(p.path ?? "", ".git"))) fix(`project ${k}: ${p.path} is not a git repo`, `fix its "path" in runner.json or remove the entry`); }
  // approvals: judged as they'll be under launchd (no terminal), since that's how the runner normally lives
  const ap = approvalWays(c, cfgPath, { tty: false });
  if ("error" in ap) fix(`approvals unreachable when running in the background`, ap.error.replace(/^.*?Fix on the runner machine: /, ""));
  else if (ap.fallback) warn(`approvals: only on the review page (no dialog, terminal or phone here)`, ap.fallback.replace(/^.*?To choose that for good: /, ""));
  else ok(`approvals: ${ap.ways.join(" + ")}${c.approve ? "" : " (approve not set: default)"}${c.approve === "auto" ? " (approve=auto: trusted senders run without asking)" : ""}`);
  // A configured phone channel is only as good as the ntfy server behind it: probe it for real (and, with --test-push, send one).
  const testPush = argv.includes("--test-push");
  if (c.ntfy?.topic) { const server = String(c.ntfy.server ?? "https://ntfy.sh").replace(/\/+$/, ""), auth: Record<string, string> = c.ntfy.token ? { authorization: `Bearer ${c.ntfy.token}` } : {};
    const why = (e: any) => `${e?.code && !String(e.message ?? "").includes(e.code) ? e.code + ": " : ""}${e?.message ?? e}`;
    const down = `phone approvals can't work until it answers (tasks wait queued and the runner retries; nothing is declined). Check your network and "ntfy.server" in ${cfgPath}${c.ntfy.server ? "" : " (default https://ntfy.sh)"}, then rerun: ${cmdFor("doctor", cfgPath)} --test-push`;
    let up = false;
    try { const r = await fetch(`${server}/v1/health`, { headers: auth, signal: AbortSignal.timeout(10_000) });
      if (r.status >= 500) fix(`approval channel unreachable: ntfy at ${server} answered HTTP ${r.status}`, down); else { up = true; ok(`ntfy reachable at ${server}${r.ok ? "" : ` (HTTP ${r.status} on /v1/health)`}`); } }
    catch (e: any) { fix(`approval channel unreachable: couldn't reach ntfy at ${server} (${why(e)})`, down); }
    if (testPush && up) try {
      const r = await fetch(server, { method: "POST", headers: { "content-type": "application/json", ...auth }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ topic: c.ntfy.topic, title: "Kitebook: test push from doctor", message: `If you see this, phone approvals from ${me?.name ?? "this runner"} reach you.`, priority: 3, tags: ["white_check_mark"] }) });
      if (r.ok) ok(`test push sent to ntfy topic ${c.ntfy.topic}: check your phone (ntfy app, subscribed to that topic)`);
      else fix(`test push refused: ntfy at ${server} answered HTTP ${r.status}`, r.status === 401 || r.status === 403 ? `the topic needs a token: set "ntfy.token" in ${cfgPath} (ntfy access token)` : down); }
    catch (e: any) { fix(`test push failed: ${why(e)}`, down); } }
  else if (testPush) fix(`--test-push: no phone channel (runner.json has no ntfy.topic)`, `${cmdFor("set", cfgPath)} approve ${process.platform === "darwin" ? "dialog+phone" : "phone"}   (then rerun init with --phone, or add "ntfy": {"topic": "kitebook-<random>"})`);
  if (c.env?.length) { const ef = c.envFile ? tilde(c.envFile) : null; const fileKeys = ef && existsSync(ef) ? readFileSync(ef, "utf8").match(/^\s*([A-Z0-9_]+)\s*=/gm)?.map(s => s.replace(/[\s=]/g, "")) ?? [] : [];
    const missing = c.env.filter((k: string) => !fileKeys.includes(k)); if (missing.length) fix(`agent keys ${missing.join(", ")} aren't in an envFile (launchd doesn't load your shell)`, `put KEY=value lines in ~/.kitebook/agent.env (chmod 600) and add "envFile": "~/.kitebook/agent.env" to runner.json`); else ok(`envFile has ${c.env.join(", ")}`); }
  // kb sync: which agent/memory sources are allowlisted, how many chunks they make here, and when the runner last published them
  const sync = c.kb?.sync ?? [], fresh = mergeSync(sync, agentSources(discover(c))).added;
  if (!sync.length) info(`kb sync: off${fresh.length ? ` (${fresh.length} agent instruction source(s) found${vb ? `: bun ${RUNNER} kb detect ${cfgPath} --apply` : "; --verbose shows how to add them"})` : ""}`);
  else {
    const local = sync.map((e: any) => ({ e, files: filesOf(e).length, chunks: chunksOf(e).chunks.length }));
    let st: any = null; try { const dir = join(homedir(), ".kitebook"), f = me ? syncStateFile(me.name, c.space) : readdirSync(dir).filter(n => n.endsWith(`.${c.space}.kb-sync.json`)).map(n => join(dir, n))[0];
      if (f) st = JSON.parse(readFileSync(f, "utf8")); } catch {}
    const ago = (t: string) => { const m = Math.round((Date.now() - Date.parse(t)) / 60_000); return m < 1 ? "just now" : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
    ok(`kb sync: ${sync.length} source(s), ${local.reduce((a: number, x: any) => a + x.files, 0)} file(s), ${local.reduce((a: number, x: any) => a + x.chunks, 0)} chunk(s); last sync ${st?.last_ok ? `${st.last_ok} (${ago(st.last_ok)})` : "never (start the runner)"}`);
    for (const x of local) detail(`  ${x.e.origin ?? "memory"} ${x.e.scope ?? "global"} ${x.e.path}: ${x.files ? `${x.chunks} chunk(s)` : "missing (its chunks are forgotten on the next sync)"}`);
    for (const s2 of st?.sources ?? []) if (s2.error) fix(`kb sync of ${s2.path} failed: ${s2.error}`, /denied|forbidden|scope|grant/i.test(s2.error) ? `this runner can't use the knowledge base (kb/ folder): get a fresh install command from ${String(c.url ?? "<kitebook>").replace(/\/+$/, "")}/start (Connect your Mac) and rerun it with KITEBOOK_FORCE=1` : `it retries every ${c.kb?.every ?? 60}s; check the runner log`);
    if (fresh.length) detail(`kb sync: ${fresh.length} more agent instruction source(s) found (${fresh.map(e => e.path).slice(0, 4).join(", ")}${fresh.length > 4 ? ", ..." : ""}): bun ${RUNNER} kb detect ${cfgPath} --apply`);
  }
  // offline-first KB writes waiting on this machine (client/outbox.ts): queued `kitebook kb add` notes + ~/.kitebook-kb/kb-inbox files
  { const { depth, outboxDir, inboxDir } = await import("./outbox.ts"), d = depth(), wait = d.outbox + d.inbox, sh = (p: string) => p.replace(homedir(), "~");
    const extra = [d.conflicts ? `${d.conflicts} conflict(s) kept (the server won) in ${sh(outboxDir())}/conflicts or ${sh(inboxDir())}/conflicts` : "", d.rejected ? `${d.rejected} refused note(s) in .../rejected (reason in each .why)` : ""].filter(Boolean).join("; ");
    if (wait) info(`kb outbox: ${d.outbox} queued${d.oldest ? ` (oldest ${d.oldest})` : ""}, ${d.inbox} inbox file(s) waiting; the runner sends them when the server is reachable${extra ? `; ${extra}` : ""}`);
    else ok(`kb outbox: empty${extra ? ` (${extra})` : ""}`); }
  // the kitebook command (client/cli-path.ts): a warning, the runner works without it, but the owner's next step is "kitebook ..."
  { const d = (await import("./cli-path.ts")).doctorCheck(cfgPath); // without --verbose the fix hides file paths, like the other checks
    if (d) { if (d.ok) ok(d.line); else warn(d.line, vb ? d.fix! : d.fix!.replace(/bun \S*cli-path\.ts install \S+/, "cli-path.ts install (--verbose shows the command)").replaceAll(homedir(), "~")); } }
  // launchd
  if (PL.plat() !== "darwin") { const { pickBackend, backendWords } = await import("./service.ts"), be = pickBackend(c), u = c.runnerUnit ?? "kitebook-runner";
    const inst = be.kind === "systemd" ? existsSync(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", `${u}.service`)) : be.loaded("dev.kitebook.runner");
    if (!inst) info(`service: not installed as a login service (fine if you run it some other way; to start it at login: ${vb ? `\`${cmdFor("install", cfgPath)}\`` : "runner.ts install (--verbose shows the command)"})`); else ok(`service: ${backendWords(be)}${be.running("dev.kitebook.runner") ? ", running" : ", NOT running (kitebook start runner; kitebook logs runner)"}`); }
  else { const plist = join(homedir(), "Library/LaunchAgents/dev.kitebook.runner.plist");
    if (!existsSync(plist)) fix(`not installed as a login service`, cmdFor("install", cfgPath));
    else { const body = readFileSync(plist, "utf8"); const p = Bun.spawnSync([c.launchctl ?? "launchctl", "print", `gui/${process.getuid!()}/dev.kitebook.runner`]); const st = p.stdout.toString();
      if (!body.includes(`<string>${cfgPath}</string>`)) fix(`launchd runs a different config than ${cfgPath}`, cmdFor("install", cfgPath));
      else if (p.exitCode !== 0) fix(`the runner service is installed but not loaded (stopped)`, "kitebook start runner");
      else if (!/state = running/.test(st)) fix(`the runner service is loaded but not running right now`, "kitebook restart runner   (if it stops again: kitebook logs runner)");
      else ok(`launchd: dev.kitebook.runner running`); } }
  // runner integrity: the pinned install still matches its manifest (an agent or anything else editing it shows up here)
  { const I = await import("./integrity.ts"), inst = I.verifyInstall(), url = String(c.url ?? "<kitebook>").replace(/\/+$/, "");
    if (!inst.installed) info(`runner: runs from${vb ? ` ${dirname(RUNNER)}` : " a copy of the code"}, not a pinned install (curl -fsSL ${url}/install.sh | sh installs one; keeps runner.json)`);
    // which code, on which channel (client/channel.ts): dev commits on a checkout are the dev channel, not unpushed local work
    if (!inst.installed) { const cb = (await import("./channel.ts")).build(dirname(dirname(RUNNER))); if (cb) {
      info(`code: Kitebook ${cb.version}, ${cb.channel === "dev" ? "on the dev channel (origin/dev)" : cb.channel === "main" ? "on the stable channel (origin/main)" : "on neither origin/main nor origin/dev (local commits)"}${cb.branch ? `, branch ${cb.branch}` : ""}${cb.dirty ? ", with local changes" : ""}`);
      if (cb.channel === "dev" && cb.branch && cb.branch !== "dev") info(`code: the checkout's ${cb.branch} branch holds dev commits; the runner moves it onto a dev branch tracking origin/dev when it next starts (kitebook restart runner), nothing to push`); } }
    else if (inst.ok) ok(`runner integrity: version ${inst.version}, ${inst.files} files match the manifest${I.isInstalledPath(RUNNER) || !vb ? "" : ` (this doctor itself runs from ${dirname(RUNNER)})`}`);
    else fix(`runner install ${inst.version} doesn't match its manifest (tampered?): ${inst.problems.join(", ")}`, `reinstall the pinned files: curl -fsSL ${url}/install.sh | sh   (keeps runner.json), then rerun doctor`);
    if (inst.installed) { const key = I.releaseKey(c), s = I.verifyInstalledSig(inst.dir!, key);
      if (s.state === "ok") ok(`release signature: runner ${inst.version} is signed by the pinned release key ${key.slice(0, 20)}…`);
      else if (s.state === "legacy") info(`release signature: no release key is pinned, so the runner files are trusted only because the server sent them. To pin one: "releaseKey": "ed25519:..." in runner.json${at(`(${cfgPath})`)}`);
      else fix(`release signature: ${s.error}`, `reinstall a signed release: curl -fsSL ${url}/install.sh | sh   (keeps runner.json); a self-hoster signs with scripts/sign-release.ts`); }
    if (inst.installed && c.url) try { const m = await I.fetchManifest(c.url); if (m.version !== inst.version) info(`the server serves runner ${m.version} (installed: ${inst.version}). To update, from your terminal: kitebook update (or kitebook pin ${m.version} first, to approve it ahead of time)`); } catch {} }
  { const T = await import("./tunnel.ts"), ts = T.readState(); if (ts) { const d = T.describe(ts); // No server / domain: the built-in tunnel on this Mac
    if (d.ok) ok(`tunnel: ${d.line}`); else fix(`tunnel: ${d.line}`, "kitebook restart tunnel   (then kitebook logs tunnel)");
    if (ts.url && /trycloudflare\.com/.test(String(c.url ?? ""))) fix(`this runner uses the tunnel's address ${c.url}, which changes when the tunnel restarts`, `kitebook restart tunnel   (once it is up, Kitebook moves this runner to ${ts.local}, which never changes)`); } }
  const url = String(c.url ?? "").replace(/\/+$/, ""), ver = (await import("./integrity.ts")).verifyInstall().version;
  console.log(`\n${bad ? `✗ ${bad} thing(s) to fix (the FIX lines above)` : `✓ All good: ${checks} checks pass${ver ? ` for runner version ${ver}` : ""}`}`);
  console.log(me ? `✓ Connected to ${url} as "${me.name}"` : `✗ Not connected to ${url || "a Kitebook server"} (see the FIX lines above)`);
  console.log(`Next: ${bad ? firstFix : `send a task from your assistant; you approve it ${approvalWhere(c, cfgPath)}`}`);
  return bad ? 1 : 0;
}

// ---- kb detect: propose kb.sync entries for the agent instruction files on this machine (print; --apply merges them in) ----
export async function kbDetectCmd(argv: string[]): Promise<number> {
  const cfgPath = resolve(argv.find(a => !a.startsWith("--")) ?? "runner.json"), apply = argv.includes("--apply");
  let c: any; try { c = JSON.parse(readFileSync(cfgPath, "utf8")); } catch (e: any) { console.error(`can't read ${cfgPath}: ${e.message}`); return 1; }
  const proposed = agentSources(discover(c)), { sync, added } = mergeSync(c.kb?.sync, proposed);
  const show = (e: any) => ({ ...e, files: filesOf(e).map(f => f.rel) }), already = (c.kb?.sync ?? []).length;
  if (apply && added.length) { c.kb = { ...(c.kb ?? {}), sync }; writeFileSync(cfgPath, JSON.stringify(c, null, 2)); const { stampOwnerEdit } = await import("./guard.ts"); stampOwnerEdit(cfgPath); }
  console.log(JSON.stringify({ config: cfgPath, applied: apply && added.length > 0, new: added.map(show), already,
    note: added.length ? (apply ? "a running runner picks these up on its next kb tick (no restart)" : `review, then: bun ${RUNNER} kb detect ${cfgPath} --apply`) : "nothing new to sync",
    skipped: "USER.md, people/, *personal*, credentials, sessions/transcripts are never synced (default denylist); secrets are redacted" }, null, 2));
  return 0;
}
