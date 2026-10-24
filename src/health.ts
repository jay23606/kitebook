// Runner health, in plain words (op `status`, the /start "Mac is down" banner). Pure: no Space, no Workers APIs, so client/health.test.ts
// tests it with bun. Incident 2026-10-23: the Mac's runner went offline at 11:04 PT while the server answered /health, nobody was told,
// and tasks and relay_update asks queued silently for hours. `status` is the one call that says "working" or what died and what to do.
//   input per runner: online, last_seen (the server's view), counts, and what the Mac said (op health_report, client/watchdog.ts):
//     watchdog = the launchd watchdog's last check {at, state, tries, last_try, last_result, alerted, stopped_by_owner}
//     last_exit = why the runner process last ended {at, reason, stack} (client/runner.ts writes it on crash / signal)
export const BOOT = Date.now(); // when this server process (isolate) loaded: status.server.uptime_s
export const STALE_MS = 2 * 60_000, ALERT_MS = 10 * 60_000, WATCHDOG_FRESH_MS = 3 * 60_000, MAX_TRIES_HOUR = 3;

export const ago = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h${s % 3600 >= 60 ? ` ${Math.floor((s % 3600) / 60)}m` : ""}` : `${Math.floor(s / 86400)}d`; };

export type RunnerIn = { name: string; online: boolean; last_seen: string | null; running?: number; queued?: number; never_connected?: boolean;
  watchdog?: { at?: string; state?: string; tries?: number; last_try?: string | null; last_result?: string | null; alerted?: string | null; stopped_by_owner?: boolean } | null;
  last_exit?: { at?: string; reason?: string; stack?: string | null } | null; started_at?: string | null };
export type RunnerOut = RunnerIn & { state: "online" | "starting" | "stopped" | "unreachable" | "never_connected" | "stopped_by_owner"; down_s: number | null; healing: string | null; line: string; next: string | null; alert: boolean };

// One runner: what state it is in, one plain line, and the one next step (null = nothing to do).
export function runnerVerdict(r: RunnerIn, now = Date.now()): RunnerOut {
  const seen = r.last_seen ? Date.parse(r.last_seen) : NaN, down = r.online ? null : Number.isFinite(seen) ? now - seen : null;
  const w = r.watchdog ?? null, wAt = w?.at ? Date.parse(w.at) : NaN, wFresh = Number.isFinite(wAt) && now - wAt < WATCHDOG_FRESH_MS;
  const work = [r.running ? `${r.running} running` : "", r.queued ? `${r.queued} queued` : ""].filter(Boolean).join(", ");
  const base = { ...r, down_s: down == null ? null : Math.round(down / 1000), healing: null as string | null, alert: false };
  if (r.online) return { ...base, state: "online", line: `${r.name} is working${work ? ` (${work})` : ""}`, next: null };
  if (r.never_connected || (!r.last_seen && !w)) return { ...base, state: "never_connected", line: `${r.name} hasn't connected yet`, next: `Finish the install on the Mac (the line from /start, Connect your Mac), then check: kitebook status` };
  const waiting = work ? ` ${work} wait for it.` : "";
  // a just-dropped socket (a reconnect, a restart on new code) isn't an outage yet
  if (down != null && down < STALE_MS) return { ...base, state: "starting", line: `${r.name} dropped off ${ago(down)} ago and is probably reconnecting.${waiting}`, next: "Wait a minute and call status again." };
  const since = down != null ? ago(down) : "a while";
  if (w?.stopped_by_owner && wFresh) return { ...base, state: "stopped_by_owner", line: `${r.name}'s runner was stopped by the owner (kitebook stop) ${since} ago.${waiting}`, next: "On the Mac run: kitebook start runner (it stays stopped until then)" };
  const why = r.last_exit?.reason ? ` Last exit: ${String(r.last_exit.reason).slice(0, 200)}.` : "";
  if (wFresh) { // the Mac is up (its watchdog checks in every minute), the runner isn't
    const tries = Number(w?.tries ?? 0), failed = w?.state === "gave_up" || (tries >= MAX_TRIES_HOUR && w?.last_result !== "ok");
    const healing = failed ? `self-restart failed ${tries} time${tries === 1 ? "" : "s"} this hour${w?.last_result ? ` (${String(w.last_result).slice(0, 160)})` : ""}`
      : tries ? `the Mac's watchdog restarted it (try ${tries} of ${MAX_TRIES_HOUR} this hour) and is checking it came back` : "the Mac's watchdog restarts it within about 2 minutes";
    return { ...base, state: "stopped", healing, alert: failed && down != null && down >= ALERT_MS, line: `Runner stopped ${since} ago on ${r.name}: ${healing}.${why}${waiting}`,
      next: failed ? "On the Mac run: kitebook restart runner (then kitebook logs runner to see why it stops)" : "Nothing yet: the Mac is restarting it. Call status again in a few minutes; if it stays down, on the Mac run: kitebook restart runner" };
  }
  if (Number.isFinite(wAt)) // the watchdog used to report and went quiet too: the whole Mac is off, asleep or offline
    return { ...base, state: "unreachable", alert: down != null && down >= ALERT_MS, line: `Mac unreachable: ${r.name} last seen ${since} ago (the runner and its watchdog both went quiet: asleep, off or offline).${why}${waiting}`,
      next: "Wake the Mac or check its network; it reconnects by itself. If it's on and online, run there: kitebook restart runner" };
  // no watchdog report (an older runner): can't tell a dead runner from a sleeping Mac
  return { ...base, state: "stopped", alert: down != null && down >= ALERT_MS, line: `Runner stopped ${since} ago on ${r.name} (or the Mac is asleep or offline).${why}${waiting}`,
    next: "On the Mac run: kitebook restart runner (if the Mac is asleep or off, wake it; it reconnects by itself)" };
}

// The whole workspace: one verdict sentence ("Working" / "Runner stopped 2h ago" / "Mac unreachable"), ok, and the most urgent next step.
export function overall(rs: RunnerOut[]): { ok: boolean; verdict: string; next: string | null } {
  if (!rs.length) return { ok: false, verdict: "No Mac connected", next: "Connect a Mac: open /start, Connect your Mac, and run the install line there" };
  // a runner that never connected (an invite not used yet) doesn't make a working Mac "not working"; it's said only when it's all there is
  const live = rs.filter(r => r.state !== "never_connected"), bad = (live.length ? live : rs).filter(r => r.state !== "online"), rank = (r: RunnerOut) => ["stopped", "unreachable", "stopped_by_owner", "starting", "never_connected"].indexOf(r.state);
  if (!bad.length) return { ok: true, verdict: live.length < rs.length ? `Working (${rs.filter(r => r.state === "never_connected").map(r => r.name).join(", ")} hasn't connected yet)` : "Working", next: null };
  const b = [...bad].sort((x, y) => rank(x) - rank(y))[0], since = b.down_s != null ? ago(b.down_s * 1000) : null, many = rs.length > 1 ? ` (${b.name})` : "";
  const verdict = b.state === "stopped" ? `Runner stopped${since ? ` ${since} ago` : ""}${many}` : b.state === "unreachable" ? `Mac unreachable${many}${since ? `, last seen ${since} ago` : ""}`
    : b.state === "stopped_by_owner" ? `Runner stopped by the owner${many}` : b.state === "starting" ? `Reconnecting${many}` : `No Mac connected yet${many}`;
  const pool = live.length ? live : rs;
  return { ok: false, verdict: bad.length < pool.length ? `${verdict}; ${pool.length - bad.length} of ${pool.length} working` : verdict, next: b.next };
}

// Preflight (owner, 2026-10-23 13:35): before a task runs, is everything it needs there? At task_create (src/space/tasks.ts) and in
// status (each queued task). Pure, from what the runner last advertised (shared/runners/<name>.json) and reported (code_report):
//   problems = it can't run as asked ("codex isn't installed on mac"): task_create refuses while the runner is online (its advert is
//              current); offline, they're said as warnings since the Mac may have changed
//   notes    = it will wait or may fail ("mac's runner has been offline for 2h", "git fetch failed"): the task still queues
export type PreIn = { runner: string; online: boolean; last_seen: string | null; now?: number; advertised: boolean;
  agent: string | null; model?: string | null; project?: string | null;
  agents?: string[] | null; agents_detail?: { id: string; bin?: string; installed?: boolean; tasks?: boolean; issue?: string | null; responds?: boolean | null; responds_why?: string | null }[] | null;
  models?: Record<string, string[]> | null; model_catalogs?: Record<string, { authoritative?: boolean }> | null; projects?: Record<string, any> | null; code?: Record<string, any> | null };
export function preflight(i: PreIn): { problems: string[]; notes: string[] } {
  const now = i.now ?? Date.now(), problems: string[] = [], notes: string[] = [], seen = i.last_seen ? Date.parse(i.last_seen) : NaN;
  if (!i.online) notes.push(Number.isFinite(seen) ? (now - seen >= STALE_MS ? `${i.runner}'s runner has been offline for ${ago(now - seen)} (last seen ${new Date(seen).toISOString().slice(0, 16).replace("T", " ")} UTC): the task waits in the queue until it's back` : `${i.runner} is reconnecting (dropped off ${ago(now - seen)} ago)`)
    : `${i.runner} has never connected: the task waits until its runner starts`);
  if (!i.advertised) return { problems, notes: [...notes, `${i.runner} hasn't said what it has yet (agents, projects), so they couldn't be checked; it checks when it picks the task up`] };
  const a = i.agent, d = a ? (i.agents_detail ?? []).find(x => x.id === a) : null;
  if (a) {
    if (d && d.installed === false) problems.push(`${a} isn't installed on ${i.runner}${d.bin ? ` (its program ${d.bin} isn't on the runner's PATH: install it, or fix the agents entry in runner.json)` : ""}`);
    else if (d && d.tasks === false) problems.push(`${a} on ${i.runner} can't run tasks${d.issue ? `: ${d.issue}` : ""}`);
    else if (!d && i.agents?.length && !i.agents.includes(a)) problems.push(`${a} isn't set up on ${i.runner} (it has ${i.agents.join(", ")})`);
    if (d?.responds === false) notes.push(`${a} didn't answer on ${i.runner} at its last check${d.responds_why ? ` (${d.responds_why})` : ""}: the task may fail to start`);
    const ms = i.models?.[a]; if (i.model && i.model_catalogs?.[a]?.authoritative === true && Array.isArray(ms) && ms.length && !ms.some(m => m === i.model || m.endsWith("/" + i.model) || m === String(i.model).replace(/:[a-z]+$/, ""))) problems.push(`model ${i.model} isn't available for ${a} on ${i.runner}`);
  }
  const p = i.project && i.project !== "home" ? i.project : null;
  if (p && i.projects && !i.projects[p]) problems.push(`project ${p} isn't on ${i.runner}`);
  const c = p ? i.code?.[p] : null;
  if (c?.missing) problems.push(`${p} on ${i.runner}: ${c.error ?? "the checkout is gone"}`);
  else if (c?.error) notes.push(`${p} on ${i.runner}: git status failed (${c.error})`);
  if (c?.fetch_error?.error) notes.push(`git fetch of ${p} failed on ${i.runner} (the remote may be unreachable): ${c.fetch_error.error}`);
  return { problems, notes };
}
