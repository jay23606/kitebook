// Shared helpers and constants for the Space Durable Object (src/space.ts and src/space/*.ts).
import { TOKEN_RES as SECRET_RES } from "../../client/redact.ts";
import { globMatch, RelayError, type Peer } from "../ops.ts";
import { type EvType } from "../events.ts";
import * as KB from "../kb.ts";

export type Member = { peer_id: string; name: string; kind: string; verbs: string[]; paths: string[]; webhook: string | null; revoked: number };
export type EvStream = { key: number; peer: Peer; t: EvType; args: any; last: number; closed: boolean; timer: any; ttl?: any; send: (method: string, params: any) => void; finish: (reason?: string) => void; abort: () => void };
export async function ctEqual(a: string, b: string) { // constant-time compare over equal-length digests
  const x = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(a))), y = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(b)));
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]; return d === 0;
}
export type Change = { path: string; content?: string; b64?: string; copyOf?: string; delete?: boolean; if_match?: string };
export const ACTIVE = ["queued", "claimed", "awaiting_approval", "running", "needs_input"];
// States where the runner holds the task. Each carries a server-side lease: if the runner is offline (no socket) and silent
// for longer than the lease, a DO alarm fails the task so it never sticks. needs_input waits on the sender, so it isn't leased.
export const HELD = ["claimed", "awaiting_approval", "running"];
// Live phases a runner reports while it holds a task (task_live); "queued" and "done" are derived from the task state.
export const LIVE_PHASES = ["waiting_approval", "approved", "agent_running", "verifying", "uploading"];
export const LIVE_LOG_MAX = 64_000;
// The same phases in plain words, for the owner's Status card and check-on-my-agents (C18/C21).
export const PHASE_WORDS: Record<string, string> = { queued: "waiting for the runner to pick it up", waiting_approval: "waiting for your approval", approved: "approved, starting the agent",
  agent_running: "the agent is working", verifying: "checking the work (tests)", uploading: "sending the results back", done: "finished" };
// Stuck detection (C18): a claimed or running task with no progress and no live update for this long reads "stuck?". Per space
// (admin stuck <space> <minutes>, meta stuck_min), else STUCK_MIN env, else 10. 0 turns it off. Raised once per quiet spell as a notify.
export const STUCK_STATES = ["claimed", "running"], STUCK_MIN_DEFAULT = 10;
export const RECOVERABLE = ["failed", "rejected", "cancelled"];
export const RELAY: Peer = { id: "relay", name: "relay", kind: "system" };
export const OWNER: Peer = { id: "owner", name: "owner", kind: "system" }; // the account owner acting from the /start Status card (signed-in session)
export const now = () => new Date().toISOString();
export const rid = (p: string) => p + "_" + [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, "0")).join("");

export const DENY_PATHS = [".env", ".env.*", "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/id_ed25519*", "**/.npmrc", "**/.netrc"];
// Token-shaped secrets (refused in writes) and the report redactor: one list for the server, its KB and the Mac (client/redact.ts).
// Task reports (progress, summary, artifacts) are redacted instead of refused, so a stray token never strands a task.
export { B, TOKEN_RES as SECRET_RES, redact } from "../../client/redact.ts";
// "claude-sonnet-4-5" matches an advertised "anthropic/claude-sonnet-4-5"; a ":high" thinking suffix is allowed (pi).
export const modelOk = (list: string[], m: string) => { const base = m.replace(/:[a-z]+$/, ""); return list.some(x => x === m || x === base || x.endsWith("/" + base)); };
export const KINDS = ["plan", "code", "review", "test", "quick"];
export const ASK_ARGS = new WeakSet<object>(); // task_create args built by the ask op: the only way to make a kind "ask" task (src/space/ask.ts)
// Task spec v2: a structured, checkable contract on task_create. Plain instructions keep working without it.
export const SPEC_FIELDS = ["goal", "acceptance", "scope", "forbidden", "budget", "mode"], MODES = ["plan", "execute"];
export function normSpec(s: any) {
  if (s == null) return null;
  if (typeof s !== "object" || Array.isArray(s)) throw new RelayError(400, "spec must be an object {goal, acceptance, scope, forbidden, budget, mode}");
  const extra = Object.keys(s).filter(k => !SPEC_FIELDS.includes(k)); if (extra.length) throw new RelayError(400, `spec: unknown field ${extra.join(", ")} (fields: ${SPEC_FIELDS.join(", ")})`);
  const strs = (k: string) => { const v = s[k] == null ? [] : typeof s[k] === "string" ? [s[k]] : s[k];
    if (!Array.isArray(v) || v.some((x: any) => typeof x !== "string" || !x.trim())) throw new RelayError(400, `spec.${k} must be a list of non-empty strings`);
    if (v.length > 50) throw new RelayError(400, `spec.${k}: at most 50 entries`); return v.map((x: string) => x.trim()); };
  if (s.goal != null && (typeof s.goal !== "string" || !s.goal.trim())) throw new RelayError(400, "spec.goal must be a non-empty string");
  const b = s.budget ?? {}; if (typeof b !== "object" || Array.isArray(b)) throw new RelayError(400, "spec.budget must be {minutes, max_files_changed}");
  const bx = Object.keys(b).filter(k => !["minutes", "max_files_changed"].includes(k)); if (bx.length) throw new RelayError(400, `spec.budget: unknown field ${bx.join(", ")}`);
  const pos = (k: string, max: number, int: boolean) => { const v = b[k]; if (v == null) return undefined;
    if (typeof v !== "number" || !(v > 0) || v > max || (int && !Number.isInteger(v))) throw new RelayError(400, `spec.budget.${k} must be a ${int ? "whole " : ""}number between 1 and ${max}`); return v; };
  const mode = s.mode ?? "execute"; if (!MODES.includes(mode)) throw new RelayError(400, `spec.mode must be ${MODES.join(" | ")}`);
  const budget = { minutes: pos("minutes", 1440, false), max_files_changed: pos("max_files_changed", 10000, true) };
  return { version: 2, goal: s.goal?.trim() ?? null, acceptance: strs("acceptance"), scope: strs("scope"), forbidden: strs("forbidden"), budget, mode };
}
export const CONTEXT_MAX = 64_000; // chars of context/<project>.md handed to a runner on claim (the runner caps what reaches the prompt)
// prefs.allow / prefs.deny: globs over "agent/model" ("codex", "codex/*", "claude/opus*"); a pattern without "/" covers every model of that agent.
export const pickRe = (g: string) => new RegExp("^" + g.split("*").map(x => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
export const pickMatch = (pat: string, agent: string, model: string | null) => { const i = pat.indexOf("/"); return i < 0 ? pickRe(pat).test(agent) : pickRe(pat.slice(0, i)).test(agent) && pickRe(pat.slice(i + 1)).test(model ?? "default"); };
export const pickAllowed = (pf: any, agent: string, model: string | null) => !(pf?.deny ?? []).some((p: string) => pickMatch(p, agent, model)) && (!(pf?.allow ?? []).length || pf.allow.some((p: string) => pickMatch(p, agent, model)));
// Changesets (`change` op): code an assistant wrote travels as a diff/file set that a runner commits on <peer>/<slug>.
// task_create reads the stored payload from here, keyed by the internal args object, so a public call can never smuggle one in.
export const CHANGE_ARGS = new WeakMap<object, { meta: any; file: string; content: string }>();
export const CHANGE_MAX = 1_000_000;
export const slugify = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").replace(/\.\.+/g, ".").slice(0, 48).replace(/[-.]+$/, "");
// Code belongs in git (change / a pushed branch), not in the space; writes of code-like files elsewhere get a warning.
export const CODE_EXT = /\.(m?[jt]sx?|cjs|py|go|rs|java|kt|kts|swift|rb|php|c|cc|cpp|h|hpp|cs|scala|sh|bash|zsh|lua|dart|vue|svelte|ex|exs|sql)$/i;
export const codeWarn = (path: string) => CODE_EXT.test(path) && !/^(kb|shared\/notes|repos|tasks)\//.test(path) ? "code_outside_change" : undefined;
export const looksText = (u: Uint8Array) => !u.subarray(0, 8192).includes(0);
export function guard(path: string, content?: string) {
  if (DENY_PATHS.some(g => globMatch(g, path))) throw new RelayError(422, `path ${path} is never shareable`);
  if (content && SECRET_RES.some(r => r.test(content))) throw new RelayError(422, `refused: ${path} looks like it contains a secret`);
  if (content && path.startsWith("kb/") && KB.secretIn(content)) throw new RelayError(422, `refused: ${path} looks like it contains a password or key`); // KB: assignments too
}
export const normPath = (p = "") => {
  const n = String(p).replace(/^\/+|\/+$/g, "");
  if (n.split("/").some(s => s === ".." || s === ".")) throw new RelayError(400, "bad path");
  return n;
};

export const VERB_PREFIX = /^(read|write|delete|dispatch):/;
// Plain-English sync warnings for code_status: what isn't committed, pushed or pulled.
export function codeNotes(v: any): string[] {
  const n: string[] = [], br = v.branch ?? "?";
  if (v.error) n.push(v.missing ? String(v.error) : `git status failed: ${v.error}`);
  if (v.fetch_error?.error) n.push(`git fetch failed (the remote may be unreachable): ${v.fetch_error.error}`);
  if (v.dirty > 0) n.push(`local has uncommitted work: ${v.dirty} file(s) on ${br}`);
  if (v.ahead > 0 && v.contained_in) n.push(/\/dev$/.test(v.contained_in) ? `${br} is on the dev channel: ${v.ahead} commit(s) from ${v.contained_in} that ${v.upstream} doesn't have yet (nothing unpushed)`
    : `${br} has ${v.ahead} commit(s) not on ${v.upstream}, all already on ${v.contained_in} (nothing unpushed)`);
  else if (v.ahead > 0) n.push(`${br} has ${v.ahead} local commit(s) not pushed to ${v.upstream}`);
  if (v.behind > 0) n.push(`${br} is ${v.behind} commit(s) behind ${v.upstream}: pull it${v.dirty ? " (commit or stash first)" : ""}`);
  if (v.upstream === null && v.branch && v.branch !== "HEAD") n.push(`${br} has no upstream`);
  for (const b of v.assistant_branches ?? []) {
    if (!b.local) n.push(`assistant branch ${b.name} not pulled locally (${b.ahead} commit(s) not in ${v.default_branch ?? "main"})`);
    else if (b.local_behind > 0) n.push(`local ${b.name} is ${b.local_behind} commit(s) behind origin`);
  }
  return n;
}


// apply [{old, new, all?}] in order; each old must match exactly once unless all:true
export function applyEdits(path: string, cur: string, edits: any[]): string {
  if (!Array.isArray(edits) || !edits.length || edits.length > 200) throw new RelayError(400, "edits: 1-200 entries");
  edits.forEach((e, i) => {
    if (typeof e?.old !== "string" || typeof e?.new !== "string" || !e.old) throw new RelayError(400, `edit ${i}: needs old and new strings`);
    const n = cur.split(e.old).length - 1;
    if (n === 0 || (n > 1 && !e.all)) throw new RelayError(409, `${path} edit ${i}: old text found ${n} times; must be exactly once (or set all:true)`);
    cur = e.all ? cur.split(e.old).join(e.new) : cur.replace(e.old, () => e.new);
  });
  return cur;
}

// minimal unified diff (LCS), one hunk per file; fine for agent-sized files
export function unified(path: string, a: string | null, b: string | null): string {
  const A = a === null ? [] : a.split("\n"), B = b === null ? [] : b.split("\n");
  const head = `diff --git a/${path} b/${path}\n${a === null ? "new file\n" : b === null ? "deleted file\n" : ""}--- ${a === null ? "/dev/null" : "a/" + path}\n+++ ${b === null ? "/dev/null" : "b/" + path}\n`;
  if (A.length * B.length > 4_000_000) return head + "@@ file too large for inline diff @@\n";
  const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const lines: string[] = []; let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { lines.push(" " + A[i]); i++; j++; }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { lines.push("+" + B[j]); j++; }
    else { lines.push("-" + A[i]); i++; }
  }
  return head + `@@ -1,${n} +1,${m} @@\n` + lines.join("\n") + "\n";
}
