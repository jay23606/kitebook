// Result headline (C16/C22): one fixed, phone-first header for every finished task, so the owner reads it in 30 s:
// outcome (done / failed / needs you / stopped), what changed, tests, branch, and ONE next action. The runner builds it
// (it knows the tests, the branch and the wall time); the server builds the same thing from the structured result for a task
// a runner didn't finish (rejected, cancelled before it ran, a non-runner target). Pure TS: imported by both sides.
// Numbers are only what was measured (wall time, files, tests); there is no estimated "time saved".
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
export type NextAction = { action: "merge" | "open_pr" | "push" | "retry" | "reply" | "approve_plan"; text: string; cmd?: string | null; url?: string | null };
export type Headline = {
  v: 1; outcome: "done" | "failed" | "needs_you" | "stopped"; label: string; title: string;
  changed: { files: number; insertions: number | null; deletions: number | null } | null;
  tests: { cmd: string | null; passed: number | null; failed: number | null; ok: boolean | null } | null;
  branch: string | null; next: NextAction;
  wall_s: number | null; files_touched: number; tests_touched: number; tests_run: number | null;
  lines: string[];
};
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb)$/i;
export const isTestFile = (f: string) => TEST_FILE.test(f);
export function dur(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "";
  const x = Math.max(0, Math.round(s)); if (x < 60) return `${x}s`;
  const m = Math.round(x / 60); if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
const one = (s: any, n = 120) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

// sr: the structured result block (runner-built); state: the task's state; id: the task id (for the retry/reply hint)
export function buildHeadline(i: { id: string; title: string; state: string; sr?: any; reason?: string | null; wall_s?: number | null }): Headline {
  const sr = i.sr ?? {}, st = String(sr.status ?? i.state), files: string[] = Array.isArray(sr.files_changed) ? sr.files_changed.map(String) : [];
  const ds = sr.diff_stat && typeof sr.diff_stat === "object" ? sr.diff_stat : null, branch = sr.branch ? String(sr.branch) : null;
  const nFiles = files.length || Number(ds?.files) || 0;
  const changed = sr.status == null && !ds ? null : { files: nFiles, insertions: ds ? Number(ds.insertions) || 0 : null, deletions: ds ? Number(ds.deletions) || 0 : null };
  const t = sr.tests, tcmd = t?.cmd ? String(t.cmd) : null;
  const tok = !tcmd ? null : t.passed != null || t.failed != null ? !(Number(t.failed) > 0) && (t.exit == null || t.exit === 0) : t.exit != null ? t.exit === 0 : null;
  const counted = t && (t.passed != null || t.failed != null), tok2 = tcmd ? tok : counted ? !(Number(t.failed) > 0) : null;
  const tests = tcmd || counted ? { cmd: tcmd, passed: t.passed ?? null, failed: t.failed ?? null, ok: tok2 } : null;
  const run = tests && (tests.passed != null || tests.failed != null) ? (Number(tests.passed) || 0) + (Number(tests.failed) || 0) : null;
  const pushProblem = !!(sr.push_error || sr.push_declined), dirty = !!sr.dirty_left;
  const finished = ["succeeded", "failed", "cancelled", "rejected"].includes(i.state);
  // outcome: a run that finished but still wants a human decision is "needs you", not "done"
  const outcome: Headline["outcome"] = i.state === "cancelled" || i.state === "rejected" ? "stopped"
    : i.state === "failed" || st === "failed" || st === "conflict" ? "failed"
    : !finished || st === "partial" || sr.mode === "plan" || dirty || (pushProblem && nFiles > 0) ? "needs_you" : "done";
  const label = { done: "Done", failed: "Failed", needs_you: "Needs you", stopped: i.state === "rejected" ? "Rejected" : "Cancelled" }[outcome];
  const cont = `task_create {continue_from: "${i.id}", instructions: "..."}`;
  let next: NextAction;
  if (outcome === "failed" && st === "conflict") next = { action: "retry", text: "The change didn't apply: rebase it on the latest base and send it again" };
  else if (i.state === "rejected") next = { action: "reply", text: "It was turned down: change the request and send it again if you still want it" };
  else if (outcome === "failed" || outcome === "stopped") next = { action: "retry", text: branch && nFiles ? `Retry on the same branch (the work so far is on ${branch})` : "Retry it as a follow-up", cmd: cont };
  else if (sr.mode === "plan") next = { action: "approve_plan", text: "Read the plan, then run it", cmd: `task_promote {id: "${i.id}"}` };
  else if (st === "partial") next = { action: "retry", text: "Tests failed: send a fix-up on the same branch", cmd: `task_create {continue_from: "${i.id}", instructions: "fix the failing tests"}` };
  else if (dirty) next = { action: "retry", text: "Some files weren't committed: retry on the same branch (the worktree was kept)", cmd: cont };
  else if (!nFiles || !branch) next = { action: "reply", text: "Nothing to merge: read the answer, reply with a follow-up if you need more", cmd: cont };
  else if (sr.pr_url) next = { action: "open_pr", text: "Review and merge the pull request", url: String(sr.pr_url) };
  else if (sr.pushed) next = { action: "merge", text: "Review and merge the branch", cmd: `git fetch origin ${branch} && git merge origin/${branch}`, url: sr.compare_url ? String(sr.compare_url) : null };
  else if (pushProblem) next = { action: "push", text: sr.push_declined ? "Push was declined: push the branch by hand when you want it" : "Push failed: push the branch by hand", cmd: `git push -u origin ${branch}` };
  else next = { action: "merge", text: "Merge the branch on the Mac (it is local only)", cmd: `git merge ${branch}` };
  const wall = i.wall_s ?? (sr.duration_s != null ? Number(sr.duration_s) : null), tt = files.filter(isTestFile).length;
  const reason = outcome === "stopped" || (outcome === "failed" && !sr.status) ? one(i.reason ?? "", 100) : "";
  const lines = [
    `${label}: ${one(i.title)}${reason ? ` (${reason})` : ""}`,
    changed ? (changed.files ? `Changed ${changed.files} file${changed.files === 1 ? "" : "s"}${tt ? ` (${tt} test file${tt === 1 ? "" : "s"})` : ""}${changed.insertions != null ? `, +${changed.insertions} -${changed.deletions}` : ""}` : "No files changed") : "",
    tests ? `Tests: ${tests.cmd ? tests.cmd + " " : ""}${tests.ok === false ? "FAILED" : tests.ok ? "passed" : "ran"}${run != null ? ` (${tests.failed ? `${tests.failed} of ${run} failed` : run})` : ""}` : sr.status ? "Tests: none run" : "",
    branch ? `Branch: ${branch}${sr.pushed ? " (pushed)" : nFiles ? " (local only)" : ""}` : "",
    wall != null ? `Agent worked ${dur(wall)}` : "",
    `Next: ${next.text}${next.url ? ` ${next.url}` : next.cmd ? `: ${next.cmd}` : ""}`,
  ].filter(Boolean);
  return { v: 1, outcome, label, title: one(i.title, 200), changed, tests, branch, next, wall_s: wall != null && Number.isFinite(wall) ? Math.round(wall * 10) / 10 : null,
    files_touched: nFiles, tests_touched: tt, tests_run: run, lines };
}
// The weekly payoff line (Status): measured numbers only
export function weekLine(w: { done: number; failed: number; agent_s: number; merged: number | null }): string {
  return `This week: ${w.done} task${w.done === 1 ? "" : "s"} done${w.failed ? `, ${w.failed} failed` : ""} · agents worked ${dur(w.agent_s) || "0s"} · ${w.merged == null ? "merges not reported yet" : `${w.merged} branch${w.merged === 1 ? "" : "es"} merged`}`;
}
