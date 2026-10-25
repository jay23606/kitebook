// Space DO: task state machine, leases and held-time cap, results, live status, dispatch-time checks, chains, context packs, kill switch.
// One layer of the Space class chain (core -> gc -> events -> files -> tasks -> Space in src/space.ts); split for size only, no behavior lives in the chain itself.
import { sha256, RelayError, type Peer } from "../ops.ts";
import { chainStepText, normStep } from "../../client/chain.ts";
import { buildHeadline, weekLine } from "../../client/headline.ts";
import * as KB from "../kb.ts";
import { BRIEF_PATH } from "../brief.ts";
import { autoEntry, signStored } from "../policy.ts";
import { SESSION_ARGS } from "./sessions.ts";
import { type Change, ACTIVE, HELD, LIVE_PHASES, LIVE_LOG_MAX, PHASE_WORDS, STUCK_STATES, STUCK_MIN_DEFAULT, RECOVERABLE, SPEC_FIELDS, RELAY, OWNER, now, rid, redact, modelOk, KINDS, normSpec, CONTEXT_MAX, pickAllowed, CHANGE_ARGS, ASK_ARGS, CHANGE_MAX, slugify, guard, normPath } from "./util.ts";
import { SpaceFiles } from "./files.ts";
import { presenceView } from "./presence.ts";
import { ago, STALE_MS, preflight } from "../health.ts";
import { runnerHealth } from "./health.ts";
import { checkSteer } from "./steer.ts";
import type { Space, Op } from "../space.ts";
import { askToTask, askView } from "./ask.ts";

export class SpaceTasks extends SpaceFiles {
  // ---------- tasks ----------
  loadTask(id: string) {
    const t = this.sql.exec("select * from tasks where id=?", id).toArray()[0] as any;
    if (!t) throw new RelayError(404, "no such task");
    for (const k of ["scope", "limits", "result", "attempts", "spec", "chain", "kb_context", "change", "steers", "session"]) t[k] = t[k] ? JSON.parse(t[k]) : null;
    // qa = every question the target raised and its answer; `question` = the open one while the task is parked in needs_input
    t.questions = t.qa ? JSON.parse(t.qa) : []; delete t.qa;
    t.question = t.state === "needs_input" ? t.questions.filter((q: any) => !q.answered_at).pop() ?? null : null;
    const nm = (i: string) => this.member(i)?.name ?? i;
    let note: string | null = null;
    t.steers = t.steers ?? []; // live steering notes (task_steer): {n, by, message, at, delivered_at}
    const ev = this.sql.exec("select data from events where task_id=? and type like 'task.%' and type not in ('task.steered','task.steer_delivered') order by seq desc limit 1", id).toArray()[0] as any;
    if (ev) try { const d = JSON.parse(ev.data); note = d.note ?? d.reason ?? null; } catch {}
    return { ...t, note, space_id: this.spaceId, from: nm(t.from_peer), target: nm(t.target_peer), needs_approval: !!t.needs_approval };
  }
  taskFor(peer: Peer, id: string, role: "any" | "from" | "target") {
    const t = this.loadTask(id);
    const ok = role === "from" ? t.from_peer === peer.id : role === "target" ? t.target_peer === peer.id : (t.from_peer === peer.id || t.target_peer === peer.id);
    if (!ok) throw new RelayError(403, "not your task");
    return t;
  }
  // Compare-and-set: the update only applies if the task is still in one of `from` states (default: the state we read).
  // Anything that awaited in between (a commit, a blob upload) can't overwrite a cancel that landed meanwhile.
  setState(t: any, state: string, actor: Peer, data: any = {}, result?: any, from: string[] = [t.state]) {
    const c = this.sql.exec(`update tasks set state=?, updated=?, result=coalesce(?,result) where id=? and state in (${from.map(() => "?").join(",")})`,
      state, now(), result ? JSON.stringify(result) : null, t.id, ...from);
    if (!c.rowsWritten) throw new RelayError(409, `task is ${this.loadTask(t.id).state}`);
    this.heldMark(t.id, state);
    this.emit("task." + state, actor, { task: t.id, data: { title: t.title, ...data } });
    if (HELD.includes(state)) this.armAlarm(Math.min(Date.now() + this.leaseMs(t), this.heldDeadline(this.loadTask(t.id)), Date.now() + (this.stuckMs() || Infinity))).catch(() => {});
  }
  // ---------- held-seconds cap: a runner can keep a task alive by staying online (the lease never expires), so the time a task may be
  // held (claimed / awaiting_approval / running, summed over the attempt; needs_input parks the clock) is capped too. Default 24h
  // (MAX_HELD_SEC env, 0 = off); a task can only lower it (limits.max_held_sec). Over the cap = failed, not retried (it would just hit it again).
  heldMark(id: string, state: string) {
    if (HELD.includes(state)) this.sql.exec("update tasks set held_since=coalesce(held_since,?) where id=?", now(), id);
    else this.sql.exec("update tasks set held_acc=coalesce(held_acc,0)+cast(max(0,(julianday(?)-julianday(held_since))*86400) as integer), held_since=null where id=? and held_since is not null", now(), id);
  }
  heldCapSec(t: any): number {
    const env = this.knob("MAX_HELD_SEC", 86400), own = Number(t.limits?.max_held_sec);
    const cap = Number.isFinite(env) && env > 0 ? env : Infinity;
    return Number.isFinite(own) && own > 0 ? Math.min(own, cap) : cap;
  }
  heldSec(t: any): number { return Number(t.held_acc ?? 0) + (t.held_since ? Math.max(0, (Date.now() - Date.parse(t.held_since)) / 1000) : 0); }
  heldDeadline(t: any): number { const cap = this.heldCapSec(t); return cap === Infinity || !t.held_since ? Infinity : Date.parse(t.held_since) + (cap - Number(t.held_acc ?? 0)) * 1000; }
  // Retryable failures (lease expired, runner crashed) go back to the queue up to max_retries times (task_create, default 1)
  // instead of waiting for someone to re-dispatch. attempt / max_retries / attempts[] (history) are on task_get.
  failOrRetry(t: any, actor: Peer, why: { summary: string; reason: string }, result: any, from: string[]) {
    const tries = Number(t.attempt ?? 1), max = Number(t.max_retries ?? 1);
    if (tries > max) return this.setState(t, "failed", actor, { ...why, retryable: true, attempt: tries }, { ...result, ...why, retryable: true, retries_exhausted: max > 0 }, from);
    const hist = [...(t.attempts ?? []), { attempt: tries, reason: why.reason, was: t.state, approved: t.state === "running", at: now(), summary: why.summary.slice(0, 1000),
      ...(result?.commit ? { commit: result.commit, files: result.files } : {}) }];
    const c = this.sql.exec(`update tasks set state='queued', attempt=?, attempts=?, result=null, updated=?, held_since=null, held_acc=0 where id=? and state in (${from.map(() => "?").join(",")})`,
      tries + 1, JSON.stringify(hist), now(), t.id, ...from);
    if (!c.rowsWritten) throw new RelayError(409, `task is ${this.loadTask(t.id).state}`);
    this.sql.exec("delete from task_live where task_id=?", t.id); // the next attempt reports its own live status
    this.emit("task.retrying", actor, { task: t.id, data: { title: t.title, reason: why.reason, summary: why.summary.slice(0, 2000), attempt: tries + 1, max_attempts: max + 1 } });
    this.emit("task.queued", actor, { task: t.id, data: { title: t.title, target: t.target, attempt: tries + 1, retry: true } });
  }
  // ---------- needs_input round-trip: the target parks the task with a question, the sender answers, the runner resumes ----------
  async answerTask(t: any, peer: Peer, answer: string) {
    if (t.state !== "needs_input") throw new RelayError(409, `task is ${t.state}; only a task in needs_input takes an answer`);
    if (t.from_peer !== peer.id && peer !== OWNER) throw new RelayError(403, "only the sender (or the account owner, from /start) answers a task's question");
    guard("x", answer);
    const qs = t.questions as any[], q = qs.filter(x => !x.answered_at).pop() ?? null;
    if (q) Object.assign(q, { answer, answered_at: now(), answered_by: peer.name });
    await this.appendTaskFile(t, peer, "thread.md", `Answer${q ? ` to "${q.text}"` : ""}:\n${answer}`);
    this.sql.exec("update tasks set qa=? where id=?", JSON.stringify(qs), t.id);
    // back to running (leased again); the runner resumes the same agent session with the answer
    this.setState(t, "running", peer, { answer: answer.slice(0, 2000), question: q?.text?.slice(0, 2000) ?? null, round: q?.round ?? null, resumed: true }, undefined, ["needs_input"]);
    const pr = this.presence(this.member(t.target_peer) as any);
    return { id: t.id, state: "running", question: q?.text ?? null, answer, target_online: pr.online, delivery: pr.online ? "the runner resumes the agent now" : "the target is offline; it resumes when it reconnects (lease applies)" };
  }
  // ---------- live steering (G4): a note from the task's sender or the owner, delivered to the running agent at its next turn boundary ----------
  // Scoped on purpose: no message injection into arbitrary sessions. Only an open task, only its sender or the account owner (/start), never
  // the agent that holds it. Kept on the task (steers[], thread.md: the audit trail) and pushed as task.steered, which wakes the target at
  // once (socket, long-poll, webhook). The runner takes undelivered notes with task_steer_take when the agent's turn ends (or before its
  // first turn) and runs the next turn in the same session with them; that marks them delivered (task.steer_delivered).
  async steerTask(t: any, peer: Peer, message: string) {
    const msg = checkSteer(t, peer === OWNER ? { owner: true } : { id: peer.id }, message), steers = (t.steers ?? []) as any[];
    const n = steers.length + 1, by = peer === OWNER ? "owner" : peer.name, at = now();
    steers.push({ n, by, message: msg, at, delivered_at: null, ...(peer === OWNER ? { owner: true } : {}) }); // owner: written on /start (the runner gives it without asking)
    this.sql.exec("update tasks set steers=? where id=?", JSON.stringify(steers), t.id);
    await this.appendTaskFile(t, peer, "thread.md", `Steer #${n} (for the agent's next turn):\n${msg}`);
    this.emit("task.steered", peer, { task: t.id, data: { title: t.title, n, by, message: msg.slice(0, 2000), target: t.target } });
    const tg = this.member(t.target_peer) as any, pr = this.presence(tg), runner = tg?.kind === "runner";
    const started = runner && ["running", "claimed"].includes(t.state) && this.liveFor(t).phase === "agent_running";
    return { id: t.id, n, state: t.state, by, target_online: pr.online,
      delivery: !runner ? `in ${t.target}'s inbox (messages) and pushed to it now` : started ? `the agent gets it when its current turn ends, in the same session${pr.online ? "" : ` (${t.target} is offline right now; it gets it when it reconnects)`}`
        : `the agent gets it with its first turn${t.state === "awaiting_approval" ? " once the task is approved" : ""}` };
  }
  // ---------- server-side leases ----------
  leaseMs(t: any) {
    const s = Number(t.limits?.lease_sec ?? (this.env as any).LEASE_SEC ?? 900);
    return Math.min(Math.max(Number.isFinite(s) ? s : 900, 3), 86400) * 1000;
  }
  // ---------- cancel + structured results ----------
  cancelTask(t: any, peer: Peer, reason?: string) {
    const r = { reason: reason ?? null, cancelled_by: peer.name, cancelled_at: now(), was: t.state };
    this.setState(t, "cancelled", peer, { reason: reason ?? null, by: peer.name, was: t.state }, r, ACTIVE);
    return { id: t.id, state: "cancelled", reason: r.reason, cancelled_by: peer.name };
  }
  async cancelledReport(t: any, peer: Peer, a: any) {
    if (t.state !== "cancelled") throw new RelayError(409, `task is ${t.state}`);
    const files: Change[] = [{ path: `tasks/${t.id}/summary.md`, content: redact(String(a.summary ?? "")) }];
    for (const [name, content] of Object.entries(a.artifacts ?? {})) {
      const p = `tasks/${t.id}/${normPath(name).replace(/\//g, "_")}`; guard(p); files.push({ path: p, content: redact(String(content)) });
    }
    const c = await this.commit(peer, files, `task ${t.id}: cancelled (partial report)`);
    const sr = a.result ? this.cleanResult(a.result) : t.result?.structured;
    const res = { ...(t.result ?? {}), summary: files[0].content, files: files.map(f => f.path), commit: c.commit, ...(a.result ? { structured: sr } : {}), headline: this.cardOf(t, { ...a, reason: t.result?.reason ?? a.reason }, sr) };
    this.sql.exec("update tasks set result=?, updated=? where id=? and state='cancelled'", JSON.stringify(res), now(), t.id);
    this.emit("task.report", peer, { task: t.id, data: { title: t.title, state: "cancelled", reason: res.reason ?? null, files: res.files } });
    return { id: t.id, state: "cancelled", files: res.files };
  }
  // Result headline (C16): the runner's card (result.card) is lifted out of the structured block into result.headline; a target that
  // sends none (an assistant, an older runner) gets the same card built here from its structured result. Redacted and capped.
  cardOf(t: any, a: any, sr: any) {
    const c = a.result?.card ?? a.headline;
    if (c && typeof c === "object" && Array.isArray(c.lines) && typeof c.outcome === "string" && c.next && typeof c.next === "object") {
      const s = redact(JSON.stringify(c)); if (s.length <= 6000) { const h = JSON.parse(s); h.lines = h.lines.slice(0, 8).map((l: any) => String(l).slice(0, 400)); return h; }
    }
    return buildHeadline({ id: t.id, title: t.title, state: a.status === "succeeded" ? "succeeded" : a.status === "cancelled" ? "cancelled" : "failed", sr, reason: a.reason ?? null });
  }
  // the card for any finished task (stored, or built from what the server has: a rejection, a cancel before the runner reported)
  headlineFor(t: any) {
    if (!["succeeded", "failed", "cancelled", "rejected"].includes(t.state)) return null;
    const r = t.result ?? {}; if (r.headline) return r.headline;
    return buildHeadline({ id: t.id, title: t.title, state: t.state, sr: r.structured, reason: r.reason ?? t.note ?? null, wall_s: this.liveFor(t).elapsed_s });
  }
  // The weekly payoff line (C22) for the Status card: measured numbers only (tasks finished, agent wall time from the runners'
  // results, task branches the runners saw merged into the default branch). No estimated "time saved".
  weekStats() {
    const since = new Date(Date.now() - 7 * 86400_000).toISOString();
    const rows = this.sql.exec("select state, result from tasks where state in ('succeeded','failed') and coalesce(kind,'')<>'ask' and updated>? order by updated desc limit 5000", since).toArray() as any[];
    const merged = new Set<string>(); let reported = false;
    for (const r of this.sql.exec("select data from code_state").toArray() as any[]) try {
      for (const p of Object.values<any>(JSON.parse(r.data))) if (Array.isArray(p?.merged_heads)) { reported = true; for (const h of p.merged_heads) merged.add(String(h).slice(0, 12)); }
    } catch {}
    let done = 0, failed = 0, agent_s = 0, nMerged = 0;
    for (const r of rows) { let res: any = {}; try { res = JSON.parse(r.result ?? "null") ?? {}; } catch {}
      const sr = res.structured ?? {}, w = Number(res.headline?.wall_s ?? sr.duration_s); if (Number.isFinite(w) && w > 0) agent_s += w;
      if (r.state === "succeeded") done++; else failed++;
      if (sr.commit && (sr.files_changed ?? []).length && merged.has(String(sr.commit).slice(0, 12))) nMerged++; }
    const w = { since, done, failed, agent_s: Math.round(agent_s), merged: reported ? nMerged : null };
    return { ...w, line: weekLine(w) };
  }
  cleanResult(r: any) { // runner-built {status, headline, tests, files_changed, branch, pr_url, risk_flags, duration_s}; redacted and capped
    if (r && typeof r === "object" && "card" in r) { r = { ...r }; delete r.card; } // the card lives at result.headline
    let s = redact(JSON.stringify(r ?? {})); if (s.length > 16000) s = JSON.stringify({ status: r?.status, headline: String(r?.headline ?? "").slice(0, 280), truncated: true });
    return JSON.parse(s);
  }
  resultBlock(t: any) {
    if (!["succeeded", "failed", "cancelled", "rejected"].includes(t.state) || !t.result) return {};
    try { const r = typeof t.result === "string" ? JSON.parse(t.result) : t.result; return r?.structured ? { result: r.structured } : r?.reason !== undefined ? { reason: r.reason, cancelled_by: r.cancelled_by } : {}; } catch { return {}; }
  }
  // ---------- live session status: what the runner is doing right now (phase, agent, model, session, last log line) ----------
  // One row per task, overwritten by the runner (task_live). Not an event: it changes every few seconds and would wake every poller.
  liveFor(t: any) {
    const row = this.sql.exec("select data, updated from task_live where task_id=?", t.id).toArray()[0] as any, d = row ? JSON.parse(row.data) : {};
    const phase = !ACTIVE.includes(t.state) ? "done" : t.state === "queued" ? "queued" : t.state === "awaiting_approval" ? "waiting_approval" : d.phase ?? "approved";
    const end = d.ended_at ? Date.parse(d.ended_at) : phase === "done" ? Date.parse(t.updated) : Date.now();
    return { phase, agent: d.agent ?? t.agent ?? null, model: d.model ?? t.model ?? null, session: d.session ?? null, started_at: d.started_at ?? null,
      elapsed_s: d.started_at ? Math.max(0, Math.round((end - Date.parse(d.started_at)) / 1000)) : null, last_line: d.last_line ?? null,
      updated: row?.updated ?? null, log: d.log ? `tasks/${t.id}/live.log` : null };
  }
  // ---------- stuck detection (C18): quiet = no state change, progress note or live update (task_live) for stuckMs ----------
  stuckMs(): number {
    const v = this.sql.exec("select v from meta where k='stuck_min'").toArray()[0]?.v, n = v != null ? Number(v) : this.knob("STUCK_MIN", STUCK_MIN_DEFAULT);
    return Number.isFinite(n) && n > 0 ? n * 60_000 : 0;
  }
  async setStuck(minutes: number | null) { // admin stuck <space> [minutes]: show, or set (0 = off; decimals allowed, so tests can use seconds)
    if (minutes != null) {
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) throw new Error("minutes: 0-1440 (0 = off)");
      this.sql.exec("insert or replace into meta values('stuck_min',?)", String(minutes));
      await this.armAlarm(Date.now() + 1000); // re-check open tasks against the new threshold
    }
    const ms = this.stuckMs(); return { space: this.spaceId, stuck_minutes: ms / 60_000, note: ms ? `a claimed or running task with no progress for ${ms / 60_000} min shows as "stuck?" and its sender is notified once` : "stuck detection is off" };
  }
  lastActivity(t: any): number {
    const lv = this.sql.exec("select updated from task_live where task_id=?", t.id).toArray()[0] as any;
    return Math.max(Date.parse(t.updated) || 0, Date.parse(lv?.updated ?? "") || 0);
  }
  // null, or what the owner and the sender need to judge it. The first look after the threshold (status read or the alarm) raises it:
  // one peer.notify to the sender, and stuck_at so the same quiet spell never notifies again (new activity starts a new spell).
  stuckOf(t: any, last_line?: string | null) {
    const ms = this.stuckMs(); if (!ms || !STUCK_STATES.includes(t.state)) return null;
    const last = this.lastActivity(t), quiet = Date.now() - last; if (quiet < ms) return null;
    const ll = last_line !== undefined ? last_line : this.liveFor(t).last_line, min = Math.max(1, Math.round(quiet / 60_000));
    const info = { quiet_s: Math.round(quiet / 1000), since: new Date(last).toISOString(), last_line: ll ? String(ll).slice(0, 300) : null, threshold_min: ms / 60_000,
      label: `stuck? no progress for ${quiet < 90_000 ? Math.round(quiet / 1000) + " s" : min + " min"}` };
    if (!(t.stuck_at && Date.parse(t.stuck_at) >= last)) {
      const c = this.sql.exec("update tasks set stuck_at=? where id=? and (stuck_at is null or stuck_at<?)", now(), t.id, new Date(last).toISOString());
      const from = c.rowsWritten ? this.member(t.from_peer) : null;
      if (from && !from.revoked) {
        const message = redact(`Task ${t.id} "${String(t.title ?? "").slice(0, 80)}" on ${t.target} looks stuck: no progress for ${min} min${ll ? `. Last line: ${String(ll).slice(0, 200)}` : ""}. Check it (task_status), cancel it, or let the owner retry it from /start.`).slice(0, 2000);
        const ev = this.emit("peer.notify", RELAY, { data: { to: from.name, message, task: t.id, stuck: true, quiet_s: info.quiet_s } });
        if (from.webhook) this.outboxAdd("peer", from.peer_id, ev.seq, ev.seq, JSON.stringify(ev));
      }
    }
    return info;
  }
  // A runner's open tasks for peers: phase/agent/model/elapsed for everyone; title and last line only for the tasks you're party to.
  activeTasks(runner: any, peer: Peer) {
    return this.sql.exec(`select id from tasks where target_peer=? and state in (${ACTIVE.map(() => "?").join(",")}) order by created`, runner.peer_id, ...ACTIVE).toArray().map((r: any) => {
      const t = this.loadTask(r.id), mine = t.from_peer === peer.id || t.target_peer === peer.id, l: any = this.liveFor(t);
      return { id: t.id, state: t.state, phase: l.phase, agent: l.agent ?? null, model: l.model ?? null, elapsed_s: l.elapsed_s ?? null, ...(mine ? { title: t.title, last_line: l.last_line ?? null } : { from: t.from }) };
    });
  }
  // The owner's glance (the /start status card, from a phone): who is connected and online, what is in flight, what waits for the owner, what just finished.
  // Titles/last lines are peer-written, so the page renders them as text only. Capped so a busy space stays one small read.
  // "Updated to X" on the Status card: the newest install or roll-back in the Mac's own Updates report (settings_report), for 3 days
  lastUpdate(name: string): { updated?: { result: string; to: string | null; at: string; why: string | null } } {
    const h = ((this as any).metaJ("rset:" + name) ?? {}).update?.history?.[0];
    if (!h || !["installed", "rolled back"].includes(h.result) || !(Date.now() - Date.parse(h.at) < 3 * 86400_000)) return {};
    const s = (v: any, n: number) => v == null ? null : String(v).slice(0, n);
    return { updated: { result: h.result, to: s(h.release ? "release " + h.release : h.to, 40), at: String(h.at).slice(0, 30), why: s(h.why, 200) } };
  }
  async ownerStatus(acct?: string) {
    const peers = await Promise.all((this.sql.exec("select * from members where revoked=0").toArray() as any[]).map(async m => {
      const p = this.presence(m), busy = m.kind === "runner" ? Number((this.sql.exec(`select count(*) n from tasks where target_peer=? and state in (${ACTIVE.map(() => "?").join(",")})`, m.peer_id, ...ACTIVE).one() as any).n) : 0;
      const ad = m.kind === "runner" ? await this.runnerCaps(m.name, true) : null, ap = ad?.approval; // the runner advertises when it can't reach its owner, and how it asks (approve_ways, phone_on: the "turn on phone approvals" offer)
      return { name: m.name, kind: m.kind, online: p.online, last_seen: p.last_seen, ...(!p.online && !p.last_seen ? { never_connected: true } : {}), ...(m.kind === "runner" ? { busy, approve_ways: ad?.approve_ways ?? null, ...(ad?.phone_on ? { phone_on: String(ad.phone_on).slice(0, 400) } : {}) } : {}), ...(ap?.ok === false ? { approval_unreachable: String(ap.error ?? "unknown").slice(0, 300) } : {}), ...(m.kind === "runner" ? this.lastUpdate(m.name) : {}),
        ...(m.kind === "runner" ? ((h: any) => ({ health: { state: h.state, down_s: h.down_s, line: h.line, next: h.next, healing: h.healing, alert: h.alert } }))(runnerHealth(this as any, m)) : {}) }; // the Home "Mac is down" banner (src/health.ts)
    }));
    // recovery (C20): what the card's Retry / Retry with a note / Hand to another agent need: the runner's advertised agents (the picker)
    // and whether it was already retried (the newest follow-up of it)
    const caps = new Map<string, Promise<any>>(), recover = async (t: any) => {
      const tg = this.member(t.target_peer) as any; if (!caps.has(t.target)) caps.set(t.target, tg?.kind === "runner" ? this.runnerCaps(t.target) : Promise.resolve(null));
      const ad = await caps.get(t.target), again = this.sql.exec("select id, state from tasks where continue_from=? order by created desc limit 1", t.id).toArray()[0] as any;
      return { agents: Array.isArray(ad?.agents) ? ad.agents.map(String).slice(0, 30) : [], agent: t.agent ?? ad?.default_agent ?? null, ...(again ? { retried_as: { id: again.id, state: again.state } } : {}) };
    };
    const brief = async (t: any) => { const l: any = this.liveFor(t), st = this.stuckOf(t, l.last_line);
      return { id: t.id, title: String(t.title ?? "").slice(0, 120), state: t.state, from: t.from, target: t.target, phase: l.phase, doing: PHASE_WORDS[l.phase] ?? l.phase, agent: l.agent ?? null, model: l.model ?? null,
        elapsed_s: l.elapsed_s ?? null, last_line: l.last_line ? String(l.last_line).slice(0, 160) : null, last_activity: new Date(this.lastActivity(t)).toISOString(), updated: t.updated, ...(t.limits?._auto ? { auto: t.limits._auto } : {}), ...(st ? { stuck: st, recover: await recover(t) } : {}), ...steerBrief(t) }; };
    const steerBrief = (t: any) => { const s = (t.steers ?? []) as any[]; if (!s.length) return {}; const last = s[s.length - 1];
      return { steers: { count: s.length, pending: s.filter(x => !x.delivered_at && !x.refused_at).length, last: { n: last.n, by: last.by, message: String(last.message).slice(0, 300), at: last.at, delivered_at: last.delivered_at, refused_at: last.refused_at ?? null } } }; };
    const open = (await Promise.all(this.sql.exec(`select id from tasks where state in (${ACTIVE.map(() => "?").join(",")}) and (coalesce(kind,'')<>'ask' or state='awaiting_approval') order by created desc limit 30`, ...ACTIVE).toArray().map((r: any) => brief(this.loadTask(r.id)))))
      .sort((a: any, b: any) => Number(!!b.stuck) - Number(!!a.stuck)); // stuck first: it's what needs a look
    // needs_you rows carry what the owner can do about them here: the runner's live review page (approve/reject; passkey: the page only), or the open question
    const needs = open.filter((t: any) => t.state === "awaiting_approval" || t.state === "needs_input").map((t: any) => {
      if (t.state === "needs_input") { const q = (this.loadTask(t.id).questions ?? []).filter((x: any) => !x.answered_at).pop(); return { ...t, question: q?.text ? String(q.text).slice(0, 2000) : null, why: "the agent asked a question: answer it here (or the sender answers with task_answer)" }; }
      const ask = this.sql.exec("select id, passkey from asks where task=? and kind='approve' and state='pending' and expires>? order by owner_only desc, created desc limit 1", t.id, Date.now()).toArray()[0] as any;
      // already approved (here, on the review page or the phone) and the runner hasn't moved it to running yet: say so, no buttons
      if (!ask && (this.sql.exec("select state from asks where task=? and kind='approve' order by created desc limit 1", t.id).toArray()[0] as any)?.state === "approved")
        return { ...t, review: null, passkey: false, approved: true, why: "Approved, starting… (the runner checks your approval, then the agent starts)" };
      const down = peers.find((p: any) => p.name === t.target)?.approval_unreachable; // R10: the runner's push failed, so this page is the way to decide
      return { ...t, review: ask && acct ? `/approve/${acct}.${this.spaceId}.${ask.id}` : null, passkey: !!ask?.passkey, ...(down ? { approvals_down: down } : {}),
        why: ask && down ? `approvals down (${down}): the runner couldn't push to your phone, so decide here: ${ask.passkey ? "open the review page and approve with your passkey" : "approve or reject here or on the review page"}. Nothing was declined; it keeps retrying the push` : ask ? (ask.passkey ? "waiting for your approval: open the review page and approve with your passkey (or on the Mac)" : "waiting for your approval: approve or reject here, on the review page, or on the Mac") : "waiting for your approval on the runner (its Mac dialog; this runner hasn't opened a review page)" };
    });
    const recent = await Promise.all(this.sql.exec("select id from tasks where state in ('succeeded','failed','rejected','cancelled') and coalesce(kind,'')<>'ask' order by updated desc limit 5").toArray().map(async (r: any) => { const t = this.loadTask(r.id), rs = t.result ?? {};
      const hl = this.headlineFor(t), br = rs.structured?.branch ?? null, ci = ((this as any).ciRuns() as any[]).find(c => c.task === t.id || (br && c.branch === br && c.project === t.project)); // local CI (client/ci.ts): its newest run
      return { id: t.id, title: String(t.title ?? "").slice(0, 120), state: t.state, from: t.from, target: t.target, updated: t.updated, project: t.project ?? null, ...(ci ? { ci: { state: ci.state, passed: ci.passed, failed: ci.failed, secs: ci.secs, at: ci.at, sha: ci.sha } } : {}), agent: rs.structured?.agent ?? t.agent ?? null, model: rs.structured?.model ?? t.model ?? null,
        headline: String(rs.structured?.headline ?? rs.summary ?? rs.reason ?? t.note ?? "").slice(0, 200) || null, branch: rs.structured?.branch ?? null, ...(t.limits?._auto ? { auto: t.limits._auto } : {}),
        ...(hl ? { result_headline: { outcome: hl.outcome, label: hl.label, lines: hl.lines, next: hl.next, wall_s: hl.wall_s } } : {}), ...(RECOVERABLE.includes(t.state) ? { recover: await recover(t) } : {}) }; }));
    // quick asks (src/space/ask.ts): a light row each, the last day's newest five, with the answer's first lines and Run as a task
    const quick = (this.sql.exec("select id from tasks where kind='ask' and created>? order by created desc limit 5", new Date(Date.now() - 86400_000).toISOString()).toArray() as any[]).map(r => {
      const v = askView(this as unknown as Space, this.loadTask(r.id));
      const t = this.loadTask(r.id); // updated: /start merges quick asks into Recent by time
      return { id: v.id, question: String(v.question ?? "").slice(0, 160), state: v.state, done: v.done, from: t.from, updated: t.updated, target: v.to, agent: v.agent, answer_s: v.answer_s, warm: v.session?.warm ?? null,
        answer: String(v.answer ?? v.partial ?? v.error ?? "").slice(0, 400) || null, needs_task: v.needs_task ? String(v.needs_task).slice(0, 200) : null, ran_as_task: (v as any).ran_as_task ?? null }; });
    const done_tasks = Number((this.sql.exec("select count(*) n from tasks where state='succeeded'").one() as any).n); // /start's Get started step 3
    const has_shared = this.sql.exec("select 1 from tree where path like 'kb/%' or path like 'context/%' or (path like 'shared/%' and path not like 'shared/runners/%') limit 1").toArray().length > 0;
    const pz = this.pauseState();
    return { space: this.spaceId, peers, open, needs_you: needs, recent, quick, week: this.weekStats(), done_tasks, has_shared, paused: pz.all || Object.keys(pz.peers).length ? pz : null, autorun: (this as any).autorunState(), experimental: (this as any).experimentalState(), working: presenceView(this as any, null) };
  }
  // The owner tapping a Status row (UX review #3): one task in detail, its headline (with the ONE next action), the summary, and the diff +
  // test log the runner already saved under tasks/<id>/. Read-only; peer-written text, rendered with textContent only by the page.
  async ownerTask(id: string) {
    const t = this.loadTask(String(id ?? "")), r = t.result ?? {}, CAP = 30000;
    const file = async (name: string) => { const sha = this.blobAt(`tasks/${t.id}/${name}`); if (!sha) return null;
      const b = await this.body(sha); if (b.enc !== "utf8") return null; return b.data.length > CAP ? b.data.slice(0, CAP) + `\n… (cut at ${CAP} chars; the whole file is tasks/${t.id}/${name})` : b.data; };
    return { id: t.id, title: String(t.title ?? "").slice(0, 200), state: t.state, from: t.from, target: t.target, project: t.project ?? null, created: t.created, updated: t.updated,
      headline: this.headlineFor(t), summary: r.summary ? String(r.summary).slice(0, 8000) : r.reason ?? null,
      diff: await file("diff.patch"), tests_log: (await file("verify.log")) ?? (await file("acceptance.log")), files: (r.files ?? []).slice(0, 50),
      steers: (t.steers ?? []).map((x: any) => ({ ...x, message: String(x.message).slice(0, 2000) })), timeline: this.timeline(t.id) };
  }
  // The task's story in plain words, oldest first, from the event log (state changes, questions, answers, steers and their delivery).
  timeline(id: string) {
    const W: Record<string, string> = { queued: "sent", claimed: "picked up by the runner", awaiting_approval: "waiting for approval", running: "running", needs_input: "asked a question",
      succeeded: "finished", failed: "failed", rejected: "rejected", cancelled: "cancelled", retrying: "retrying", report: "partial report saved", recovered: "retried by the owner", message: "message", steered: "steer", steer_delivered: "steer delivered to the agent" };
    return (this.sql.exec("select type, actor, data, at from events where task_id=? and type like 'task.%' order by seq limit 200", id).toArray() as any[]).map(e => {
      const k = String(e.type).slice(5), d = (() => { try { return JSON.parse(e.data); } catch { return {}; } })();
      const text = k === "steered" ? `Steer #${d.n} from ${d.by ?? e.actor}: ${String(d.message ?? "").slice(0, 300)}` : k === "steer_delivered" ? `Steer ${(d.n ?? []).map((x: any) => "#" + x).join(", ")} delivered to the agent`
        : k === "needs_input" ? `Asked: ${String(d.question ?? "").slice(0, 300)}` : k === "running" && d.answer ? `Answered by ${e.actor}: ${String(d.answer).slice(0, 300)}` : k === "message" ? `${e.actor}: ${String(d.message ?? "").slice(0, 300)}`
        : `${cap1(W[k] ?? k)}${e.actor && !["relay"].includes(e.actor) ? ` (${e.actor})` : ""}`;
      return { at: e.at, type: e.type, actor: e.actor, text };
    });
  }
  // The owner acting from the /start Status card (session + one-time nonce, checked by the front door before this is called).
  // approve/reject decide the runner's live review page, exactly as the page itself would (the runner still checks its HMAC nonce
  // and payload hash, and a passkey runner only takes a passkey-signed approval, so here only Reject goes through for it).
  async ownerAct(a: any) {
    const t = this.loadTask(String(a.task ?? "")); if (!t) throw new RelayError(404, "no such task in this space");
    const act = String(a.action ?? "");
    if (act === "approve" || act === "reject") {
      if (t.state !== "awaiting_approval") throw new RelayError(409, `task is ${t.state}; nothing to approve`);
      const ask = this.sql.exec("select id, passkey from asks where task=? and kind='approve' and state='pending' and expires>? order by owner_only desc, created desc limit 1", t.id, Date.now()).toArray()[0] as any;
      if (!ask) throw new RelayError(409, "this runner hasn't opened a review page for it (older runner or terminal prompt): approve on the runner");
      if (act === "approve" && ask.passkey) throw new RelayError(403, "this runner requires your passkey: open the review page and approve there");
      const r = await this.askDecide(ask.id, { decision: act === "approve" ? "approved" : "rejected" });
      if (r.status !== 200) throw new RelayError(r.status, r.error ?? "not decided");
      return { id: t.id, decision: r.state, note: "the runner checks it and starts (or stops) within seconds" };
    }
    if (act === "answer") {
      const ans = String(a.answer ?? "").trim(); if (!ans) throw new RelayError(400, "answer: write the reply to the agent's question");
      return await this.answerTask(t, OWNER, ans.slice(0, 8000));
    }
    if (act === "steer") return await this.steerTask(t, OWNER, String(a.message ?? "").slice(0, 4000));
    if (act === "cancel") {
      if (!ACTIVE.includes(t.state)) throw new RelayError(409, `task is ${t.state}; nothing to cancel`);
      return this.cancelTask(t, OWNER, String(a.reason ?? "cancelled by the owner from /start").slice(0, 500));
    }
    if (act === "retry" || act === "retry_note" || act === "handoff") return await this.recoverTask(t, act, a);
    if (act === "ask_task") { // a quick ask's Run as a task: sent as the asker (it gets the result), approved on the runner like any task
      const from = this.member(t.from_peer) as any; if (!from || from.revoked) throw new RelayError(409, `the asker (${t.from}) is no longer connected; ask again from an agent`);
      const r = await askToTask(this as unknown as Space, t, { id: from.peer_id, name: from.name, kind: from.kind }, {});
      return { ...r, note: `sent as task ${r.id} from ${from.name}; ${r.needs_approval === true ? "the runner asks you to approve it" : "the runner picks it up"}` };
    }
    throw new RelayError(400, "action: approve | reject | answer | steer | cancel | retry | retry_note | handoff | ask_task");
  }
  // One-tap recovery (C20) for a failed, rejected, cancelled or stuck task: a follow-up (continue_from) on the same branch, sent as the
  // original sender (it gets the result, the same as its own follow-up) and carrying the original instructions word for word, plus the
  // owner's note. handoff = the same with another of the runner's agents. A stuck task is cancelled first (its partial work stays on
  // its branch). The new task is unsigned, so the runner asks for approval as usual (a passkey runner still wants the passkey).
  async recoverTask(t: any, act: string, a: any) {
    const stuck = RECOVERABLE.includes(t.state) ? null : this.stuckOf(t);
    if (!RECOVERABLE.includes(t.state) && !stuck) throw new RelayError(409, `task is ${t.state}; retry works on a failed, rejected, cancelled or stuck task`);
    const note = String(a.note ?? "").trim().slice(0, 2000); if (act === "retry_note" && !note) throw new RelayError(400, "note: write what the agent should do differently");
    if (note) guard("x", note);
    let agent: string | null = null;
    if (act === "handoff") {
      const ad = await this.runnerCaps(t.target), agents: string[] = Array.isArray(ad?.agents) ? ad.agents.map(String) : [];
      agent = String(a.agent ?? "").trim();
      if (!agent || (agents.length && !agents.includes(agent))) throw new RelayError(400, `agent: pick one of ${t.target}'s agents: ${agents.join(", ") || "(none advertised)"}`);
    }
    const from = this.member(t.from_peer) as any;
    if (!from || from.revoked) throw new RelayError(409, `the sender (${t.from}) is no longer connected, so there is nobody to send the result to; dispatch it again from an agent`);
    if (this.pausedFor(from.name)) throw new RelayError(409, "paused by the owner (kill switch): resume first");
    if (stuck) this.cancelTask(t, OWNER, `looked stuck (quiet ${Math.round(stuck.quiet_s / 60)} min); ${agent ? `handed to ${agent}` : "retried"} by the owner from /start`);
    const p = this.loadTask(t.id), rs = p.result ?? {}, why = String(rs.structured?.headline ?? rs.reason ?? p.note ?? "").split("\n")[0].slice(0, 300);
    const ins = `${p.instructions}\n\n---\n${agent ? `Handed over to ${agent}` : "Retried"} by the owner: the earlier attempt (task ${p.id}) ${stuck ? "looked stuck and was stopped" : p.state}${why ? `: ${why}` : ""}.`
      + ` Whatever it committed is already on this branch; check it, then finish the task above.${note ? `\n\nOwner's note: ${note}` : ""}`;
    const lim = { ...(p.limits ?? {}) }; delete lim._sig; delete lim._idem;
    const args: any = { space: this.spaceId, target: p.target, title: `${agent ? `Handoff to ${agent}` : "Retry"}: ${String(p.title).replace(/^(Retry|Handoff to [^:]+): /, "")}`.slice(0, 200), instructions: ins, continue_from: p.id,
      ...(agent ? { agent } : {}), ...(p.project ? { project: p.project } : {}), ...(p.scope?.length ? { scope: p.scope } : {}), ...(p.acceptance ? { acceptance: p.acceptance } : {}),
      ...(p.verify ? { verify: p.verify } : {}), ...(p.kind ? { kind: p.kind } : {}), ...(Object.keys(lim).length ? { limits: lim } : {}), max_retries: Number(p.max_retries ?? 1),
      ...(p.spec ? { spec: Object.fromEntries(SPEC_FIELDS.filter(k => p.spec[k] != null).map(k => [k, k === "goal" ? ins : p.spec[k]])) } : {}) };
    const r = await (this as unknown as Space).impl.task_create({ id: from.peer_id, name: from.name, kind: from.kind }, args);
    this.emit("task.recovered", OWNER, { task: p.id, data: { title: p.title, action: act, new_task: r.id, agent, stuck: !!stuck } });
    return { id: r.id, retry_of: p.id, action: act, target: r.target, agent: agent ?? p.agent ?? null, state: r.state, needs_approval: r.needs_approval, ...(stuck ? { stopped: p.id } : {}),
      note: `${agent ? `handed to ${agent}` : "retried"} as ${r.id} on the same branch; ${r.needs_approval === true ? "the runner asks you to approve it" : "the runner picks it up"}` };
  }
  // Agent/model picked on task_create: checked against what the target runner advertises at shared/runners/<name>.json (when it does).
  async checkAgentModel(target: string, a: any) {
    const sha = this.blobAt(`shared/runners/${target}.json`); if (!sha) return; // not advertised: the runner validates on claim
    let ad: any; try { ad = JSON.parse(await this.content(sha)); } catch { return; }
    const agents: string[] = ad.agents ?? [];
    if (a.agent != null && agents.length && !agents.includes(a.agent)) throw new RelayError(400, `agent "${a.agent}" is not available on ${target}; agents: ${agents.join(", ")}`);
    const agent = a.agent ?? ad.projects?.[a.project]?.agent ?? ad.default_agent;
    const models: string[] = Array.isArray(ad.models?.[agent]) ? ad.models[agent] : [];
    if (a.model != null && ad.model_catalogs?.[agent]?.authoritative === true && !modelOk(models, String(a.model))) throw new RelayError(400, `model "${a.model}" is not available for ${agent} on ${target}; models: ${models.join(", ")}`);
    const pf = ad.prefs ?? {}; // the machine owner's allow/deny rules (the runner enforces them too)
    if (a.agent != null && !pickAllowed(pf, agent, a.model ?? null)) throw new RelayError(400, `${agent}${a.model ? "/" + a.model : ""} is not allowed by ${target}'s owner; allowed: ${(pf.allow ?? []).join(", ") || "anything"}${pf.deny?.length ? ` except ${pf.deny.join(", ")}` : ""}`);
  }
  // Dispatch-time project check (agent/model: checkAgentModel). The runner re-checks on claim; this only refuses what its own
  // advertisement already rules out, so a typo fails at task_create with the list instead of a rejection a minute later.
  // No advertisement yet (runner never started, or an old runner.ts): accept with a warning, the runner decides when it claims.
  async checkTarget(tgt: any, a: any): Promise<string | null> {
    if (tgt.kind !== "runner") return null; // assistants get project as data
    const ad = await this.runnerAd(tgt.name);
    if (!ad) return `${tgt.name} ${this.presence(tgt).online ? "is online but" : "is offline and"} hasn't advertised its projects/agents (shared/runners/${tgt.name}.json), so project${a.agent != null ? "/agent" : ""} couldn't be checked; the runner checks them when it picks the task up`;
    const p = a.project ?? null, projs = ad.projects;
    if (p != null && p !== "home" && projs && typeof projs === "object" && !projs[p])
      throw new RelayError(400, `project "${p}" is not on ${tgt.name}; projects: ${Object.keys(projs).join(", ") || "none"} (or omit project / use "home" for a machine task)`);
    return null;
  }
  // Runner peers: what they advertise (agents, models, the owner's prefs), so a dispatcher can read it from peers.
  // owner: also phone_on (the exact "turn on phone approvals" command, which names the runner.json path), for the /start Status card only
  async runnerCaps(name: string, owner = false) {
    const sha = this.blobAt(`shared/runners/${name}.json`); if (!sha) return null;
    try { const ad = JSON.parse(await this.content(sha)); return { agents: ad.agents, default_agent: ad.default_agent, models: ad.models, model_catalogs: ad.model_catalogs ?? null, prefs: ad.prefs ?? {}, max_parallel: ad.max_parallel, paused: ad.paused, ...(ad.approval ? { approval: ad.approval } : {}),
      approve_ways: Array.isArray(ad.approve_ways) ? ad.approve_ways : null, ...(owner && typeof ad.phone_on === "string" ? { phone_on: ad.phone_on } : {}), updated: ad.updated }; } catch { return null; }
  }
  // git-first: a task names code by git (repo = a git remote URL or the runner's project name, base = branch/tag/commit),
  // never by uploading it. A remote is mapped to the runner project that has it as origin, so the runner works in its own checkout.
  async gitRef(tgt: any, a: any) {
    if (a.base != null && (typeof a.base !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(a.base) || a.base.includes("..") || a.base.endsWith(".lock")))
      throw new RelayError(400, "base must be a branch, tag or commit sha (letters, digits, . _ / -)");
    if (a.repo == null) return;
    if (typeof a.repo !== "string" || !a.repo.trim() || a.repo.length > 300) throw new RelayError(400, "repo must be a git remote URL or the runner's project name");
    a.repo = a.repo.trim().replace(/^(https?:\/\/)[^@\/]+@/, "$1"); // never keep credentials from a URL
    if (tgt.kind !== "runner") return; // assistants get it as data
    const ad = await this.runnerAd(tgt.name), projs = ad?.projects ?? null; if (!projs) return; // not advertised yet: the runner resolves it
    const norm = (u: string) => String(u ?? "").toLowerCase().replace(/^git@([^:]+):/, "https://$1/").replace(/^ssh:\/\/git@/, "https://").replace(/\.git$/, "").replace(/\/+$/, "");
    const hit = projs[a.repo] ? a.repo : Object.keys(projs).find(k => projs[k].remote && norm(projs[k].remote) === norm(a.repo));
    if (!hit) throw new RelayError(400, `repo ${a.repo} isn't checked out on ${tgt.name}; repos there: ${Object.entries<any>(projs).map(([k, v]) => v.remote ? `${k} (${v.remote})` : k).join(", ") || "none"}`);
    if (a.project != null && a.project !== hit) throw new RelayError(400, `repo ${a.repo} is project ${hit} on ${tgt.name}, not ${a.project}`);
    a.project = hit;
  }
  // The repos/<project>/ mirror is opt-in per runner project (mirror:true in runner.json, default off). Git is the source of
  // truth for code, so the mirror (and its `has` op) is only advertised in a space where some runner turned it on.
  codeBrief(runner: string) { // presence: each checkout's git state in one line per project (details: code_status)
    const r = this.sql.exec("select data, updated from code_state where runner=?", runner).toArray()[0] as any; if (!r) return {};
    try { return { code: Object.fromEntries(Object.entries<any>(JSON.parse(r.data)).map(([k, v]) => [k, { branch: v.branch, dirty: v.dirty, ahead: v.ahead, behind: v.behind, ...(v.contained_in ? { on: v.contained_in } : {}), unpulled: (v.assistant_branches ?? []).filter((b: any) => !b.local).length }])), code_at: r.updated }; } catch { return {}; }
  }
  async mirrorOn(): Promise<boolean> {
    for (const r of this.sql.exec("select path from tree where path like 'shared/runners/%.json'").toArray() as any[]) {
      const ad = await this.runnerAd(String(r.path).slice(15, -5)); if (Object.values<any>(ad?.projects ?? {}).some(p => p?.mirror)) return true;
    } return false;
  }
  // Preflight (src/health.ts): is what this task needs on that runner? From its advert and code report; the runner re-checks on claim.
  async preflightFor(tgt: any, a: { agent?: string | null; model?: string | null; project?: string | null; kind?: string | null }) {
    const ad = await this.runnerAd(tgt.name), pr = this.presence(tgt), p = a.project && a.project !== "home" ? a.project : null;
    const agent = a.agent ?? (a.kind ? ad?.prefs?.byKind?.[a.kind]?.agent : null) ?? (p ? ad?.project_agents?.[p] ?? ad?.projects?.[p]?.agent : null) ?? ad?.prefs?.defaultAgent ?? ad?.default_agent ?? null;
    let code: any = null; try { const r = this.sql.exec("select data from code_state where runner=?", tgt.name).toArray()[0] as any; code = r ? JSON.parse(r.data) : null; } catch {}
    return { agent, online: pr.online, ...preflight({ runner: tgt.name, online: pr.online, last_seen: pr.last_seen, advertised: !!ad, agent, model: a.model ?? null, project: p,
      agents: ad?.agents ?? null, agents_detail: Array.isArray(ad?.agents_detail) ? ad.agents_detail : null, models: ad?.models ?? null, model_catalogs: ad?.model_catalogs ?? null, projects: ad?.projects ?? null, code }) };
  }
  async runnerAd(name: string) { const sha = this.blobAt(`shared/runners/${name}.json`); if (!sha) return null; try { return JSON.parse(await this.content(sha)); } catch { return null; } }
  // A spec is a contract the runner must be able to keep, so refuse at create what its advertisement already rules out.
  // (The runner re-checks on claim, including tools the server can't see, like whether `cargo` is installed.)
  async checkSpec(tgt: any, project: string | null, spec: any) {
    if (tgt.kind !== "runner") return; // assistants get the spec as data
    const ad = await this.runnerAd(tgt.name);
    if (!ad) throw new RelayError(400, `runner ${tgt.name} hasn't advertised its capabilities yet (shared/runners/${tgt.name}.json), so it can't take a spec; start it once, or send plain instructions`);
    if (!ad.spec) throw new RelayError(400, `runner ${tgt.name} doesn't support task specs (update client/runner.ts on that machine); send plain instructions instead`);
    const scratch = !project || project === "home", pj = scratch ? null : ad.projects?.[project];
    if (!scratch && ad.projects && !pj) throw new RelayError(400, `spec rejected: project "${project}" is not on ${tgt.name}; projects: ${Object.keys(ad.projects).join(", ") || "none"}`);
    if (spec.acceptance.length && scratch) throw new RelayError(400, "spec rejected: acceptance commands need a project (a machine task has no allowlisted commands)");
    for (const c of spec.acceptance) if (pj && !(pj.verify ?? []).includes(c))
      throw new RelayError(400, `spec rejected: acceptance command "${c}" is not allowlisted for ${project} on ${tgt.name}; allowed: ${(pj.verify ?? []).join(" | ") || "none"}`);
  }
  taskMd(t: any) {
    return `# ${t.title}\n\n- id: ${t.id}\n- from: ${t.from}\n- target: ${t.target}\n- project: ${t.project ?? "-"}\n${t.repo || t.base ? `- repo: ${t.repo ?? "(project checkout)"}  base: ${t.base ?? "(checkout HEAD)"}\n` : ""}- scope: ${(t.scope ?? []).join(", ") || "-"}\n- verify: ${t.verify ?? "-"}\n${t.agent || t.model ? `- agent: ${t.agent ?? "(runner default)"}  model: ${t.model ?? "(agent default)"}\n` : ""}${t.kind ? `- kind: ${t.kind}\n` : ""}${t.continue_from ? `- continues: ${t.continue_from}\n` : ""}${t.parent_id || t.chain ? `- chain: ${t.parent_id ?? t.id} step ${Number(t.chain_step ?? 0) + 1}\n` : ""}\n## Instructions\n${t.instructions}\n\n## Acceptance\n${t.acceptance ?? "-"}\n${t.spec ? `\n## Spec (v2)\n- mode: ${t.spec.mode}${t.spec.promoted ? ` (promoted from plan by ${t.spec.promoted.by})` : ""}\n- goal: ${t.spec.goal ?? "-"}\n- acceptance: ${t.spec.acceptance.map((c: string) => "`" + c + "`").join(", ") || "-"}\n- scope: ${t.spec.scope.join(", ") || "-"}\n- forbidden: ${t.spec.forbidden.join(", ") || "-"}\n- budget: ${t.spec.budget.minutes ?? "-"} min, ${t.spec.budget.max_files_changed ?? "-"} files\n` : ""}${t.kb_context?.length ? `\n## Knowledge base context\n${t.kb_context.map((x: any) => `- [${x.kind}] ${x.id}`).join("\n")}\n` : ""}`;
  }

  // ---------- chains: steps [{agent, kind, instructions}] run one after another on one branch ----------
  // The task_create'd task is step 1 and the chain's parent; each later step is a child task (parent_id, chain_step) created
  // here only when the previous step succeeded, as a follow-up of it (continue_from), so the runner keeps the branch and
  // writes the handoff note. A step that fails, is rejected or cancelled stops the chain: nothing after it is created.
  // A failed step that retries automatically (lease/crash) and then succeeds carries on.
  chainStepText(goal: string, steps: any[], i: number) { return chainStepText(goal, steps, i); } // client/chain.ts: the runner re-renders it to check signed chains
  checkChain(chain: any): any[] {
    if (!Array.isArray(chain) || !chain.length || chain.length > 8) throw new RelayError(400, "chain must be a list of 1-8 steps [{agent, kind, instructions}]");
    return chain.map((s: any, i: number) => {
      if (!s || typeof s !== "object" || typeof s.instructions !== "string" || !s.instructions.trim()) throw new RelayError(400, `chain step ${i + 1}: instructions required`);
      if (!["code", "review", "test"].includes(s.kind)) throw new RelayError(400, `chain step ${i + 1}: kind must be code | review | test`);
      guard("tasks/x/task.md", s.instructions);
      return normStep(s);
    });
  }
  async chainNext(t: any) {
    const root = t.parent_id ? this.loadTask(t.parent_id) : t; if (!root.chain?.steps) return null;
    const steps = root.chain.steps, n = Number(t.chain_step ?? 0) + 1; if (n >= steps.length) return null;
    if (this.sql.exec("select 1 from tasks where parent_id=? and chain_step=?", root.id, n).toArray().length) return null; // already created
    const from = this.member(root.from_peer); if (!from || this.pausedFor(from.name)) return null; // owner kill switch: the chain stops here
    const s = steps[n], id = rid("t"), ts = now(), lim = { ...(root.limits ?? {}) }; delete lim._idem;
    const title = `${s.title ?? root.title} [step ${n + 1}/${steps.length}: ${s.kind}]`;
    this.sql.exec("insert into tasks(id,from_peer,target_peer,title,instructions,project,scope,acceptance,verify,limits,state,needs_approval,result,created,updated,continue_from,agent,model,kind,attempt,max_retries,parent_id,chain_step) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)",
      id, root.from_peer, root.target_peer, title, this.chainStepText(root.chain.goal, steps, n), root.project ?? null, JSON.stringify(root.scope ?? []), null, s.verify ?? root.chain.verify ?? null,
      JSON.stringify(lim), "queued", root.needs_approval ? 1 : 0, null, ts, ts, t.id, s.agent, s.agent ? s.model : null, s.kind, Number(root.max_retries ?? 1), root.id, n);
    const c = this.loadTask(id);
    await this.commit(RELAY, [{ path: `tasks/${id}/task.md`, content: this.taskMd(c) }], `task ${id}: chain ${root.id} step ${n + 1}`);
    this.emit("task.queued", RELAY, { task: id, data: { title, target: c.target, chain: root.id, step: n + 1 } });
    return id;
  }
  chainView(t: any) {
    const root = t.chain?.steps ? t : t.parent_id ? this.loadTask(t.parent_id) : null; if (!root) return null;
    const kids = new Map(this.sql.exec("select id,state,chain_step from tasks where parent_id=?", root.id).toArray().map((r: any) => [Number(r.chain_step), r]));
    const steps = root.chain.steps.map((s: any, i: number) => { const k: any = i === 0 ? root : kids.get(i);
      return { step: i + 1, kind: s.kind, agent: s.agent, model: s.model, task: k?.id ?? null, state: k?.state ?? "pending" }; });
    const bad = steps.find((s: any) => ["failed", "rejected", "cancelled"].includes(s.state));
    const status = bad ? "stopped" : steps.every((s: any) => s.state === "succeeded") ? "succeeded" : "running";
    return { parent: root.id, steps, status, ...(bad ? { stopped_at: bad.step, stopped_because: bad.state } : {}) };
  }
  // ---------- context packs: context/<project>.md in the space ----------
  // The runner gets its task's project notes on claim (only for the project it was sent), and agents' learnings come back
  // with task_complete; the server appends them here after a successful task, secret-guarded like any write.
  async projectContext(project: string | null) {
    if (!project || project === "home") return null;
    const path = `context/${normPath(project).replace(/\//g, "_")}.md`, sha = path === BRIEF_PATH ? null : this.blobAt(path); if (!sha) return null; // a project named "assistant" has no pack: that file is the brief
    let content = await this.content(sha); const size = content.length, truncated = size > CONTEXT_MAX; if (truncated) content = content.slice(-CONTEXT_MAX); // newest learnings are at the end
    return { path, sha, size, truncated, content };
  }
  async appendLearnings(t: any, peer: Peer, text: string) {
    const path = `context/${normPath(String(t.project)).replace(/\//g, "_")}.md`;
    const body = text.trim().slice(0, 8000); if (!body || path === BRIEF_PATH) return null;
    try { guard(path, body); } catch (e: any) { return { path, status: "refused", reason: e.message }; }
    const cur = this.blobAt(path), prev = cur ? await this.content(cur) : `# ${t.project}: project context\n\nNotes every Kitebook agent on this project gets with its task. Edit freely.\n`;
    const who = t.agent ?? "agent";
    await this.commit(peer, [{ path, content: `${prev.replace(/\n*$/, "\n")}\n## Learned in ${t.id} (${who}, ${now().slice(0, 10)})\n${body}\n` }], `context ${t.project}: learnings from ${t.id}`);
    return { path, status: "appended", chars: body.length };
  }

  // ---------- kill switch: owner/admin only (Dir admin pause/resume); refuses new tasks and cancels active ones ----------
  pauseState(): { all: any; peers: Record<string, any> } {
    const v = this.sql.exec("select v from meta where k='pause'").toArray()[0]?.v as string | undefined;
    return v ? JSON.parse(v) : { all: null, peers: {} };
  }
  pausedFor(name: string) { const p = this.pauseState(); return p.all ?? p.peers[name] ?? null; }
  async setPause(on: boolean, peer?: string, reason?: string) {
    const p = this.pauseState(), rec = { reason: reason || "paused by the owner", at: now() };
    const m = peer ? this.sql.exec("select peer_id from members where name=?", peer).toArray()[0] as any : null;
    if (peer && !m) throw new Error(`no connected app named ${peer} in workspace ${this.spaceId}`);
    if (on) { if (peer) p.peers[peer] = rec; else p.all = rec; }
    else if (peer) delete p.peers[peer]; else { p.all = null; p.peers = {}; }
    this.sql.exec("insert or replace into meta values('pause',?)", JSON.stringify(p));
    const cancelled: string[] = [];
    if (on) { // cancel what's queued or running; runners kill the agent on task.cancelled (and on space.paused)
      const rows = this.sql.exec(`select id from tasks where state in (${ACTIVE.map(() => "?").join(",")})${m ? " and from_peer=?" : ""}`, ...ACTIVE, ...(m ? [m.peer_id] : [])).toArray();
      for (const r of rows) try { this.setState(this.loadTask(r.id as string), "cancelled", RELAY, { reason: `Paused by the owner: ${rec.reason}` }, undefined, ACTIVE); cancelled.push(r.id as string); } catch {}
    }
    this.emit(on ? "space.paused" : "space.resumed", RELAY, { data: { peer: peer ?? null, reason: rec.reason, cancelled } });
    return { paused: on, scope: peer ? `dispatcher ${peer}` : "whole space", cancelled, state: p };
  }
}

const cap1 = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s;
// taskOps: this space's tasks ops for the impl table (src/space.ts); `this` is the Space.
export function taskOps(this: Space): Record<string, Op> {
  return {
    task_create: async (peer, a) => {
      this.need(peer, "dispatch");
      const tgt = this.sql.exec("select * from members where name=? and revoked=0", a.target).toArray()[0] as any;
      if (!tgt) throw new RelayError(404, `no connected app named ${a.target} in workspace ${this.spaceId}`);
      if (tgt.peer_id === peer.id) throw new RelayError(400, "can't dispatch to yourself");
      const pz = this.pausedFor(peer.name); if (pz) throw new RelayError(423, `paused by the owner (kill switch): ${pz.reason}. No new tasks until the owner resumes.`);
      const spec = normSpec(a.spec);
      if (a.instructions == null || a.instructions === "") { if (!spec?.goal) throw new RelayError(400, "missing instructions (or spec.goal)"); a.instructions = spec.goal; }
      guard(`tasks/x/task.md`, String(a.instructions) + "\n" + JSON.stringify(spec ?? {}));
      if (spec && !spec.scope.length && Array.isArray(a.scope)) spec.scope = a.scope; // the old top-level scope feeds the spec
      const idem = a.idempotency_key != null ? String(a.idempotency_key).slice(0, 128) : null;
      if (idem) { // retried create with the same key returns the original task instead of a duplicate
        const dup = this.sql.exec("select id,state from tasks where from_peer=? and target_peer=? and json_extract(limits,'$._idem')=? limit 1", peer.id, tgt.peer_id, idem).toArray()[0] as any;
        if (dup) { const pr0 = this.presence(tgt); return { id: dup.id, state: dup.state, target: tgt.name, duplicate: true, needs_approval: tgt.kind === "runner", target_online: pr0.online, target_last_seen: pr0.last_seen, target_wake: pr0.wake, delivery: "idempotent replay: existing task returned" }; }
      }
      let parent: any = null;
      if (a.continue_from) { // follow-up: same target, same project, continues the parent's branch (and agent session if the runner supports it)
        parent = this.loadTask(String(a.continue_from));
        if (parent.from_peer !== peer.id && parent.target_peer !== peer.id) throw new RelayError(403, "you can only follow up on tasks you sent or received");
        if (parent.target_peer !== tgt.peer_id) throw new RelayError(400, `follow-ups go to the same peer as the parent (${parent.target})`);
        if (!["succeeded", "failed", "cancelled", "rejected"].includes(parent.state)) throw new RelayError(409, `parent is ${parent.state}; follow up after it finishes`); // cancelled/rejected: a retry (its partial work, if any, is on its branch)
        // handoff: a different agent/model may pick it up (e.g. codex wrote it, claude reviews); its model is not inherited across agents
        if (a.agent == null || a.agent === parent.agent) a.model ??= parent.model ?? undefined;
        a.project ??= parent.project; a.agent ??= parent.agent ?? undefined;
        a.repo ??= parent.repo ?? undefined; // a follow-up continues the parent's branch, so a new base would be ignored
        if (a.base != null) throw new RelayError(400, "a follow-up continues the parent's branch; base only applies to new tasks");
      }
      let chain: any = null;
      if (a.chain != null) { // step 1 runs as this task; later steps become child tasks as each one succeeds (chainNext)
        const steps = this.checkChain(a.chain); chain = { goal: String(a.instructions), steps, verify: a.verify ?? null };
        a.instructions = this.chainStepText(chain.goal, steps, 0); a.kind = steps[0].kind; a.verify = steps[0].verify ?? a.verify;
        if (steps[0].agent) { a.agent = steps[0].agent; a.model = steps[0].model ?? undefined; }
        for (const s of steps.slice(1)) if (s.agent != null || s.model != null) await this.checkAgentModel(tgt.name, { ...s, project: a.project });
      }
      await this.gitRef(tgt, a);
      const chg = CHANGE_ARGS.get(a) ?? null; // only set by the change op
      if (a.kind === "ask" ? !ASK_ARGS.has(a) : a.kind != null && !KINDS.includes(a.kind)) throw new RelayError(400, a.kind === "ask" ? "a quick ask is sent with the ask op, not task_create" : `kind must be one of ${KINDS.join(", ")}`);
      if (a.agent != null || a.model != null) await this.checkAgentModel(tgt.name, a);
      const warn0 = await this.checkTarget(tgt, a); // project vs the runner's advertisement: fail now, not 60-90 s later on claim
      // preflight: what's missing is said, not silently queued. Online (a current advert): refused with the reason. Offline: queued, with
      // how long it's been gone and what looked missing at its last report (the Mac may have changed since)
      const pre = tgt.kind === "runner" && a.kind !== "ask" ? await this.preflightFor(tgt, a) : null;
      if (pre?.problems.length && pre.online) throw new RelayError(400, `can't run this on ${tgt.name}: ${pre.problems.join("; ")}. Pick another agent/project (describe lists what ${tgt.name} has) or ask the owner to fix it`);
      const warn = [warn0, ...(pre && !pre.online ? [...pre.problems.map(x => `at its last report: ${x}`), ...pre.notes.filter(n => !/offline|never connected|reconnecting/.test(n) && !(warn0 && /hasn't said what it has/.test(n)))] : (pre?.notes ?? []).filter(n => !(warn0 && /hasn't said what it has/.test(n))))].filter(Boolean).join("; ") || null;
      if (spec) await this.checkSpec(tgt, a.project ?? null, spec);
      // Signed dispatch (client/sign.ts): the sender chose the task id and signed it with the payload, so keep its id. The server can't
      // check the signature (it has no trusted keys and isn't trusted); the runner does, before it lets the task auto-run.
      const sig = a.signature ?? null;
      if (sig != null) {
        if (typeof sig !== "object" || Array.isArray(sig) || JSON.stringify(sig).length > 8192) throw new RelayError(400, "signature must be the object client/sign.ts signCreate makes");
        if (!/^t_[0-9a-f]{12,32}$/.test(String(sig.task))) throw new RelayError(400, "signature.task must be a task id like t_<hex> (signCreate picks it)");
        if (sig.target !== tgt.name) throw new RelayError(400, `signature is for target ${sig.target}, not ${tgt.name}`);
        if (this.sql.exec("select 1 from tasks where id=?", sig.task).toArray().length) throw new RelayError(409, `task ${sig.task} already exists; sign a new task (a signature is single-use)`);
      }
      const id = sig ? String(sig.task) : rid("t"), ts = now(), needsApproval = tgt.kind === "runner" ? 1 : 0;
      const { _sig: _s, _idem: _i, ...userLim } = a.limits ?? {}, lim = { ...userLim, ...(idem ? { _idem: idem } : {}), ...(sig ? { _sig: sig } : {}) };
      const maxRetries = a.max_retries == null ? 1 : Number(a.max_retries);
      if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new RelayError(400, "max_retries must be an integer 0-5");
      this.sql.exec("insert into tasks(id,from_peer,target_peer,title,instructions,project,scope,acceptance,verify,limits,state,needs_approval,result,created,updated,continue_from,agent,model,kind,attempt,max_retries,spec,chain,chain_step,repo,base,change) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?)", id, peer.id, tgt.peer_id, a.title, a.instructions, a.project ?? null,
        JSON.stringify(a.scope ?? spec?.scope ?? []), a.acceptance ?? null, a.verify ?? null, JSON.stringify(lim), "queued", needsApproval, null, ts, ts, parent?.id ?? null, a.agent ?? null, a.model ?? null, a.kind ?? null, maxRetries, spec ? JSON.stringify(spec) : null,
        chain ? JSON.stringify(chain) : null, chain ? 0 : null, a.repo ?? null, a.base ?? null, chg ? JSON.stringify(chg.meta) : null);
      const sess = SESSION_ARGS.get(a) ?? null; // only set by session_create / session_send (src/space/sessions.ts); before signing: the payload covers it
      if (sess) this.sql.exec("update tasks set session=? where id=?", JSON.stringify(sess), id);
      // KB: the top-k entries for this goal (global + the task's project), as the dispatcher can see them; kb_k: 0 turns it off
      // A signed task names its entries (kb_ids, covered by the signature); the runner drops anything else, so attach exactly those.
      const kbc = a.kb_ids != null ? KB.contextByIds(this, peer, a.kb_ids) : await KB.contextFor(this, peer, { title: String(a.title), goal: String(spec?.goal ?? a.instructions), project: a.project ?? null }, a.kb_k == null ? 5 : Number(a.kb_k)).catch(e => { console.error("kb context", e); return []; });
      if (kbc.length) this.sql.exec("update tasks set kb_context=? where id=?", JSON.stringify(kbc), id);
      // The owner's standing permission (src/policy.ts, the /start Permissions panel): an app the owner let run on its own in this project
      // gets its task signed here with its relay-held key, which the owner-signed policy names; the runner checks the policy signature
      // and this one. An app that signs its own tasks keeps its signature. Anything else is unsigned and waits for the owner as before.
      // Run tasks without asking (Settings top row, client/payload.ts autorunOn): the same, with the relay-held autorun key, for the owner's OWN apps only, while
      // they're still connected (senderState); an app's own entry wins where it applies.
      let standing: any = null, autoRun = false;
      if (needsApproval && (peer.kind === "assistant" || peer.kind === "coding_agent") && sess?.mode !== "continue" && !(sess && this.metaJ("policy")?.policy?.apps?.[peer.name]?.session_rule)) { // continuing an owner's session in place always asks the owner
        if (sig) { const ae = autoEntry(this.metaJ("policy")?.policy, peer.name, a.project ?? null); if ("entry" in ae && (ae.entry.keys ?? []).includes(String(sig.key))) standing = ae.entry; }
        else { const ss = await this.standingSig(peer.name, a.project ?? null);
          if (ss) { const e = await signStored(this.loadTask(id), ss.key); this.sql.exec("update tasks set limits=? where id=?", JSON.stringify({ ...lim, _sig: e }), id); standing = ss.entry; autoRun = !!ss.autorun; } } }
      // Session consent signs only session tasks, independently of task autorun. The runner verifies the signed rule and actual source folder.
      const sr = sess && this.metaJ("policy")?.policy?.apps?.[peer.name]?.session_rule;
      if (sr?.approval === "auto" && sr.access !== "read" && sr.projects.includes(a.project) && !sig) {
        const k = this.metaJ(`appkey:${peer.name}`);
        if (k && sr.keys.includes(k.pub)) { const signature = await signStored(this.loadTask(id),k); this.sql.exec("update tasks set limits=? where id=?",JSON.stringify({ ...lim,_sig: signature }),id); }
      }
      const t = this.loadTask(id);
      // what the dispatcher can expect (R10/R13): a signed task to a runner that auto-runs signatures from this sender's key may not ask
      // anyone (the runner decides when it checks the signature); a runner whose approval push is failing parks the task for /start
      let appr: any = !!needsApproval, apprNote: string | null = null, downNote: string | null = null;
      if (needsApproval) { const ad = await this.runnerAd(tgt.name);
        if (sr && t.limits?._sig) { appr = "maybe_auto"; apprNote = "runs within your saved session limits if the runner verifies the signature and source project; otherwise asks you"; }
        if (!sr && sig && ad?.approve === "auto" && ad.signing?.auto_requires_signature === true && (ad.signing.trusted_signers ?? []).includes(peer.name)) { appr = "maybe_auto"; apprNote = `auto-runs if the signature checks (${tgt.name} trusts ${peer.name}'s signing key); otherwise ${tgt.name} asks its owner`; }
        if (standing && autoRun) { appr = "maybe_auto"; apprNote = `runs right away: the owner turned on "Run tasks without asking"${standing.until ? ` (until ${new Date(Number(standing.until)).toISOString().slice(0, 16).replace("T", " ")} UTC)` : ""}, so tasks from their own apps don't ask (${tgt.name} checks the owner's signature first; it pushes only the task's own branch by itself, never the main branch)`; }
        else if (standing) { appr = "maybe_auto"; apprNote = `runs on its own: the owner lets ${peer.name} run tasks in ${a.project} without asking${standing.until ? ` until ${new Date(Number(standing.until)).toISOString().slice(0, 10)}` : ""} (${tgt.name} checks the owner's signature first; pushing ${standing.push ? "is allowed too" : "still asks"})`; }
        if (ad?.approval?.ok === false && appr !== "maybe_auto") downNote = `${tgt.name} can't reach its owner for approvals right now (${String(ad.approval.error ?? "unknown").slice(0, 200)}): the task waits in awaiting_approval and the owner can approve it from /start (Status); nothing is declined`; }
      await this.commit(peer, [{ path: `tasks/${id}/task.md`, content: this.taskMd(t) }, ...(chg ? [{ path: `tasks/${id}/${chg.file}`, content: chg.content }] : [])], `task ${id}: ${a.title}`); // the change lands with the task, before the runner hears of it
      this.emit("task.queued", peer, { task: id, data: { title: a.title, target: tgt.name } });
      const pr = this.presence(tgt);
      return { id, state: "queued", target: tgt.name, ...(chain ? { chain: { parent: id, steps: chain.steps.length } } : {}), needs_approval: appr, ...(apprNote ? { approval: apprNote } : {}), ...(warn || downNote ? { warning: [warn, downNote].filter(Boolean).join("; ") } : {}), ...(spec ? { mode: spec.mode } : {}), ...(sig ? { signed: true } : {}), ...(kbc.length ? { kb_context: kbc.map((x: any) => x.id) } : {}), target_online: pr.online, target_last_seen: pr.last_seen, target_wake: pr.wake,
        delivery: pr.online ? "pushed to the target's live connection" : pr.wake === "webhook" ? "webhook sent; target is not connected" : offWords(tgt.name, pr.last_seen, tgt.kind === "runner"),
        ...(!pr.online && tgt.kind === "runner" ? { target_offline_for: offFor(pr.last_seen) } : {}), ...(pre ? { preflight: { ok: !pre.problems.length, agent: pre.agent, problems: pre.problems, notes: pre.notes } } : {}) };
    },
    // A plan-mode task that succeeded becomes an execute run on the same task id (and branch kitebook/<id>). The runner asks
    // for approval again, since running code is a bigger ask than planning, and gets the plan in its prompt.
    task_promote: async (peer, a) => {
      this.need(peer, "dispatch");
      const t = this.taskFor(peer, a.id, "from");
      if (t.spec?.mode !== "plan") throw new RelayError(409, t.spec?.promoted ? "already promoted" : "only a task created with spec.mode \"plan\" can be promoted");
      if (t.state !== "succeeded") throw new RelayError(409, `plan is ${t.state}; only a plan that succeeded can be promoted`);
      const pz = this.pausedFor(peer.name); if (pz) throw new RelayError(423, `paused by the owner (kill switch): ${pz.reason}. No new tasks until the owner resumes.`);
      if (a.note != null) guard("x", String(a.note));
      const spec = { ...t.spec, mode: "execute", promoted: { at: now(), by: peer.name, plan: `tasks/${t.id}/plan.md`, note: a.note != null ? String(a.note).slice(0, 4000) : null } };
      const res = { plan: { summary: String(t.result?.summary ?? "").slice(0, 4000), structured: t.result?.structured ?? null, commit: t.result?.commit ?? null } };
      const c = this.sql.exec("update tasks set state='queued', spec=?, result=?, attempt=1, held_acc=0, updated=? where id=? and state='succeeded'", JSON.stringify(spec), JSON.stringify(res), now(), t.id);
      if (!c.rowsWritten) throw new RelayError(409, `task is ${this.loadTask(t.id).state}`);
      // the plan's signature covered spec.mode "plan", so it no longer fits: re-sign for what runs now where the owner's permission or autorun
      // still allows this sender (otherwise the runner asks, as for any promoted plan)
      if (t.needs_approval && (peer.kind === "assistant" || peer.kind === "coding_agent")) { const ss = await this.standingSig(peer.name, t.project ?? null);
        if (ss) { const lim = { ...(this.loadTask(t.id).limits ?? {}) }; delete lim._sig; const e = await signStored(this.loadTask(t.id), ss.key); this.sql.exec("update tasks set limits=? where id=?", JSON.stringify({ ...lim, _sig: e }), t.id); } }
      const t2 = this.loadTask(t.id);
      await this.commit(peer, [{ path: `tasks/${t.id}/task.md`, content: this.taskMd(t2) }], `task ${t.id}: promoted to execute`);
      this.emit("task.queued", peer, { task: t.id, data: { title: t.title, target: t2.target, promoted: true } });
      const pr = this.presence(this.member(t.target_peer));
      return { id: t.id, state: "queued", mode: "execute", target: t2.target, plan: spec.promoted.plan, target_online: pr.online };
    },
    task_list: async (peer, a) => {
      const where = a.role === "sent" ? "from_peer=?" : a.role === "received" ? "target_peer=?" : "(from_peer=?1 or target_peer=?1)";
      const rows = this.sql.exec(`select id from tasks where ${where} ${a.state ? "and state=?2" : ""} order by created desc limit 100`, peer.id, ...(a.state ? [a.state] : [])).toArray();
      return { tasks: rows.map(r => { const t = this.loadTask(r.id as string); return { id: t.id, title: t.title, from: t.from, target: t.target, state: t.state, note: t.note, updated: t.updated, ...(t.question ? { question: t.question.text } : {}) }; }) };
    },
    task_get: async (peer, a) => { const t = this.taskFor(peer, a.id, "any"), cv = this.chainView(t);
      const kids = this.sql.exec("select id from tasks where parent_id=? order by chain_step", t.id).toArray().map(r => r.id as string);
      const hl = this.headlineFor(t); if (hl && t.result) t.result.headline = hl;
      return { ...(hl ? { headline: hl } : {}), ...t, live: this.liveFor(t), ...(cv ? { chain: cv } : {}), ...(t.chain?.steps ? { chain_def: t.chain } : {}), ...(kids.length ? { children: kids } : {}) }; }, // chain_def: what a signed parent signed (runner checks children against it)
    change: async (peer, a) => {
      if ((a.diff == null) === (a.files == null)) throw new RelayError(400, "send exactly one of diff (unified diff) or files ({path: content | null})");
      const msg = String(a.message).trim(); if (!msg) throw new RelayError(400, "message is empty");
      let content: string, file: string, paths: string[];
      if (a.diff != null) {
        content = String(a.diff); if (!/^(diff --git |--- |\+\+\+ |@@ )/m.test(content)) throw new RelayError(400, "diff must be a unified diff (git diff output)");
        paths = [...new Set([...content.matchAll(/^(?:\+\+\+ b\/|--- a\/)(\S+)/gm)].map(m => m[1]).filter(p => p !== "/dev/null"))]; file = "change.patch";
      } else {
        if (typeof a.files !== "object" || Array.isArray(a.files)) throw new RelayError(400, "files must be {path: content | null}");
        const fs = Object.entries<any>(a.files); if (!fs.length || fs.length > 200) throw new RelayError(400, "files: 1-200 entries");
        for (const [p, v] of fs) if (v !== null && typeof v !== "string") throw new RelayError(400, `files[${p}] must be text or null (delete)`);
        paths = fs.map(([p]) => normPath(p)); content = JSON.stringify(Object.fromEntries(fs.map(([p, v]) => [normPath(p), v]))); file = "change.json";
      }
      if (content.length > CHANGE_MAX) throw new RelayError(413, `change is too large (max ${CHANGE_MAX} bytes); push a branch instead`);
      for (const p of paths) { normPath(p); guard(p); } guard(`tasks/x/${file}`, content); // no .env/keys, no token-shaped secrets
      const slug = slugify(a.slug ?? msg.split("\n")[0]); if (!slug) throw new RelayError(400, "slug is empty after cleaning; give slug");
      const meta = { mode: a.diff != null ? "diff" : "files", file, sha: await sha256(content), branch: `${slugify(peer.name) || "assistant"}/${slug}`, files: paths.slice(0, 200), message: msg.slice(0, 4000) };
      const args: any = { space: a.space, target: a.target, title: msg.split("\n")[0].slice(0, 120), kind: "code", project: a.project, repo: a.repo, base: a.base, verify: a.verify,
        instructions: `Apply changeset from ${peer.name} (no agent runs): ${meta.mode}, ${paths.length} file(s): ${paths.slice(0, 20).join(", ")}${paths.length > 20 ? ", ..." : ""}\nBranch ${meta.branch} from ${a.base}.\n\n${msg}` };
      CHANGE_ARGS.set(args, { meta, file, content });
      const r = await this.impl.task_create(peer, args);
      return { ...r, branch: meta.branch, files: paths.length };
    },
    task_status: async (peer, a) => { // live view: one task, or every open task you sent or received
      const row = (t: any) => { const l = this.liveFor(t), st = this.stuckOf(t, l.last_line); return { id: t.id, title: t.title, state: t.state, from: t.from, target: t.target, live: { ...l, doing: PHASE_WORDS[l.phase] ?? l.phase }, ...(st ? { status: "stuck?", stuck: st } : {}) }; };
      if (a.id) return row(this.taskFor(peer, a.id, "any"));
      const rows = this.sql.exec(`select id from tasks where (from_peer=?1 or target_peer=?1) and state in (${ACTIVE.map((_, i) => `?${i + 2}`).join(",")}) order by created`, peer.id, ...ACTIVE).toArray();
      return { tasks: rows.map(r => row(this.loadTask(r.id as string))).sort((x: any, y: any) => Number(!!y.stuck) - Number(!!x.stuck)) }; // stuck first
    },
    task_live: async (peer, a) => { // runner: overwrite this task's live status; `log` (the tail) is saved as tasks/<id>/live.log. Redacted like every report.
      const t = this.taskFor(peer, a.id, "target");
      if (!HELD.includes(t.state)) throw new RelayError(409, `task is ${t.state}`);
      if (!LIVE_PHASES.includes(a.phase)) throw new RelayError(400, `phase must be one of ${LIVE_PHASES.join(", ")}`);
      const cur = this.sql.exec("select data from task_live where task_id=?", t.id).toArray()[0] as any, prev = cur ? JSON.parse(cur.data) : {};
      const str = (v: any, n: number) => v == null ? null : redact(String(v)).slice(0, n);
      const d = { ...prev, phase: a.phase, ...Object.fromEntries((["agent", "model", "started_at", "ended_at"] as const).filter(k => a[k] !== undefined).map(k => [k, str(a[k], 200)])),
        ...(a.session !== undefined ? { session: str(String(a.session ?? "").split("/").pop() || null, 200) } : {}), // file name only, never the path
        ...(a.last_line !== undefined ? { last_line: str(a.last_line, 500) } : {}), ...(a.partial !== undefined && t.kind === "ask" ? { partial: str(a.partial, 8000) } : {}) }; // a quick ask's answer so far (ask_get)
      if (a.log != null) { d.log = true; await this.commit(peer, [{ path: `tasks/${t.id}/live.log`, content: redact(String(a.log).slice(-LIVE_LOG_MAX)) }], `task ${t.id}: live.log`); }
      this.sql.exec("insert or replace into task_live(task_id, data, updated) values(?,?,?)", t.id, JSON.stringify(d), now());
      return { ok: true, phase: d.phase };
    },
    task_cancel: async (peer, a) => {
      const t = this.taskFor(peer, a.id, "any"); if (!ACTIVE.includes(t.state)) throw new RelayError(409, `task is ${t.state}`);
      return this.cancelTask(t, peer, a.reason);
    },
    cancel_all: async (peer, a) => { // every open task you're party to, optionally narrowed to one dispatcher (peer) and/or target
      const id = (n: any) => n == null ? null : (this.sql.exec("select peer_id from members where name=?", String(n)).toArray()[0] as any)?.peer_id ?? "\0none";
      const from = id(a.peer), to = id(a.target);
      const rows = this.sql.exec(`select id from tasks where (from_peer=?1 or target_peer=?1) and state in (${ACTIVE.map(() => "?").join(",")}) order by created`, peer.id, ...ACTIVE).toArray();
      const cancelled: string[] = [];
      for (const r of rows) { const t = this.loadTask(r.id as string);
        if ((from && t.from_peer !== from) || (to && t.target_peer !== to)) continue;
        try { this.cancelTask(t, peer, a.reason ?? "cancel_all"); cancelled.push(t.id); } catch {} }
      return { cancelled, count: cancelled.length };
    },
    task_message: async (peer, a) => {
      const t = this.taskFor(peer, a.id, "any"); guard("x", a.message);
      if (t.state === "needs_input" && t.from_peer === peer.id) return { ok: true, ...(await this.answerTask(t, peer, String(a.message))) }; // a sender's message on a parked task is its answer
      await this.appendTaskFile(t, peer, "thread.md", a.message);
      this.emit("task.message", peer, { task: t.id, data: { message: String(a.message).slice(0, 2000) } });
      return { ok: true };
    },
    task_answer: async (peer, a) => this.answerTask(this.taskFor(peer, a.id, "from"), peer, String(a.answer)),
    task_steer: async (peer, a) => { const m = this.member(peer.id); if (!m || m.revoked) throw new RelayError(403, `no access to workspace ${this.spaceId}`);
      return this.steerTask(this.loadTask(String(a.id)), peer, String(a.message ?? "")); },
    // the target takes the notes not yet given to its agent (marks them delivered): the runner calls it at every turn boundary.
    // A steer is text added after the owner approved the task, so the runner may first peek (peek:true, nothing marked), ask the owner, then
    // take only the approved ones (only:[n]) and mark the rest refused (refused:[n]: kept on the task, never offered again).
    task_steer_take: async (peer, a) => {
      const t = this.taskFor(peer, a.id, "target"), s = (t.steers ?? []) as any[], nums = (v: any) => Array.isArray(v) ? new Set(v.map(Number)) : null;
      const only = nums(a.only), refused = nums(a.refused), open = (x: any) => !x.delivered_at && !x.refused_at;
      if (refused?.size) { const at = now(), r = s.filter(x => open(x) && refused.has(x.n)); for (const x of r) x.refused_at = at;
        if (r.length) { this.sql.exec("update tasks set steers=? where id=?", JSON.stringify(s), t.id);
          await this.appendTaskFile(t, peer, "thread.md", `Steer ${r.map(x => "#" + x.n).join(", ")} not given to the agent: the owner didn't approve ${r.length > 1 ? "them" : "it"}.`); }
        return { id: t.id, steers: [], refused: r.map(x => x.n) }; }
      const todo = s.filter(x => open(x) && (!only || only.has(x.n))), out = todo.map(x => ({ n: x.n, by: x.by, message: x.message, at: x.at, ...(x.owner ? { owner: true } : {}) }));
      if (!todo.length || a.peek) return { id: t.id, steers: out };
      const at = now(); for (const x of todo) x.delivered_at = at;
      this.sql.exec("update tasks set steers=? where id=?", JSON.stringify(s), t.id);
      this.emit("task.steer_delivered", peer, { task: t.id, data: { title: t.title, n: todo.map(x => x.n) } });
      return { id: t.id, steers: out };
    },
    task_claim: async (peer, a) => {
      const t = this.taskFor(peer, a.id, "target"); if (t.state !== "queued") throw new RelayError(409, `task is ${t.state}`);
      this.setState(t, t.needs_approval ? "awaiting_approval" : "claimed", peer);
      const context = await this.projectContext(t.project); // the claimer gets its project's context pack (and nothing else under context/)
      return { ...this.loadTask(t.id), ...(context ? { context } : {}) };
    },
    approval_page: async (peer, a) => {
      if (peer.kind !== "runner") throw new RelayError(403, "only a runner opens approval pages");
      if (!["approve", "register"].includes(a.kind ?? "approve")) throw new RelayError(400, "kind: approve | register");
      if (a.task) this.taskFor(peer, a.task, "target");
      const view = JSON.stringify(a.view ?? {}); if (view.length > 100_000) throw new RelayError(413, "view too large");
      if (typeof a.nonce !== "string" || !a.nonce || a.nonce.length > 200) throw new RelayError(400, "nonce required");
      const exp = Math.min(Number(a.expires_at) || 0, Date.now() + 10 * 60_000); if (exp <= Date.now()) throw new RelayError(400, "expires_at must be in the next 10 minutes");
      const pk = a.passkey ? JSON.stringify({ rp_id: String(a.passkey.rp_id ?? ""), allow: (a.passkey.allow ?? []).map(String).slice(0, 20) }) : null;
      this.sql.exec("delete from asks where expires<?", Date.now() - 86400_000);
      const id = [...crypto.getRandomValues(new Uint8Array(18))].map(b => b.toString(16).padStart(2, "0")).join("");
      this.sql.exec("insert into asks(id,runner,kind,task,view,nonce,passkey,expires,state,response,created,owner_only) values(?,?,?,?,?,?,?,?,?,?,?,?)", id, peer.id, a.kind ?? "approve", a.task ?? null, view, a.nonce, pk, exp, "pending", null, now(), a.owner_only ? 1 : 0);
      return { id, expires_at: exp };
    },
    approval_wait: async (peer, a) => {
      const own = () => { const r = this.askRow(a.id); if (!r || r.runner !== peer.id) throw new RelayError(404, "no such approval page"); return r; };
      let r = own();
      if (a.close && r.state === "pending") { this.sql.exec("update asks set state='closed' where id=?", r.id); r = own(); }
      if (r.state === "pending" && a.wait) { await this.wait(Math.min(Number(a.wait), 25)); r = own(); }
      return { id: r.id, state: r.state, response: r.response ? JSON.parse(r.response) : null };
    },
    task_approval: async (peer, a) => {
      if (peer.kind !== "runner") throw new RelayError(403, "only a runner records approvals (the human approves locally)");
      const t = this.taskFor(peer, a.id, "target"); if (t.state !== "awaiting_approval") throw new RelayError(409, `task is ${t.state}`);
      const auto = a.decision === "approved" && (a.auto === "autorun" || a.auto === "dev_mode" || (a.auto === "ask" && t.kind === "ask")) ? (a.auto === "dev_mode" ? "autorun" : String(a.auto)) : null; // ask: a read-only quick ask from the owner's own app; dev_mode: autorun's old name (a runner from before the rename)
      if (auto) this.sql.exec("update tasks set limits=? where id=?", JSON.stringify({ ...(t.limits ?? {}), _auto: auto }), t.id); // Status: "ran without asking"
      this.setState(t, a.decision === "approved" ? "running" : "rejected", peer, { note: a.note, ...(auto ? { auto } : {}) }); return { id: t.id, state: this.loadTask(t.id).state };
    },
    // An approval channel that fails (ntfy down, review page unreachable) is not the owner saying no: the task goes back to queued
    // untouched with the runner's note ("approval channel unreachable: <cause>; run doctor") and the runner retries with backoff.
    task_release: async (peer, a) => {
      if (peer.kind !== "runner") throw new RelayError(403, "only a runner releases a task it claimed");
      const t = this.taskFor(peer, a.id, "target");
      this.setState(t, "queued", peer, { note: redact(String(a.note ?? "released by the runner")).slice(0, 2000), reason: String(a.reason ?? "approval_unreachable").slice(0, 64), ...(a.retry_in_s != null ? { retry_in_s: Number(a.retry_in_s) || 0 } : {}) }, undefined, ["claimed", "awaiting_approval"]);
      return { id: t.id, state: "queued" };
    },
    task_progress: async (peer, a) => {
      const t = this.taskFor(peer, a.id, "target");
      if (!["claimed", "running", "needs_input"].includes(t.state)) throw new RelayError(409, `task is ${t.state}` + (t.state === "awaiting_approval" ? " (not approved yet)" : ""));
      const msg = redact(String(a.message ?? "")), ask = a.needs_input || a.question != null;
      await this.appendTaskFile(t, peer, "progress.md", ask ? `Question: ${redact(String(a.question ?? msg))}` : msg);
      if (!ask && t.state === "needs_input") return { ok: true, state: "needs_input" }; // plain progress never un-parks a task; only the sender's answer does
      if (ask) { // park: needs_input isn't leased, so it waits as long as the sender takes
        const qs = t.questions as any[], text = redact(String(a.question ?? msg)).slice(0, 4000);
        qs.push({ round: qs.length + 1, text, asked_at: now(), asked_by: peer.name });
        this.sql.exec("update tasks set qa=? where id=?", JSON.stringify(qs), t.id);
        this.setState(t, "needs_input", peer, { message: text.slice(0, 2000), question: text.slice(0, 2000), round: qs.length }, undefined, ["claimed", "running"]);
        return { ok: true, state: "needs_input", round: qs.length };
      }
      this.setState(t, "running", peer, { message: msg.slice(0, 2000) }, undefined, ["claimed", "running"]); return { ok: true };
    },
    task_complete: async (peer, a) => {
      const t = this.taskFor(peer, a.id, "target");
      if (a.status === "cancelled") return this.cancelledReport(t, peer, a); // runner uploading the partial work of a task that was cancelled
      const live = a.status === "succeeded" ? ["claimed", "running", "needs_input"] : ["claimed", "running", "needs_input", "awaiting_approval"];
      if (!live.includes(t.state)) throw new RelayError(409, `task is ${t.state}`);
      a.summary = redact(String(a.summary ?? ""));
      const files: Change[] = [{ path: `tasks/${t.id}/summary.md`, content: a.summary }];
      for (const [name, content] of Object.entries(a.artifacts ?? {})) {
        const p = `tasks/${t.id}/${normPath(name).replace(/\//g, "_")}`; guard(p); files.push({ path: p, content: redact(String(content)) });
      }
      const r = await this.commit(peer, files, `task ${t.id}: ${a.status}`);
      const sr = a.result ? this.cleanResult(a.result) : null, card = this.cardOf(t, a, sr);
      const res = { summary: a.summary, files: files.map(f => f.path), commit: r.commit, ...(sr ? { structured: sr } : {}), headline: card, ...(t.result?.plan ? { plan: t.result.plan } : {}) }; // a promoted run keeps its plan run's result
      // Only the runner holding the task can say its failure was infrastructure (crash/restart), not the work itself.
      if (a.status !== "succeeded" && a.retryable && peer.kind === "runner") {
        this.failOrRetry(t, peer, { summary: String(a.summary).slice(0, 2000), reason: String(a.reason ?? "runner_crash").slice(0, 40) }, res, live);
        return { id: t.id, state: this.loadTask(t.id).state, attempt: this.loadTask(t.id).attempt, files: files.map(f => f.path) };
      }
      // durable learnings the agent left (.relay-learnings.md) go into the project's context pack, only after a success
      const learn = a.status === "succeeded" && t.project && t.project !== "home" && typeof a.learnings === "string" ? await this.appendLearnings(t, peer, a.learnings) : null;
      this.setState(t, a.status === "succeeded" ? "succeeded" : "failed", peer, { summary: String(a.summary).slice(0, 2000), headline: card.lines.join("\n").slice(0, 1500) }, { ...res, ...(learn ? { learnings: learn } : {}) }, live);
      const next = a.status === "succeeded" ? await this.chainNext(this.loadTask(t.id)) : null;
      return { id: t.id, state: this.loadTask(t.id).state, files: files.map(f => f.path), ...(learn ? { learnings: learn } : {}), ...(next ? { chain_next: next } : {}) };
    },
  };
}

// task_create to an offline target, in words (incident 2026-10-23: tasks queued for hours behind a dead runner and the answer said only
// "normal"): a short drop is normal; a runner gone for minutes says for how long and points at status (src/space/health.ts)
export const offFor = (seen: string | null) => { const t = seen ? Date.parse(seen) : NaN; return Number.isFinite(t) ? ago(Date.now() - t) : null; };
export function offWords(name: string, seen: string | null, runner: boolean) {
  const t = seen ? Date.parse(seen) : NaN, long = !Number.isFinite(t) || Date.now() - t >= STALE_MS;
  if (!runner || !long) return `queued: ${name} isn't connected right now, which is normal (not an error). The task waits in its inbox and ${name} picks it up the next time it checks in`;
  return `queued, but ${name}'s runner has been OFFLINE ${Number.isFinite(t) ? `for ${ago(Date.now() - t)} (last seen ${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC)` : "and has never connected"}: nothing runs until it's back. Call status for why and the next step (often: on the Mac run kitebook restart runner) and tell the owner; the task stays queued meanwhile`;
}
