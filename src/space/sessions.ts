// Space ops: the owner's LOCAL agent sessions (live-sessions). sessions_search / session_get read the owner's own Codex, Claude Code, Pi,
// Gemini, Copilot, opencode and Cursor sessions on their computer; session_create / session_send start or continue a coding-agent session
// through the normal task machinery (worktree, approvals, results, the live driver when the runner has one).
// Transcripts are private, so:
//   - the grant is the owner-SIGNED policy entry apps[<app>].sessions = "read" (search/get) | "write" (+ create/send), set in Settings ->
//     Assistants (a policy change, so it needs presence: kitebook confirm with the master password / Touch ID). Off by default. The runner
//     re-checks the signature itself before it reads anything (client/runner-sessions.ts), so the server can't grant it;
//   - the server never stores a transcript: a read is an in-memory request to the runner (event sessions.requested, which only that runner
//     sees; it fetches the args with sessions_take and answers with sessions_reply), held in memory until the caller reads it (25 s max);
//   - every call is audited: an event (sessions.read / sessions.write, actor = the app; args without any transcript text) + Settings' list.
// Part of the impl table (src/space.ts); `this` is the Space.
import { RelayError, sha256, type Peer } from "../ops.ts";
import { ACTIVE, now, rid, redact } from "./util.ts";
import type { Space, Op } from "../space.ts";

export const SESSION_AGENTS = ["codex", "claude", "pi", "gemini", "copilot", "opencode", "cursor"];
export const LEVELS = ["off", "read", "write"];
export const SESSION_ARGS = new WeakMap<object, any>(); // task_create args built by session_create / session_send (the only way to set tasks.session)
type Pending = { space: string; runner: string; from: string; op: string; args: any; at: number; res: { ok: boolean; result?: any; error?: string } | null };
const pending = new Map<string, Pending>(); // in memory only: a transcript never touches storage here
const WAIT_MAX = 25, KEEP_MS = 60_000;
const clamp = (v: any, lo: number, hi: number, d: number) => { const n = Number(v ?? d); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const str = (v: any, n: number) => v == null ? null : String(v).slice(0, n);

// What the owner allowed this app (kitebook's view of the signed policy; the runner re-checks the signature): off | read | write
export function sessionsLevel(sp: Space, app: string): string { const e = sp.metaJ("policy")?.policy?.apps?.[app]; const l = e?.sessions; return LEVELS.includes(l) ? l : "off"; }
export function needSessions(sp: Space, peer: Peer, want: "read" | "write") {
  const m = sp.member(peer.id); if (!m || m.revoked) throw new RelayError(403, `no access to workspace ${sp.spaceId}`);
  if (m.kind === "runner" || m.kind === "human") throw new RelayError(403, "the session tools are for assistants and coding agents");
  const lvl = sessionsLevel(sp, peer.name);
  if (lvl === "off" || (want === "write" && lvl !== "write"))
    throw new RelayError(403, `${peer.name} may not ${want === "read" ? "read" : "start or continue"} the owner's agent sessions: the owner has to allow it in Settings -> Assistants -> ${peer.name} -> "Agent sessions" (${want === "read" ? "Search and read" : "Search, read and send"}). Tell the owner; it asks them to confirm it's them.`);
  return m;
}
const runnerFor = async (sp: Space, to: any) => {
  let name = to == null || to === "" ? null : String(to);
  if (!name) { const rs = sp.sql.exec("select name from members where kind='runner' and revoked=0 order by name").toArray() as any[];
    if (rs.length !== 1) throw new RelayError(400, rs.length ? `to: which computer? runners here: ${rs.map(r => r.name).join(", ")}` : "no runner (computer) is connected to this workspace yet"); name = rs[0].name as string; }
  const tgt = sp.sql.exec("select * from members where name=? and revoked=0", name).toArray()[0] as any;
  if (!tgt) throw new RelayError(404, `no connected computer named ${name}`); if (tgt.kind !== "runner") throw new RelayError(400, `${name} isn't a runner (a computer with Kitebook)`);
  const ad = await sp.runnerAd(tgt.name); if (ad && !ad.sessions) throw new RelayError(400, `${name} runs an older runner without the session tools: update it (kitebook update)`);
  return tgt;
};
const audit = (sp: Space, peer: Peer, kind: "read" | "write", op: string, d: any) => {
  const log = sp.metaJ("sessions_log", []) as any[]; log.push({ at: now(), app: peer.name, op, ...d }); sp.metaSet("sessions_log", log.slice(-100));
  sp.emit(`sessions.${kind}`, peer, { data: { op, ...d } });
};

export function sessionOps(this: Space): Record<string, Op> {
  // ask the runner, wait (in memory) for its answer
  const rpc = async (peer: Peer, op: string, args: any) => {
    for (const [k, p] of pending) if (Date.now() - p.at > KEEP_MS) pending.delete(k);
    const tgt = await runnerFor(this, args.to), id = rid("sx");
    pending.set(id, { space: this.spaceId, runner: tgt.name, from: peer.name, op, args, at: Date.now(), res: null });
    this.emit("sessions.requested", peer, { data: { id, op, target: tgt.name } }); // only that runner (and the asker) see it: Space.visible
    const end = Date.now() + WAIT_MAX * 1000;
    try { for (;;) { const p = pending.get(id); if (p?.res) { if (!p.res.ok) throw new RelayError(p.res.error?.startsWith("refused") ? 403 : 400, String(p.res.error)); return { computer: tgt.name, ...p.res.result }; }
        const left = (end - Date.now()) / 1000; if (left <= 0.05) throw new RelayError(504, `${tgt.name} didn't answer within ${WAIT_MAX} s (it may be offline or asleep); try again later`);
        await this.wait(Math.min(left, 5)); } }
    finally { pending.delete(id); }
  };
  const taskArgs = async (peer: Peer, a: any, sess: any, title: string, text: string) => {
    const tgt = await runnerFor(this, a.to);
    if (a.project == null && a.repo == null) { // a checkout folder (session_create cwd, or a session's cwd from sessions_search): its project, by path hash
      if (a.cwd == null || !String(a.cwd).trim()) throw new RelayError(400, "which checkout? give project, repo, or cwd (a session's cwd from sessions_search)");
      const roots = (await this.runnerAd(tgt.name))?.sessions?.roots ?? {}, parts = String(a.cwd).replace(/\/+$/, "").split("/");
      for (let i = parts.length; i > 1 && a.project == null; i--) { const h = await sha256(parts.slice(0, i).join("/")); const hit = Object.keys(roots).find(k => roots[k] === h); if (hit) a.project = hit; }
      if (a.project == null) throw new RelayError(400, `${a.cwd} isn't in a project ${tgt.name} has allowlisted (projects there: ${Object.keys(roots).join(", ") || "none"}); pass project`);
    }
    const args: any = { space: a.space, target: tgt.name, title, instructions: text, kind: "code",
      ...(a.project != null ? { project: a.project } : {}), ...(a.repo != null ? { repo: a.repo } : {}), agent: sess.agent, ...(a.model != null ? { model: a.model } : {}) };
    SESSION_ARGS.set(args, sess); return args;
  };
  return {
    sessions_search: async (peer, a) => {
      needSessions(this, peer, "read");
      const args = { query: str(a.query, 500) ?? "", agent: a.agent ?? null, cwd: str(a.cwd, 1000), since: a.since ?? null, limit: clamp(a.limit, 1, 50, 10), to: a.to };
      if (args.agent != null && !SESSION_AGENTS.includes(String(args.agent))) throw new RelayError(400, `agent: one of ${SESSION_AGENTS.join(", ")}`);
      audit(this, peer, "read", "sessions_search", { agent: args.agent, cwd: args.cwd, query_chars: args.query.length });
      return await rpc(peer, "search", args);
    },
    session_get: async (peer, a) => {
      needSessions(this, peer, "read");
      if (!SESSION_AGENTS.includes(String(a.agent))) throw new RelayError(400, `agent: one of ${SESSION_AGENTS.join(", ")}`);
      audit(this, peer, "read", "session_get", { agent: a.agent, id: str(a.id, 200) });
      return await rpc(peer, "get", { agent: String(a.agent), id: String(a.id), last: clamp(a.last, 1, 100, 20), to: a.to });
    },
    session_create: async (peer, a) => {
      needSessions(this, peer, "write");
      const agent = String(a.agent ?? ""); if (!agent) throw new RelayError(400, "agent: which coding agent (codex, claude, pi, ...)");
      const prompt = String(a.prompt ?? "").trim(); if (!prompt) throw new RelayError(400, "prompt is empty");
      audit(this, peer, "write", "session_create", { agent, project: a.project ?? null, repo: a.repo ?? null });
      const r = await this.impl.task_create(peer, await taskArgs(peer, a, { mode: "new", agent }, str(a.title, 200) ?? `Session: ${prompt.split("\n")[0].slice(0, 90)}`, prompt));
      return { ...r, session: { mode: "new", agent, task: r.id }, next: { text: "Follow it like a task: task_status / task_get; send more with session_send {agent, id: <this task id>, text}", call: "task_status", args: { id: r.id } } };
    },
    session_send: async (peer, a) => {
      const text = String(a.text ?? "").trim(); if (!text) throw new RelayError(400, "text is empty");
      const id = String(a.id ?? ""), mode = a.mode == null ? null : String(a.mode); if (mode != null && !["fork", "steer"].includes(mode)) throw new RelayError(400, "mode: fork | steer");
      // a Kitebook-owned session: the task that runs it (its id, or the agent session id it reported)
      const own = /^t_[0-9a-f]+$/.test(id) ? this.sql.exec("select id from tasks where id=?", id).toArray()[0] as any
        : this.sql.exec("select t.id from tasks t join task_live l on l.task_id=t.id where t.from_peer=? and json_extract(l.data,'$.session')=? order by t.created desc limit 1", peer.id, id).toArray()[0] as any;
      if (own) { const t = this.taskFor(peer, own.id, "from");
        const how = t.state === "needs_input" ? "answer" : ACTIVE.includes(t.state) ? "steer" : "continue";
        needSessions(this, peer, "write"); audit(this, peer, "write", "session_send", { task: t.id, how });
        // parked on the agent's question: the text is the answer (task_steer refuses a parked task; task_answer resumes the same session)
        if (how === "answer") { const r = await this.answerTask(t, peer, text); return { ...r, how, task: t.id }; }
        if (ACTIVE.includes(t.state)) { const r = await this.impl.task_steer(peer, { space: a.space, id: t.id, message: text }); return { ...r, how: "steer", task: t.id }; }
        const r = await this.impl.task_create(peer, { space: a.space, target: t.target, title: str(a.title, 200) ?? t.title, instructions: text, continue_from: t.id, ...(t.agent ? { agent: t.agent } : {}) });
        return { ...r, how: "continue", continues: t.id };
      }
      // one of the OWNER's own sessions: a fork (a new copy, then continue) is the default and the only automatic mode; steer = continue that
      // very session in place, which the runner refuses while it's open anywhere and always asks the owner for
      needSessions(this, peer, "write");
      const agent = String(a.agent ?? ""); if (!SESSION_AGENTS.includes(agent)) throw new RelayError(400, `agent: one of ${SESSION_AGENTS.join(", ")} (the agent the session belongs to)`);
      const how = mode === "steer" ? "continue" : "fork";
      audit(this, peer, "write", "session_send", { agent, id: str(id, 200), how });
      const r = await this.impl.task_create(peer, await taskArgs(peer, a, { mode: how, agent, from: id.slice(0, 200) }, str(a.title, 200) ?? `${how === "fork" ? "Fork of" : "Continue"} ${agent} session ${id.slice(0, 12)}: ${text.split("\n")[0].slice(0, 70)}`, text));
      return { ...r, how, session: { mode: how, agent, from: id, task: r.id },
        note: how === "fork" ? "A copy of the owner's session continues as a new Kitebook session; the original is never written." : "The owner is asked first; refused if the session is open anywhere (use the default fork instead)." };
    },
    // ---- runner side ----
    sessions_take: async (peer, a) => {
      const p = pending.get(String(a.id ?? "")); if (!p || p.space !== this.spaceId || p.runner !== peer.name || peer.kind !== "runner") throw new RelayError(404, "no such session request (it expired)");
      return { id: a.id, op: p.op, from: p.from, args: p.args };
    },
    sessions_reply: async (peer, a) => {
      const p = pending.get(String(a.id ?? "")); if (!p || p.space !== this.spaceId || p.runner !== peer.name || peer.kind !== "runner") throw new RelayError(404, "no such session request (it expired)");
      p.res = a.ok === false ? { ok: false, error: redact(String(a.error ?? "failed")).slice(0, 1000) } : { ok: true, result: a.result ?? {} };
      for (const w of [...this.waiters]) w(); return { ok: true };
    },
  };
}
// Settings -> Assistants: the recent session calls per app (audit), newest first
export const sessionsLog = (sp: Space) => (sp.metaJ("sessions_log", []) as any[]).slice(-30).reverse();
