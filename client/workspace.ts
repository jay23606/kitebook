// A disposable replica for daily-agent sandboxes. Credentials stay with the caller; no Git checkout or model calls required.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, lstatSync, readdirSync, unlinkSync } from "fs";
import { resolve, join, dirname } from "path";
import { createHash, randomUUID } from "crypto";
type Call = (op: string, a: any) => Promise<any>;
type State = { format: 1; replica: string; remote: string; path: string; cursor?: string; files: Record<string, string>; pending?: any };
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const conflict = (p: string) => new Error(`conflict: local changes in ${p}; publish or move them before pulling`);
function safe(base: string, path: string) {
  const parts = path.split("/"); if (!path || path.includes("\\") || parts.some(p => !p || p === "." || p === ".." || p.includes("\0"))) throw new Error("unsafe workspace path");
  let p = base; for (const part of parts) { p = join(p, part); if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`refused symlink: ${p}`); } return p;
}
function init(dir: string, remote: string, path?: string): { root: string; state: State; save: () => void } {
  if (path !== undefined) path = path.replace(/^\/+|\/+$/g, "");
  const root = resolve(dir); let p = root; while (true) { if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`refused symlink: ${p}`); const next = dirname(p); if (p === next) break; p = next; }
  mkdirSync(root, { recursive: true, mode: 0o700 }); const sf = safe(root, "state.json"); const fresh = !existsSync(sf); let state: State;
  if (existsSync(sf)) { state = JSON.parse(readFileSync(sf, "utf8")); if (state.format !== 1 || state.remote !== remote || path && state.path !== path) throw new Error("replica belongs to another server/workspace/path; use a fresh directory"); }
  else { if (readdirSync(root).length) throw new Error("new replica directory must be empty"); state = { format: 1, replica: randomUUID(), remote, path: path ?? "shared", files: {} }; }
  safe(root, "files"); mkdirSync(join(root, "files"), { recursive: true, mode: 0o700 });
  const save = () => { const tmp = safe(root, "state.tmp"); writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); renameSync(tmp, sf); };
  if (fresh) save(); // a failed first request must remain retryable, not leave a nonempty uninitialized folder
  return { root, state, save };
}
function local(root: string, p: string) { return safe(root, "files/" + p); }
function localHash(p: string) { if (!existsSync(p)) return null; if (!lstatSync(p).isFile()) throw new Error(`expected regular file: ${p}`); return hash(readFileSync(p)); }
function store(root: string, path: string, bytes: Uint8Array) { const p = local(root, path); mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const temp = safe(root, "download.tmp"); writeFileSync(temp, bytes, { mode: 0o600 }); renameSync(temp, p); }

export async function pull(call: Call, dir: string, remote: string, path?: string) {
  const { root, state, save } = init(dir, remote, path); if (state.pending) throw new Error("publication pending; retry workspace publish before pulling");
  // A checkpoint without its materialized files is not a cache. Recover using a fresh snapshot.
  if (Object.keys(state.files).some(p => !existsSync(local(root, p)))) state.cursor = undefined;
  let cursor = state.cursor, snapshot = !cursor, final: any, readCursor: string = ""; const desired = new Map<string, any>(); let resets = 0;
  for (;;) {
    const r = await call("sync", { path: state.path, cursor });
    if (r.reset_required) { if (++resets > 2) throw new Error("workspace changed during recovery; retry pull"); cursor = undefined; snapshot = true; desired.clear(); continue; }
    for (const e of r.entries) desired.set(e.path, e); readCursor = r.read_cursor; cursor = r.cursor;
    if (!r.more) { final = r; break; }
  }
  // Validate everything before replacing any file. Fetch all final states at the same watermark.
  const writes: [string, Uint8Array, string][] = [], removes = new Set<string>();
  if (snapshot) for (const p of Object.keys(state.files)) if (!desired.has(p)) removes.add(p);
  for (const [p, e] of desired) {
    const file = local(root, p), have = localHash(file), previous = state.files[p] ?? null;
    if (e.deleted) { if (have !== null && have !== previous) throw conflict(p); removes.add(p); continue; }
    if (have !== null && have !== previous && have !== e.sha) throw conflict(p);
    if (have === e.sha) continue;
    const r = await call("sync_read", { path: p, cursor: readCursor });
    const bytes = r.content_base64 !== undefined ? Buffer.from(r.content_base64, "base64") : Buffer.from(r.content ?? "", "utf8");
    if (r.sha !== e.sha || hash(bytes) !== e.sha) throw new Error(`snapshot integrity mismatch: ${p}`);
    writes.push([p, bytes, e.sha]);
  }
  for (const p of removes) { const have = localHash(local(root, p)); if (have !== null && have !== state.files[p]) throw conflict(p); }
  for (const [p, bytes] of writes) store(root, p, bytes);
  for (const p of removes) { const f = local(root, p); if (existsSync(f)) unlinkSync(f); delete state.files[p]; }
  for (const [p, e] of desired) if (!e.deleted) state.files[p] = e.sha;
  state.cursor = final.cursor; save(); await call("sync_ack", { cursor: state.cursor, replica: state.replica });
  return { state: status(dir, remote).state, replica: state.replica, version: final.version, files: Object.keys(state.files).length, downloaded: writes.length, removed: removes.size, directory: join(root, "files") };
}
function walk(root: string, dir: string, out: string[] = []) { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isSymbolicLink()) throw new Error(`refused symlink: ${p}`); if (e.isDirectory()) walk(root, p, out); else if (e.isFile()) out.push(p.slice(root.length + 1).split("\\").join("/")); else throw new Error(`not a regular file: ${p}`); } return out; }

export async function publish(call: Call, dir: string, remote: string, options: { goal?: string; done?: string; next?: string; questions?: string; message?: string } = {}) {
  const { root, state, save } = init(dir, remote);
  if (!state.cursor && !state.pending) throw new Error("run workspace pull first to establish file versions");
  if (!state.pending) {
    if (options.goal || options.next) {
      const files = walk(join(root, "files"), join(root, "files")).filter(p => p !== state.path + "/handoff.json");
      const artifacts = files.map(p => ({ path: p, content_type: ({ csv: "text/csv", json: "application/json", md: "text/markdown", txt: "text/plain", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as Record<string,string>)[p.split(".").pop()!.toLowerCase()] ?? "application/octet-stream", sha: localHash(local(root, p)), size: readFileSync(local(root, p)).length }));
      store(root, `${state.path}/handoff.json`, Buffer.from(JSON.stringify({ goal: options.goal ?? "", completed: options.done ?? "", next: options.next ?? "", questions: options.questions ?? "", artifacts, producer_replica: state.replica, updated: new Date().toISOString() }, null, 2)));
    }
    const paths = walk(join(root, "files"), join(root, "files")), present = new Set(paths), changes: any[] = [];
    for (const p of paths) { if (!(p === state.path || p.startsWith(state.path + "/"))) throw new Error(`outside replica path: ${p}`);
      const bytes = readFileSync(local(root, p)), sha = hash(bytes); if (sha === state.files[p]) continue;
      let text: string | undefined; try { text = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes); if (text.includes("\0")) text = undefined; } catch {}
      changes.push({ path: p, ...(text !== undefined ? { content: text } : { content_base64: bytes.toString("base64") }), if_match: state.files[p] ?? "none" }); }
    for (const p of Object.keys(state.files)) if (!present.has(p)) changes.push({ path: p, delete: true, if_match: state.files[p] });
    if (!changes.length) return { state: "published", unchanged: true };
    state.pending = { operation_id: randomUUID(), changes, message: options.message ?? "Publish workspace artifacts and handoff" }; save();
  }
  const result = await call("sync_publish", state.pending);
  for (const [p, sha] of Object.entries<string | null>(result.shas)) { if (sha === null) delete state.files[p]; else state.files[p] = sha; }
  delete state.pending; save(); return { state: status(dir, remote).state, ...result };
}

export function status(dir: string, remote: string) { if (!existsSync(join(resolve(dir), "state.json"))) return { state: "not_initialized", replica: null, changed: [], deleted: [], pending_operation: null };
  const { root, state } = init(dir, remote); const files = walk(join(root, "files"), join(root, "files"));
  const changed = files.filter(p => localHash(local(root, p)) !== state.files[p]); const deleted = Object.keys(state.files).filter(p => !existsSync(local(root, p)));
  return { state: state.pending ? "pending" : !state.cursor ? "not_initialized" : changed.length || deleted.length ? "local_changes" : "published", replica: state.replica, changed, deleted, pending_operation: state.pending?.operation_id ?? null };
}

// A reference client policy: explicit capability needs choose the operation; retrieved text never grants authority.
export async function assist(call: Call, input: { goal: string; project?: string; target?: string; needsRepository?: boolean; changesCode?: boolean; existingTask?: string; operationId?: string }) {
  if (!input.goal?.trim()) throw new Error("goal required");
  const scopes = input.project ? ["global", "project:" + input.project] : ["global"];
  const found = await Promise.all(scopes.map(scope => call("kb_search", { query: input.goal, scope, k: 5 })));
  const knowledge = { results: [...new Map<string, any>(found.flatMap(r => r.results.map((e: any) => [e.id, e]))).values()].slice(0, 8) };
  if (input.existingTask) return { action: "continue", knowledge: knowledge.results, result: await call("task_status", { id: input.existingTask }) };
  if (!input.needsRepository && !input.changesCode) return { action: "retrieve", knowledge: knowledge.results };
  const capabilities = await call("describe", {});
  if (!input.changesCode) return { action: "ask", knowledge: knowledge.results, capabilities, result: await call("ask", { question: input.goal, project: input.project, to: input.target }) };
  if (!input.project || !input.target || !input.operationId) throw new Error("coding work requires project, target and a stable operation-id (retry with the same id)");
  return { action: "task_create", knowledge: knowledge.results, capabilities, result: await call("task_create", { target: input.target, project: input.project, title: input.goal.slice(0, 160), instructions: input.goal, kb_ids: knowledge.results.map((x: any) => x.id), idempotency_key: input.operationId }) };
}
