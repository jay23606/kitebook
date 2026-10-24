// Space ops: status (is it working, or what died and what to do; any connected app, read-only) and health_report (runner only: what the
// Mac's watchdog and the runner say about the runner's restarts and exits). Verdict logic: src/health.ts. Part of the impl table (src/space.ts).
import { RelayError } from "../ops.ts";
import type { Space, Op } from "../space.ts";
import { SERVER_BUILD } from "../build.ts";
import { redact } from "./util.ts";
import { BOOT, ago, runnerVerdict, overall, type RunnerOut } from "../health.ts";

const s = (v: any, n: number) => v == null ? null : String(v).slice(0, n);
const iso = (v: any) => { const t = typeof v === "number" ? v : Date.parse(String(v ?? "")); return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null; };

// every runner's verdict (also the /start banner: ownerStatus -> peers[].health)
export function runnerHealth(sp: Space, m: any, now = Date.now()): RunnerOut {
  const p = sp.presence(m), n = (q: string) => Number((sp.sql.exec(`select count(*) n from tasks where target_peer=? and state in (${q})`, m.peer_id).one() as any).n);
  const h = sp.metaJ("rhealth:" + m.name) ?? {};
  return runnerVerdict({ name: m.name, online: p.online, last_seen: p.last_seen, never_connected: !p.online && !p.last_seen,
    running: n("'claimed','awaiting_approval','running','needs_input'"), queued: n("'queued'"), watchdog: h.watchdog ?? null, last_exit: h.last_exit ?? null, started_at: h.started_at ?? null }, now);
}

export function healthOps(this: Space): Record<string, Op> {
  return {
    status: async (peer) => {
      this.need(peer, "read"); const now = Date.now();
      const rows = this.sql.exec("select * from members where kind='runner' and revoked=0 order by name").toArray() as any[];
      const runners = rows.map(m => runnerHealth(this, m, now)), v0 = overall(runners);
      // preflight for what's waiting (src/health.ts preflight): a queued task whose agent/project/model is missing on its runner, said plainly
      const blocked: any[] = [], gitNotes: Record<string, string[]> = {};
      for (const m of rows) {
        for (const r of this.sql.exec("select id from tasks where target_peer=? and state='queued' and coalesce(kind,'')<>'ask' order by created limit 20", m.peer_id).toArray() as any[]) {
          const tk: any = this.loadTask(r.id), pf = await (this as any).preflightFor(m, { agent: tk.agent ?? null, model: tk.model ?? null, project: tk.project ?? null, kind: tk.kind ?? null });
          if (pf.problems.length) blocked.push({ id: tk.id, title: String(tk.title ?? "").slice(0, 120), runner: m.name, agent: pf.agent, problems: pf.problems }); }
        try { const c = this.sql.exec("select data from code_state where runner=?", m.name).toArray()[0] as any, d = c ? JSON.parse(c.data) : {};
          const n = Object.entries<any>(d).flatMap(([k, x]) => [x?.missing ? `${k}: ${x.error}` : null, x?.fetch_error?.error ? `${k}: git fetch failed (${x.fetch_error.error})` : null].filter(Boolean) as string[]);
          if (n.length) gitNotes[m.name] = n; } catch {} }
      const v = blocked.length ? { ok: false, verdict: `${v0.ok ? "Working, but" : v0.verdict + ";"} ${blocked.length} queued task${blocked.length === 1 ? " can't" : "s can't"} run: ${[...new Set(blocked.flatMap(b => b.problems))].slice(0, 3).join("; ")}`,
        next: v0.next ?? "Install or fix what's missing on the Mac, or cancel the task and send it again with an agent/project the Mac has (describe lists them)" } : v0;
      // relay_update asks the Mac hasn't answered yet (a day; src/space/peers.ts relay_update): with the runner down they just wait
      const done = new Set(rows.flatMap(m => ((this.metaJ("rset:" + m.name) ?? {}).done ?? []).map((d: any) => d.id)));
      const pending = (this.metaJ("update_reqs", []) as any[]).filter(q => now - q.at < 86400_000 && !q.reported && !done.has(q.id))
        .map(q => ({ id: q.id, by: q.by, asked: new Date(q.at).toISOString(), waiting: ago(now - q.at), note: runners.some(r => r.state !== "online") ? "waits until the runner is back" : "the Mac picks it up when idle" }));
      return { ok: v.ok, verdict: v.verdict, next: v.next, checked_at: new Date(now).toISOString(),
        server: { ok: true, version: SERVER_BUILD.version, sha: SERVER_BUILD.commit, channel: SERVER_BUILD.channel, started_at: new Date(BOOT).toISOString(), uptime_s: Math.round((now - BOOT) / 1000) },
        runners: runners.map(r => ({ name: r.name, state: r.state, online: r.online, last_seen: r.last_seen, down_for: r.down_s != null ? ago(r.down_s * 1000) : null, running: r.running ?? 0, queued: r.queued ?? 0,
          line: r.line, next: r.next, healing: r.healing, last_exit: r.last_exit ?? null, started_at: r.started_at ?? null,
          ...(gitNotes[r.name] ? { git: gitNotes[r.name] } : {}),
          watchdog: r.watchdog ? { at: r.watchdog.at ?? null, state: r.watchdog.state ?? null, tries_this_hour: r.watchdog.tries ?? 0, last_try: r.watchdog.last_try ?? null, last_result: r.watchdog.last_result ?? null, alerted: r.watchdog.alerted ?? null } : null })),
        pending_updates: pending, blocked_tasks: blocked,
        note: v.ok ? "Everything answers. If a task still looks stuck, task_status <id> shows its live phase." : "Tell the owner the verdict and the next step in these words; tasks you send meanwhile wait in the queue (nothing is lost)." };
    },
    // Runner only (its token; the runner at start, the Mac's watchdog every minute): the last exit reason, when it started, the watchdog's state
    health_report: async (peer, a) => {
      if (peer.kind !== "runner") throw new RelayError(403, "runners only");
      const cur = this.metaJ("rhealth:" + peer.name) ?? {}, w = a?.watchdog, x = a?.last_exit;
      const next = { ...cur, at: new Date().toISOString(),
        ...(w && typeof w === "object" ? { watchdog: { at: new Date().toISOString(), state: s(w.state, 30), tries: Math.max(0, Math.min(99, Number(w.tries) || 0)), last_try: iso(w.last_try), last_result: s(w.last_result == null ? null : redact(String(w.last_result)), 300), alerted: iso(w.alerted), stopped_by_owner: !!w.stopped_by_owner } } : {}),
        ...(x && typeof x === "object" ? { last_exit: { at: iso(x.at), reason: s(x.reason == null ? null : redact(String(x.reason)), 300), stack: s(x.stack == null ? null : redact(String(x.stack)), 2000) } } : x === null ? { last_exit: null } : {}),
        ...(a?.started_at ? { started_at: iso(a.started_at) } : {}) };
      this.metaSet("rhealth:" + peer.name, next); return { ok: true };
    },
  };
}
