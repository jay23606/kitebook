// Space DO: retention (finished tasks, events, repos/ history) and blob GC (mark-and-sweep from the alarm).
// One layer of the Space class chain (core -> gc -> events -> files -> tasks -> Space in src/space.ts); split for size only, no behavior lives in the chain itself.
import { ACTIVE } from "./util.ts";
import { SpaceCore } from "./core.ts";

export class SpaceGc extends SpaceCore {
  // ---------- retention: tasks/events are bounded; shared files and knowledge have durable version history ----------
  // Finished tasks (their rows, events, live rows and tasks/<id>/ files, history included) and old events go after N days
  // (default 30: RETENTION_DAYS env, or per space via admin `retention`; 0 = keep forever). Blobs nothing references any more go through blob GC (gc below).
  // Never touched: active tasks, shared/ and other files, members, grants, approvals in flight, and the KB (kb/ + context/ files and the kb_* index).
  retentionDays(): number {
    const v = this.sql.exec("select v from meta where k='retention_days'").toArray()[0]?.v as string | undefined;
    const n = Number(v ?? (this.env as any).RETENTION_DAYS ?? 30); return Number.isFinite(n) && n >= 0 ? n : 30;
  }
  retentionNext(): number { return Number(this.sql.exec("select v from meta where k='retention_next'").toArray()[0]?.v ?? 0) || Date.now() + 3_600_000; }
  // Event cap: a busy space can write many events between daily runs, so the log is also capped by count (default 100000 per space:
  // EVENTS_MAX env, or per space via admin `retention <space> <days> <events_max>`; 0 = no cap). Oldest go first; events of active tasks
  // stay (loadTask reads a task's latest note and open question from them). Checked every 500 events and at each retention run.
  // Events are only the change feed: kb/ + context/ files, their history and the kb_* index never live in it, so a trim can't lose KB content.
  eventsMax(): number {
    const v = this.sql.exec("select v from meta where k='events_max'").toArray()[0]?.v as string | undefined;
    const n = Number(v ?? this.knob("EVENTS_MAX", 100_000)); return Number.isFinite(n) && n >= 0 ? n : 100_000;
  }
  trimEvents(act?: string[]): number {
    const max = this.eventsMax(); if (!max) return 0;
    const n = this.sql.exec("select count(*) n from events").one().n as number; if (n <= max) return 0;
    act ??= this.sql.exec(`select id from tasks where state in (${ACTIVE.map(() => "?").join(",")})`, ...ACTIVE).toArray().map(r => r.id as string);
    const floor = this.sql.exec("select seq from events order by seq desc limit 1 offset ?", max - 1).toArray()[0]?.seq as number | undefined; if (floor == null) return 0;
    return this.sql.exec(`delete from events where seq < ? and (task_id is null or task_id not in (${act.map(() => "?").join(",") || "''"})) returning seq`, floor, ...act).toArray().length;
  }
  async setRetention(days?: number | null, eventsMax?: number | null, reposHistory?: number | null, gcGraceSec?: number | null) {
    if (reposHistory !== undefined && reposHistory !== null) {
      if (!Number.isInteger(reposHistory) || reposHistory < 0 || reposHistory > 100_000) throw new Error("repos_history: 0 (current tree only) to 100000 earlier versions per repos/ file");
      this.sql.exec("insert or replace into meta values('repos_history',?)", String(reposHistory));
      if (this.ctx.storage.transactionSync(() => this.trimRepos())) { this.sql.exec("insert or replace into meta values('gc_dirty',?)", String(Date.now())); await this.armAlarm(Date.now() + 60_000); }
    }
    if (gcGraceSec !== undefined && gcGraceSec !== null) {
      if (!Number.isFinite(gcGraceSec) || gcGraceSec < 0 || gcGraceSec > 90 * 86400) throw new Error("gc_grace_sec: 0 to 7776000 (90 days)");
      this.sql.exec("insert or replace into meta values('gc_grace_sec',?)", String(gcGraceSec));
    }
    if (eventsMax !== undefined && eventsMax !== null) {
      if (!Number.isInteger(eventsMax) || eventsMax < 0 || eventsMax > 10_000_000) throw new Error("events_max: 0 (no cap) to 10000000");
      this.sql.exec("insert or replace into meta values('events_max',?)", String(eventsMax));
    }
    if (days !== undefined && days !== null) {
      if (!Number.isFinite(days) || days < 0 || days > 3650) throw new Error("retention days: 0 (keep forever) to 3650");
      this.sql.exec("insert or replace into meta values('retention_days',?)", String(days));
      if (days > 0) await this.armAlarm(this.retentionNext());
    }
    return { days: this.retentionDays(), next_run: this.retentionDays() > 0 ? new Date(this.retentionNext()).toISOString() : null,
      events_max: this.eventsMax(), events: this.sql.exec("select count(*) n from events").one().n as number, repos_history: this.reposHistory(), gc_grace_sec: this.gcGraceMs() / 1000 };
  }
  async ensureRefs() { if (this.store && !this.sql.exec("select 1 from meta where k='blob_refs'").toArray().length) await this.backfillRefs(); return { space: this.spaceId, key: this.refKey }; }
  async prune(olderThanMs?: number) {
    const cutoff = new Date(Date.now() - (olderThanMs ?? this.retentionDays() * 86_400_000)).toISOString(), done = ["succeeded", "failed", "rejected", "cancelled"];
    const ids = this.sql.exec(`select id from tasks where state in (${done.map(() => "?").join(",")}) and updated < ? limit 2000`, ...done, cutoff).toArray().map(r => r.id as string);
    let events = 0, repos = 0;
    this.ctx.storage.transactionSync(() => { // one sync step: a commit can't interleave between unlinking files and the GC mark below
      for (const id of ids) {
        for (const tb of ["tasks:id", "task_live:task_id", "events:task_id", "task_notes:task_id"]) { const [n, c] = tb.split(":"); this.sql.exec(`delete from ${n} where ${c}=?`, id); }
        this.sql.exec("delete from changes where path like ?", `tasks/${id}/%`); this.sql.exec("delete from tree where path like ?", `tasks/${id}/%`);
      }
      const act = this.sql.exec(`select id from tasks where state not in (${done.map(() => "?").join(",")})`, ...done).toArray().map(r => r.id as string);
      events = this.sql.exec(`delete from events where at < ? and (task_id is null or task_id not in (${act.map(() => "?").join(",") || "''"})) returning seq`, cutoff, ...act).toArray().length;
      events += this.trimEvents(act);
      repos = this.trimRepos();
      this.sql.exec("delete from commits where seq not in (select distinct seq from changes) and seq < (select max(seq) from commits)"); // keep head
    });
    // Blobs the unlinked files and trimmed repos/ versions leave behind go through blob GC (mark, then sweep after the grace).
    // An explicit prune window (older_than_sec) also caps the grace, so `admin.ts prune <space> 0` collects right away.
    const gc = await this.gc(olderThanMs === undefined ? undefined : Math.min(olderThanMs, this.gcGraceMs()));
    return { cutoff, tasks: ids.length, events, repos_versions: repos, blobs: gc.swept, external_blobs: gc.external_deleted, gc };
  }

  // ---------- blob GC: mark-and-sweep, driven by the DO alarm ----------
  // A blob is referenced while any file version still points at it: the current tree, the kept history (repos/** trimmed to its
  // bound, tasks/<id>/ gone with the task at retention), and always every kb/ and context/ version (never trimmed here). An export
  // in progress holds everything. Mark: unreferenced blobs get a timestamp. Sweep: ones still unreferenced after the grace
  // (BLOB_GC_GRACE_SEC, default 1 day; admin `gc <space> [grace_sec]`) are deleted, inline rows and external objects alike
  // (an external object only when no other space still marks it, see blobs.ts). The grace covers a client that asked `has`
  // and is about to commit by sha, and a re-upload of the same content. Uploads whose commit never landed (413, conflict,
  // crash) are tracked in blob_put and collected the same way. Bytes freed are kept for admin `usage`.
  exporting = 0;
  putting = new Map<string, number>();            // external uploads in flight (by sha)
  sweeping = new Map<string, Promise<void>>();    // external objects this space is deleting right now; a new upload of one waits
  get refKey() { return this.ctx.id.toString(); }
  gcGraceMs() { const v = this.sql.exec("select v from meta where k='gc_grace_sec'").toArray()[0]?.v; return (v != null ? Number(v) : this.knob("BLOB_GC_GRACE_SEC", 86_400)) * 1000; }
  reposHistory() { const v = this.sql.exec("select v from meta where k='repos_history'").toArray()[0]?.v; return v != null ? Number(v) : this.knob("REPOS_HISTORY", 10); }
  // keep each repos/ path's newest version + N earlier ones (REPOS_HISTORY, default 10; admin `retention <space> - - <n>`); returns rows dropped
  trimRepos(paths?: string[]): number {
    const keep = this.reposHistory() + 1, q = "delete from changes where path=? and seq <= coalesce((select c2.seq from changes c2 where c2.path=? order by c2.seq desc limit 1 offset ?), -1)";
    let n = 0; for (const p of paths ?? (this.sql.exec("select path from changes where path like 'repos/%' group by path having count(*) > ?", keep).toArray().map((r: any) => r.path as string)))
      n += this.sql.exec(q + " returning seq", p, p, keep).toArray().length;
    return n;
  }
  async extPut(sha: string, bytes: Uint8Array) {
    while (this.sweeping.has(sha)) await this.sweeping.get(sha);
    this.putting.set(sha, (this.putting.get(sha) ?? 0) + 1);
    this.sql.exec("insert or ignore into blob_put values(?,?,?)", sha, Date.now(), bytes.length);
    try { await this.store!.ref(sha, this.refKey); await this.store!.put(sha, bytes); }
    finally { const n = (this.putting.get(sha) ?? 1) - 1; if (n) this.putting.set(sha, n); else this.putting.delete(sha); }
  }
  async backfillRefs() {
    for (const r of this.sql.exec("select sha from blobs where loc != 'inline'").toArray() as any[]) await this.store!.ref(r.sha, this.refKey);
    this.sql.exec("insert or replace into meta values('blob_refs','1')");
  }
  gcDue(): number { // when the alarm next has GC work: a dirty mark (repos trim) or the first marked/pending blob's grace end
    const g = this.gcGraceMs(), d = this.sql.exec("select v from meta where k='gc_dirty'").toArray()[0]?.v;
    const m = this.sql.exec("select min(marked) m from blob_gc").one().m as number | null, p = this.sql.exec("select min(at) m from blob_put").one().m as number | null;
    const failures = Number(this.sql.exec("select v from meta where k='gc_failures'").toArray()[0]?.v ?? 0);
    if (failures >= 8) return Infinity; // storage needs operator attention; do not wake/bill forever
    const retry = Number(this.sql.exec("select v from meta where k='gc_retry_at'").toArray()[0]?.v ?? 0);
    return Math.max(retry, Math.min(d != null ? Number(d) + 60_000 : Infinity, m != null ? m + g : Infinity, p != null ? p + g : Infinity));
  }
  gcStats() {
    const k = (x: string) => Number(this.sql.exec("select v from meta where k=?", x).toArray()[0]?.v ?? 0);
    const p = this.sql.exec("select count(*) n, coalesce(sum(b.size),0) s from blob_gc g join blobs b on b.sha=g.sha").one() as any;
    return { freed_bytes: k("gc_freed_bytes"), freed_blobs: k("gc_freed_blobs"), marked_blobs: p.n as number, marked_bytes: p.s as number,
      pending_uploads: this.sql.exec("select count(*) n from blob_put").one().n as number, grace_sec: this.gcGraceMs() / 1000, repos_history: this.reposHistory(),
      retry_failures: k("gc_failures"), retry_paused: k("gc_failures") >= 8, retry_at: k("gc_retry_at") && k("gc_failures") < 8 ? new Date(k("gc_retry_at")).toISOString() : null,
      last_run: k("gc_last") ? new Date(k("gc_last")).toISOString() : null };
  }
  gcPending?: Promise<any>;
  gc(graceMs = this.gcGraceMs(), retry = false): Promise<any> {
    return this.gcPending ??= this.collectBlobs(graceMs, retry).finally(() => { this.gcPending = undefined; });
  }
  async collectBlobs(graceMs: number, retry: boolean) {
    if (retry) this.sql.exec("delete from meta where k in ('gc_failures','gc_retry_at')");
    const failures = Number(this.sql.exec("select v from meta where k='gc_failures'").toArray()[0]?.v ?? 0);
    const retryAt = Number(this.sql.exec("select v from meta where k='gc_retry_at'").toArray()[0]?.v ?? 0);
    if (failures >= 8 || retryAt > Date.now()) return { deferred: failures >= 8 ? "storage failures: retry paused; operator gc resumes" : "storage retry cooldown", marked: 0, swept: 0, freed_bytes: 0, external_deleted: 0 };

    if (this.exporting) { await this.armAlarm(Date.now() + 60_000); return { deferred: "export in progress", marked: 0, swept: 0, freed_bytes: 0, external_deleted: 0 }; }
    const t = Date.now(), due = t - graceMs, ext = new Set<string>(), orphan = new Map<string, number>(); let marked = 0, swept = 0, freed = 0;
    this.ctx.storage.transactionSync(() => { // mark + row sweep in one sync step: no commit interleaves between "unreferenced" and delete
      this.sql.exec("delete from blob_gc where sha in (select sha from changes where sha is not null) or sha not in (select sha from blobs)"); // referenced again: unmark
      // The KB is never collected: kb/ and context/ versions are in `changes` and nothing here trims them (listed explicitly anyway).
      marked = this.sql.exec(`insert or ignore into blob_gc select sha, ? from blobs where sha not in (select sha from changes where sha is not null)
        and sha not in (select sha from changes where sha is not null and (path like 'kb/%' or path like 'context/%')) returning sha`, t).toArray().length;
      for (const b of this.sql.exec("select g.sha, b.size, b.loc from blob_gc g join blobs b on b.sha=g.sha where g.marked <= ?", due).toArray() as any[]) {
        this.sql.exec("delete from blobs where sha=?", b.sha); this.sql.exec("delete from blob_gc where sha=?", b.sha); swept++; freed += b.size; if (b.loc !== "inline") ext.add(b.sha);
      }
      // uploads that never became a row (commit refused or crashed): past the grace they're orphans in the store
      for (const r of this.sql.exec("select sha, size from blob_put where at <= ? and sha not in (select sha from blobs)", due).toArray() as any[])
        if (!this.putting.has(r.sha)) { this.sql.exec("delete from blob_put where sha=?", r.sha); ext.add(r.sha); orphan.set(r.sha, Number(r.size ?? 0)); }
      this.sql.exec("delete from blob_put where sha in (select sha from blobs)");
      this.sql.exec("delete from meta where k='gc_dirty'");
    });
    let deleted = 0, failed = false;
    const held = (sha: string) => this.putting.has(sha) || this.sql.exec("select 1 from blobs where sha=? union all select 1 from blob_put where sha=?", sha, sha).toArray().length > 0;
    for (const sha of ext) {
      if (!this.store || held(sha) || this.sweeping.has(sha)) continue;
      let done!: () => void; this.sweeping.set(sha, new Promise<void>(r => done = r));
      try {
        await this.store.unref(sha, this.refKey);
        if (held(sha)) { await this.store.ref(sha, this.refKey); continue; } // re-used while we awaited: keep it
        if ((await this.store.refs(sha)) === 0) { await this.store.del(sha); deleted++; if (orphan.has(sha)) { freed += orphan.get(sha)!; swept++; } } // another space still marks it: theirs now
      } catch (e) { failed = true; console.error("blob gc", sha, e); this.sql.exec("insert or replace into blob_put values(?,?,?)", sha, Date.now() - this.gcGraceMs() + 60_000, orphan.get(sha) ?? 0); } // persist a retry deadline >= 1 minute away, even with zero grace; timestamp + grace = deadline
      finally { this.sweeping.delete(sha); done(); }
    }
    if (failed) this.sql.exec("insert or replace into meta values('gc_failures',?),('gc_retry_at',?)", String(failures + 1), String(Date.now() + Math.min(3600000, 60000 * 2 ** failures)));
    else this.sql.exec("delete from meta where k in ('gc_failures','gc_retry_at')");
    const m = (k: string) => Number(this.sql.exec("select v from meta where k=?", k).toArray()[0]?.v ?? 0); // bytes freed: rows swept + orphan uploads deleted
    this.sql.exec("insert or replace into meta values('gc_freed_bytes',?),('gc_freed_blobs',?),('gc_last',?)", String(m("gc_freed_bytes") + freed), String(m("gc_freed_blobs") + swept), String(t));
    const next = this.gcDue(); if (next < Infinity) await this.armAlarm(Math.max(next, Date.now() + 1000));
    return { marked, swept, freed_bytes: freed, external_deleted: deleted };
  }
}
