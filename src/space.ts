// One Durable Object per space: files (content-addressed blobs + linear changesets), tasks, events, live sockets.
// Single-threaded, so every commit lands in order; if_match gives optimistic concurrency on top.
// The class is split by area into a chain of layers in src/space/ (core -> gc -> events -> files -> tasks), and the op table into
// fileOps/peerOps/taskOps/kbOps; this file keeps what the Worker and the Dir object call: setup, admin RPC, the alarm, run, sockets.
import { RESOURCE, failureDecision } from "../client/resource-guard.ts";
import { normAcct, dirName } from "../client/account.ts";
import { missing, RelayError, type Peer, type Res } from "./ops.ts";
import { EventsError, CODES } from "./events.ts";
import { blobStore, b64encode, b64decode, INLINE_MAX, EXTERNAL_AT } from "./blobs.ts";
import * as KB from "./kb.ts";
import { HELD, RELAY, OWNER, STUCK_STATES, now, redact } from "./space/util.ts";
import { SpaceTasks, taskOps } from "./space/tasks.ts";
import { ownerWorkspace } from "./workspace-ui.ts";
import { SYNC_SCHEMA, syncOps } from "./space/sync.ts";
import { fileOps } from "./space/files.ts";
import { peerOps } from "./space/peers.ts";
import { kbOps } from "./space/kb.ts";
import { askOps } from "./space/ask.ts";
import { sessionOps, sessionsLog } from "./space/sessions.ts";
import { presenceOps, presenceView, PRESENCE_SCHEMA } from "./space/presence.ts";
import { briefOps, briefOwner, briefView } from "./space/brief.ts";
import { healthOps } from "./space/health.ts";
import { checkEnvelope, checkCmd, mintAppKey, AUTORUN_KEY, LEGACY_AUTORUN_KEY } from "./policy.ts";
import { summarize, canon, describeAutorun, describeExperimental, standingEntry, migratePolicy, experimentalOn } from "../client/payload.ts";
// the two switches, normalized (a legacy dev field reads as both): "one change at a time" compares these, not the raw fields
const arN = (p: any) => canon(migratePolicy(p ?? {}).autorun ?? null), exN = (p: any) => canon(experimentalOn(p));
import * as DL from "./devlog.ts";
import { SERVER_BUILD } from "./build.ts";

export type Op = (peer: Peer, a: any) => Promise<any>;

export class Space extends SpaceTasks {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SYNC_SCHEMA);
    this.sql.exec(`
create table if not exists meta(k text primary key, v text);
create table if not exists members(peer_id text primary key, name text, kind text, verbs text, paths text, webhook text, revoked integer default 0);
create table if not exists blobs(sha text primary key, content text, size integer);
create table if not exists commits(seq integer primary key autoincrement, id text unique, author text, at text, message text);
create table if not exists changes(seq integer, path text, sha text, primary key(seq, path));
create index if not exists changes_path on changes(path, seq);
create table if not exists tree(path text primary key, sha text, size integer, seq integer);
create table if not exists tasks(id text primary key, from_peer text, target_peer text, title text, instructions text, project text,
  scope text, acceptance text, verify text, limits text, state text, needs_approval integer, result text, created text, updated text);
create table if not exists events(seq integer primary key autoincrement, type text, path text, task_id text, actor text, data text, at text);
create table if not exists event_subs(id text primary key, peer_id text, name text, args text, url text, secret text, prev_secret text, prev_until text,
  refresh_before text, active integer default 1, fails integer default 0, last_delivery_at text, last_error text, failed_since text, created text, updated text);
create table if not exists event_verified(peer_id text, url text, at text, primary key(peer_id, url));
create table if not exists asks(id text primary key, runner text, kind text, task text, view text, nonce text, passkey text, expires integer, state text, response text, created text);
create table if not exists outbox(id integer primary key autoincrement, kind text, target text, lo integer, seq integer, body text, extra text,
  attempts integer default 0, next_at integer, last_error text, created text);
create index if not exists outbox_due on outbox(next_at);
create table if not exists task_live(task_id text primary key, data text, updated text);
create index if not exists events_task on events(task_id, seq);
create table if not exists task_notes(id integer primary key autoincrement, task_id text, file text, actor text, at text, body text);
create index if not exists task_notes_task on task_notes(task_id, file, id);
create table if not exists code_state(runner text primary key, data text, updated text);
create table if not exists blob_gc(sha text primary key, marked integer);
create table if not exists blob_put(sha text primary key, at integer, size integer);`);
    this.sql.exec(PRESENCE_SCHEMA); // who's working (src/space/presence.ts): one row per reported session, with its heartbeat
    try { this.sql.exec("alter table tasks add column steers text"); } catch {} // live steering notes (task_steer), JSON
    this.sql.exec(KB.KB_SCHEMA); // live knowledge base: derived index over kb/ files (src/kb.ts)
    let kbAuthor = false; for (const col of ["author text", "author_kind text"]) try { this.sql.exec(`alter table kb_entries add column ${col}`); kbAuthor = true; } catch {} // KB provenance (R8)
    if (kbAuthor && this.sql.exec("select 1 from kb_entries limit 1").toArray().length) ctx.blockConcurrencyWhile(async () => { await KB.rebuild(this); }); // older index: fill authors from commit history
    try { this.sql.exec("alter table members add column last_seen text"); } catch {}
    try { this.sql.exec("alter table asks add column owner_only integer default 0"); } catch {} // dialog-path pages: owner session only (phone act)
    try { this.sql.exec("alter table event_subs add column grant_id text"); } catch {} // OAuth family that subscribed (ends with it)
    try { this.sql.exec("alter table tasks add column continue_from text"); } catch {}
    try { this.sql.exec("alter table tasks add column spec text"); } catch {} // task spec v2 (JSON), null for plain-instruction tasks
    for (const col of ["agent text", "model text", "kind text", "qa text"]) try { this.sql.exec(`alter table tasks add column ${col}`); } catch {} // per-task agent/model pick
    for (const col of ["enc text default 'utf8'", "loc text default 'inline'"]) try { this.sql.exec(`alter table blobs add column ${col}`); } catch {}
    for (const col of ["attempt integer default 1", "max_retries integer default 1", "attempts text"]) try { this.sql.exec(`alter table tasks add column ${col}`); } catch {} // auto-requeue
    for (const col of ["chain text", "parent_id text", "chain_step integer"]) try { this.sql.exec(`alter table tasks add column ${col}`); } catch {} // chains: steps on one branch
    // tasks are looked up by target/sender/state (inbox, check, status card, retention) and chain parent: indexes, not table scans
    this.sql.exec(`create index if not exists tasks_target on tasks(target_peer, state); create index if not exists tasks_from on tasks(from_peer, state);
      create index if not exists tasks_state on tasks(state, updated); create index if not exists tasks_parent on tasks(parent_id, chain_step);`);
    try { this.sql.exec("alter table tasks add column kb_context text"); } catch {}
    try { this.sql.exec("alter table tasks add column session text"); } catch {} // live-sessions: {mode new|fork|continue, agent, from} (src/space/sessions.ts) // KB hits attached at create (JSON)
    for (const col of ["repo text", "base text", "change text"]) try { this.sql.exec(`alter table tasks add column ${col}`); } catch {} // git-first: code is referenced by repo + base, never copied in
    try { this.sql.exec("alter table tasks add column stuck_at text"); } catch {} // when "stuck?" was last raised (once per quiet spell)
    for (const col of ["held_since text", "held_acc integer default 0"]) try { this.sql.exec(`alter table tasks add column ${col}`); } catch {} // held-seconds cap (heldCap)
    this.store = blobStore(env);
    // Blob GC markers (blobs.ts): external blobs stored before markers existed get theirs the first time the space wakes, so another
    // space's GC never deletes an object this one still uses. Runs in the background; retried on the next wake until it completes.
    if (!this.resourcesPaused() && this.store && this.sql.exec("select 1 from meta where k='blob_refs'").toArray().length === 0) ctx.waitUntil(this.backfillRefs().catch(e => console.error("blob refs backfill", e)));
    // Safety net: pending webhook deliveries always have an alarm behind them, even if one was lost (restart, older code).
    ctx.blockConcurrencyWhile(async () => { if (!this.resourcesPaused() && this.sql.exec("select 1 from outbox limit 1").toArray().length && (await ctx.storage.getAlarm()) === null) await this.armAlarm(Math.max(Date.now() + 1000, Number(this.sql.exec("select min(next_at) t from outbox").one().t) || 0)); });
    // Retention runs from the same alarm (daily), so a space that only ever finished tasks still gets pruned.
    ctx.blockConcurrencyWhile(async () => { if (!this.resourcesPaused() && this.retentionDays() > 0 && this.sql.exec("select 1 from tasks limit 1").toArray().length && (await ctx.storage.getAlarm()) === null) await this.armAlarm(this.retentionNext()); });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
  // ---------- admin (called by the Dir object only) ----------
  async init(id: string, name: string, acct?: string, storageMb?: number) {
    this.sql.exec("insert or replace into meta values('id',?),('name',?)", id, name);
    if (acct) this.sql.exec("insert or replace into meta values('acct',?),('quota_mb',?)", acct, String(storageMb ?? 0)); // the account's storage quota, pushed by its Dir
    return { id, name };
  }
  // stored bytes: every blob any commit kept (history included), inline or in R2/S3; gc = what blob GC freed and what waits out its grace
  async usage() { return { bytes: (this.sql.exec("select coalesce(sum(size),0) b from blobs").one().b as number), gc: this.gcStats() }; }
  // An OAuth grant ended (oauth.ts killFamily): drop what it opened here. Same peer's other grants and its peer token keep theirs.
  async endGrant(peerId: string, grant: string, reason: string) {
    const e = new EventsError(CODES.Forbidden, "Forbidden", { reason });
    for (const sub of this.sql.exec("select * from event_subs where peer_id=? and grant_id=?", peerId, grant).toArray()) this.evKillSub(sub, e);
    for (const st of [...this.evStreams.values()]) if (st.peer.id === peerId && st.peer.grant === grant) this.evTerminate(st, e);
    for (const ws of this.ctx.getWebSockets(peerId)) { try { if ((ws.deserializeAttachment() as any)?.grant === grant) ws.close(4001, "grant revoked"); } catch {} }
    return { ok: true };
  }
  async setMember(m: { id: string; name: string; kind: string; verbs?: string[]; paths?: string[]; webhook?: string | null; revoked?: number; terminate?: string }) {
    const cur = this.member(m.id);
    // an upsert, not insert-or-replace: a changed grant keeps the member's last_seen (else Settings reads a connected app as "not connected yet")
    this.sql.exec("insert into members(peer_id,name,kind,verbs,paths,webhook,revoked) values(?,?,?,?,?,?,?) on conflict(peer_id) do update set name=excluded.name, kind=excluded.kind, verbs=excluded.verbs, paths=excluded.paths, webhook=excluded.webhook, revoked=excluded.revoked", m.id, m.name, m.kind,
      JSON.stringify(m.verbs ?? cur?.verbs ?? []), JSON.stringify(m.paths ?? cur?.paths ?? []), m.webhook ?? cur?.webhook ?? null, m.revoked ?? 0);
    if (m.terminate) this.metaSet("session_epoch:" + m.id, crypto.randomUUID());
    if (m.revoked) for (const ws of this.ctx.getWebSockets(m.id)) ws.close(4001, "revoked");
    if (m.revoked && ["assistant","coding_agent"].includes(m.kind)) {
      for (const r of this.sql.exec("select id from tasks where (from_peer=? or target_peer=?) and state in ('queued','claimed','awaiting_approval','running','needs_input')",m.id,m.id).toArray() as any[])
        this.cancelTask(this.loadTask(r.id),OWNER,"Connected app disconnected");
      for (const wake of [...this.waiters]) wake();
    }
    // An event subscription is a credential: revoking (or rotating) the peer's token ends every subscription and stream it holds,
    // and a narrowed grant ends the ones it no longer covers.
    if (m.terminate) this.evEndPeer(m.id, new EventsError(CODES.Forbidden, "Forbidden", { reason: m.terminate }));
    else this.evRecheck(m.id);
    return { ok: true };
  }
  // ---------- the owner's standing permissions (src/policy.ts; the Dir calls these for the /start Permissions panel) ----------
  metaJ(k: string, d: any = null) { const r = this.sql.exec("select v from meta where k=?", k).toArray()[0] as any; try { return r ? JSON.parse(r.v) : d; } catch { return d; } }
  metaSet(k: string, v: any) { this.sql.exec("insert or replace into meta values(?,?)", k, JSON.stringify(v)); }
  async setOwnerKeys(keys: any[]) { this.metaSet("owner_keys", keys); return { ok: true }; } // the account's registered owner keys (the Dir's list, copied here)
  // the relay-held signing key for an app that can't sign its own tasks; minted once, only the public half ever leaves the space
  async appKey(name: string) { let k = this.metaJ(`appkey:${name}`); if (!k) { k = await mintAppKey(); this.metaSet(`appkey:${name}`, k); } return { pub: k.pub }; }
  // Settings changes for the Mac (owner commands, client/payload.ts): checked here so a forged one is refused early, kept a day (the
  // newest 50), read by the runners with op policy; each runner checks the signature against its own pins and does each one once
  async cmdPut(env: any, keys: string[]) {
    const err = await checkCmd(env, keys, this.spaceId); if (err) throw new RelayError(400, "change not saved: " + err);
    const list = (this.metaJ("owner_cmds", []) as any[]).filter(x => Date.now() - x.cmd.at < 86400_000 && x.cmd.id !== env.cmd.id);
    list.push({ cmd: env.cmd, key: env.key, sig: env.sig }); this.metaSet("owner_cmds", list.slice(-50));
    this.emit("policy.updated", OWNER, { data: { cmd: env.cmd.do, id: env.cmd.id } }); return { id: env.cmd.id, queued: true };
  }
  // Settings -> Updates "Let apps update Kitebook" (owner, 2026-10-22 22:00: "update is fine, just remove those barriers except it could
  // only pull from latest"): the owner's kill switch for relay_update, on unless the owner turned it off. Off: relay_update answers needs_owner.
  appUpdatesOn() { return this.metaJ("app_updates")?.on !== false; }
  async appUpdatesSet(on: boolean) { const v = { on: !!on, at: Date.now() }; this.metaSet("app_updates", v); return v; }
  async policyState() {
    const env = this.metaJ("policy"), log = this.metaJ("policy_log", []) as any[];
    const rows = this.sql.exec("select * from members where revoked=0 order by name").toArray() as any[], apps: any[] = [], runners: any[] = [], projects = new Set<string>();
    for (const r of rows) { const pr = this.presence(r);
      if (r.kind !== "runner") { if (r.kind !== "human") apps.push({ name: r.name, id: r.peer_id, session_epoch: this.metaJ("session_epoch:" + r.peer_id, ""), kind: r.kind, verbs: JSON.parse(r.verbs), paths: JSON.parse(r.paths), ...(!pr.online && !pr.last_seen ? { never_connected: true } : {}) }); continue; }
      const ad = await this.runnerAd(r.name); for (const p of Object.keys(ad?.projects ?? {})) projects.add(p);
      runners.push({ name: r.name, online: pr.online, projects: Object.keys(ad?.projects ?? {}).sort(), owner_keys: ad?.policy?.owner_keys ?? null, seq: ad?.policy?.seq ?? null, error: ad?.policy?.error ?? null,
        settings: this.metaJ("rset:" + r.name), approve_ways: Array.isArray(ad?.approve_ways) ? ad.approve_ways : null,
        // Settings -> Coding agents: what the Mac advertises (client/runner.ts agentsDetail), which agent runs each project, its default
        agents: Array.isArray(ad?.agents_detail) ? ad.agents_detail.slice(0, 30) : null, project_agents: ad?.project_agents && typeof ad.project_agents === "object" ? ad.project_agents : null,
        default_agent: ad?.prefs?.defaultAgent ?? ad?.default_agent ?? null, build: ad?.build ?? null }); } // settings: what the Mac says it did (client/settings-sync.ts)
    return { space: this.spaceId, envelope: env, apps, runners, projects: [...projects].sort(), log: log.slice(-30).reverse(), update_asks: (this.metaJ("update_asks", []) as any[]).slice(-10).reverse(), app_updates: { on: this.appUpdatesOn(), at: this.metaJ("app_updates")?.at ?? null }, autorun: this.autorunState(), experimental: this.experimentalState(), ci: this.ciRuns().slice(0, 8), server: SERVER_BUILD, sessions_log: sessionsLog(this as any),
      // Settings -> Experimental "Recent errors" (src/devlog.ts): the newest few, only while Experimental is on
      recent_errors: this.experimentalState() ? await this.dirOf().devlogRead({ level: "error", limit: 10 }).then((r: any) => r.entries).catch(() => []) : null };
  }
  // A new owner-signed policy: signed by a registered owner key, for this workspace, exactly one step after the current one (so two
  // tabs can't overwrite each other's change). rec says what the owner changed, for the audit list (one line + what Undo restores).
  async policyPut(env: any, rec: { app: string; access?: any; prev_caps?: any; next_caps?: any; undo_of?: string | null }) {
    const cur = this.metaJ("policy"), keys = (this.metaJ("owner_keys", []) as any[]).map(k => k.key);
    const err = await checkEnvelope(env, keys, this.spaceId); if (err) throw new RelayError(400, "permission not saved: " + err);
    const want = (cur?.policy?.seq ?? 0) + 1; if (env.policy.seq !== want) throw new RelayError(409, `permissions changed meanwhile (version ${cur?.policy?.seq ?? 0}); reload and try again`);
    if (arN(env.policy) !== arN(cur?.policy)) throw new RelayError(400, "one change at a time: \"Run tasks without asking\" changed too (reload Settings and try again)"); // an older page would drop the switch
    if (exN(env.policy) !== exN(cur?.policy)) throw new RelayError(400, "one change at a time: Experimental changed too (reload Settings and try again)");
    const prev = cur?.policy?.apps?.[rec.app] ?? null, next = env.policy.apps?.[rec.app] ?? null;
    for (const [k, v] of Object.entries<any>(env.policy.apps ?? {})) if (k !== rec.app && canon(v) !== canon(cur?.policy?.apps?.[k] ?? null)) throw new RelayError(400, `one app per change: ${k} changed too`);
    for (const k of Object.keys(cur?.policy?.apps ?? {})) if (k !== rec.app && !(k in (env.policy.apps ?? {}))) throw new RelayError(400, `one app per change: ${k} was removed`);
    const log = this.metaJ("policy_log", []) as any[], undo = rec.undo_of ? log.find(x => x.id === rec.undo_of) : null;
    if (rec.undo_of && (!undo || undo.undone_by)) throw new RelayError(409, "nothing to undo (already undone, or too old)");
    const sendNow = !!rec.next_caps?.verbs?.includes("dispatch"), sendWas = !!rec.prev_caps?.verbs?.includes("dispatch"); // the audit line says when sending tasks changed
    const changed = rec.next_caps && canon(rec.next_caps) !== canon(rec.prev_caps), summary = undo ? `Undone: ${undo.summary}` : summarize(rec.app, prev, next, changed && rec.access ? { ...rec.access, ...(sendNow !== sendWas ? { send: sendNow } : {}) } : null);
    const id = "pc_" + [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, "0")).join("");
    log.push({ id, at: now(), seq: env.policy.seq, app: rec.app, summary, prev: { entry: prev, caps: changed ? rec.prev_caps : null }, next: { entry: next, caps: changed ? rec.next_caps : null }, ...(undo ? { undo_of: undo.id } : {}) });
    if (undo) undo.undone_by = id;
    this.metaSet("policy", env); this.metaSet("policy_log", log.slice(-100));
    if (canon([prev?.sessions,prev?.session_rule]) !== canon([next?.sessions,next?.session_rule])) {
      const m = this.sql.exec("select peer_id from members where name=?",rec.app).toArray()[0] as any;
      if (m) for (const row of this.sql.exec("select id from tasks where from_peer=? and session is not null and state in ('queued','claimed','awaiting_approval','running','needs_input')",m.peer_id).toArray() as any[])
        this.cancelTask(this.loadTask(row.id),OWNER,"Session permission changed; resend under the current permission");
      for (const wake of [...this.waiters]) wake();
    }
    this.emit("policy.updated", OWNER, { data: { app: rec.app, seq: env.policy.seq, summary } });
    return { id, seq: env.policy.seq, summary };
  }
  // an audit line with nothing to undo (an app key added: Remove undoes it)
  async noteLog(app: string, summary: string) {
    const log = this.metaJ("policy_log", []) as any[], id = "pc_" + [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, "0")).join("");
    log.push({ id, at: now(), app, summary, note: true, undo_of: "none" }); this.metaSet("policy_log", log.slice(-100)); this.emit("policy.updated", OWNER, { data: { app, summary } }); return { id }; // undo_of set: Settings offers no Undo (Remove is the undo)
  }
  // ---------- Run tasks without asking (client/payload.ts autorunOn) and Experimental (experimentalOn): two owner-signed switches ----------
  // They used to be one ("dev mode", policy.dev). Each is now its own field and its own change; neither implies the other.
  // the relay-held key autorun names; public half only. A Kitebook from before the rename kept it as appkey:*dev: copied once, so a
  // policy the owner already signed (naming that key) keeps working.
  async autorunKey() { if (!this.metaJ(`appkey:${AUTORUN_KEY}`)) { const old = this.metaJ(`appkey:${LEGACY_AUTORUN_KEY}`); if (old) this.metaSet(`appkey:${AUTORUN_KEY}`, old); }
    return await this.appKey(AUTORUN_KEY); }
  // a new owner-signed policy that changes only one switch (apps and the other switch exactly as they are), one version after the current
  // one; audit line + Undo. what: "autorun" | "experimental".
  async switchPut(what: "autorun" | "experimental", env: any, undoOf?: string | null) {
    const label = what === "autorun" ? "\"Run tasks without asking\"" : "Experimental";
    const cur = this.metaJ("policy"), keys = (this.metaJ("owner_keys", []) as any[]).map(k => k.key);
    const err = await checkEnvelope(env, keys, this.spaceId); if (err) throw new RelayError(400, `${label} not saved: ${err}`);
    if ("dev" in env.policy) throw new RelayError(400, `${label} not saved: dev is the old name; reload Settings`); // read old, write new
    const want = (cur?.policy?.seq ?? 0) + 1; if (env.policy.seq !== want) throw new RelayError(409, `permissions changed meanwhile (version ${cur?.policy?.seq ?? 0}); reload and try again`);
    if (canon(env.policy.apps ?? {}) !== canon(cur?.policy?.apps ?? {})) throw new RelayError(400, `one change at a time: turning ${label} on or off can't change an app's permissions too`);
    if (what === "autorun" ? exN(env.policy) !== exN(cur?.policy) : arN(env.policy) !== arN(cur?.policy)) throw new RelayError(400, `one change at a time: ${label} can't change the other switch too (reload Settings)`);
    const old = migratePolicy(cur?.policy ?? {}) as any, d = env.policy[what] ?? null;
    if (what === "autorun" && d && !d.keys.includes((await this.autorunKey()).pub)) throw new RelayError(400, `${label} not saved: it has to name this Kitebook's key (reload Settings)`);
    const log = this.metaJ("policy_log", []) as any[], undo = undoOf ? log.find(x => x.id === undoOf && (x.switch === what || (what === "autorun" && x.dev))) : null;
    if (undoOf && (!undo || undo.undone_by)) throw new RelayError(409, "nothing to undo (already undone, or too old)");
    const prev = old[what] ?? null, summary = undo ? `Undone: ${undo.summary}` : what === "autorun" ? describeAutorun(d) : describeExperimental(d);
    const id = "pc_" + [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, "0")).join("");
    log.push({ id, at: now(), seq: env.policy.seq, app: what === "autorun" ? "Run tasks without asking" : "Experimental", switch: what, summary, prev: { [what]: prev }, next: { [what]: d }, ...(undo ? { undo_of: undo.id } : {}) });
    if (undo) undo.undone_by = id;
    this.metaSet("policy", env); this.metaSet("policy_log", log.slice(-100));
    this.emit("policy.updated", OWNER, { data: { [what]: !!d, seq: env.policy.seq, summary } });
    return { id, seq: env.policy.seq, summary, [what]: d };
  }
  // an app or agent asked to change a switch (op experimental, or its old name dev_mode): refused, and the owner sees the attempt in Settings -> Recent changes
  switchRefused(by: string, want: string) {
    const log = this.metaJ("policy_log", []) as any[], id = "pc_" + [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, "0")).join("");
    log.push({ id, at: now(), app: by, refused: true, summary: `${by} tried to turn Experimental ${want === "off" ? "off" : "on"}: refused (only you can, in Settings)` }); this.metaSet("policy_log", log.slice(-100));
    this.emit("policy.refused", OWNER, { data: { by, want } });
  }
  // ---------- local CI (client/ci.ts on the Mac; an Experimental feature) ----------
  // ci_runs: what the Mac's runner reported (newest first, 40 kept); ci_asks: Run tests / ci_run asks waiting for the runner (20 kept, a day)
  ciRuns(): any[] { return this.metaJ("ci_runs", []) as any[]; }
  ciAsk(a: { project: string; branch: string | null; by: string }) { const id = "ci_" + [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, "0")).join("");
    const list = (this.metaJ("ci_asks", []) as any[]).filter(x => Date.now() - x.at < 86400_000 && !(x.project === a.project && x.branch === a.branch)); // a newer ask for the same branch supersedes
    list.push({ id, ...a, at: Date.now() }); this.metaSet("ci_asks", list.slice(-20)); this.emit("ci.asked", OWNER, { data: { id, project: a.project, branch: a.branch } }); return id; }
  // the runner's report: its runs (merged by id, newest first) and the asks it took; answers what is still waiting for it
  ciReport(runner: string, runs: any[], took: string[]) {
    const keep = new Map<string, any>(); for (const r of [...runs.map(r => ({ ...r, runner })), ...this.ciRuns()]) if (r?.id && !keep.has(r.id)) keep.set(String(r.id), r);
    this.metaSet("ci_runs", [...keep.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 40));
    const asks = (this.metaJ("ci_asks", []) as any[]).filter(x => !took.includes(x.id) && Date.now() - x.at < 86400_000); this.metaSet("ci_asks", asks); return asks; }
  // Run tasks without asking is on (kitebook's view; the runner re-checks the owner's signature): {until} or null
  autorunState(): { on: true; until: number | null } | null { const d = migratePolicy(this.metaJ("policy")?.policy ?? {}).autorun;
    return d?.on === true && (d.until == null || Number(d.until) > Date.now()) ? { on: true, until: d.until ?? null } : null; }
  // Experimental is on: {ci, gh_status} or null (relay_logs, local CI, the dev update channel follow it; no permission does)
  experimentalState(): { on: true; ci: boolean; gh_status: boolean } | null { const x = experimentalOn(this.metaJ("policy")?.policy); return x ? { on: true, ...x } : null; }
  // Is `name` one of the owner's OWN apps, still connected? The live check autorun leans on: a removed app or one whose access ended is
  // never covered, nor a person (human member) or another runner. Asks the account's Dir (the source of truth for removal and end dates).
  // the account's Dir: owner-level state that isn't per workspace (connected apps, the recent logs/errors ring)
  dirOf(): any { const acct = normAcct(this.sql.exec("select v from meta where k='acct'").toArray()[0]?.v as string); return (this.env as any).DIR.get((this.env as any).DIR.idFromName(dirName(acct))); }
  async senderState(name: string): Promise<{ connected: boolean; own: boolean; why?: string }> {
    const m = this.sql.exec("select kind, revoked from members where name=?", name).toArray()[0] as any;
    if (!m || m.revoked) return { connected: false, own: false, why: "not connected to this workspace" };
    if (m.kind !== "assistant" && m.kind !== "coding_agent") return { connected: true, own: false, why: m.kind === "human" ? "a person, not one of your apps" : "a Mac, not one of your apps" };
    const acct = normAcct(this.sql.exec("select v from meta where k='acct'").toArray()[0]?.v as string);
    try { const d: any = (this.env as any).DIR.get((this.env as any).DIR.idFromName(dirName(acct))); const r = await d.peerState(name);
      return { connected: !!r?.live, own: !!r?.own, ...(r?.why ? { why: String(r.why) } : {}) }; }
    catch { return { connected: false, own: false, why: "couldn't check" }; } // fail closed: autorun doesn't cover it
  }
  // what the server can sign for this sender now: its own app entry (relay-held app key) or autorun (its key, own + connected only)
  async standingSig(name: string, project: string | null): Promise<{ entry: any; autorun?: true; key: { pub: string; priv: string } } | null> {
    const ae = standingEntry(this.metaJ("policy")?.policy, name, project); if (!("entry" in ae)) return null;
    if (ae.autorun) { const s = await this.senderState(name); if (!s.connected || !s.own) return null; await this.autorunKey(); }
    const k = this.metaJ(`appkey:${ae.autorun ? AUTORUN_KEY : name}`); return k && (ae.entry.keys ?? []).includes(k.pub) ? { entry: ae.entry, ...(ae.autorun ? { autorun: true as const } : {}), key: k } : null;
  }
  // a connection request for this workspace waits for the owner (src/oauth.ts connectNew): the runners ask the owner on the phone and
  // in `kitebook approve`. The event carries only the request id; a runner fetches the rest with connect_get. Returns how many are online.
  // the master password typed on another device (src/remote-pw.ts): ask that runner; the event carries only the request id (the password
  // stays in the account's Dir memory) and only that runner sees it (src/space/events.ts visible)
  async remotePresence(id: string, target: string) {
    const m = this.sql.exec("select peer_id from members where name=? and kind='runner' and revoked=0", target).toArray()[0] as any; if (!m) return { online: false };
    this.emit("presence.remote", null, { data: { id, target } }); return { online: this.online(m.peer_id) };
  }
  async connectRequested(id: string) {
    this.emit("connect.requested", null, { data: { id } });
    return { runners: (this.sql.exec("select peer_id from members where kind='runner' and revoked=0").toArray() as any[]).filter(r => this.online(r.peer_id)).length };
  }
  // whether any runner here can reach its owner's phone (approve_ways has phone): the consent page offers "Send to my phone" only then
  async phoneReady() { for (const r of this.sql.exec("select name from members where kind='runner' and revoked=0").toArray() as any[]) { const ad = await this.runnerAd(r.name); if ((ad?.approve_ways ?? []).includes("phone")) return true; } return false; }
  async workspaceView(a: any) { return ownerWorkspace(this, a); }

  async exportAll() {
    const t = (n: string) => this.sql.exec(`select * from ${n}`).toArray();
    const blobs: any[] = []; this.exporting++; // blob GC waits while an export is reading external blobs (see gc)
    try { for (const b of t("blobs") as any[]) {
      if (b.loc === "inline") blobs.push(b);
      else { const u = await this.store?.get(b.sha); if (!u) throw new Error(`blob ${b.sha} missing from ${b.loc}`); blobs.push({ sha: b.sha, size: b.size, enc: b.enc, ext_b64: b64encode(u) }); }
    } } finally { this.exporting--; }
    return { format: "relay-space/1", exported: now(), meta: t("meta"), members: t("members"), blobs, commits: t("commits"),
      changes: t("changes"), tree: t("tree"), tasks: t("tasks"), events: t("events"), task_notes: t("task_notes"), sync_receipts: t("sync_receipts") };
  }
  async importAll(dump: any) {
    if (dump?.format !== "relay-space/1") throw new Error("not a relay-space/1 export");
    if ((this.sql.exec("select count(*) n from commits").one().n as number) > 0) throw new Error("space is not empty");
    for (const b of dump.blobs ?? []) if (b.ext_b64 !== undefined) { // external blobs travel inline in the dump; re-home them here
      const u = b64decode(b.ext_b64); delete b.ext_b64;
      if (this.store && u.length > EXTERNAL_AT) { await this.extPut(b.sha, u); b.loc = this.store.kind; b.content = null; }
      else if (u.length <= INLINE_MAX) { b.loc = "inline"; b.content = b.enc === "base64" ? b64encode(u) : new TextDecoder().decode(u); }
      else throw new Error(`blob ${b.sha} is ${u.length} bytes and this host has no external blob store`);
    }
    this.ctx.storage.transactionSync(() => {
      // The copy keeps its own id/name, and membership comes from this host's grants, not the source's.
      // Unfinished tasks can't continue here (their runner belongs to the old space), so they arrive as failed.
      for (const n of ["meta", "blobs", "commits", "changes", "tree", "tasks", "events", "task_notes", "sync_receipts"]) for (const row of dump[n] ?? []) {
        if (n === "meta" && ["id", "name", "acct", "quota_mb", "sync_epoch"].includes(row.k)) continue;
        if (n === "tasks" && !["succeeded", "failed", "rejected", "cancelled"].includes(row.state)) row.state = "failed";
        const k = Object.keys(row); this.sql.exec(`insert or replace into ${n}(${k.join(",")}) values(${k.map(() => "?").join(",")})`, ...k.map(x => row[x]));
      }
      this.sql.exec("delete from blob_put where sha in (select sha from blobs)"); // uploads that landed in a row aren't pending any more
    });
    this.sql.exec("insert or replace into meta values('sync_epoch',?)", crypto.randomUUID());
    this.sql.exec("delete from sync_replicas");
    await KB.rebuild(this); // the KB index is derived data: rebuilt from the imported kb/ files
    return { ok: true, commits: dump.commits.length };
  }

  async alarm() {
    if (this.resourcesPaused()) return;
    const gate = failureDecision(this.resourceState("alarm"), RESOURCE.alarm);
    if (gate.waitMs > 0) { await this.armAlarm(Date.now() + gate.waitMs); return; }
    try {
      await this.alarmWork(); this.sql.exec("delete from meta where k='resource:alarm:'");
    } catch (error) {
      const state = this.resourceFailure("alarm", "", redact(error instanceof Error ? error.message : String(error)));
      console.error("background alarm failed; resource circuit", state.failures, state.paused ? "paused" : "backoff");
      if (state.paused) await this.ctx.storage.deleteAlarm(); else await this.armAlarm(state.nextAt);
    }
  }
  async alarmWork() {
    const subNext = this.evSweep();
    const outNext = await this.outboxRun();
    if (this.retentionDays() > 0 && Date.now() >= this.retentionNext()) {
      try { await this.prune(); } catch (e) { console.error("retention", e); }
      this.sql.exec("insert or replace into meta values('retention_next',?)", String(Date.now() + 86_400_000));
    }
    if (this.gcDue() <= Date.now()) await this.gc(); // unexpected errors must consume the alarm circuit, not silently rearm forever
    const ids = this.sql.exec(`select id from tasks where state in (${HELD.map(() => "?").join(",")})`, ...HELD).toArray().map(r => r.id as string);
    let next = Math.min(subNext ?? Infinity, outNext ?? Infinity);
    for (const id of ids) {
      const t = this.loadTask(id), m = this.member(t.target_peer) as any, lease = this.leaseMs(t);
      const cap = this.heldCapSec(t);
      if (cap !== Infinity && this.heldSec(t) >= cap) {
        const summary = `Held too long: this task was held by ${t.target} for over ${Math.round(cap)}s (cap: ${t.limits?.max_held_sec ? "limits.max_held_sec" : "MAX_HELD_SEC"}) while ${t.state}. Not retried; split the work or raise limits.max_held_sec.`;
        try { this.setState(t, "failed", RELAY, { summary, reason: "held_cap", retryable: false }, { summary, reason: "held_cap", retryable: false }, HELD); } catch {}
        continue;
      }
      next = Math.min(next, this.heldDeadline(t));
      const sm = this.stuckMs(); if (sm && STUCK_STATES.includes(t.state)) { const st = this.stuckOf(t); if (!st) next = Math.min(next, this.lastActivity(t) + sm); }
      const last = this.online(t.target_peer) ? Date.now()
        : Math.max(Date.parse(t.updated) || 0, Date.parse(m?.last_seen ?? "") || 0, this.lastSeenAt.get(t.target_peer) ?? 0);
      if (last + lease > Date.now()) { next = Math.min(next, last + lease); continue; }
      const retry = Number(t.attempt ?? 1) <= Number(t.max_retries ?? 1);
      const summary = `Lease expired: the runner ${t.target} went offline and was silent for over ${Math.round(lease / 1000)}s while this task was ${t.state}. ` +
        (retry ? `Requeued automatically (attempt ${Number(t.attempt ?? 1) + 1}); it runs again when the runner is back.` : `Retryable: send a follow-up (continue_from: ${t.id}) once it is back, or resend it.`);
      try { this.failOrRetry(t, RELAY, { summary, reason: "lease_expired" }, {}, HELD); } catch {}
    }
    if (this.retentionDays() > 0 && this.sql.exec("select 1 from tasks limit 1").toArray().length) next = Math.min(next, this.retentionNext());
    next = Math.min(next, Math.max(this.gcDue(), Date.now() + 60_000)); // marked blobs wait out their grace, then this alarm sweeps them
    if (next < Infinity) await this.armAlarm(next);
  }

  // ---------- RPC entry ----------
  async run(peer: Peer, op: string, args: any, reqId?: string): Promise<Res> {
    const t = Date.now(); if ((this.lastSeenAt.get(peer.id) ?? 0) < t - 60_000) { this.lastSeenAt.set(peer.id, t); try { this.seen(peer.id); } catch {} } // pollers count as seen (throttled to save row writes)
    const lim = this.rateHit(peer); if (lim) return { ok: false, ...lim };
    try {
      const miss = missing(op, args); if (miss) throw new RelayError(miss.startsWith("unknown") ? 404 : 400, miss);
      const fn = (this.impl as any)[op]; if (!fn) throw new RelayError(404, `unknown op ${op}`);
      return { ok: true, result: await fn(peer, args ?? {}) };
    } catch (e: any) {
      if (e instanceof RelayError) return { ok: false, status: e.status, error: e.message };
      console.error(`op ${op}${reqId ? ` (${reqId})` : ""}:`, e?.stack ?? e);
      await this.dirOf().devlogPut([DL.fromError(e, { source: "server", route: `op ${op}`, request_id: reqId })]).catch(() => {}); // Experimental's recent errors (src/devlog.ts)
      return { ok: false, status: 500, error: "internal error", logged: true };
    }
  }

  // The op table, one module per area (fileOps: src/space/files.ts, peerOps: peers.ts, taskOps: tasks.ts, kbOps: kb.ts).
  impl: Record<string, Op> = { ...fileOps.call(this), ...syncOps.call(this), ...peerOps.call(this), ...taskOps.call(this), ...kbOps.call(this), ...askOps.call(this), ...sessionOps.call(this), ...presenceOps.call(this), ...briefOps.call(this), ...healthOps.call(this),
    // every task an app sends answers with the brief's etag, so a client that cached the owner's instructions knows when to re-read them
    task_create: async (peer, a) => { const r = await this.taskCreate(peer, a); if (peer.kind === "runner" || !r || typeof r !== "object") return r;
      const v = await briefView(this, peer).catch(() => null); return v ? { ...r, brief: { etag: v.etag, chars: v.chars, hint: v.text ? "the owner's standing instructions; re-read them (describe, or the brief tool) if your copy has another etag" : "no instructions from the owner yet" } } : r; } };
  taskCreate: Op = taskOps.call(this).task_create;
  // ---------- the assistant brief (src/brief.ts): the owner's Settings actions, via the Dir ----------
  async briefOwner(a: any) { try { return await briefOwner(this, a); } catch (e: any) { throw new Error(String(e?.message ?? e)); } }
  // the /start "Who's working" panel (owner session; every title): the Dir calls this every few seconds while the page is open
  async ownerPresence() { return { space: this.spaceId, ...presenceView(this, null) }; }

  // ---------- WebSocket (hibernatable): live events + ops over the same socket ----------
  async fetch(req: Request) {
    const peer = JSON.parse(req.headers.get("x-relay-peer") ?? "null") as Peer | null;
    if (peer && req.method === "POST" && new URL(req.url).pathname === "/events/stream") {
      const b: any = await req.json().catch(() => ({})); try { this.seen(peer.id); } catch {}
      return this.evStream(peer, b.id, b.params ?? {});
    }
    if (!peer || req.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const m = this.member(peer.id); if (!m || m.revoked || !m.verbs.includes("read")) return new Response("forbidden", { status: 403 });
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [peer.id]);
    server.serializeAttachment(peer);
    const since = Number(new URL(req.url).searchParams.get("since") ?? -1);
    if (since >= 0) { // replay everything since the cursor, page by page, so a long outage never drops events
      let cur = since;
      for (let i = 0; i < 200; i++) { const r = await this.impl.changes(peer, { since: cur, limit: 1000 }); for (const e of r.events) server.send(JSON.stringify({ event: e })); if (r.events.length < 1000) break; cur = r.events[r.events.length - 1].seq; }
    }
    this.seen(peer.id); this.emit("peer.online", peer);
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const peer = ws.deserializeAttachment() as Peer;
    let msg: any; try { msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return ws.send(JSON.stringify({ ok: false, error: "bad json" })); }
    const r = await this.run(peer, msg.op, { ...(msg.args ?? {}) });
    ws.send(JSON.stringify({ id: msg.id, ...r }));
  }
  async webSocketClose(ws: WebSocket) {
    const peer = ws.deserializeAttachment() as Peer | null;
    if (peer) this.seen(peer.id);
    if (peer && this.ctx.getWebSockets(peer.id).filter(w => w !== ws).length === 0) this.emit("peer.offline", peer);
  }
}
