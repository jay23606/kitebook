import { sessionRuleWords, type SessionRule } from "./session-policy.ts";
// What gets hashed and signed, shared by the runner (client/approval.ts, client/sign.ts, client/policy.ts), the server (src/policy.ts
// signs tasks for an app the owner let run on its own) and the owner's browser (the Permissions panel signs the policy over canon()).
// Pure, no imports beyond chain.ts: it's bundled into the Worker and fetched by installed runners. Change it in one place only.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { normStep } from "./chain.ts";

// stable JSON: sorted keys, so the same payload always hashes the same (the browser runs this exact function: start.ts embeds its source)
export function canon(v: any): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",")}}`;
}
// What the owner approves for a task run. Anything that changes what runs (or where, or with what access) is in here.
export function payloadOf(t: any, x: { agent?: string | null; model?: string | null; access?: string | null; gate?: string }): any {
  return { v: 2, gate: x.gate ?? "run", task: t.id, from: t.from ?? null, title: t.title ?? null, instructions: t.instructions ?? null, acceptance: t.acceptance ?? null,
    scope: t.scope ?? [], project: t.project ?? null, agent: x.agent ?? null, model: x.model ?? null, verify: t.verify ?? null, access: x.access ?? null,
    continue_from: t.continue_from ?? null, spec: t.spec ?? t.limits?.spec ?? null, ...(t.repo || t.base ? { repo: t.repo ?? null, base: t.base ?? null } : {}), ...(t.change ? { change: t.change } : {}), ...(t.session ? { session: t.session } : {}), // git-first / session fields only when set, so older payload hashes hold
    ...(t.kb_context?.length ? { kb_context: t.kb_context.map((x: any) => x.author ? [x.id, x.text, x.author] : [x.id, x.text]) } : {}) }; // the KB notes go into the prompt, so the approval covers them (author too: it sets the UNTRUSTED label)
}
// approval-v2's payload with gate "dispatch" (client/sign.ts explains the fields). kb = the signed [[id, hash(, author)], ...] list.
export const dispatchPayload = (t: any, kb?: any[]) => ({ ...payloadOf({ ...t, kb_context: null }, { agent: t.agent ?? null, model: t.model ?? null, access: null, gate: "dispatch" }),
  kind: t.kind ?? null, ...(t.chain?.steps ? { chain: { goal: t.chain.goal, steps: t.chain.steps.map(normStep), verify: t.chain.verify ?? null } } : {}), ...(kb ? { kb } : {}) });
export const dispatchMsg = (e: any) => `relay-dispatch:v1|${e.task}|${e.target}|${e.from}|${e.ts}|${e.nonce}|${e.hash}`;

// ---------- the owner's standing permissions (policy) ----------
// The Permissions panel on /start keeps one policy per workspace, signed in the owner's browser with a P-256 key that never leaves it
// (WebCrypto, not extractable). The runner pins the owner's key(s) in runner.json "ownerKeys" and acts only on a policy that key signed:
//   { v: 1, type: "relay-policy", space, seq, at, apps: { <app>: { tasks: "ask" | "auto" | "off", projects: [...], push: bool,
//     until: <ms epoch> | null, keys: ["ed25519:..."] } }, autorun?: { on: true, until, keys }, experimental?: { on: true, ci?, gh_status? } }
//   (autorun / experimental: see autorunOn and experimentalOn below; a legacy dev field is read as both)
// tasks "auto" = signed tasks from that app (with one of `keys`) run on their own in those projects until `until`; push = its task
// branches push without asking too. Everything else, an expired entry, another project, an unsigned or tampered policy: the owner is asked.
export const POLICY_TYPE = "relay-policy", POLICY_WINDOW_MS = 24 * 3600_000;
export const policyMsg = (p: any) => `relay-policy:v1|${canon(p)}`;
// ---------- Settings changes for the Mac (owner commands) ----------
// What the owner changes in Settings that lives on the Mac (which browsers it trusts, whether approvals also go to the phone, a release
// key), signed in the owner's browser with the same P-256 key as the policy, relayed as-is, and done by the runner only when a key it
// pinned signed it, for its workspace, within a day, once (client/settings-sync.ts):
//   { v: 1, type: "relay-owner-cmd", space, id, at, runner: <name> | null, do: "trust" | "untrust" | "approvals" | "release_key" | "update" | "auto_update" | "update_ref",
//     key?: "p256:...", phone?: bool, rotate?: bool, version?: <16 hex: the release the owner saw on Update now>, on?: bool, ref?: <branch> }
// update_ref (Settings -> Updates "Update to dev now", Experimental only): the Mac fast-forwards its git checkout to origin/<ref> with no terminal y.
//   ref is "dev" (where Hark's tested builds land; the button) or "main" (the stable branch people install; an older Settings page or Mac
//   still sends it). Nothing else: a signed click can't move a Mac onto an arbitrary branch.
// update_trust {on} (retired 2026-10-22 22:00 with "Install updates without asking me": apps' updates need no approval now): still accepted
//   from an older Settings page, and the Mac only answers that the switch is gone (client/settings-sync.ts).
// connect_agent {agent} (Settings -> Coding agents "Connect"): the Mac wires that coding agent to Kitebook like `kitebook connect <agent>`.
// default_agent {agent, project} (Settings -> Coding agents): which agent runs tasks in that project (runner.json prefs.byProject.<project>.agent),
// or on this Mac by default (project null -> prefs.defaultAgent); agent "" = back to the Mac's default.
export const UPDATE_REFS = ["dev", "main"];
export const CMD_TYPE = "relay-owner-cmd", CMD_WINDOW_MS = 24 * 3600_000, CMD_DO = ["trust", "untrust", "approvals", "release_key", "update", "auto_update", "update_ref", "connect_agent", "default_agent", "update_trust"];
export const cmdMsg = (c: any) => `relay-owner-cmd:v1|${canon(c)}`;
export function cmdShape(c: any): string | null {
  if (!c || c.v !== 1 || c.type !== CMD_TYPE || typeof c.space !== "string" || !/^[A-Za-z0-9_-]{8,40}$/.test(String(c.id ?? "")) || !Number.isFinite(c.at)) return "not a relay-owner-cmd v1";
  if (!CMD_DO.includes(c.do)) return "do: " + CMD_DO.join(" | ");
  if ((c.do === "trust" || c.do === "untrust") && !/^p256:[A-Za-z0-9_-]{80,200}$/.test(String(c.key ?? ""))) return "key: a browser's p256 key";
  if (c.do === "approvals" && typeof c.phone !== "boolean") return "phone: true | false";
  if (c.do === "update" && !/^[0-9a-f]{16}$/.test(String(c.version ?? ""))) return "version: the release shown on Update now";
  if ((c.do === "auto_update" || c.do === "update_trust") && typeof c.on !== "boolean") return "on: true | false";
  if (c.do === "update_ref" && !UPDATE_REFS.includes(String(c.ref ?? ""))) return "ref: " + UPDATE_REFS.join(" | ");
  if (c.do === "connect_agent" && !/^[a-z][a-z0-9-]{0,31}$/.test(String(c.agent ?? ""))) return "agent: a coding agent's name such as gemini";
  if (c.do === "default_agent" && (!/^([A-Za-z0-9][A-Za-z0-9_-]{0,39})?$/.test(String(c.agent ?? "-")) || (c.project != null && !/^[\w.-]{1,64}$/.test(String(c.project))))) return "agent: an agent name (or \"\" for the Mac's default); project: a project name or null";
  if (c.runner != null && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(c.runner))) return "runner: a runner name or null";
  return JSON.stringify(c).length > 2000 ? "too large" : null;
}
// Sessions are enabled by default; explicit off/read overrides remain authoritative.
export type PolicyEntry = { tasks: "ask" | "auto" | "off"; projects: string[]; push?: boolean; until?: number | null; keys?: string[]; sessions?: "off" | "read" | "write" | null; session_rule?: SessionRule };
export const SESSION_WORDS: Record<string, string> = { off: "can't see your agent sessions", read: "can search and read your agent sessions on your computers", write: "can search, read and continue your agent sessions (a copy; continuing one in place asks you)" };
export const sessionsOf = (e: any): "off" | "read" | "write" => e?.session_rule ? e.session_rule.access === "read" ? "read" : "write" : e?.sessions == null ? "write" : ["off", "read", "write"].includes(e.sessions) ? e.sessions : "off";
// Changing task/folder permissions must preserve an explicit session choice, including Off.
export const keepSessions = (prev: any, next: any) => (prev?.session_rule || ["off", "read", "write"].includes(prev?.sessions)) && !(next && Object.prototype.hasOwnProperty.call(next, "sessions"))
  ? { ...(next ?? { tasks: "ask", projects: [] }), sessions: prev.sessions, ...(prev.session_rule ? { session_rule: prev.session_rule } : {}) } : next;
// the entry that lets `from` run in `project` on its own now, or why not (plain words: it goes into the review page's "why you're asked")
export function autoEntry(p: any, from: string, project: string | null | undefined, now = Date.now()): { entry: PolicyEntry } | { why: string } {
  const e: PolicyEntry | undefined = p?.apps?.[from];
  if (!e || e.tasks !== "auto") return { why: `you haven't let ${from} run tasks on its own` };
  if (e.until != null && !(Number(e.until) > now)) return { why: `your permission for ${from} to run on its own ended ${new Date(Number(e.until)).toISOString().slice(0, 10)}` };
  if (!project || !(e.projects ?? []).includes(project)) return { why: `${from} may run on its own only in ${(e.projects ?? []).join(", ") || "no project"}, not in ${project ?? "a machine task"}` };
  if (!(e.keys ?? []).length) return { why: `no signing key is set for ${from}` };
  return { entry: e };
}
// ---------- Run tasks without asking (Settings top row, "autorun"): one owner-signed switch instead of per-app, per-project rules ----------
// policy.autorun = { on: true, until: <ms epoch> | null, keys: ["ed25519:..."] } (absent = off). While it's on and not past `until`, a task
// from one of the owner's OWN connected apps (an assistant or coding agent of this account, still connected: not removed, its access not
// ended; never a person or another runner; the server checks, and the runner asks it again per task) runs without asking when it carries a valid signature from one of `keys` (the relay-held autorun key, src/policy.ts).
// An app's own per-project entry still wins where it applies (it may allow pushing); "off" (can't send tasks) is never overridden.
// It never widens what an app may read or write (that stays its folders), and the guard / deploy-spend-send gate are unchanged.
// Once "dev mode" (policy.dev): a policy signed before the rename reads as autorun AND experimental on; new writes use the new names.
export type Autorun = { on: boolean; until?: number | null; keys?: string[] };
const arOf = (p: any) => p?.autorun ?? p?.dev; // dev: the legacy name, read-only
export function autorunOn(p: any, now = Date.now()): { until: number | null; keys: string[] } | null {
  const d = arOf(p); if (!d || d.on !== true) return null;
  if (d.until != null && !(Number(d.until) > now)) return null;
  const keys = Array.isArray(d.keys) ? d.keys.map(String).filter((k: string) => /^ed25519:[A-Za-z0-9_-]{43}$/.test(k)) : [];
  return keys.length ? { until: d.until == null ? null : Number(d.until), keys } : null;
}
export const autorunEnded = (p: any, now = Date.now()) => { const d = arOf(p); return d?.on === true && d.until != null && !(Number(d.until) > now); };
// ---------- Experimental (Settings -> More): not-yet-stable features only, never a permission ----------
// policy.experimental = { on: true, ci?: bool (Test every push, default on), gh_status?: bool (GitHub commit status, default off) }
export type Experimental = { on: boolean; ci?: boolean; gh_status?: boolean };
export function experimentalOn(p: any, now = Date.now()): { ci: boolean; gh_status: boolean } | null {
  const x = p?.experimental;
  if (x && typeof x === "object") return x.on === true ? { ci: x.ci !== false, gh_status: x.gh_status === true } : null;
  return p?.dev && autorunOn({ autorun: p.dev }, now) ? { ci: true, gh_status: false } : null; // migrated from dev mode
}
// read old, write new: legacy dev -> autorun + experimental
export function migratePolicy<T extends Record<string, any>>(p: T, now = Date.now()): T {
  if (!p || !("dev" in p)) return p; const { dev, ...rest } = p as any;
  return { ...rest, ...(rest.autorun || !dev ? {} : { autorun: dev }), ...(rest.experimental || !experimentalOn(p, now) ? {} : { experimental: { on: true } }) };
}
// What lets `from` run in `project` without asking now: its own entry (autoEntry) or autorun; autorun = it came from the switch.
export function standingEntry(p: any, from: string, project: string | null | undefined, now = Date.now()): { entry: PolicyEntry; autorun?: true } | { why: string } {
  const a = autoEntry(p, from, project, now); if ("entry" in a) return a;
  if (p?.apps?.[from]?.tasks === "off") return a;
  const d = autorunOn(p, now);
  if (d) return { entry: { tasks: "auto", projects: project ? [project] : [], push: true, until: d.until, keys: d.keys }, autorun: true };
  return autorunEnded(p, now) ? { why: `"Run tasks without asking" ended ${new Date(Number(arOf(p).until)).toISOString().slice(0, 16).replace("T", " ")} UTC` } : a;
}
// Autorun pushes only the task's own branch by itself. The default branch (or a force push) is never pushed without asking: the runner
// itself never pushes it (runner.ts pushBranch) and the guard blocks the agent from doing it, so this is the last line, kept explicit.
export function autorunPushOk(branch: string | null | undefined, defaultBranch: string | null | undefined, force = false): boolean {
  const b = String(branch ?? ""); if (!b || force) return false;
  return !/^(main|master|HEAD)$/.test(b) && b !== String(defaultBranch ?? "") && !b.startsWith("refs/heads/main") && !b.startsWith("+");
}
export function describeAutorun(d: Autorun | null | undefined): string {
  if (!d || !d.on) return "Run tasks without asking: off, tasks ask you again";
  return `Run tasks without asking: on, your own apps' tasks start without asking${d.until ? ` until ${new Date(Number(d.until)).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC` : ""}`;
}
export function describeExperimental(x: Experimental | null | undefined): string {
  if (!x || !x.on) return "Experimental: off";
  return `Experimental: on (Test every push ${x.ci === false ? "off" : "on"}${x.gh_status ? ", results on GitHub" : ""})`;
}
const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
// One line per change, the way the panel and its audit list say it ("Hark can now run tasks in kitebook on its own until Oct 25").
export function describeEntry(app: string, e: PolicyEntry | null | undefined): string {
  const s = e?.sessions == null && !e?.session_rule || sessionsOf(e) === "off" ? "" : `; it ${e?.session_rule ? sessionRuleWords(e.session_rule) : SESSION_WORDS[sessionsOf(e)]}`;
  if (!e || e.tasks === "ask") return `${app} asks you before every task${s}`;
  if (e.tasks === "off") return `${app} can't send tasks or push${s}`;
  return `${app} can now run tasks in ${(e.projects ?? []).join(", ") || "no project"} on its own${e.until ? ` until ${day(Number(e.until))}` : ""}${e.push ? ", and push its branches" : ""}${s}`;
}
const ACCESS_WORDS: Record<string, string> = { read: "read every folder and change nothing", full: "read, edit and delete everything", shared: "read every folder and save to shared memory (shared/ and kb/)" }; // the consent page's words
export function describeAccess(a: { mode: string; folders?: string[] } | null | undefined): string {
  if (!a) return ""; if (a.mode === "folders") return `read and edit only ${(a.folders ?? []).join(", ")}`;
  return ACCESS_WORDS[a.mode] ?? a.mode;
}
// access.send: whether the change gave (true) or took away (false) sending tasks; said when the policy entry itself didn't change (newuser #17:
// "Its folder + send tasks" logged only "can read and edit only kb/claude-code")
export function summarize(app: string, prev: PolicyEntry | null | undefined, next: PolicyEntry | null | undefined, access?: { mode: string; folders?: string[]; send?: boolean } | null): string {
  const parts: string[] = [], bare = (e: any) => { if (!e) return null; const { sessions: _s, session_rule: _r, ...r } = e; return r.tasks === "ask" && !(r.projects ?? []).length && Object.keys(r).every(k => ["tasks", "projects"].includes(k)) ? null : r; };
  if (canon(bare(prev)) === canon(bare(next)) && (sessionsOf(prev) !== sessionsOf(next) || canon(prev?.session_rule ?? null) !== canon(next?.session_rule ?? null))) parts.push(`${app} ${next?.session_rule && sessionsOf(next) !== "off" ? sessionRuleWords(next.session_rule) : SESSION_WORDS[sessionsOf(next)]}`); // only the Agent sessions switch moved
  else if (canon(prev ?? null) !== canon(next ?? null)) parts.push(describeEntry(app, next));
  if (access) parts.push(`${parts.length ? "it" : app} can ${describeAccess(access)}${parts.length || access.send === undefined ? "" : access.send ? " and send tasks to your Mac (you approve each one)" : "; it can't send tasks"}`);
  return parts.join("; ") || `${app}: nothing changed`;
}
