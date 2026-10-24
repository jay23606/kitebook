// MCP polish for connector UIs (Claude.ai, ChatGPT): tool titles/annotations/outputSchemas, resources, prompts.
// Everything here goes through the same `call(op, args)` as tools, so resources and prompts get exactly the caller's
// token scope (spaces, verbs, path globs); nothing reads the Space object directly. Spec: MCP 2025-06-18.
import { OPS, jsonSchema, sha256, type Res } from "./ops.ts";

type Call = (op: string, args: any) => Promise<Res>;
const any = {}, str = { type: "string" }, num = { type: "number" }, bool = { type: "boolean" }, arr = { type: "array" }, obj = { type: "object" };
const o = (properties: Record<string, any>, required: string[] = []) => ({ type: "object", properties, required });

// ---------- tools ----------
// Hints per 2025-06-18: readOnly (no side effects); destructive (may overwrite/delete, vs additive only); idempotent
// (repeating with the same args has no further effect); openWorld (reaches beyond the space: wakes another agent).
// outputSchema only where the result shape is stable; types are left open ({}) where a field can be null or vary,
// because clients validate structuredContent against it and a too-tight schema turns a good result into an error.
type TM = { title: string; ro?: 1; destr?: 1; idem?: 1; open?: 1; out?: any };
const task = o({ id: str, title: str, state: str, from: str, target: str }, ["id", "state"]);
const TOOLS: Record<string, TM> = {
  sync: { title: "Recover shared workspace", ro: 1 },
  sync_read: { title: "Read workspace snapshot file", ro: 1 },
  sync_ack: { title: "Acknowledge a local workspace copy", idem: 1 },
  sync_status: { title: "Workspace publication and copies", ro: 1 },
  sync_publish: { title: "Publish artifacts and handoff", destr: 1, idem: 1 },
  revoke_self: { title: "Revoke my own access", destr: 1, idem: 1, out: o({ revoked: str, revoked_grant: str, peer: str }) },
  whoami: { title: "Who am I", ro: 1, out: o({ id: str, name: str, kind: str, account: str, spaces: arr, can: str }, ["name", "spaces"]) },
  ls: { title: "List directory", ro: 1, out: o({ path: str, entries: arr }, ["entries"]) },
  stat: { title: "File info", ro: 1, out: o({ path: str, sha: str, size: num, binary: bool, storage: any, last: obj }, ["path", "sha"]) },
  read: { title: "Read file", ro: 1, out: o({ path: str, sha: str, content: str, content_base64: str, binary: bool, unchanged: bool, size: num, total_lines: num, partial: bool }, ["path", "sha"]) },
  glob: { title: "Find files", ro: 1, out: o({ files: { type: "array", items: str }, truncated: bool }, ["files"]) },
  grep: { title: "Search file contents", ro: 1, out: o({ matches: arr, truncated: bool }, ["matches"]) },
  write: { title: "Write file", destr: 1, idem: 1, out: o({ path: str, sha: str, commit: str, warning: str, hint: str }, ["path", "commit"]) },
  batch: { title: "Commit many changes", destr: 1, out: o({ commit: any, shas: obj, skipped: arr }, ["shas"]) },
  has: { title: "Which blobs are missing", ro: 1, out: o({ missing: { type: "array", items: str } }, ["missing"]) },
  patch: { title: "Edit file", destr: 1, out: o({ path: str, sha: str, commit: str }, ["path", "commit"]) },
  mv: { title: "Move file", destr: 1, out: o({ from: str, to: str, commit: str }, ["commit"]) },
  rm: { title: "Delete file", destr: 1, idem: 1, out: o({ path: str, commit: str }, ["commit"]) },
  log: { title: "History", ro: 1, out: o({ commits: arr }, ["commits"]) },
  diff: { title: "Diff commits", ro: 1, out: o({ diff: str }, ["diff"]) },
  changes: { title: "Changes since cursor", ro: 1, out: o({ events: arr, cursor: num }, ["events", "cursor"]) },
  check: { title: "Check inbox and updates", ro: 1, out: o({ cursor: num, inbox: arr, updates: arr, needs_answer: arr, files_changed: arr, more: bool, sent_active: num, next_poll_after: num }, ["cursor", "inbox", "updates"]) },
  webhook_secret: { title: "Webhook signing secret", ro: 1, out: o({ secret: str, header: str }, ["secret"]) },
  peers: { title: "Peers and runners", ro: 1, out: o({ peers: arr, paused: obj }, ["peers"]) },
  task_create: { title: "Dispatch a task", open: 1,
    out: o({ id: str, state: str, target: str, duplicate: bool, needs_approval: any, approval: str, target_online: bool, target_last_seen: any, target_wake: any, delivery: str, mode: str, brief: obj }, ["id", "state"]) },
  ask: { title: "Quick ask (read-only answer from the Mac)", open: 1, out: o({ id: str, state: str, done: bool, answer: any, partial: any, error: any, needs_task: any, session: any, next: obj }, ["id", "state", "done"]) },
  ask_get: { title: "Quick ask: answer so far", ro: 1, out: o({ id: str, state: str, done: bool, answer: any, partial: any, error: any, needs_task: any, session: any, next: obj }, ["id", "state", "done"]) },
  ask_to_task: { title: "Run a quick ask as a task", open: 1, out: o({ id: str, state: str, target: str, from_ask: str, needs_approval: any }, ["id", "state"]) },
  task_promote: { title: "Run an approved plan", open: 1, out: o({ id: str, state: str, mode: str, target: str, plan: str, target_online: bool }, ["id", "state"]) },
  brief: { title: "The owner's instructions for assistants", ro: 1, out: o({ space: str, text: str, etag: str, chars: num, sections: arr, updated: any, unchanged: bool, note: str }, ["etag"]) },
  brief_propose: { title: "Suggest new instructions to the owner", idem: 1, out: o({ id: str, state: str, replaced: arr, warning: str, note: str }, ["id", "state"]) },
  describe: { title: "Runner capabilities", ro: 1, out: o({ space: str, generated: str, runners: arr, peers: arr, task_spec: obj, paused: obj }, ["runners", "peers", "task_spec"]) },
  inbox: { title: "Wake-up digest", ro: 1, out: o({ cursor: num, since: num, acked: num, more: bool, watch: arr, tasks: arr, finished: arr, needs_you: arr, messages: arr, files: arr, sent_active: num, next_poll_after: num }, ["cursor", "tasks"]) },
  ack: { title: "Acknowledge inbox", idem: 1, out: o({ cursor: num, watch: arr }, ["cursor"]) },
  notify: { title: "Notify a peer", open: 1, out: o({ ok: bool, seq: num, to: str, target_online: bool, target_wake: any }, ["ok"]) },
  task_list: { title: "List tasks", ro: 1, out: o({ tasks: arr }, ["tasks"]) },
  task_get: { title: "Get task", ro: 1, out: task },
  task_status: { title: "Live status of running tasks", ro: 1, out: o({ id: str, title: str, state: str, target: str, live: obj, tasks: arr }) },
  change: { title: "Submit a changeset (code -> branch)", open: 1, out: o({ id: str, state: str, target: str, branch: str, files: num }, ["id", "branch"]) },
  code_status: { title: "Git sync status of local checkouts", ro: 1, out: o({ runners: arr, notes: { type: "array", items: str } }, ["runners", "notes"]) },
  code_report: { title: "Report git state (runner)", idem: 1, out: o({ ok: bool }, ["ok"]) },
  task_live: { title: "Report live status (runner)", idem: 1, out: o({ ok: bool, phase: str }, ["ok"]) },
  task_cancel: { title: "Cancel task", destr: 1, out: o({ id: str, state: str, reason: any, cancelled_by: str }, ["id", "state"]) },
  cancel_all: { title: "Cancel all open tasks", destr: 1, idem: 1, out: o({ cancelled: { type: "array", items: str }, count: num }, ["cancelled", "count"]) },
  task_message: { title: "Message on task thread", open: 1, out: o({ ok: bool }) },
  task_claim: { title: "Claim task (target)", out: task },
  task_approval: { title: "Record approval (runner)", out: o({ id: str, state: str }, ["id", "state"]) },
  task_release: { title: "Release task back to queued (runner)", idem: 1, out: o({ id: str, state: str }, ["id", "state"]) },
  approval_page: { title: "Open approval page (runner)", out: o({ id: str, path: str, expires_at: num }, ["id"]) },
  policy: { title: "Read the owner's permissions (runner)", ro: 1, out: o({ envelope: any, owner_keys: arr, cmds: arr }, ["owner_keys"]) },
  settings_report: { title: "Report Settings changes done (runner)", idem: 1, out: o({ ok: bool }, ["ok"]) },
  experimental: { title: "Is Experimental on? (owner-only switch)", ro: 1, out: o({ on: bool, ci: bool, gh_status: bool, autorun: obj, note: str }, ["on"]) },
  dev_mode: { title: "Is Experimental on? (old name)", ro: 1 },
  ci_run: { title: "Run a project's tests on the Mac (Experimental)", out: o({ id: str, queued: bool, project: str, branch: any, note: str }, ["id"]) },
  ci_status: { title: "Latest test runs on the Mac (Experimental)", ro: 1, out: o({ experimental: bool, test_every_push: bool, runs: arr, waiting: arr, note: str }, ["runs"]) },
  ci_report: { title: "Report test runs (runner)", idem: 1 },
  relay_update: { title: "Update Kitebook on the owner's Mac", idem: 1, open: 1, out: o({ id: str, ok: bool, state: str, from: any, to: any, sha: any, health: any, code: any, expires: any, why: any, runners: arr, note: str }, ["ok", "runners"]) },
  relay_logs: { title: "Recent logs and errors (Experimental)", ro: 1, out: o({ experimental: bool, dev: bool, entries: arr, counts: obj, order: str, note: str }, ["entries"]) },
  logs_report: { title: "Send recent logs (runner)", idem: 1, out: o({ stored: num, experimental: bool, dev: bool }, ["stored"]) },
  approval_wait: { title: "Wait for approval (runner)", idem: 1, out: o({ id: str, state: str, response: any }, ["id", "state"]) },
  task_progress: { title: "Post progress (target)", out: o({ ok: bool }) },
  task_steer: { title: "Steer a running task", open: 1, out: o({ id: str, n: num, state: str, by: str, target_online: bool, delivery: str }, ["id", "n"]) },
  task_steer_take: { title: "Take steering notes (runner)", out: o({ id: str, steers: arr }, ["id", "steers"]) },
  presence: { title: "Who's working", ro: 1, out: o({ sessions: arr, summary: str, at: str }, ["sessions", "summary"]) },
  presence_report: { title: "Report what I'm working on (heartbeat)", idem: 1, out: o({ ok: bool, sessions: num, every: num, offline_after_s: num }, ["ok"]) },
  task_answer: { title: "Answer a task's question", open: 1, out: o({ id: str, state: str, question: any, answer: str, target_online: bool, delivery: str }, ["id", "state"]) },
  task_complete: { title: "Complete task (target)", out: o({ id: str, state: str, attempt: num, files: arr, learnings: obj, chain_next: any }, ["id", "state"]) },
  kb_add: { title: "Add to knowledge base", idem: 1, out: o({ entries: arr, rejected: arr, commit: any, kb_version: num }, ["entries", "kb_version"]) },
  kb_search: { title: "Search knowledge base", ro: 1, out: o({ query: str, results: arr, semantic: bool, embed_model: str, semantic_note: str, kb_version: num }, ["results", "semantic", "kb_version"]) },
  kb_get: { title: "Knowledge-base entry", ro: 1, out: o({ id: str, scope: str, kind: str, key: any, title: any, text: str, origin: any, source: str, updated: str, version: num, superseded_by: any, path: str, sha: any, kb_version: num }, ["id", "text"]) },
  kb_list: { title: "List knowledge base", ro: 1, out: o({ entries: arr, removed: arr, more: bool, cursor: num, kb_version: num }, ["entries", "cursor", "kb_version"]) },
  agent_models: { title: "Discover agent models", ro: 1 }, mcp_status: { title: "Check MCP updates", ro: 1 }, session_status: { title: "Agent conversation status", ro: 1 },
  sessions_search: { title: "Search my agent sessions", ro: 1 }, session_get: { title: "Read an agent session", ro: 1 },
  session_create: { title: "Start an agent session", open: 1 }, session_send: { title: "Send to an agent session", open: 1 },
  status: { title: "Is Kitebook working? (runner health)", ro: 1, out: o({ ok: bool, verdict: str, next: any, checked_at: str, server: obj, runners: arr, pending_updates: arr, note: str }, ["ok", "verdict", "runners"]) },
  health_report: { title: "Report runner health (runner only)", idem: 1 },
  kb_forget: { title: "Forget knowledge-base entries", destr: 1, idem: 1, out: o({ forgotten: arr, missing: arr, commit: any, kb_version: num }, ["forgotten"]) },
};
// Who sees which tools in tools/list (fix-agents). Every tool stays callable by name for whoever its op allows; the list only decides what a
// client is shown, because a connector UI (Claude.ai) sends every listed schema with every conversation and asks before each write tool.
//   runner        all of them (it is the owner's Mac)
//   assistants    the ~30 that dispatch, ask, steer, answer, follow up, read/write files, use the KB and ask the Mac to update (relay_update:
//                 an assistant that may send tasks moves a git install to its channel's newest commit right away, no owner approval; the owner's kill switch is Settings -> Updates)
//   coding agents the same plus presence_report (kitebook connect wires them; client/agents-connect.ts)
//   any target    task_claim / task_progress / task_complete while a task is addressed to it
//   Experimental  relay_logs (recent logs/errors), ci_run, ci_status (local CI); off they answer needs_owner / nothing, so they aren't listed
// brief_propose is listed so a connector UI can suggest a brief change; the brief itself arrives in initialize and describe, so the brief
// tool stays unlisted (callable by name) to keep the list short.
export const ASSISTANT_TOOLS = ["agent_models", "mcp_status", "brief_propose", "describe", "presence", "peers", "whoami", "task_create", "ask", "ask_get", "ask_to_task", "task_promote", "task_get", "task_list", "task_status", "sync", "sync_read", "sync_ack", "sync_status", "sync_publish",
  "task_steer", "task_answer", "task_cancel", "task_message", "inbox", "ack", "notify", "change", "code_status", "ls", "read", "grep", "glob", "write", "patch", "kb_search", "kb_add", "kb_get", "relay_update", "status"];
export const SESSION_TOOLS = { read: ["sessions_search", "session_get", "session_status"], write: ["sessions_search", "session_get", "session_status", "session_create", "session_send"] } as Record<string, string[]>; // listed once the owner allowed Agent sessions
export const AGENT_TOOLS = ["presence_report"], TARGET_TOOLS = ["task_claim", "task_progress", "task_complete"], EXPERIMENTAL_TOOLS = ["relay_logs", "ci_run", "ci_status"]; // listed while Experimental is on (describe.experimental), when they answer
export function toolsFor(kind: string, o: { target?: boolean; experimental?: boolean; sessions?: string } = {}) {
  const all = toolsList(); if (kind === "runner") return all.filter(t => !SESSION_TOOLS.write.includes(t.name)); // a Mac doesn't read its own owner's sessions through Kitebook
  const keep = new Set([...ASSISTANT_TOOLS, ...(kind === "coding_agent" ? AGENT_TOOLS : []), ...(o.target ? TARGET_TOOLS : []), ...(o.experimental ? EXPERIMENTAL_TOOLS : []), ...(SESSION_TOOLS[o.sessions ?? ""] ?? [])]);
  return all.filter(t => keep.has(t.name));
}
export function toolsList() {
  return Object.entries(OPS).map(([name, d]) => {
    const m = TOOLS[name] ?? { title: name };
    return { name, title: m.title, description: d.desc, inputSchema: jsonSchema(d), ...(m.out ? { outputSchema: m.out } : {}),
      annotations: { title: m.title, readOnlyHint: !!m.ro, destructiveHint: !!m.destr, idempotentHint: !!(m.ro || m.idem), openWorldHint: !!m.open } };
  });
}

// ---------- resources ----------
// kitebook://tasks (recent list), kitebook://task/<id> (summary/state/result), kitebook://file/<path> (a file; trailing / = a directory).
// ?space=<id> picks the space when a token has several. Kitebook's /mcp is stateless JSON (no server->client channel), so
// resources/subscribe isn't offered; each resource names the MCP Events subscription that watches it in _meta instead.
export const RES_ERR = { NotFound: -32002, Invalid: -32602 };
const EV_META = "relay/subscribeWith";
const MIME: Record<string, string> = { md: "text/markdown", txt: "text/plain", json: "application/json", ts: "text/x-typescript", js: "text/javascript", mjs: "text/javascript",
  py: "text/x-python", sh: "text/x-shellscript", html: "text/html", css: "text/css", yml: "text/yaml", yaml: "text/yaml", toml: "text/plain", patch: "text/x-diff", diff: "text/x-diff",
  log: "text/plain", csv: "text/csv", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf" };
const mimeOf = (p: string) => MIME[p.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const q = (space: string, multi: boolean) => multi ? `?space=${encodeURIComponent(space)}` : "";
export const TEMPLATES = [
  { uriTemplate: "kitebook://task/{id}", name: "task", title: "Task", mimeType: "application/json",
    description: "One task: state, who sent it, the result summary, structured result (tests, branch, PR) and links to its artifacts. Add ?space= if your token has several spaces." },
  { uriTemplate: "kitebook://file/{+path}", name: "file", title: "Shared file",
    description: "A file in the shared space (end with / for a directory listing). Add ?space= if your token has several spaces." },
  { uriTemplate: "kitebook://kb{?q,scope}", name: "kb-search", title: "Knowledge base search", mimeType: "application/json",
    description: "Search the shared knowledge base (what assistants and coding agents know: facts, decisions, gotchas, learnings, synced memory). Without q: the most recent entries." },
  { uriTemplate: "kitebook://kb/{+id}", name: "kb-entry", title: "Knowledge-base entry", mimeType: "application/json", description: "One knowledge-base entry in full (id from kb_search)." },
];

async function spacesOf(call: Call): Promise<string[]> { const r = await call("whoami", {}); return r.ok ? r.result.spaces.map((c: any) => c.space) : []; }
const PAGE = 100;
export async function resourcesList(call: Call, cursor?: string) {
  const spaces = await spacesOf(call), multi = spaces.length > 1, all: any[] = [];
  for (const s of spaces) {
    const sp = q(s, multi), tl = await call("task_list", { space: s, role: "all" });
    all.push({ uri: `kitebook://tasks${sp}`, name: multi ? `tasks (${s})` : "tasks", title: multi ? `Recent tasks in ${s}` : "Recent tasks", mimeType: "application/json",
      description: "Tasks you sent or received, newest first, with state", _meta: { [EV_META]: { name: "task.updated", arguments: { space: s } } } });
    if (tl.ok) for (const t of tl.result.tasks.slice(0, 20)) all.push({ uri: `kitebook://task/${t.id}${sp}`, name: t.id, title: t.title, mimeType: "application/json",
      description: `${t.state}: ${t.from} -> ${t.target}`, _meta: { [EV_META]: { name: "task.updated", arguments: { space: s, task_id: t.id } } } });
    all.push({ uri: `kitebook://kb${sp}`, name: multi ? `kb (${s})` : "kb", title: multi ? `Knowledge base in ${s}` : "Knowledge base", mimeType: "application/json",
      description: "Shared knowledge base: recent entries. Search with kitebook://kb?q=<words> or the kb_search tool", _meta: { [EV_META]: { name: "file.changed", arguments: { space: s, path_glob: "kb/**" } } } });
    const g = await call("glob", { space: s, pattern: "**" });
    if (g.ok) for (const f of g.result.files) all.push({ uri: `kitebook://file/${enc(f)}${sp}`, name: f, mimeType: mimeOf(f),
      _meta: { [EV_META]: { name: "file.changed", arguments: { space: s, path_glob: f } } } });
  }
  const at = Math.max(0, Number(cursor ?? 0) || 0), page = all.slice(at, at + PAGE);
  return { resources: page, ...(at + PAGE < all.length ? { nextCursor: String(at + PAGE) } : {}) };
}

type RErr = { code: number; message: string; data?: any };
export async function resourceRead(call: Call, uri: string): Promise<{ result: any } | { error: RErr }> {
  const m = String(uri ?? "").match(/^(?:kitebook|relay):\/\/(tasks|task|file|kb)(?:\/([^?#]*))?(?:\?([^#]*))?$/);
  if (!m) return { error: { code: RES_ERR.Invalid, message: "unknown resource uri (kitebook://tasks, kitebook://task/<id>, kitebook://file/<path>, kitebook://kb?q=, kitebook://kb/<id>)", data: { uri } } };
  const qs = new URLSearchParams(m[3] ?? ""), space = qs.get("space") ?? undefined, rest = m[2] ?? "";
  let path: string; try { path = decodeURIComponent(rest); } catch { return { error: { code: RES_ERR.Invalid, message: "bad percent-encoding", data: { uri } } }; }
  const fail = (r: any): { error: RErr } => ({ error: { code: r.status === 404 ? RES_ERR.NotFound : r.status === 400 ? RES_ERR.Invalid : -32603, message: r.status === 404 ? "Resource not found" : r.error, data: { uri, reason: r.error } } });
  const js = (v: any) => ({ result: { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(v, null, 1) }] } });
  if (m[1] === "kb") {
    if (path) { const r = await call("kb_get", { space, id: path }); return r.ok ? js(r.result) : fail(r); }
    const r = qs.get("q") ? await call("kb_search", { space, query: qs.get("q"), scope: qs.get("scope") ?? undefined, k: 20 })
      : await call("kb_list", { space, scope: qs.get("scope") ?? undefined, limit: 1000 });
    if (!r.ok) return fail(r);
    return js(qs.get("q") ? r.result : { ...r.result, entries: r.result.entries.slice(-50).reverse() });
  }
  if (m[1] === "tasks") {
    const r = await call("task_list", { space, role: "all" }); if (!r.ok) return fail(r);
    return js({ tasks: r.result.tasks.map((t: any) => ({ uri: `kitebook://task/${t.id}${space ? q(space, true) : ""}`, ...t })) });
  }
  if (m[1] === "task") {
    const r = await call("task_get", { space, id: path }); if (!r.ok) return fail(r);
    const t = r.result, res = t.result ?? {};
    return js({ ...(t.headline ? { result_headline: t.headline } : {}), id: t.id, title: t.title, state: t.state, from: t.from, target: t.target, project: t.project, kind: t.kind, agent: t.agent, model: t.model,
      created: t.created, updated: t.updated, note: t.note, attempt: t.attempt, max_retries: t.max_retries, continue_from: t.continue_from,
      headline: res.structured?.headline ?? null, summary: res.summary ?? null, result: res.structured ?? null,
      artifacts: (res.files ?? []).map((f: string) => `kitebook://file/${enc(f)}${space ? q(space, true) : ""}`), instructions: t.instructions });
  }
  if (!path || path.endsWith("/")) { const r = await call("ls", { space, path: path.replace(/\/$/, "") }); return r.ok ? js(r.result) : fail(r); }
  const r = await call("read", { space, path }); if (!r.ok) return fail(r);
  const f = r.result, mimeType = mimeOf(path);
  return { result: { contents: [f.binary ? { uri, mimeType, blob: f.content_base64 } : { uri, mimeType: mimeType.startsWith("application/octet") ? "text/plain" : mimeType, text: f.content }], _meta: { sha: f.sha } } };
}

// ---------- prompts ----------
// Each prompt returns ONE user message carrying a ready task_create call: target and project are filled from the space
// when there is only one sensible choice (one runner; one project on it), otherwise left as <placeholders> with the
// choices listed. idempotency_key is derived from the arguments, so a client that retries the call can't double-dispatch.
type PArg = { name: string; description: string; required?: boolean };
const A = { target: { name: "target", description: "runner to send it to (default: the only runner, if there's one)" },
  project: { name: "project", description: "project allowlisted on that runner (default: its only project, if there's one)" },
  agent: { name: "agent", description: "coding agent (pi, codex, claude...); default: the project's agent" } };
export const PROMPTS: { name: string; title: string; description: string; arguments: PArg[] }[] = [
  { name: "delegate-coding-task", title: "Delegate a coding task", description: "Hand a coding task to your local coding agent through a runner; returns a ready task_create call.",
    arguments: [{ name: "task", description: "what to build or change", required: true }, A.target, A.project, { name: "acceptance", description: "how to tell it's done" },
      { name: "verify", description: "command that must pass (runner must allowlist it)" }, A.agent,
      { name: "repo", description: "git remote URL (or project name) of the code to change" }, { name: "base", description: "branch/commit to start from (default: the checkout's HEAD)" }] },
  { name: "review-branch", title: "Review a branch", description: "Ask a local agent to review a git branch against its base without changing it; returns a ready task_create call.",
    arguments: [{ name: "branch", description: "branch to review", required: true }, { name: "base", description: "base branch (default main)" },
      { name: "focus", description: "what to look at hardest (security, tests, perf...)" }, A.target, A.project, A.agent] },
  { name: "fix-failing-tests", title: "Fix failing tests", description: "Ask a local agent to make the test suite pass without weakening it; returns a ready task_create call.",
    arguments: [{ name: "test_command", description: "test command (also the verify step; runner must allowlist it)" },
      { name: "failure", description: "failing output or test names, if you have them" }, A.target, A.project, A.agent] },
  { name: "check-on-my-agents", title: "Check on my agents", description: "Status of your runners and the tasks you sent (live snapshot, stuck tasks first), with ready task_create follow-ups for anything that failed or is waiting on you.",
    arguments: [{ name: "space", description: "space id (if your token has several)" }] },
];

async function pickTarget(call: Call, space: string | undefined, want?: string) {
  const r = await call("peers", { space }); const runners = r.ok ? r.result.peers.filter((p: any) => p.kind === "runner") : [];
  if (want) return { target: want, runners };
  const online = runners.filter((p: any) => p.online), one = runners.length === 1 ? runners[0] : online.length === 1 ? online[0] : null;
  return { target: one?.name as string | undefined, runners };
}
async function projectsOf(call: Call, space: string | undefined, target?: string): Promise<string[]> {
  if (!target) return [];
  const r = await call("read", { space, path: `shared/runners/${target}.json` });
  try { return r.ok ? Object.keys(JSON.parse(r.result.content).projects ?? {}) : []; } catch { return []; }
}
const firstLine = (s: string, n = 80) => { const l = s.trim().split("\n")[0]; return l.length > n ? l.slice(0, n - 1) + "…" : l; };
async function ready(call: Call, a: Record<string, string>, base: Record<string, any>) {
  const { target, runners } = await pickTarget(call, a.space, a.target);
  const projects = await projectsOf(call, a.space, target), notes: string[] = [];
  const project = a.project ?? (a.repo ? undefined : projects.length === 1 ? projects[0] : undefined); // a repo picks the project on the server
  if (!target) notes.push(runners.length ? `Pick the runner: ${runners.map((p: any) => `${p.name}${p.online ? " (online)" : ""}`).join(", ")}.` : "No runner is in this space yet; call peers to check, or ask the user to start one.");
  if (!project && !a.repo) notes.push(projects.length ? `Pick the project on ${target}: ${projects.join(", ")}.` : "Ask the user which project (repo) this is for, or omit project for a machine-level task.");
  const args: any = { ...(a.space ? { space: a.space } : {}), target: target ?? "<runner>", ...(project || (projects.length && !a.repo) ? { project: project ?? `<${projects.join(" | ")}>` } : {}), ...base,
    ...(a.agent ? { agent: a.agent } : {}) };
  for (const k of Object.keys(args)) if (args[k] === undefined) delete args[k];
  args.idempotency_key = "p_" + (await sha256(JSON.stringify(args))).slice(0, 16);
  return { args, notes };
}
const msg = (text: string) => [{ role: "user", content: { type: "text", text } }];
const callText = (intro: string, args: any, notes: string[]) => `${intro}\n\nCall the Kitebook tool \`task_create\` with:\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\`\n`
  + (notes.length ? `\nBefore calling: ${notes.join(" ")} Replace any <placeholder> with the user's answer.\n` : "")
  + `\nRelevant shared knowledge-base entries are attached to the task automatically (kb_context); if the user mentioned a decision or preference, check kb_search first.`
  + `\nAfter it's created, tell the user the task id and whether the runner is online (target_online). The owner approves it on their Mac or phone; follow it with task_get, the server://task/<id> resource, or the task.completed event.`;

export async function promptGet(call: Call, name: string, a: Record<string, string> = {}): Promise<{ result: any } | { error: RErr }> {
  const p = PROMPTS.find(x => x.name === name); if (!p) return { error: { code: -32602, message: `unknown prompt ${name}` } };
  for (const x of p.arguments) if (x.required && !String(a[x.name] ?? "").trim()) return { error: { code: -32602, message: `missing argument ${x.name}` } };
  a = Object.fromEntries(Object.entries(a).filter(([, v]) => v != null && String(v).trim() !== "").map(([k, v]) => [k, String(v)]));
  const done = (text: string) => ({ result: { description: p.description, messages: msg(text) } });
  if (name === "delegate-coding-task") {
    const { args, notes } = await ready(call, a, { title: firstLine(a.task), instructions: a.task, kind: "code",
      acceptance: a.acceptance ?? "The change is implemented, the project's tests pass, and the summary lists what changed and anything left undone.", verify: a.verify,
      ...(a.repo ? { repo: a.repo } : {}), ...(a.base ? { base: a.base } : {}) });
    return done(callText("Delegate this coding task to the local coding agent via Kitebook.", args, notes));
  }
  if (name === "review-branch") {
    const base = a.base ?? "main";
    const { args, notes } = await ready(call, a, { title: firstLine(`Review ${a.branch} vs ${base}`), kind: "review",
      instructions: `Review branch \`${a.branch}\` against \`${base}\` (git diff ${base}...${a.branch}). Do not commit, push or modify the branch.${a.focus ? ` Focus on: ${a.focus}.` : ""}\nReport findings ranked by severity (bug, risk, missing test, style), each with file:line and a suggested fix, then an overall verdict: merge, merge after fixes, or don't merge. Save the report as review.md.`,
      acceptance: "review.md with severity-ranked findings (file:line + fix) and a merge verdict; branch unchanged." });
    return done(callText(`Ask the local agent to review branch ${a.branch}.`, args, notes));
  }
  if (name === "fix-failing-tests") {
    const { args, notes } = await ready(call, a, { title: firstLine(a.test_command ? `Fix failing tests: ${a.test_command}` : "Fix failing tests"), kind: "code",
      instructions: `Make the failing tests pass${a.test_command ? ` (\`${a.test_command}\`)` : ""}. Fix the code, not the tests: don't delete, skip or loosen assertions unless a test is clearly wrong, and say so if you change one.${a.failure ? `\n\nFailure output:\n${a.failure.slice(0, 4000)}` : ""}`,
      verify: a.test_command, acceptance: `${a.test_command ? `\`${a.test_command}\`` : "The test suite"} passes; summary explains each root cause and lists any test that was changed and why.` });
    return done(callText("Ask the local agent to fix the failing tests.", args, notes));
  }
  // check-on-my-agents: live snapshot so the model can report without extra calls, plus ready follow-ups.
  const pr = await call("peers", { space: a.space }), tl = await call("task_list", { space: a.space, role: "sent" });
  const st = await call("task_status", { space: a.space }), open: any[] = st.ok ? st.result.tasks : [], live = new Map<string, any>(open.map((t: any) => [t.id, t.live]));
  const liveNote = (id: string) => { const l = live.get(id); if (!l || l.phase === "queued") return "";
    return ` — ${l.doing ?? l.phase}${l.agent ? ` (${l.agent}${l.model ? "/" + l.model : ""})` : ""}${l.elapsed_s != null ? `, ${l.elapsed_s}s` : ""}${l.last_line ? `, last: "${String(l.last_line).slice(0, 120)}"` : ""}`; };
  // stuck first (C18): a claimed/running task with no progress past the space's threshold, with how long it's been quiet and its last line
  const stuck = open.filter((t: any) => t.stuck), quietFor = (s: number) => s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
  const runners = pr.ok ? pr.result.peers.filter((p: any) => p.kind === "runner") : [], tasks = tl.ok ? tl.result.tasks.slice(0, 30) : [];
  const lines = [...(stuck.length ? [`STUCK? (no progress or live update past the threshold; look at these first):`, ...stuck.map((t: any) => `- ${t.id} [stuck? quiet ${quietFor(t.stuck.quiet_s)}] ${t.title} -> ${t.target}${t.live?.agent ? ` (${t.live.agent}${t.live.model ? "/" + t.live.model : ""})` : ""}, last: ${t.stuck.last_line ? `"${String(t.stuck.last_line).slice(0, 160)}"` : "no output yet"}`)] : []),
    `Runners: ${runners.length ? runners.map((p: any) => `${p.name} (${p.online ? "online" : `offline${p.last_seen ? `, last seen ${p.last_seen}` : ""}`})`).join(", ") : "none"}${pr.ok && pr.result.paused ? " — space is PAUSED by the owner" : ""}.`,
    `Tasks you sent (newest first):`, ...(tasks.length ? tasks.map((t: any) => `- ${t.id} [${t.state}] ${t.title} -> ${t.target}${t.note ? ` (${t.note})` : ""}${liveNote(t.id)}`) : ["- none"])];
  const follow: any[] = [];
  for (const t of tasks.filter((t: any) => t.state === "failed").slice(0, 5)) follow.push({ why: `${t.id} failed`, call: { ...(a.space ? { space: a.space } : {}), target: t.target, continue_from: t.id,
    title: firstLine(`Retry: ${t.title}`), instructions: "The previous attempt failed. Read its summary and logs, fix the cause, and finish the original task.", idempotency_key: `p_retry_${t.id}` } });
  for (const t of stuck.slice(0, 5)) follow.unshift({ why: `${t.id} looks stuck`, first: { tool: "task_cancel", args: { ...(a.space ? { space: a.space } : {}), id: t.id, reason: "looked stuck" } }, call: { ...(a.space ? { space: a.space } : {}), target: t.target, continue_from: t.id,
    title: firstLine(`Retry: ${t.title}`), instructions: "The previous attempt stalled (no progress) and was cancelled. Check what it left on the branch, then finish the original task.", idempotency_key: `p_stuck_${t.id}` } });
  const waiting = tasks.filter((t: any) => t.state === "needs_input");
  const text = `Give the user a short status of their local agents from this live snapshot (call task_get <id> for details on anything that needs it):\n\n${lines.join("\n")}\n`
    + (waiting.length ? `\nWaiting on the user: ${waiting.map((t: any) => t.id).join(", ")}. Read the question with task_get, ask the user, and answer with task_message.\n` : "")
    + (follow.length ? `\nReady follow-ups (only call after the user says yes):\n${follow.map(f => `- ${f.why}: ${f.first ? `${f.first.tool} ${JSON.stringify(f.first.args)}, then ` : ""}task_create ${JSON.stringify(f.call)}`).join("\n")}\n` : "")
    + (stuck.length ? `\nLead with the stuck task(s): say how long each has been quiet and its last line, and offer to cancel and retry it (the owner can also retry or hand it to another agent in one tap on /start, Status).\n` : "")
    + `\nEnd with what, if anything, needs the user.`;
  return done(text);
}
