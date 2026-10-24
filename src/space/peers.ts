// Space ops: peers, describe, inbox polling (check/inbox/ack/notify), webhook secret, code status. Part of the impl table (src/space.ts); `this` is the Space.
import { globMatch, RelayError } from "../ops.ts";
import { ACTIVE, now, redact, SPEC_FIELDS, codeNotes, MODES } from "./util.ts";
import { sessionsLevel } from "./sessions.ts";
import type { Space, Op } from "../space.ts";
import { briefView } from "./brief.ts";
import { SERVER_BUILD } from "../build.ts";
import { runnerHealth } from "./health.ts";
import { ago } from "../health.ts";

export function peerOps(this: Space): Record<string, Op> {
  const ops: Record<string, Op> = {
    peers: async (peer) => {
      this.need(peer, "read");
      const rows = this.sql.exec("select * from members where revoked=0").toArray() as any[];
      const pz = this.pauseState();
      const caps = new Map<string, any>(); for (const r of rows) if (r.kind === "runner") { const c = await this.runnerCaps(r.name); if (c) caps.set(r.name, c); }
      return { peers: rows.map(r => ({ name: r.name, kind: r.kind, verbs: JSON.parse(r.verbs), ...this.presence(r), ...(caps.has(r.name) ? { capabilities: caps.get(r.name) } : {}),
        ...(caps.get(r.name)?.approval?.ok === false ? { approval_unreachable: String(caps.get(r.name).approval.error ?? "unknown") } : {}), // its owner can't be asked right now
        ...(r.kind === "runner" ? { active_tasks: this.activeTasks(r, peer), ...this.codeBrief(r.name) } : {}) })), ...(pz.all || Object.keys(pz.peers).length ? { paused: pz } : {}) };
    },
    // Capability manifest: one read that aggregates what each runner advertises plus live presence, so a dispatcher
    // can pick target/project/agent/model/acceptance commands without reading every shared/runners/*.json.
    describe: async (peer) => {
      this.need(peer, "read");
      const rows = this.sql.exec("select * from members where revoked=0 order by name").toArray() as any[];
      const runners: any[] = [], peers: any[] = [];
      for (const r of rows) {
        const pr = this.presence(r);
        if (r.kind !== "runner") { peers.push({ name: r.name, kind: r.kind, ...pr }); continue; }
        const ad = await this.runnerAd(r.name);
        runners.push({ name: r.name, ...pr, advertised: !!ad, hours: ad?.hours ?? null, ...(ad ? {
          agents: ad.agents ?? [], default_agent: ad.default_agent ?? null, models: ad.models ?? {}, max_parallel: ad.max_parallel ?? null, prefs: ad.prefs ?? {},
          projects: Object.fromEntries(Object.entries<any>(ad.projects ?? {}).map(([k, v]) => [k, { agent: v.agent, verify: v.verify ?? [], push: v.push ?? "never", remote: v.remote ?? null, ...(v.mirror ? { mirror: true } : {}) }])),
          machine_tasks: !!ad.machine_tasks, approve: ad.approve ?? null, access: ad.access ?? null, protect: ad.protect ?? null, paused: !!ad.paused,
          spec: ad.spec ?? null, cancel: !!ad.cancel, build: ad.build ?? null, updated: ad.updated ?? null } : {}) }); // build: which Kitebook code that runner runs (client/runner.ts)
      }
      const pz = this.pauseState();
      // the owner's standing instructions come first, so a dispatcher reads them before anything else (src/brief.ts)
      const b = peer.kind === "runner" ? null : await briefView(this, peer);
      return { ...(b ? { brief: { ...b, note: b.text ? "The owner's standing instructions for you: follow them (brief_propose suggests a change)." : "No instructions from the owner yet." } } : {}), space: this.spaceId, generated: now(), server: SERVER_BUILD, runners, peers, // server: which Kitebook code this server runs (src/build.ts)
        task_spec: { version: 2, fields: SPEC_FIELDS, modes: MODES, budget: ["minutes", "max_files_changed"], promote: "task_promote", note: "acceptance commands must be in the project's verify list" },
        git: { repo: "task_create repo = a project's remote URL or its name", base: "branch, tag or commit to start from (default: the checkout's HEAD)", push: "the task branch only, never main", result: ["branch", "base", "commit", "diff_stat", "pushed", "compare_url", "pr_url"] },
        retention_days: this.retentionDays(),
        // the owner's local agent sessions (src/space/sessions.ts): what this app may do with them, in words
        ...(peer.kind === "runner" ? {} : { sessions: ((l: string) => ({ allowed: l, tools: l === "write" ? ["sessions_search", "session_get", "session_create", "session_send"] : l === "read" ? ["sessions_search", "session_get"] : [],
          note: l === "off" ? "You can't see the owner's agent sessions; the owner can allow it in Settings -> Assistants -> Agent sessions" : l === "read" ? "You may search and read the owner's agent sessions (read-only)" : "You may search, read, start and continue the owner's agent sessions (their own sessions only as a copy)" }))(sessionsLevel(this, peer.name)) }),
        // something broke on the owner's side (a 500 answers {ok:false, error, request_id}): where to look (src/devlog.ts)
        // experimental: what the owner's Experimental switch turned on (relay_logs, local CI); debug: its older name for the logs part
        ...((x: any) => { const dbg = x ? { logs: "relay_logs", note: "Experimental is on: relay_logs {source, since, level, limit, request_id} shows the recent server, sign-in, runner and update errors (secrets redacted)" }
          : { logs: null, note: "Experimental is off: recent logs and errors are the owner's (kitebook logs --errors on their Mac); relay_logs answers needs_owner" };
          return { experimental: { on: !!x, tools: x ? ["relay_logs", "ci_run", "ci_status"] : [], test_every_push: !!x?.ci }, debug: dbg }; })(this.experimentalState()),
        ...(await this.mirrorOn() ? { mirror: { enabled: true, note: "repos/<project>/ holds a read-only copy of opted-in checkouts (.relay-repo.json = branch + commit); git stays the source of truth" } } : {}),
        ...(pz.all || Object.keys(pz.peers).length ? { paused: pz } : {}) };
    },
    check: async (peer, a) => { // one call for polling assistants: new tasks for me, updates on tasks I sent, files changed
      const since = Number(a.since ?? 0);
      if (a.wait && !this.sql.exec("select 1 from events where seq>? limit 1", since).toArray().length) await this.wait(Number(a.wait));
      const rows = this.sql.exec("select * from events where seq>? order by seq limit 1000", since).toArray() as any[];
      const cursor = rows.length ? rows[rows.length - 1].seq : since;
      const mine = (id: string) => this.sql.exec("select from_peer,target_peer,title,state,result,qa from tasks where id=?", id).toArray()[0] as any;
      const updates: any[] = [], files = new Set<string>();
      for (const r of rows) {
        if (r.actor === peer.name) continue;
        if (r.task_id) { const t = mine(r.task_id); if (t && t.from_peer === peer.id && r.type !== "task.queued") updates.push({ task: r.task_id, title: t.title, event: r.type, state: t.state, at: r.at, ...(r.type === "task.needs_input" ? { question: JSON.parse(r.data).question ?? null } : {}), ...this.resultBlock(t) }); }
        else if (r.path && this.visible(peer, { path: r.path })) files.add(r.path);
      }
      const inbox = this.sql.exec(`select id,title,state,from_peer,created from tasks where target_peer=? and state in (${ACTIVE.map(() => "?").join(",")}) order by created`, peer.id, ...ACTIVE).toArray()
        .map((t: any) => ({ id: t.id, title: t.title, state: t.state, from: this.member(t.from_peer)?.name, created: t.created }));
      // tasks you sent that are parked on a question for you: answer with task_answer
      const needsAnswer = this.sql.exec("select id,title,qa,updated from tasks where from_peer=? and state='needs_input' order by updated", peer.id).toArray()
        .map((t: any) => { const q = (t.qa ? JSON.parse(t.qa) : []).filter((x: any) => !x.answered_at).pop(); return { id: t.id, title: t.title, question: q?.text ?? null, asked_at: q?.asked_at ?? t.updated, answer_with: "task_answer" }; });
      const sentActive = Number((this.sql.exec(`select count(*) n from tasks where from_peer=? and state in (${ACTIVE.map(() => "?").join(",")})`, peer.id, ...ACTIVE).toArray()[0] as any).n);
      // hint for scheduled pollers: sooner while tasks you sent are in flight, relaxed when idle
      const next_poll_after = rows.length === 1000 ? 0 : sentActive || inbox.length ? 30 : 300;
      return { cursor, inbox, updates, needs_answer: needsAnswer, files_changed: [...files].slice(0, 200), more: rows.length === 1000, sent_active: sentActive, next_poll_after };
    },
    // the owner's signed standing permissions + the owner keys this account registered; the runner verifies the signature itself against
    // the keys IT pinned (client/policy.ts), so the server's word on either never widens what runs
    policy: async (peer, a) => {
      this.need(peer, "read"); if (peer.kind !== "runner") throw new RelayError(403, "runners only: the owner reads and changes permissions on /start (Permissions)");
      // from: a task's sender, for autorun's live check (one of the owner's own apps, still connected; client/runner-approval.ts autorunSenderWhy)
      return { envelope: this.metaJ("policy"), ...(a?.from ? { sender: await this.senderState(String(a.from)) } : {}), owner_keys: this.metaJ("owner_keys", []), cmds: (this.metaJ("owner_cmds", []) as any[]).filter(x => Date.now() - x.cmd.at < 86400_000),
        // relay_update asks (the Mac decides; client/updater.ts); none while the owner has "Let apps update Kitebook" off, so an ask the Mac hasn't picked up yet stops too
        update_requests: this.appUpdatesOn() ? (this.metaJ("update_reqs", []) as any[]).filter(x => Date.now() - x.at < 86400_000) : [] };
    },
    // what the Mac did with the owner's Settings changes (client/settings-sync.ts): kept per runner, shown only on the owner's Settings
    // page (Dir policy -> policyState), never in shared/ where every app could read the phone topic
    settings_report: async (peer, a) => {
      if (peer.kind !== "runner") throw new RelayError(403, "runners only");
      const s = a.settings ?? {}, str = (v: any, n: number) => v == null ? null : String(v).slice(0, n);
      this.metaSet("rset:" + peer.name, { done: (Array.isArray(s.done) ? s.done : []).slice(-20).map((d: any) => ({ id: str(d?.id, 40), do: str(d?.do, 20), ok: !!d?.ok, msg: str(d?.msg, 300), at: str(d?.at, 30),
        // a relay_update's outcome, so the asking app hears it on its next relay_update (state, the exact sha, health, the reason)
        ...(d?.do === "relay_update" && d?.state ? { state: str(d.state, 20), from: str(d.from, 12), to: str(d.to, 12), sha: d.sha && /^[0-9a-f]{40}$/.test(String(d.sha)) ? String(d.sha) : null,
          ref: str(d.ref, 10), health: str(d.health, 20), why: str(d.why, 300), approved_by: str(d.approved_by, 20) } : {}) })),
        phone_topic: str(s.phone_topic, 80), release_key: str(s.release_key, 60), approve: str(s.approve, 40), darwin: !!s.darwin,
        update: s.update && typeof s.update === "object" && JSON.stringify(s.update).length <= 12_000 ? s.update : null, at: new Date().toISOString() }); // Updates (client/updater.ts report)
      return { ok: true };
    },
    // An agent asks the Mac to update Kitebook. No argument: the only thing it can ask for is THE LATEST (owner, 2026-10-22 22:00: "update is
    // fine, just remove those barriers except it could only pull from latest"): a git install's runner fetches origin itself and fast-forwards
    // to the newest commit of the branch its checkout follows (origin/dev with Experimental on), a release install takes the newest release signed with
    // the key the Mac already trusts. Never a version, sha, link or branch the app picks, never back. No confirm code, no presence prompt, no
    // Experimental or standing switch: any connected app of the owner's that may send tasks here (the update-capable grant) updates it right away,
    // once the runner is idle, health-checked and rolled back on failure (client/settings-sync.ts devAsk, client/git-channel.ts devUpdate).
    // The owner's kill switch: Settings -> Updates "Let apps update Kitebook" (default on; off: needs_owner).
    // A runner from before this (374169f, it knows only the approval flow) doesn't report update.nogate: its ask still waits for the owner's
    // approval on that Mac (waiting_approval, kitebook confirm), as it did. Asking again reports the last ask, and once how it ended.
    // The answer here is what the Mac said at its last check; every ask is kept (a day, the newest 20) and shown in Settings.
    relay_update: async (peer, a) => {
      const extra = Object.keys(a ?? {}).filter(k => k !== "space" && a[k] !== undefined && a[k] !== null);
      if (extra.length) throw new RelayError(400, `relay_update takes no arguments (got ${extra.join(", ")}): it only ever installs the latest (the newest commit of the branch the Mac's git checkout follows, origin/dev with Experimental on, or the newest signed release), as a fast-forward that never goes back, so there is no version, commit, branch or link to choose`);
      const m = this.need(peer, "write");
      const rs = (this.sql.exec("select name from members where kind='runner' and revoked=0 order by name").toArray() as any[]).map(r => r.name as string);
      if (!rs.length) throw new RelayError(404, "no Mac is connected to this workspace, so there is nothing to update");
      const id = "ur_" + [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, "0")).join(""), at = Date.now();
      const asked = (runners: any[]) => { const log = (this.metaJ("update_asks", []) as any[]); log.push({ id, by: m.name, at, runners: runners.map((r: any) => ({ runner: r.runner, status: r.status, why: r.why, ...(r.from ? { from: r.from, to: r.to ?? null } : {}) })) }); this.metaSet("update_asks", log.slice(-20)); };
      if (!this.appUpdatesOn()) { const why = "The owner turned off \"Let apps update Kitebook\" (Settings -> Updates), so apps can't update the Mac now; only the owner can (Update now in Settings), or turn it back on.";
        const runners = rs.map(r => ({ runner: r, status: "needs_owner", why })); asked(runners);
        return { id, ok: false, state: "needs_owner", from: null, to: null, why, runners, note: "Nothing was asked of the Mac. Tell the owner if the update matters; don't retry until they turn it back on." }; }
      // the owner's own apps that may send tasks here (dispatch) update a git install; a coding agent wired with kitebook connect only reads and
      // writes its own folder, so it gets the signed-release path alone
      const dev = !!this.experimentalState(), sender = await this.senderState(m.name); // Experimental picks the channel (dev), nothing else
      const devWhy = !m.verbs.includes("dispatch") ? `${m.name} can't send tasks in this workspace, so it can't ask to update the Mac's code`
        : !sender?.connected || !sender.own ? `only the owner's own apps can ask to update the Mac's code; ${m.name} is ${sender?.why ?? "not one of them"}` : null;
      const ng = (name: string) => (this.metaJ("rset:" + name) ?? {}).update?.nogate === true; // this runner updates without asking (else: 374169f, the approval flow)
      const chan = dev ? "origin/dev (Experimental is on)" : "the branch its checkout follows (usually main)";
      const now = (name: string) => `${name} updates to the newest commit of ${chan} now, once its running tasks finish: no confirmation, a fast-forward only (never back), checked, and rolled back if the new code doesn't start.`;
      const devOk = !devWhy, list = (this.metaJ("update_reqs", []) as any[]).filter(x => at - x.at < 86400_000);
      const until = (t: number) => new Date(t).toISOString().slice(11, 16) + " UTC";
      const where = (q: any) => { for (const name of rs) { const st = this.metaJ("rset:" + name) ?? {};
          const d = (st.done ?? []).find((x: any) => x.id === q.id); if (d) return { name, done: d };
          const p = (st.update?.pending ?? []).find((x: any) => x.id === q.id); if (p) return { name, pending: p }; } return null; };
      const last = devOk ? [...list].reverse().find(x => x.by === m.name && x.dev && !x.reported) : null;
      if (last) { const w = where(last);
        if (w?.done) { last.reported = true; this.metaSet("update_reqs", list.slice(-20)); const d = w.done;
          const words = d.state === "updated" ? `${w.name} updated to ${d.sha ?? d.to} (health ${d.health ?? "ok"})` : d.state === "rolled_back" ? `${w.name} tried ${d.to} and rolled back: ${d.why}` : d.state === "up_to_date" ? `${w.name} already ran the newest origin/${d.ref ?? "dev"} (${d.from})` : `${w.name} didn't update: ${d.why ?? d.msg}`;
          return { id: last.id, ok: d.state === "updated" || d.state === "up_to_date", state: d.state, from: d.from ?? null, to: d.to ?? null, sha: d.sha ?? null, health: d.health ?? null, why: d.state === "updated" ? null : d.why ?? d.msg, runners: [{ runner: w.name, status: d.state, why: d.msg }],
            note: `${words}. That was the result of your ask from ${until(last.at)}; calling relay_update again ${ng(w.name) ? "updates to the newest commit again (if there is a newer one)" : "starts a new ask, which waits for the owner's approval on that Mac (it runs an older Kitebook)"}.` }; }
        if (w?.pending?.kind === "dev" && (w.pending.approved || ng(w.name))) { const p = w.pending, why = now(w.name);
          return { id: last.id, ok: true, state: "updating", from: p.from ? String(p.from).slice(0, 7) : null, to: p.sha ? String(p.sha).slice(0, 7) : null, sha: p.sha ?? null, why, runners: [{ runner: w.name, status: "updating", why }], note: "Call relay_update again later to see the result (updated to <sha> with health ok, or rolled back with the reason)." }; }
        if (!w && at - last.at < 65 * 60_000 && rs.every(ng)) { const why = `${rs.join(", ")} hasn't picked up your ask yet (it looks every few seconds while online). ${now(rs[0])}`;
          return { id: last.id, ok: true, state: "updating", from: null, to: null, sha: null, why, runners: rs.map(r => ({ runner: r, status: "updating", why })), note: "Call relay_update again later to see the result." }; }
        if (w?.pending?.kind === "dev" || (!w && at - last.at < 65 * 60_000)) { const p = w?.pending; // a runner from before no-gate (374169f): its approval flow
          const why = p ? `waiting for your approval on your Mac: the owner runs kitebook confirm ${p.code} on ${w!.name} (master password or fingerprint / face unlock) to update to ${p.ref} ${String(p.sha).slice(0, 7)}, until ${until(p.expires)}. Nothing changes until then (that Mac runs an older Kitebook, which still asks).`
            : `waiting for your approval on your Mac: ${rs.join(", ")} is resolving which commit to update to, then the owner confirms exactly that commit there (kitebook confirm, master password or fingerprint / face unlock).`;
          return { id: last.id, ok: true, state: "waiting_approval", from: p?.from ? String(p.from).slice(0, 7) : null, to: p?.sha ? String(p.sha).slice(0, 7) : null, sha: p?.sha ?? null, code: p?.code ?? null, expires: p?.expires ?? null, why, runners: rs.map(r => ({ runner: r, status: "waiting_approval", why })),
            note: "Tell the owner it waits for their approval on their Mac. Call relay_update again later to see the result (updated to <sha> with health ok, or rolled back with the reason); it doesn't start a second ask meanwhile." }; }
        last.reported = true; this.metaSet("update_reqs", list.slice(-20)); } // the Mac never answered and it expired: start over
      const runners = rs.map(name => { const u = (this.metaJ("rset:" + name) ?? {}).update, c = u?.check, g = u?.git;
        if (!c) return { runner: name, status: "asked", why: `${name} hasn't reported its updates yet; it checks the release signature itself before installing anything` };
        if (g || c.state === "not_installed") { // a git install
          const from = g?.head ? String(g.head).slice(0, 7) : null, to = dev && g?.dev ? String(g.dev).slice(0, 7) : !dev && g?.stable && g.behind ? String(g.stable).slice(0, 7) : null;
          if (devWhy) return { runner: name, status: "refused", why: devWhy, from };
          if (ng(name)) return { runner: name, status: "updating", why: now(name), from, to };
          // 374169f and older: the owner's standing "Install updates without asking me" there, else its approval on that Mac
          if (u?.trust?.on) return { runner: name, status: "will_update", why: `${name} updates without asking the owner (they turned on Install updates without asking me): it fetches origin itself and fast-forwards only to the exact newest commit of ${chan}, once its tasks finish; the new code must start and reach the server, else it goes back.`, from };
          const which = dev ? "origin/dev commit (Experimental is on)" : "commit of the branch its checkout follows (usually main)";
          return { runner: name, status: "waiting_approval", why: `waiting for your approval on your Mac: ${name} runs an older Kitebook that still asks: it fetches origin itself, resolves the exact ${which}${to ? ` (${to} at its last check)` : ""} and waits up to an hour for the owner to approve exactly that commit there (kitebook confirm <code>, master password or fingerprint / face unlock). Only then it fast-forwards, checks that the new code starts and reaches the server, and goes back if it doesn't.`, from, to }; }
        if (c.state === "newer") return { runner: name, status: "will_install", why: `${name} installs signed release ${c.latest_release} (it checks the signature again first)`, current: c.current_release, latest: c.latest_release, from: c.current ?? null, to: c.latest ?? null };
        if (c.state === "up_to_date") return { runner: name, status: "refused", why: `${name} already runs the newest release${c.current_release ? " (" + c.current_release + ")" : ""}`, current: c.current_release };
        if (c.state === "no_key" || c.state === "no_number") return { runner: name, status: "needs_owner", why: `${c.why} The owner can approve it with one click in Settings -> Updates.` };
        return { runner: name, status: "refused", why: String(c.why ?? c.state) }; });
      const go = runners.filter(r => r.status !== "refused");
      // a git install's ask is tracked (asking again reports it); a release install's isn't (it answers fresh each time). auth: the asker may
      // update a git install, kept apart from that tracking, so a Mac that hasn't reported its install type yet still honours the ask
      const gitAsk = devOk && runners.some(r => ["updating", "waiting_approval", "will_update"].includes(r.status)); // a Mac that hasn't reported yet ("asked") doesn't make a release install's ask a tracked git ask
      if (go.length) { list.push({ id, by: m.name, at, ...(gitAsk ? { dev: true } : {}), ...(devOk ? { auth: true } : {}) }); this.metaSet("update_reqs", list.slice(-20)); }
      asked(runners);
      this.emit("update.requested", peer, { data: { id, runners: runners.map(r => r.runner + ":" + r.status) } });
      // one Mac is the usual case: its answer on top ({state, from, to} or the plain reason); every Mac's in runners
      const top: any = runners.find(r => ["updating", "waiting_approval", "will_update", "will_install"].includes(r.status)) ?? runners[0];
      const old = runners.some(r => r.status === "waiting_approval");
      return { id, ok: go.length > 0, state: top.status, from: top.from ?? null, to: top.to ?? null, why: top.status === "will_install" ? null : top.why, runners,
        note: gitAsk ? `The Mac's runner itself fetches origin and fast-forwards to the newest commit of ${chan} (never one you pick, never back), checks that the new code starts and reaches the server, and rolls back if it doesn't. Call relay_update again to see how it ended (updated to <sha> with health ok, or rolled back with the reason).${old ? " A Mac on an older Kitebook still waits for the owner's approval there (kitebook confirm)." : ""}` : "The Mac installs only a newer release signed with the key it trusts, checks that it starts, and goes back if it doesn't. Results show in the owner's Settings -> Updates." };
    },
    // Experimental for apps: read-only. Only the owner turns it on or off, in Settings in their own signed-in browser (the policy is signed
    // there); an app asking to change it is refused with the reason and the attempt is shown to the owner (Settings -> Recent changes).
    // It turns on experimental features only (relay_logs, local CI, the dev update channel); "Run tasks without asking" is its own switch,
    // reported here as autorun so an app knows whether its tasks will ask. dev_mode is its old name (same answer).
    experimental: async (peer, a) => {
      this.need(peer, "read"); const set = a?.set ?? a?.on ?? a?.enable;
      if (set !== undefined && set !== null && set !== "" && set !== "status") { this.switchRefused(peer.name, set === false || set === "off" ? "off" : "on");
        throw new RelayError(403, "Only the owner can turn Experimental on or off (Settings -> More -> Experimental). This attempt is shown to the owner."); }
      const x = this.experimentalState(), r = this.autorunState(), t = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
      return { on: !!x, ci: x?.ci ?? false, gh_status: x?.gh_status ?? false, autorun: { on: !!r, until: r?.until ?? null },
        note: `Experimental is ${x ? "on" : "off"}; "Run tasks without asking" (a separate permission) is ${r ? "on" + (r.until ? ` until ${t(r.until)}` : "") : "off"}. Only the owner changes either, in Settings.` };
    },
    dev_mode: async (peer, a) => await ops.experimental(peer, a),
    // Recent logs and errors (src/devlog.ts), for whoever has to fix them: the owner's Mac always (runner token: `kitebook logs --errors`);
    // an assistant or coding agent of the owner's with dispatch rights only while Experimental is on (and it is still connected and one of the
    // owner's own apps, the same live check autorun uses). Everything is redacted before it was stored.
    relay_logs: async (peer, a) => {
      this.need(peer, peer.kind === "runner" ? "read" : "dispatch"); const d = this.experimentalState();
      if (peer.kind !== "runner") {
        if (!d) throw new RelayError(403, "needs_owner: recent logs and errors are shared with the owner's apps only while Experimental is on. It is off, so ask the owner to turn it on (Settings -> More -> Experimental) or to run `kitebook logs --errors` on their Mac and share the output.");
        const st = await this.senderState(peer.name); if (!st.connected || !st.own) throw new RelayError(403, `forbidden: Experimental shares recent logs only with the owner's own connected apps; ${peer.name} is ${st.why ?? "not one of them"}`);
      }
      let r: any; try { r = await this.dirOf().devlogRead({ source: a.source, since: a.since, level: a.level, limit: a.limit, request_id: a.request_id }); }
      catch (e: any) { throw new RelayError(400, String(e?.message ?? e).replace(/^Error: /, "")); }
      return { experimental: !!d, dev: !!d, entries: r.entries, counts: r.counts, order: "newest first", // dev: the old name of experimental
        note: (r.entries.length ? "" : "Nothing matches. ") + "Secrets are redacted before anything is stored; the server keeps the newest 500 lines and 200 errors per source (server, auth, runner, updates). The runner's own lines arrive only while Experimental is on." };
    },
    // Runner only: the Mac's recent logs/errors (client/devlog.ts), sent while Experimental is on; redacted again here before they're kept
    logs_report: async (peer, a) => {
      this.need(peer, "read"); if (peer.kind !== "runner") throw new RelayError(403, "runners only");
      if (!this.experimentalState()) return { stored: 0, experimental: false, dev: false, note: "Experimental is off: keep them on the Mac" };
      const list = Array.isArray(a.entries) ? a.entries.slice(0, 200) : []; if (!list.length) return { stored: 0, experimental: true, dev: true };
      const r = await this.dirOf().devlogPut(list.map((e: any) => ({ ts: e?.ts, level: e?.level, source: e?.source === "updates" ? "updates" : "runner", msg: e?.msg, stack: e?.stack, route: e?.route, runner: peer.name })));
      return { stored: r?.stored ?? 0, experimental: true, dev: true };
    },
    // Local CI (client/ci.ts; an Experimental feature): the owner's Mac runs a project's own test command on watched pushes and task
    // branches, in a throwaway worktree, one at a time, at low priority. Never GitHub Actions. ci_run asks for one run (the owner's own apps
    // that may send tasks, or the owner); ci_status reads the latest results; ci_report is the runner's.
    ci_run: async (peer, a) => {
      const m = this.need(peer, "dispatch");
      if (!this.experimentalState()) throw new RelayError(403, "needs_owner: local CI needs Experimental on (Settings -> More -> Experimental).");
      { const st = await this.senderState(m.name); if (!st.connected || !st.own) throw new RelayError(403, `forbidden: only the owner's own connected apps can ask for test runs (the owner uses Run tests); ${m.name} is ${st.why ?? "not one of them"}`); }
      const project = String(a.project ?? "").trim(), branch = a.branch == null || a.branch === "" ? null : String(a.branch).trim();
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(project)) throw new RelayError(400, "project: one of the Mac's project names (describe lists them)");
      if (branch != null && (!/^[A-Za-z0-9._\/-]{1,200}$/.test(branch) || branch.includes("..") || /^(pull|refs\/pull|merge-requests)\//.test(branch) || branch.startsWith("-"))) throw new RelayError(400, "branch: a branch of the project's own repo (forks and pull-request refs are never run)");
      if (!(this.sql.exec("select 1 from members where kind='runner' and revoked=0").toArray().length)) throw new RelayError(404, "no Mac is connected to this workspace, so there is nothing to run tests on");
      const id = this.ciAsk({ project, branch, by: m.name });
      return { id, queued: true, project, branch, note: "Read the result with ci_status." };
    },
    ci_status: async (peer, a) => {
      this.need(peer, "read"); const x = this.experimentalState();
      const runs = this.ciRuns().filter(r => (!a.project || r.project === a.project) && (!a.branch || r.branch === a.branch)).slice(0, Math.min(20, Math.max(1, Number(a.limit ?? 5) || 5)));
      const waiting = (this.metaJ("ci_asks", []) as any[]).filter(q => !a.project || q.project === a.project).map(q => ({ id: q.id, project: q.project, branch: q.branch, by: q.by, at: new Date(q.at).toISOString() }));
      return { experimental: !!x, test_every_push: !!x?.ci, runs, waiting, note: x ? (runs.length ? "Newest first." : "No test runs yet.") : "Experimental is off, so the Mac runs no tests." };
    },
    ci_report: async (peer, a) => {
      this.need(peer, "read"); if (peer.kind !== "runner") throw new RelayError(403, "runners only");
      const S = (v: any, n: number) => v == null ? null : String(v).slice(0, n), N = (v: any) => Number.isFinite(v) ? v : null; // kept short and typed: it is shown to the owner
      const runs = (Array.isArray(a.runs) ? a.runs.slice(0, 20) : []).map((r: any) => ({ id: S(r?.id, 40), project: S(r?.project, 64), branch: S(r?.branch, 200), sha: S(r?.sha, 40), reason: S(r?.reason, 20), cmd: S(r?.cmd, 200), why: S(r?.why, 300), task: S(r?.task, 40),
        state: ["queued", "running", "passed", "failed", "error", "cancelled", "skipped"].includes(r?.state) ? r.state : "error", passed: N(r?.passed), failed: N(r?.failed), secs: N(r?.secs),
        tail: Array.isArray(r?.tail) ? r.tail.slice(-20).map((l: any) => S(l, 300)) : [], at: Number(r?.at) || Date.now() })).filter((r: any) => r.id);
      const x = this.experimentalState(), asks = this.ciReport(peer.name, runs, (Array.isArray(a.took) ? a.took : []).map(String));
      return { experimental: !!x, ci: !!x?.ci, gh_status: !!x?.gh_status, asks: x ? asks : [] };
    },
    webhook_secret: async (peer) => ({ secret: this.whsec(peer.id), header: "x-relay-signature: t=<unix>,v1=hex(hmac_sha256(secret, t + '.' + raw_body))" }),
    // Wake digest for peers that can't be pushed to (no socket, no inbound URL): one call says what finished, what needs you,
    // what you were told, and what changed under your watched paths, since your stored cursor. Read-only, so a GET or a retry
    // never loses anything; `ack` moves the cursor. `tasks` keeps the old inbox shape (runners use it on connect).
    inbox: async (peer, a) => {
      const st = this.inboxState(peer.id), since = Math.max(0, Number(a.since ?? st.cursor) || 0);
      const watch: string[] = (Array.isArray(a.watch) ? a.watch : st.watch).map(String).slice(0, 50), m = this.member(peer.id);
      if (a.wait && !this.sql.exec("select 1 from events where seq>? limit 1", since).toArray().length) await this.wait(Number(a.wait));
      const LIM = 1000, rows = this.sql.exec("select * from events where seq>? order by seq limit ?", since, LIM).toArray() as any[];
      const cursor = rows.length ? rows[rows.length - 1].seq as number : since;
      const tk = new Map<string, any>(), task = (id: string) => { if (!tk.has(id)) tk.set(id, this.sql.exec("select * from tasks where id=?", id).toArray()[0] ?? null); return tk.get(id); };
      const finished = new Map<string, any>(), files = new Map<string, any>(), messages: any[] = [];
      for (const r of rows) {
        if (r.actor === peer.name) continue;
        const d = (() => { try { return JSON.parse(r.data); } catch { return {}; } })();
        if (r.type === "peer.notify") { if (d.to === peer.name) messages.push({ kind: "notify", from: r.actor, message: d.message, task: d.task ?? null, at: r.at, seq: r.seq }); continue; }
        if (r.task_id) {
          const t = task(r.task_id); if (!t || (t.from_peer !== peer.id && t.target_peer !== peer.id)) continue;
          if (r.type === "task.message") messages.push({ kind: "task", from: r.actor, task: t.id, title: t.title, message: d.message, at: r.at, seq: r.seq });
          else if (r.type === "task.steered") { if (t.target_peer === peer.id) messages.push({ kind: "steer", from: d.by ?? r.actor, task: t.id, title: t.title, message: d.message, at: r.at, seq: r.seq, take_with: "task_steer_take" }); }
          else if (t.from_peer === peer.id && ["task.succeeded", "task.failed", "task.cancelled", "task.rejected", "task.report"].includes(r.type)) {
            const res = (() => { try { return JSON.parse(t.result ?? "null") ?? {}; } catch { return {}; } })(), sr = res.structured ?? {};
            const text = sr.headline ?? res.summary ?? res.reason ?? d.summary ?? d.reason ?? d.note ?? null;
            finished.set(t.id, { task: t.id, title: t.title, state: t.state, target: this.member(t.target_peer)?.name, summary: text == null ? null : String(text).slice(0, 500),
              branch: sr.branch ?? null, commit: sr.commit ?? null, compare_url: sr.compare_url ?? null, pr_url: sr.pr_url ?? null, ...(sr.tests ? { tests: sr.tests } : {}),
              ...(res.headline ? { headline: res.headline } : {}), at: r.at }); // headline: the phone-first card (outcome, changed, tests, branch, next action)
          }
          continue;
        }
        if (r.path && watch.some(g => globMatch(g, r.path)) && m?.verbs.includes("read") && this.pathOk(m, r.path))
          files.set(r.path, { path: r.path, change: r.type === "file.deleted" ? "deleted" : "written", sha: d.sha ?? null, by: r.actor, at: r.at });
      }
      // needs_you is current state, not history: it stays listed until you act, whatever the cursor says
      const needs = this.sql.exec(`select * from tasks where (target_peer=?1 and state in ('queued','awaiting_approval')) or (from_peer=?1 and state='needs_input') order by updated`, peer.id).toArray()
        .map((t: any) => { const ask = t.state === "needs_input" ? this.sql.exec("select data from events where task_id=? and type='task.needs_input' order by seq desc limit 1", t.id).toArray()[0] as any : null;
          return { task: t.id, title: t.title, state: t.state, why: t.state === "queued" ? "assigned to you: claim it" : t.state === "awaiting_approval" ? "waiting for your approval" : "the worker asked you something: answer with task_answer",
            from: this.member(t.from_peer)?.name, target: this.member(t.target_peer)?.name, ...(ask ? { question: (() => { try { return JSON.parse(ask.data).message ?? null; } catch { return null; } })() } : {}), updated: t.updated }; });
      const open = this.sql.exec(`select id from tasks where target_peer=? and state in (${ACTIVE.map(() => "?").join(",")}) order by created`, peer.id, ...ACTIVE).toArray();
      const sentActive = Number((this.sql.exec(`select count(*) n from tasks where from_peer=? and state in (${ACTIVE.map(() => "?").join(",")})`, peer.id, ...ACTIVE).one() as any).n);
      const more = rows.length === LIM;
      return { cursor, since, acked: st.cursor, more, watch, tasks: open.map(r => this.loadTask(r.id as string)),
        finished: [...finished.values()], needs_you: needs, messages: messages.slice(-200), files: [...files.values()].slice(-200), sent_active: sentActive,
        next_poll_after: more ? 0 : sentActive || needs.length ? 30 : 300 };
    },
    ack: async (peer, a) => {
      const me = this.member(peer.id); if (!me || me.revoked) throw new RelayError(403, `no access to workspace ${this.spaceId}`);
      const st = this.inboxState(peer.id), head = this.evHead();
      const c = a.cursor === undefined || a.cursor === null ? head : Number(a.cursor);
      if (!Number.isFinite(c) || c < 0) throw new RelayError(400, "cursor must be a non-negative number");
      if (a.watch !== undefined && !Array.isArray(a.watch)) throw new RelayError(400, "watch must be an array of globs");
      const next = { cursor: Math.max(st.cursor, Math.min(c, head)), watch: a.watch !== undefined ? a.watch.map(String).slice(0, 50) : st.watch };
      this.sql.exec("insert or replace into meta values(?,?)", `inbox:${peer.id}`, JSON.stringify(next));
      return next;
    },
    notify: async (peer, a) => { // a short wake-up for a peer: stored in its inbox, pushed to its socket/long-poll/webhook/event subscriptions
      const m = this.member(peer.id); if (!m || m.revoked) throw new RelayError(403, `no access to workspace ${this.spaceId}`);
      const to = this.sql.exec("select * from members where name=? and revoked=0", String(a.to)).toArray()[0] as any;
      if (!to) throw new RelayError(404, `no connected app named ${a.to} in workspace ${this.spaceId}`);
      const message = redact(String(a.message)); if (!message.trim() || message.length > 2000) throw new RelayError(400, "message: 1-2000 chars");
      if (a.task != null) this.taskFor(peer, String(a.task), "any");
      const ev = this.emit("peer.notify", peer, { data: { to: to.name, message, task: a.task ?? null } });
      if (to.webhook && to.peer_id !== peer.id) this.outboxAdd("peer", to.peer_id, ev.seq, ev.seq, JSON.stringify(ev)); // durable, retried by the alarm
      const pr = this.presence(to);
      return { ok: true, seq: ev.seq, to: to.name, target_online: pr.online, target_wake: pr.wake };
    },
    code_report: async (peer, a) => {
      this.need(peer, "write"); if (peer.kind !== "runner") throw new RelayError(403, "runners only");
      const s = redact(JSON.stringify(a.projects ?? {})); if (s.length > 64_000) throw new RelayError(413, "code report too large");
      this.sql.exec("insert or replace into code_state values(?,?,?)", peer.name, s, now()); return { ok: true };
    },
    code_status: async (peer, a) => {
      this.need(peer, "read");
      const rows = this.sql.exec("select * from code_state order by runner").toArray() as any[], out: any[] = [];
      for (const r of rows) {
        if (a.runner && r.runner !== a.runner) continue;
        const m = this.sql.exec("select * from members where name=? and revoked=0", r.runner).toArray()[0] as any; if (!m) continue;
        const projects: any = {};
        for (const [k, v] of Object.entries<any>(JSON.parse(r.data))) if (!a.project || a.project === k) { const { merged_heads, ...rest } = v ?? {}; projects[k] = { ...rest, notes: codeNotes(v) }; } // merged_heads only feeds the Status week line
        out.push({ runner: r.runner, online: this.online(m.peer_id), reported_at: r.updated, projects });
      }
      return { runners: out, notes: out.flatMap(x => Object.entries<any>(x.projects).flatMap(([k, v]) => v.notes.map((n: string) => `${x.runner}/${k}: ${n}`))) };
    },
  };
  // relay_update to a Mac whose runner is offline: the ask just waits (only the runner updates itself), so say so and for how long
  // (incident 2026-10-23: asks queued silently for hours behind a dead runner). status has the why and the next step.
  const ru = ops.relay_update;
  ops.relay_update = async (peer, a) => { const r = await ru(peer, a); if (!r || typeof r !== "object") return r;
    const off = (this.sql.exec("select * from members where kind='runner' and revoked=0 order by name").toArray() as any[]).map(m => runnerHealth(this, m)).filter(h => !h.online);
    if (!off.length) return r;
    const words = off.map(h => `${h.name}'s runner is offline${h.down_s != null ? ` (for ${ago(h.down_s * 1000)})` : ""}`).join("; ");
    return { ...r, runner_offline: off.map(h => ({ runner: h.name, down_for: h.down_s != null ? ago(h.down_s * 1000) : null, state: h.state, next: h.next })),
      warning: `${words}: nothing happens until it's back, since only the runner updates the Mac. Call status for why; tell the owner (often: on the Mac run kitebook restart runner).` }; };
  return ops;
}
