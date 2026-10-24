// Live steering (G4): who may steer which task, and what a note may say. Pure (no Durable Object), so client/presence.test.ts checks
// the rules directly; SpaceTasks.steerTask (src/space/tasks.ts) runs this first, then stores, audits and pushes the note.
import { RelayError } from "../ops.ts";
import { ACTIVE, guard } from "./util.ts";

export const STEER_MAX = 20, STEER_LEN = 4000;
// by: the caller's peer id, or owner:true for the account owner on /start. Returns the trimmed note, or throws the refusal in plain words.
export function checkSteer(t: any, by: { id?: string; owner?: boolean }, message: unknown): string {
  if (!by.owner && t.from_peer !== by.id) throw new RelayError(403, t.target_peer === by.id ? "the agent working on a task can't steer it; only the task's sender or the account owner (from /start) can" : "only the task's sender or the account owner (from /start) can steer a task");
  if (t.kind === "ask") throw new RelayError(409, "a quick ask can't be steered (it's one short read-only answer): ask again with the detail you'd add");
  if (!ACTIVE.includes(t.state)) throw new RelayError(409, `task is ${t.state}; steering only reaches an open task (send a follow-up with continue_from instead)`);
  if (t.state === "needs_input") throw new RelayError(409, "the agent is waiting for an answer to its question: answer it with task_answer (the owner: Answer on /start); a steer would only arrive with the answer");
  const msg = String(message ?? "").trim(); if (!msg || msg.length > STEER_LEN) throw new RelayError(400, `message: 1-${STEER_LEN} chars, what the agent should do differently`);
  guard("x", msg); // a key or password is refused, like any task text
  if ((t.steers ?? []).length >= STEER_MAX) throw new RelayError(429, `this task already has ${STEER_MAX} steering notes; cancel it and send a new task instead`);
  return msg;
}
