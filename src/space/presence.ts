// Space ops: presence (G5). Every runner and agent session says what it is doing ({agent, repo, branch, task, phase, busy}) with a
// heartbeat; `presence` reads it back as "who's working" in plain words ("Pi on relay-cf · branch hark/x · running tests · 2m").
// A session that misses a heartbeat (no report for 2 x its own interval) reads offline. Part of the impl table (src/space.ts).
// A runner's held tasks fill in what the server already knows (phase, agent, project, start time from task_live), so a session only
// has to name its task; a runner that predates presence still shows up from its tasks (source "task").
import { RelayError, type Peer } from "../ops.ts";
import { ACTIVE, now, redact } from "./util.ts";
import type { Space, Op } from "../space.ts";

export const PRESENCE_SCHEMA = `create table if not exists presence(peer_id text, session text, data text, every integer, last_seen text, since text, primary key(peer_id, session));`;
const EVERY_DEFAULT = 30, EVERY_MIN = 2, EVERY_MAX = 600, KEEP_MS = 86400_000, MAX_SESSIONS = 20;
// short phase words for the panel line (the Status card's longer PHASE_WORDS read as sentences)
const DOING: Record<string, string> = { queued: "queued", waiting_approval: "waiting for your approval", approved: "starting", agent_running: "working",
  verifying: "running tests", uploading: "sending results", needs_input: "waiting for an answer", done: "finishing", idle: "idle",
  answering: "answering a quick question", ask_warm: "ready for quick questions" }; // the runner's quick-ask sessions (auto presence)
const cap = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s;
const str = (v: any, n: number) => v == null || v === "" ? null : redact(String(v)).replace(/\s+/g, " ").trim().slice(0, n) || null;
export const shortDur = (s: number) => s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;

// One plain line per session: what a person reads on the panel and an assistant can quote as is.
function lineOf(r: any) {
  const who = r.agent ? cap(r.agent) : r.who;
  if (r.state === "offline") return `${who}${r.agent && r.who !== r.agent ? ` (${r.who})` : ""} · offline · last seen ${shortDur(Math.max(0, Math.round((Date.now() - Date.parse(r.last_seen)) / 1000)))} ago`;
  if (r.state === "idle" && !r.repo && !r.task) return `${who}${r.agent && r.who !== r.agent ? ` (${r.who})` : ""} · idle`;
  return [`${who} on ${r.repo ?? (r.task ? "a machine task" : r.who)}`, r.branch ? `branch ${r.branch}` : null, r.doing, r.busy_s != null && r.state === "busy" ? shortDur(r.busy_s) : null].filter(Boolean).join(" · ");
}

// viewer: the peer asking (titles only for tasks it is party to), or null for the owner's /start page (sees every title)
export function presenceView(sp: Space, viewer: Peer | null) {
  const t0 = Date.now();
  sp.sql.exec("delete from presence where julianday(last_seen) < julianday(?)", new Date(t0 - KEEP_MS).toISOString()); // a day offline: gone
  const rows = sp.sql.exec("select p.*, m.name, m.kind from presence p join members m on m.peer_id=p.peer_id where m.revoked=0 order by m.name, p.session").toArray() as any[];
  const out: any[] = [], covered = new Set<string>();
  const taskOf = (id: string) => { try { return sp.loadTask(id); } catch { return null; } };
  for (const r of rows) {
    const d = JSON.parse(r.data ?? "{}"), off = Date.parse(r.last_seen) + 2 * Number(r.every || EVERY_DEFAULT) * 1000 < t0;
    const s: any = { who: r.name, kind: r.kind, session: r.session, agent: d.agent ?? null, model: d.model ?? null, repo: d.repo ?? null, branch: d.branch ?? null, task: null, phase: d.phase ?? null,
      busy: !!d.busy, last_seen: r.last_seen, since: r.since ?? null, source: "report" };
    const t = d.task ? taskOf(d.task) : null;
    if (t && (t.target_peer === r.peer_id || t.from_peer === r.peer_id)) {
      const party = !viewer || t.from_peer === viewer.id || t.target_peer === viewer.id;
      s.task = t.id; if (party) s.title = String(t.title ?? "").slice(0, 120);
      if (t.target_peer === r.peer_id && ACTIVE.includes(t.state)) { // the runner's own live report is fresher than its heartbeat
        const l = sp.liveFor(t); covered.add(t.id);
        s.phase = t.state === "needs_input" ? "needs_input" : t.kind === "ask" && l.phase === "agent_running" ? "answering" : l.phase; s.agent = s.agent ?? l.agent; s.repo = s.repo ?? (t.project && t.project !== "home" ? t.project : null);
        s.branch = s.branch ?? (t.project && t.project !== "home" ? (t.result?.structured?.branch ?? null) : null);
        if (l.started_at) s.since = l.started_at; s.busy = t.state !== "needs_input";
      } else if (!ACTIVE.includes(t.state)) { s.phase = null; s.busy = false; s.task = null; delete s.title; } // finished since the last heartbeat
    }
    s.state = off ? "offline" : s.busy ? "busy" : "idle";
    s.doing = s.state === "idle" && !s.phase ? "idle" : DOING[s.phase] ?? (s.phase ? String(s.phase) : s.busy ? "working" : "idle");
    s.busy_s = s.since ? Math.max(0, Math.round((t0 - Date.parse(s.since)) / 1000)) : null;
    out.push(s);
  }
  // runners that hold tasks no session names (an older runner, or between heartbeats): the server's own view of those tasks
  const held = sp.sql.exec(`select t.id, t.target_peer, m.name, m.kind, m.last_seen from tasks t join members m on m.peer_id=t.target_peer where m.kind='runner' and m.revoked=0 and t.state in ('claimed','awaiting_approval','running','needs_input') order by t.created`).toArray() as any[];
  for (const h of held) {
    if (covered.has(h.id)) continue; const t = taskOf(h.id); if (!t) continue;
    const l = sp.liveFor(t), pr = sp.presence({ peer_id: h.target_peer, last_seen: h.last_seen }), party = !viewer || t.from_peer === viewer.id || t.target_peer === viewer.id;
    const s: any = { who: h.name, kind: h.kind, session: t.id, agent: l.agent, repo: t.project && t.project !== "home" ? t.project : null, branch: t.result?.structured?.branch ?? null, task: t.id,
      ...(party ? { title: String(t.title ?? "").slice(0, 120) } : {}), phase: t.state === "needs_input" ? "needs_input" : t.kind === "ask" && l.phase === "agent_running" ? "answering" : l.phase, busy: t.state !== "needs_input", last_seen: pr.last_seen, since: l.started_at, source: "task" };
    s.state = !pr.online && (!pr.last_seen || Date.parse(pr.last_seen) + 2 * EVERY_DEFAULT * 1000 < t0) ? "offline" : s.busy ? "busy" : "idle";
    s.doing = DOING[s.phase] ?? s.phase; s.busy_s = s.since ? Math.max(0, Math.round((t0 - Date.parse(s.since)) / 1000)) : null;
    out.push(s);
  }
  // busy first, then idle, then offline; one reporter's idle row is dropped when the same reporter has a busy one
  const busyWho = new Set(out.filter(s => s.state === "busy" || (s.state === "idle" && s.task)).map(s => s.who));
  const list = out.filter(s => !(s.state === "idle" && !s.task && !s.repo && busyWho.has(s.who)));
  const rank: Record<string, number> = { busy: 0, idle: 1, offline: 2 };
  list.sort((a, b) => rank[a.state] - rank[b.state] || (b.busy_s ?? -1) - (a.busy_s ?? -1) || a.who.localeCompare(b.who));
  for (const s of list) s.line = lineOf(s);
  const n = (k: string) => list.filter(s => s.state === k).length;
  const summary = list.length ? [n("busy") && `${n("busy")} working`, n("idle") && `${n("idle")} idle`, n("offline") && `${n("offline")} offline`].filter(Boolean).join(", ") : "nobody is reporting right now";
  return { sessions: list, summary, at: now() };
}

export function presenceOps(this: Space): Record<string, Op> {
  return {
    // a heartbeat: the reporter's sessions as they are now. Without merge the list replaces every session this peer reported before
    // (a runner sends its whole picture); merge:true upserts just these (an agent with several windows), end:true removes one.
    presence_report: async (peer, a) => {
      const m = this.member(peer.id); if (!m || m.revoked) throw new RelayError(403, `no access to workspace ${this.spaceId}`);
      const every = Math.min(EVERY_MAX, Math.max(EVERY_MIN, Math.round(Number(a.every ?? EVERY_DEFAULT)) || EVERY_DEFAULT));
      const list = a.sessions == null ? [{}] : a.sessions;
      if (!Array.isArray(list) || list.length > MAX_SESSIONS || list.some((x: any) => !x || typeof x !== "object" || Array.isArray(x))) throw new RelayError(400, `sessions: a list of up to ${MAX_SESSIONS} {session, agent, repo, branch, task, phase, busy}`);
      const ts = now(), keep: string[] = [];
      for (const x of list) {
        const session = str(x.session, 80) ?? "default";
        if (x.end === true) { this.sql.exec("delete from presence where peer_id=? and session=?", peer.id, session); continue; }
        let task = str(x.task, 40); // only a task this peer sent or holds: nobody gets to say they're on someone else's task
        if (task) { const t = this.sql.exec("select from_peer, target_peer from tasks where id=?", task).toArray()[0] as any; if (!t || (t.from_peer !== peer.id && t.target_peer !== peer.id)) task = null; }
        const d = { agent: str(x.agent, 40), model: str(x.model, 80), repo: str(x.repo, 120), branch: str(x.branch, 160), task, phase: str(x.phase, 60), busy: x.busy === true || (x.busy == null && !!task) };
        const cur = this.sql.exec("select data, since from presence where peer_id=? and session=?", peer.id, session).toArray()[0] as any, prev = cur ? JSON.parse(cur.data) : null;
        const since = d.busy ? (prev?.busy && prev.task === d.task && prev.repo === d.repo && cur?.since ? cur.since : str(x.since, 40) ?? ts) : null; // busy since: kept while it's the same work
        this.sql.exec("insert or replace into presence(peer_id, session, data, every, last_seen, since) values(?,?,?,?,?,?)", peer.id, session, JSON.stringify(d), every, ts, since);
        keep.push(session);
      }
      if (a.merge !== true) { const rest = (this.sql.exec("select session from presence where peer_id=?", peer.id).toArray() as any[]).map(r => r.session as string).filter(s => !keep.includes(s));
        for (const s of rest) this.sql.exec("delete from presence where peer_id=? and session=?", peer.id, s); }
      try { this.seen(peer.id); } catch {}
      return { ok: true, sessions: keep.length, every, offline_after_s: every * 2 };
    },
    presence: async (peer) => { this.need(peer, "read"); return presenceView(this, peer); },
  };
}
