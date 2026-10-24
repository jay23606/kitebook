// Space ops: quick asks (G3). A read-only question answered in seconds by a warm agent session on the runner (client/runner-ask.ts):
// stored as a task with kind "ask" so it rides the same inbox, wake-up, approval, live status, cancel and audit paths, but the runner
// never makes a worktree or branch for it. ask waits for the answer (or returns the partial one), ask_get keeps waiting, and
// ask_to_task turns it into a normal task carrying the question and answer. Part of the impl table (src/space.ts); `this` is the Space.
import { RelayError, type Peer } from "../ops.ts";
import { ACTIVE, ASK_ARGS, guard } from "./util.ts";
import type { Space, Op } from "../space.ts";

const DONE = ["succeeded", "failed", "cancelled", "rejected"];
const clamp = (v: any, lo: number, hi: number, d: number) => { const n = Number(v ?? d); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

// What an asker reads: the answer, or the state and partial answer while it runs, and the one next step.
export function askView(sp: Space, t: any) {
  const row = sp.sql.exec("select data from task_live where task_id=?", t.id).toArray()[0] as any, live = row ? JSON.parse(row.data) : {};
  const done = DONE.includes(t.state), sr = t.result?.structured ?? {}, q = sr.ask ?? {};
  const err = done && t.state !== "succeeded" ? String(t.result?.summary ?? t.result?.reason ?? t.note ?? t.state).slice(0, 2000) : null;
  const next = !done ? (t.state === "awaiting_approval" ? { action: "wait", text: `${t.target} asked its owner to approve this question; call ask_get again`, call: "ask_get", args: { id: t.id, wait: 20 } }
      : { action: "wait", text: "still answering; call ask_get for the rest", call: "ask_get", args: { id: t.id, wait: 20 } })
    : t.state === "succeeded" ? { action: "run_as_task", text: q.needs_task ? `This needs changes (${String(q.needs_task).slice(0, 200)}): run it as a task` : "If this needs code changes, run it as a task", call: "ask_to_task", args: { id: t.id } }
    : { action: "retry", text: "ask again (or send a task)", call: "ask", args: { to: t.target, question: t.instructions } };
  return { id: t.id, state: t.state, done, to: t.target, project: t.project ?? q.project ?? null, question: t.instructions,
    answer: t.state === "succeeded" ? String(t.result?.summary ?? "") : null, partial: !done && live.partial ? String(live.partial) : null, error: err,
    agent: q.agent ?? live.agent ?? t.agent ?? null, model: q.model ?? live.model ?? t.model ?? null,
    session: q.session ? { id: q.session, warm: !!q.warm, turn: q.turn ?? null, sandbox: q.sandbox ?? null } : null,
    answer_s: q.ms != null ? Math.round(q.ms / 100) / 10 : null, needs_task: q.needs_task ?? null, ...(t.limits?._task ? { ran_as_task: t.limits._task } : {}),
    ...(t.limits?._auto ? { auto: t.limits._auto } : {}), next };
}

export function askOps(this: Space): Record<string, Op> {
  // hold until the ask finishes (any task event wakes the waiters) or the time is up
  const settle = async (id: string, sec: number) => { const end = Date.now() + sec * 1000;
    for (;;) { const t = this.loadTask(id); if (!ACTIVE.includes(t.state)) return t; const left = (end - Date.now()) / 1000; if (left <= 0.05) return t; await this.wait(Math.min(left, 25)); } };
  return {
    ask: async (peer, a) => {
      this.need(peer, "dispatch");
      const q = String(a.question ?? "").trim(); if (!q) throw new RelayError(400, "question is empty");
      if (q.length > 8000) throw new RelayError(413, "question is too long for a quick ask (max 8000 chars); send a task instead");
      let to = a.to == null || a.to === "" ? null : String(a.to);
      if (!to) { const rs = this.sql.exec("select name from members where kind='runner' and revoked=0 order by name").toArray() as any[];
        if (rs.length !== 1) throw new RelayError(400, rs.length ? `to: which Mac? runners here: ${rs.map(r => r.name).join(", ")}` : "no runner (Mac) is connected to this workspace yet"); to = rs[0].name as string; }
      const tgt = this.sql.exec("select * from members where name=? and revoked=0", to).toArray()[0] as any;
      if (!tgt) throw new RelayError(404, `no connected app named ${to} in workspace ${this.spaceId}`);
      if (tgt.kind !== "runner") throw new RelayError(400, `a quick ask goes to a runner (a Mac); ${to} is ${tgt.kind === "human" ? "a person" : "an app"}: use notify or task_create`);
      const ad = await this.runnerAd(tgt.name); if (ad && !ad.ask) throw new RelayError(400, `${to} runs an older runner without quick asks: update it (kitebook update), or send a task`);
      const timeout = clamp(a.timeout, 5, 600, 120);
      const args: any = { space: a.space, target: to, title: `Ask: ${q.split("\n")[0].slice(0, 100)}`, instructions: q, kind: "ask", max_retries: 0, kb_k: 0, limits: { minutes: timeout / 60 },
        ...(a.project != null ? { project: a.project } : {}), ...(a.repo != null ? { repo: a.repo } : {}), ...(a.agent != null ? { agent: a.agent } : {}), ...(a.model != null ? { model: a.model } : {}) };
      ASK_ARGS.add(args);
      const r = await this.impl.task_create(peer, args);
      const t = await settle(r.id, clamp(a.wait, 0, 25, 20));
      return { ...askView(this, t), target_online: r.target_online, ...(r.warning ? { warning: r.warning } : {}), ...(!r.target_online ? { delivery: r.delivery } : {}) };
    },
    ask_get: async (peer, a) => {
      const t0 = this.taskFor(peer, a.id, "any"); if (t0.kind !== "ask") throw new RelayError(400, `${t0.id} is a task, not a quick ask: use task_get`);
      return askView(this, a.wait ? await settle(t0.id, clamp(a.wait, 0, 25, 0)) : t0);
    },
    ask_to_task: async (peer, a) => {
      this.need(peer, "dispatch");
      return await askToTask(this, this.taskFor(peer, a.id, "from"), peer, a);
    },
  };
}

// "Run as a task": a normal task (worktree + branch, approved like any other) from the asker, carrying the question and the ask's answer.
// Called by ask_to_task (the asker) and by the owner's Run as a task button on /start (sent as the asker, like Retry).
export async function askToTask(sp: Space, t: any, from: Peer, a: any) {
  if (t.kind !== "ask") throw new RelayError(400, `${t.id} is not a quick ask`);
  if (ACTIVE.includes(t.state)) throw new RelayError(409, "the ask is still running; wait for its answer first (ask_get)");
  if (t.limits?._task) throw new RelayError(409, `already run as task ${t.limits._task}`);
  const v = askView(sp, t), ins = a.instructions != null && String(a.instructions).trim() ? String(a.instructions).trim() : String(t.instructions);
  if (a.instructions != null) guard("x", ins);
  const body = `${ins}\n\n---\nContext from quick ask ${t.id}${ins !== t.instructions ? ` (question: ${String(t.instructions).slice(0, 2000)})` : ""}, answered read-only by ${v.agent ?? "the runner's agent"}:\n`
    + (v.answer ? v.answer.slice(0, 8000) : `(no answer: ${v.error ?? t.state})`) + (v.needs_task ? `\n\nWhat it said needs doing: ${v.needs_task}` : "");
  const title = String(a.title ?? t.title.replace(/^Ask: /, "")).slice(0, 200);
  const r = await sp.impl.task_create(from, { space: sp.spaceId, target: t.target, title, instructions: body, kind: "code",
    ...(v.project ? { project: v.project } : {}), ...(t.repo && !v.project ? { repo: t.repo } : {}), ...(t.agent ? { agent: t.agent } : {}), ...(t.model ? { model: t.model } : {}) });
  sp.sql.exec("update tasks set limits=? where id=?", JSON.stringify({ ...(t.limits ?? {}), _task: r.id }), t.id);
  return { ...r, from_ask: t.id };
}
