#!/usr/bin/env bun
// Kitebook safety layer for the runner. Full access stays on; these protections are on by default and only the
// machine owner can turn one off (runner.json "protect": {...} or `bun runner.ts set <cfg> protect.<name> on|off`).
// Dispatchers can never change them: nothing a task carries is read as policy.
//
//   killSwitch        honor pause: the owner's server-side `pause` (space-wide or per dispatcher) and the local
//                     `bun runner.ts pause` stop new tasks and kill running agents (whole process tree)
//   destructiveGuard  PATH shims block sudo, rm -r outside the task dir, git push --force / to main|master,
//                     git reset --hard / clean -f outside the task worktree, launchctl, diskutil, shutdown, dd
//   irreversibleGate  PATH shims block deploy/publish/spend/send commands unless the owner approved this task
//                     from their phone (task text asks with [needs-owner-approval: why]; only the runner adds the marker)
//   auditLog          append-only, hash-chained ~/.kitebook/audit.jsonl + audit.json artifact per task
//   protectedFiles    changes to AGENTS.md, CLAUDE.md, .github/workflows/**, .git/hooks/**, .kitebook* and .relay*, runner.json and the
//                     runner's own install (~/.kitebook/versions, current) fail the task as out-of-policy
// The shims are a TRIPWIRE, not a sandbox: an agent that calls /bin/rm by absolute path, edits PATH, or uses
// another language's file APIs gets around them. They stop the common confused-agent mistakes and record them.
//
// CLI (also reachable through runner.ts):
//   bun guard.ts set <runner.json> protect.<name> on|off
//   bun guard.ts protect <runner.json>            show the protect state
//   bun guard.ts pause [runner.json] [reason]     local kill switch: stop new tasks, kill running agents
//   bun guard.ts resume [runner.json]
//   bun guard.ts audit verify [audit.jsonl]       check the hash chain
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { stopProcessTree } from "./execution-process.ts";
import * as PL from "./platform.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync, realpathSync, chmodSync, rmSync, openSync, readSync, closeSync, fstatSync } from "fs";
import { COMPILED } from "./binary.ts"; // the kitebook binary: shims call `kitebook __guard` / `kitebook runner`, not a .ts path
import { join, resolve, dirname, basename } from "path";
import { homedir, tmpdir } from "os";
import { createHmac, createHash, randomBytes } from "crypto";
import { treeHash, installStamp } from "./integrity.ts";

export const PROTECT: Record<string, string> = {
  killSwitch: "owner pause/resume stops new tasks and kills running agents",
  destructiveGuard: "blocks sudo, rm -r outside the task dir, force-push, push to main/master, reset --hard / clean outside the worktree, launchctl, diskutil, shutdown, dd",
  irreversibleGate: "blocks deploy/publish/spend/send commands unless the owner approved the task from their phone",
  auditLog: "append-only hash-chained ~/.kitebook/audit.jsonl + audit.json task artifact",
  protectedFiles: "changes to AGENTS.md, CLAUDE.md, .github/workflows/**, .git/hooks/**, .kitebook* and .relay*, runner.json or the runner install (~/.kitebook/versions) fail the task",
};
export type Protect = Record<string, boolean>;
const NAMES = Object.keys(PROTECT);
export const resolveProtect = (c: any): Protect => Object.fromEntries(NAMES.map(n => { const v = c?.protect?.[n]; return [n, !(v === false || v === "off" || v === "false")]; }));

const STATE = join(homedir(), ".kitebook");
export const AUDIT_FILE = join(STATE, "audit.jsonl");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const expand = (p: string) => p.replace(/^~(?=$|\/)/, homedir());

// ---------- audit log: one JSON object per line, each carrying prev (hash of the line before) and its own hash ----------
function lastHash(file: string): string {
  if (!existsSync(file)) return "0".repeat(64);
  const fd = openSync(file, "r"); try {
    const size = fstatSync(fd).size; if (!size) return "0".repeat(64);
    const n = Math.min(size, 1 << 20), buf = Buffer.alloc(n); readSync(fd, buf, 0, n, size - n);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    return JSON.parse(lines[lines.length - 1]).hash;
  } finally { closeSync(fd); }
}
export function auditAppend(entry: Record<string, any>, file = AUDIT_FILE): { hash: string; prev: string } {
  mkdirSync(dirname(file), { recursive: true });
  const fresh = !existsSync(file);
  const prev = lastHash(file), body = { ts: new Date().toISOString(), ...entry, prev };
  const hash = sha(prev + JSON.stringify(body));
  appendFileSync(file, JSON.stringify({ ...body, hash }) + "\n", { mode: 0o600 });
  if (fresh) { try { chmodSync(file, 0o600); } catch {} if (process.platform === "darwin") Bun.spawnSync(["chflags", "uappnd", file]); } // macOS: append-only flag (owner can clear it)
  return { hash, prev };
}
export function auditVerify(file = AUDIT_FILE): { ok: boolean; entries: number; error?: string } {
  if (!existsSync(file)) return { ok: true, entries: 0 };
  let prev = "0".repeat(64), n = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue; n++;
    let e: any; try { e = JSON.parse(line); } catch { return { ok: false, entries: n, error: `line ${n}: not JSON` }; }
    const { hash, ...body } = e;
    if (body.prev !== prev) return { ok: false, entries: n, error: `line ${n}: prev does not match the line before (inserted/removed lines)` };
    if (sha(prev + JSON.stringify(body)) !== hash) return { ok: false, entries: n, error: `line ${n}: hash mismatch (edited line)` };
    prev = hash;
  }
  return { ok: true, entries: n };
}

// ---------- owner-approval marker for irreversible actions ----------
function key(): string {
  const f = join(STATE, "guard.key"); mkdirSync(STATE, { recursive: true });
  if (!existsSync(f)) { writeFileSync(f, randomBytes(32).toString("hex"), { mode: 0o600 }); }
  return readFileSync(f, "utf8").trim();
}
export const approvalKey = key; // also keys the approval nonces (client/approval.ts): runner-only, never sent anywhere
const sig = (task: string) => createHmac("sha256", key()).update("owner-approved:" + task).digest("hex").slice(0, 24);
const MARKER_RE = /RELAY-OWNER-APPROVED[:\-\s]*[A-Za-z0-9]*/gi;
export const stripMarkers = (s: string) => s.replace(MARKER_RE, "[approval marker removed: only the runner adds it]");
const REQUEST_RE = /\[needs-owner-approval(?::\s*([^\]\n]*))?\]/i;

// ---------- rules the shims enforce ----------
const ALWAYS_DESTRUCTIVE = ["sudo", "launchctl", "diskutil", "shutdown", "reboot", "halt", "dd"];
const IRREVERSIBLE_CMDS = ["wrangler", "cf", "npm", "pnpm", "yarn", "gh", "vercel", "netlify", "mail", "mailx", "sendmail", "curl", "npx", "pnpx"];
export const SHIMS = ["rm", "git", ...ALWAYS_DESTRUCTIVE, ...IRREVERSIBLE_CMDS];
const MONEY_HOSTS = /(^|\.)(api\.stripe\.com|api\.paypal\.com|api-m\.paypal\.com|api\.sandbox\.paypal\.com|connect\.squareup\.com|api\.squareup\.com|api\.braintreegateway\.com|api\.lemonsqueezy\.com|api\.paddle\.com|api\.adyen\.com|checkout\.adyen\.com|api\.razorpay\.com|api\.coinbase\.com|api\.twilio\.com|api\.sendgrid\.com|api\.mailgun\.net|api\.resend\.com|api\.postmarkapp\.com|api\.mailchimp\.com|mandrillapp\.com|hooks\.slack\.com)$/i;
type Verdict = { kind: "destructive" | "irreversible"; rule: string } | null;

function realish(p: string): string { // realpath of the nearest existing ancestor + the rest (so symlinks like /tmp -> /private/tmp compare equal)
  let cur = resolve(p), rest = "";
  for (let i = 0; i < 64; i++) { try { return join(realpathSync(cur), rest); } catch { rest = join(basename(cur), rest); const up = dirname(cur); if (up === cur) return resolve(p); cur = up; } }
  return resolve(p);
}
const under = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/");
function allowedPath(p: string, root: string): boolean {
  const r = realish(p), rt = realish(root);
  if (under(r, rt)) return true;
  for (const t of new Set([realish(tmpdir()), realish("/tmp")])) if (under(r, t) && r !== t && !basename(r.slice(t.length + 1).split("/")[0]).startsWith("kitebook-")) return true; // scratch in tmp is fine, other tasks' worktrees aren't
  return false;
}
const nonFlags = (a: string[]) => a.filter(x => !x.startsWith("-"));

export function decide(name: string, args: string[], cwd: string, root: string, realPath = process.env.PATH ?? ""): Verdict {
  if (ALWAYS_DESTRUCTIVE.includes(name)) return { kind: "destructive", rule: `${name} is never run by a Kitebook server agent` };
  if (name === "rm") {
    const dd = args.indexOf("--"), flags = (dd < 0 ? args : args.slice(0, dd)).filter(a => a.startsWith("-"));
    const recursive = flags.some(f => f === "--recursive" || (/^-[a-zA-Z]+$/.test(f) && /[rR]/.test(f)));
    const targets = dd < 0 ? args.filter(a => !a.startsWith("-")) : [...args.slice(0, dd).filter(a => !a.startsWith("-")), ...args.slice(dd + 1)];
    const bad = targets.find(t => !allowedPath(resolve(cwd, expand(t)), root));
    if (recursive && bad) return { kind: "destructive", rule: `rm -r outside the task directory (${bad})` };
    return null;
  }
  if (name === "git") {
    let i = 0, dir = cwd;
    while (i < args.length && args[i].startsWith("-")) { const a = args[i];
      if (a === "-C") { dir = resolve(dir, expand(args[i + 1] ?? ".")); i += 2; continue; }
      if (a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") { i += 2; continue; }
      i++; }
    const sub = args[i], rest = args.slice(i + 1);
    if (sub === "push") {
      if (rest.some(a => a === "-f" || a === "--force" || a.startsWith("--force-with-lease") || a === "--force-if-includes" || a === "--mirror" || (/^-[a-zA-Z]+$/.test(a) && a.includes("f"))))
        return { kind: "destructive", rule: "git push --force (history rewrite)" };
      const pos = nonFlags(rest), refs = pos.slice(1);
      if (refs.some(r => r.startsWith("+"))) return { kind: "destructive", rule: "git push +refspec (force)" };
      if (rest.includes("--all")) return { kind: "destructive", rule: "git push --all (would push main/master)" };
      const toMain = (r: string) => /^(refs\/heads\/)?(main|master)$/.test(r.includes(":") ? r.split(":").pop()! : r);
      if (refs.some(toMain)) return { kind: "destructive", rule: "git push to main/master (work lands on kitebook/<id>, merge stays human)" };
      if (!refs.length) {
        const git = Bun.which("git", { PATH: realPath });
        const br = git ? Bun.spawnSync([git, "-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]).stdout.toString().trim() : "";
        if (/^(main|master)$/.test(br)) return { kind: "destructive", rule: `git push from ${br} (pushes the default branch)` };
      }
      return null;
    }
    if (sub === "reset" && rest.includes("--hard") && !allowedPath(dir, root)) return { kind: "destructive", rule: `git reset --hard outside the task worktree (${dir})` };
    if (sub === "clean" && rest.some(a => /^-[a-zA-Z]*f/.test(a) || a === "--force") && !allowedPath(dir, root)) return { kind: "destructive", rule: `git clean -f outside the task worktree (${dir})` };
    return null;
  }
  const pos = nonFlags(args);
  const irr = (rule: string): Verdict => ({ kind: "irreversible", rule });
  switch (name) {
    case "wrangler": if (["deploy", "publish"].includes(pos[0]) || (["pages", "versions"].includes(pos[0]) && pos[1] === "deploy")) return irr(`wrangler ${pos.slice(0, 2).join(" ")} (deploy)`); return null;
    case "cf": if (pos[0] === "deploy") return irr("cf deploy"); return null;
    case "npm": case "pnpm": case "yarn": if (pos[0] === "publish" || (pos[0] === "npm" && pos[1] === "publish")) return irr(`${name} publish`); return null;
    case "gh": if ((pos[0] === "release" && pos[1] === "create") || (pos[0] === "pr" && pos[1] === "merge")) return irr(`gh ${pos[0]} ${pos[1]}`); return null;
    case "vercel": if (!pos.length || ["deploy", "promote", "redeploy"].includes(pos[0]) || args.includes("--prod")) return irr("vercel deploy"); return null;
    case "netlify": if (pos[0] === "deploy") return irr("netlify deploy"); return null;
    case "mail": case "mailx": case "sendmail": return irr(`${name} (sends email)`);
    case "curl": {
      let method = "";
      for (let j = 0; j < args.length; j++) { const a = args[j];
        if (a === "-X" || a === "--request") method = (args[j + 1] ?? "").toUpperCase(); else if (/^-X./.test(a)) method = a.slice(2).toUpperCase(); else if (a.startsWith("--request=")) method = a.slice(10).toUpperCase();
        else if (!method && (/^-(d|F|T)/.test(a) || /^--(data|form|json|upload-file)/.test(a))) method = "POST"; }
      if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return null;
      const host = args.map(a => { try { return new URL(/^https?:\/\//.test(a) ? a : "x://none").hostname; } catch { return ""; } }).find(h => MONEY_HOSTS.test(h));
      return host ? irr(`curl ${method} to ${host} (payment/messaging API)`) : null;
    }
    case "npx": case "pnpx": { // npx wrangler deploy etc. resolve from node_modules/.bin, not PATH, so look through npx
      let j = 0; while (j < args.length && args[j].startsWith("-")) { if (args[j] === "-p" || args[j] === "--package") j++; j++; }
      if (j >= args.length) return null;
      const inner = basename(args[j].replace(/@[^/]*$/, ""));
      if (inner === "rm" || inner === "git" || SHIMS.includes(inner)) return decide(inner, args.slice(j + 1), cwd, root, realPath);
      return null;
    }
  }
  return null;
}

// Runs inside each shim: `guard.ts __check <conf.json> <cmd> args...` exits 0 to allow, 1 to block. Every call is logged.
export function shimCheck(confFile: string, name: string, args: string[]) {
  let c: any; try { c = JSON.parse(readFileSync(confFile, "utf8")); } catch { process.exit(0); } // guard state gone (task over): don't break the tool
  const v = decide(name, args, process.cwd(), c.root, c.realPath);
  let decision = "allow";
  if (v?.kind === "destructive" && c.destructive) decision = "block";
  if (v?.kind === "irreversible" && c.irreversible) decision = c.approved && c.approved === sig(c.task) ? "allow-owner-approved" : "block";
  const line = { ts: new Date().toISOString(), cmd: name, args: args.slice(0, 40).map(a => a.length > 300 ? a.slice(0, 300) + "…" : a), cwd: process.cwd(), decision, ...(v ? { rule: v.rule, kind: v.kind } : {}) };
  try { appendFileSync(c.log, JSON.stringify(line) + "\n"); } catch {}
  if (decision === "block") {
    const why = v!.kind === "irreversible" ? "deploy/publish/spend/send needs the machine owner's phone approval for this task" : "destructive command";
    process.stderr.write(`kitebook guard: blocked \`${[name, ...args].join(" ").slice(0, 200)}\`: ${v!.rule}. ${why}. This is the machine owner's policy (${v!.kind === "irreversible" ? "irreversibleGate" : "destructiveGuard"}); do not work around it, say in your summary that it was needed.\n`);
    process.exit(1);
  }
  process.exit(0);
}

// ---------- runner integration ----------
type Init = { cfg: any; cfgPath: string; call: (op: string, a?: any) => Promise<any>; log: (...a: any[]) => void; me: { name: string }; onChange?: () => void;
  ownerAsk: (text: string, t: any) => Promise<boolean | null> };
let S: Init; let protect: Protect = resolveProtect({}); let paused = false; let serverPaused: any = null;
const active = new Map<string, Ctx>();
const fileHash = (p: string) => { try { return sha(readFileSync(p, "utf8")); } catch { return ""; } };
// The owner's CLI stamps the config hash it wrote, so an owner toggle mid-task isn't mistaken for an agent editing runner.json.
const stampFile = (cfg: string) => join(STATE, `owner-edit-${sha(resolve(cfg)).slice(0, 16)}`);
export const stampOwnerEdit = (cfg: string) => { try { mkdirSync(STATE, { recursive: true }); writeFileSync(stampFile(cfg), fileHash(cfg), { mode: 0o600 }); } catch {} };
const ownerStamp = (cfg: string) => { try { return readFileSync(stampFile(cfg), "utf8").trim(); } catch { return ""; } };
function dirHash(d: string) { try { return sha(readdirSync(d).sort().map(f => { const p = join(d, f); const st = statSync(p); return `${f}:${st.size}:${st.mtimeMs}:${st.isFile() ? fileHash(p) : ""}`; }).join("\n")); } catch { return ""; } }

export function init(o: Init) {
  S = o; protect = resolveProtect(o.cfg); paused = !!o.cfg.paused;
  key();
  setInterval(reload, 3000);
}
// Hot reload, like approve/access. Tightening applies at once; loosening (a guard turned off) waits until no agent is
// running, so an agent that edits runner.json can't switch off the guards watching it mid-run.
function reload() {
  let c: any; try { c = JSON.parse(readFileSync(S.cfgPath, "utf8")); } catch { return; }
  const want = resolveProtect(c), next = { ...protect }; let changed = false, deferred = false;
  for (const n of NAMES) if (want[n] !== protect[n]) { if (want[n] || active.size === 0) { next[n] = want[n]; changed = true; } else deferred = true; }
  const wasPaused = isPaused(); const wantPaused = !!c.paused;
  if (changed) { protect = next; S.log(`protect now: ${NAMES.map(n => `${n}=${protect[n] ? "on" : "off"}`).join(" ")}`); }
  if (deferred && !(reload as any).warned) { (reload as any).warned = true; S.log("protect: a guard was turned off; applies once running tasks finish"); } else if (!deferred) (reload as any).warned = false;
  if (wantPaused !== paused) { paused = wantPaused; changed = true; S.log(paused ? "PAUSED by the machine owner (kill switch)" : "resumed"); }
  if (!wasPaused && isPaused()) stopAll(`Paused by the machine owner on ${S.me.name} (kill switch): the agent was stopped.${c.pausedReason ? " Reason: " + c.pausedReason : ""}`, () => true, true);
  if (changed) S.onChange?.();
}
export const isPaused = () => protect.killSwitch && paused;
export const pausedNote = () => `runner ${S.me.name} is paused by the machine owner (kill switch); no new tasks until it is resumed`;
export const state = () => ({ ...protect });
export const caps = () => ({ protect: state(), paused: isPaused(), server_paused: serverPaused, protect_note: "owner-only; shims are a tripwire, not a sandbox" });

function stopAll(reason: string, match: (c: Ctx) => boolean, completeOnServer: boolean) {
  for (const c of [...active.values()]) if (match(c)) c.stop(reason, completeOnServer);
}
// Server-side kill switch: the owner's `pause` cancels the tasks (so the runner's cancel path already kills them);
// this also kills them directly and remembers the state for the capabilities file.
export function onEvent(ev: any) {
  if (ev?.type === "space.paused") {
    serverPaused = { peer: ev.data?.peer ?? null, reason: ev.data?.reason, at: ev.at };
    if (protect.killSwitch) stopAll(`Paused by the owner (${ev.data?.peer ? "dispatcher " + ev.data.peer : "whole space"}): ${ev.data?.reason ?? ""}`, c => !ev.data?.peer || c.from === ev.data.peer, false);
    if (protect.auditLog) auditAppend({ type: "space.paused", runner: S.me.name, peer: ev.data?.peer ?? null, reason: ev.data?.reason });
    S.onChange?.();
  }
  if (ev?.type === "space.resumed") { serverPaused = null; if (protect.auditLog) auditAppend({ type: "space.resumed", runner: S.me.name, peer: ev.data?.peer ?? null }); S.onChange?.(); }
}

const killTree = (pid: number) => stopProcessTree(pid);

const PROTECTED = [/(^|\/)AGENTS\.md$/i, /(^|\/)CLAUDE\.md$/i, /(^|\/)\.github\/workflows\//, /(^|\/)\.git\/hooks\//, /(^|\/)\.(kitebook|relay)[^/]*($|\/)/, /(^|\/)runner\.json$/];
export const isProtected = (f: string) => PROTECTED.some(r => r.test(f));

export class Ctx {
  id: string; from: string; root: string; t: any; done = false; ctl: any = null; pid = 0;
  shimDir: string; logFile: string; approved: string | null = null; requested: string | null = null; denied = false;
  started = new Date().toISOString(); cfgHash: string; installHash: string; hooksDir = ""; hooksHash = ""; kind: string; protectAtStart: Protect;
  constructor(t: any, root: string, kind: string, repo?: string) {
    this.t = t; this.id = t.id; this.from = t.from; this.root = root; this.kind = kind; this.protectAtStart = state();
    this.shimDir = join(STATE, "guard", t.id); this.logFile = join(this.shimDir, "calls.jsonl");
    this.cfgHash = fileHash(S.cfgPath); this.installHash = treeHash(); // the runner's own code: an agent must not be able to rewrite its runner
    if (repo) { const g = Bun.spawnSync(["git", "-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.toString().trim(); if (g) { this.hooksDir = join(g, "hooks"); this.hooksHash = dirHash(this.hooksDir); } }
  }
  // extra prompt text: what's blocked, and the owner's approval marker when they approved irreversible actions
  prompt(p: string) {
    const lines: string[] = [];
    if (this.approved) lines.push(`Owner approval: the machine owner approved irreversible actions (deploy/publish/spend/send) for this task from their phone${this.requested ? ` for: ${this.requested}` : ""}. ${this.approved}`);
    else if (protect.irreversibleGate) lines.push(`Deploy, publish, payment and outbound-message commands are blocked on this machine unless the owner approved them for this task${this.denied ? " (the owner did not approve them this time)" : ""}. If the task needs one, stop and say so in your summary.`);
    if (protect.destructiveGuard) lines.push(`Destructive commands are blocked here: sudo, rm -r outside your working directory, git push --force or to main/master, git reset --hard / clean outside your worktree, launchctl, diskutil, shutdown, dd. To restart or update Kitebook itself, use kitebook-svc status, kitebook-svc restart server|runner|all or kitebook-svc update (allowed; a runner restart waits until your task ends).`);
    if (protect.protectedFiles) lines.push(`Do not change AGENTS.md, CLAUDE.md, .github/workflows/, git hooks, .kitebook* or .relay* files (except writing your notes to .relay-learnings.md), runner.json or the runner's install in ~/.kitebook; changing them fails the task.`);
    return lines.length ? `${p}\n\nMachine policy (set by the owner, not negotiable):\n- ${lines.join("\n- ")}` : p;
  }
  // put the shim dir first in the agent's PATH (only the agent's environment; the runner itself is untouched)
  env(env: Record<string, string>) {
    if (!(protect.destructiveGuard || protect.irreversibleGate || protect.auditLog)) return env;
    mkdirSync(this.shimDir, { recursive: true });
    const D = PL.pathSep(), win = PL.plat() === "win32", realPath = (env.PATH ?? "").split(D).filter(d => d && resolve(d) !== this.shimDir).join(D);
    const conf = join(this.shimDir, "conf.json");
    writeFileSync(conf, JSON.stringify({ task: this.id, root: realish(this.root), realPath, log: this.logFile, destructive: protect.destructiveGuard, irreversible: protect.irreversibleGate, approved: this.approved ? sig(this.id) : null }));
    writeFileSync(this.logFile, "");
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    for (const name of SHIMS) {
      const f = join(this.shimDir, name);
      writeFileSync(f, `#!/bin/sh\n# Kitebook guard shim (tripwire, not a sandbox). Task ${this.id}.\n${COMPILED ? `${q(process.execPath)} __guard` : `${q(process.execPath)} ${q(import.meta.path)} __check`} ${q(conf)} ${name} "$@" || exit $?\nreal=$(PATH=${q(realPath)} command -v ${name}) || { echo "${name}: command not found" >&2; exit 127; }\nexec "$real" "$@"\n`, { mode: 0o755 });
    }
    // Windows: the same shims as .cmd files (cmd.exe and PowerShell find name.cmd; Git Bash still finds the sh ones). After the check the
    // shim runs the real command with the PATH that has no shims in it.
    if (win) { const cq = (x: string) => `"${x}"`;
      for (const name of SHIMS) writeFileSync(join(this.shimDir, `${name}.cmd`), `@echo off\r\nrem Kitebook guard shim (tripwire, not a sandbox). Task ${this.id}.\r\n${COMPILED ? `${cq(process.execPath)} __guard` : `${cq(process.execPath)} ${cq(import.meta.path)} __check`} ${cq(conf)} ${name} %*\r\nif errorlevel 1 exit /b %errorlevel%\r\nset "PATH=${realPath}"\r\n${name} %*\r\nexit /b %errorlevel%\r\n`);
      writeFileSync(join(this.shimDir, "kitebook-svc.cmd"), `@echo off\r\nrem Kitebook service CLI for agents (task ${this.id}).\r\n${cq(process.execPath)} ${COMPILED ? "runner" : cq(join(dirname(import.meta.path), "runner.ts"))} service ${cq(resolve(S.cfgPath))} %*\r\n`); }
    // kitebook-svc: the one sanctioned way for an agent to restart/update Kitebook's own launchd jobs (raw launchctl stays blocked)
    writeFileSync(join(this.shimDir, "kitebook-svc"), `#!/bin/sh\n# Kitebook service CLI for agents (task ${this.id}). Only dev.kitebook.server / dev.kitebook.runner.\nexec ${q(process.execPath)} ${COMPILED ? "runner" : q(join(dirname(import.meta.path), "runner.ts"))} service ${q(resolve(S.cfgPath))} "$@"\n`, { mode: 0o755 });
    env.PATH = `${this.shimDir}${D}${env.PATH ?? ""}`; env.KITEBOOK_TASK_ID = this.id; env.KITEBOOK_GUARD = "tripwire";
    return env;
  }
  // after spawn: kills now take the whole process tree, and a paused runner stops the agent at once
  track(ctl: any, pid: number) {
    this.ctl = ctl; this.pid = pid; active.set(this.id, this);
    const orig = ctl.kill; ctl.kill = () => { killTree(pid); try { orig(); } catch {} };
    if (isPaused()) this.stop(pausedNote(), true);
  }
  stop(reason: string, completeOnServer: boolean) {
    if (this.done) return;
    if (this.ctl) { this.ctl.cancelled = true; this.ctl.kill(); }
    S.log("kill switch: stopped", this.id);
    if (completeOnServer) S.call("task_complete", { id: this.id, status: "failed", summary: reason, artifacts: this.finish([], "paused").artifacts }).catch((e: any) => S.log("pause complete", this.id, e.message));
    else this.finish([], "paused");
  }
  calls(): any[] { try { return readFileSync(this.logFile, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } }
  // after the run: protected-file check, guard notes for the summary, audit entry + audit.json artifact
  finish(changed: string[], outcome = "finished"): { ok: boolean; notes: string[]; artifacts: Record<string, string> } {
    if (this.done) return { ok: true, notes: [], artifacts: {} }; this.done = true; active.delete(this.id);
    const calls = this.calls(), blocked = calls.filter(c => c.decision === "block");
    const p = { ...this.protectAtStart, ...Object.fromEntries(NAMES.map(n => [n, this.protectAtStart[n] || protect[n]])) }; // a guard on at start stays on for this task
    const violations: string[] = [];
    if (p.protectedFiles && outcome === "finished") {
      if (this.kind === "worktree") violations.push(...changed.filter(isProtected));
      if (this.hooksDir && dirHash(this.hooksDir) !== this.hooksHash) violations.push(".git/hooks/ (repository hooks)");
      const h = fileHash(S.cfgPath); if (h !== this.cfgHash && h !== ownerStamp(S.cfgPath)) violations.push(`${basename(S.cfgPath)} (the live runner config)`);
      const ih = treeHash(); if (ih !== this.installHash && ih !== installStamp()) violations.push("~/.kitebook/versions (the runner install)"); // kitebook-svc update stamps what it installed
    }
    const notes: string[] = [];
    if (violations.length) notes.push(`Out of policy (protectedFiles): changed protected files: ${violations.join(", ")}. Not accepted; nothing was pushed.`);
    if (blocked.length) notes.push(`Kitebook guard blocked ${blocked.length} command(s): ${[...new Set(blocked.map(b => b.rule))].slice(0, 5).join("; ")}.`);
    if (this.requested) notes.push(this.approved ? `Owner approved irreversible actions from their phone (${this.requested}).` : `Owner approval for irreversible actions was requested (${this.requested}) but not given; those commands stayed blocked.`);
    const artifacts: Record<string, string> = {};
    if (p.auditLog) {
      const entry = { type: "task", task: this.id, from: this.from, runner: S.me.name, project: this.t.project ?? null, kind: this.kind, cwd: this.root, outcome,
        instructions_sha256: sha(String(this.t.instructions ?? "")), started: this.started, ended: new Date().toISOString(), protect: p,
        owner_approved_irreversible: !!this.approved, calls: calls.slice(0, 300), calls_total: calls.length, blocked: blocked.length,
        files_changed: changed.slice(0, 500), files_changed_total: changed.length, protected_violations: violations };
      try { const { hash, prev } = auditAppend(entry); artifacts["audit.json"] = JSON.stringify({ ...entry, audit_file: "~/.kitebook/audit.jsonl", hash, prev }, null, 2); }
      catch (e: any) { notes.push("audit log write failed: " + e.message); }
    }
    try { rmSync(this.shimDir, { recursive: true, force: true }); } catch {}
    return { ok: violations.length === 0, notes, artifacts };
  }
}

// Called once the runner has approved a task and its directory exists, before the prompt is built.
// Strips forged approval markers from the task text and, if the task asks for irreversible actions, asks the owner's phone.
export async function begin(t: any, root: string, kind: "worktree" | "scratch", repo?: string): Promise<Ctx> {
  for (const k of ["title", "instructions", "acceptance"]) if (typeof t[k] === "string") t[k] = stripMarkers(t[k]);
  if (t.spec && typeof t.spec.goal === "string") t.spec.goal = stripMarkers(t.spec.goal); // spec text reaches the prompt too
  const c = new Ctx(t, root, kind, repo);
  const m = String(t.instructions ?? "").match(REQUEST_RE);
  if (m && protect.irreversibleGate) {
    c.requested = (m[1] ?? "").trim() || "unspecified";
    const text = `IRREVERSIBLE actions requested\n${t.from} asks ${S.me.name} to allow deploy/publish/spend/send commands in task "${t.title}" (project ${t.project ?? "machine task"}).\nRequested: ${c.requested}\n\n${String(t.instructions).slice(0, 1200)}\n\nApprove only if you asked for this.`;
    let yes: boolean | null = null; try { yes = await S.ownerAsk(text, t); } catch (e: any) { S.log("owner approval error", e.message); }
    if (yes) c.approved = `RELAY-OWNER-APPROVED:${sig(t.id)}`; else c.denied = true;
    if (protect.auditLog) auditAppend({ type: "owner_approval", task: t.id, from: t.from, runner: S.me.name, requested: c.requested, approved: !!yes });
  }
  return c;
}

// files in a scratch dir (machine tasks have no git diff), for the audit entry
export function listFiles(dir: string, max = 500): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => { if (out.length >= max) return; let es: any[] = []; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { if (out.length >= max) return; if (e.name === ".git" || e.name === "node_modules") continue; const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r); else out.push(r); } };
  walk(dir, ""); return out;
}

// ---------- CLI ----------
export function cli(argv: string[]): boolean {
  const [cmd, ...a] = argv;
  const save = (f: string, c: any) => writeFileSync(f, JSON.stringify(c, null, 2));
  if (cmd === "set" && a[1]?.startsWith("protect.")) {
    const [f, k, v] = a, name = k.slice(8);
    if (!NAMES.includes(name) || !["on", "off"].includes(v)) { console.error(`usage: set <runner.json> protect.<${NAMES.join("|")}> on|off`); process.exit(2); }
    const c = JSON.parse(readFileSync(f, "utf8")); c.protect = { ...(c.protect ?? {}), [name]: v === "on" }; save(f, c); stampOwnerEdit(f);
    try { auditAppend({ type: "protect.set", name, value: v === "on", config: resolve(f) }); } catch {}
    console.log(`protect.${name} = ${v}${v === "off" ? " (a running runner applies it once its current tasks finish)" : ""}`); return true;
  }
  if (cmd === "protect") { const c = JSON.parse(readFileSync(a[0] ?? "runner.json", "utf8")); console.log(JSON.stringify({ protect: resolveProtect(c), paused: !!c.paused }, null, 2)); return true; }
  if (cmd === "pause" || cmd === "resume") {
    const f = a[0] && a[0].endsWith(".json") ? a.shift()! : "runner.json"; const c = JSON.parse(readFileSync(f, "utf8"));
    c.paused = cmd === "pause"; if (cmd === "pause" && a.length) c.pausedReason = a.join(" "); else delete c.pausedReason; save(f, c); stampOwnerEdit(f);
    try { auditAppend({ type: "local." + cmd, config: resolve(f), reason: c.pausedReason }); } catch {}
    console.log(cmd === "pause" ? `paused: the runner stops new tasks and kills running agents within ~3s${resolveProtect(c).killSwitch ? "" : " (warning: protect.killSwitch is off, so the runner ignores this)"}` : "resumed"); return true;
  }
  if (cmd === "audit") {
    if (a[0] !== "verify") { console.error("usage: audit verify [audit.jsonl]"); process.exit(2); }
    const r = auditVerify(a[1] ? expand(a[1]) : AUDIT_FILE); console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1);
  }
  return false;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "__check") shimCheck(rest[0], rest[1], rest.slice(2));
  else if (!cli(process.argv.slice(2))) { console.error("usage: guard.ts set <cfg> protect.<name> on|off | protect <cfg> | pause [cfg] [reason] | resume [cfg] | audit verify [file]"); process.exit(2); }
}
