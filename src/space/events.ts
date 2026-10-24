// Space DO: the event log, legacy peer webhooks, the durable webhook outbox and MCP Events (poll, push, webhook).
// One layer of the Space class chain (core -> gc -> events -> files -> tasks -> Space in src/space.ts); split for size only, no behavior lives in the chain itself.
import { type Peer } from "../ops.ts";
import { EventsError, CODES, SUB_META, evErr, typeOf, validateArgs, payloadFor, encCursor, decCursor, checkCallbackUrl, resolvesPublic, secretBytes, signV1, subId, category, type EvType, type Raw } from "../events.ts";
import { type Member, type EvStream, ctEqual, now, rid } from "./util.ts";
import { SpaceGc } from "./gc.ts";

export class SpaceEvents extends SpaceGc {
  // ---------- events ----------
  emit(type: string, actor: Peer | null, o: { path?: string; task?: string; data?: any } = {}) {
    const at = now();
    const seq = this.sql.exec("insert into events(type,path,task_id,actor,data,at) values(?,?,?,?,?,?) returning seq",
      type, o.path ?? null, o.task ?? null, actor?.name ?? null, JSON.stringify(o.data ?? {}), at).one().seq as number;
    if (seq % 500 === 0) try { this.trimEvents(); } catch (e) { console.error("event cap", e); }
    const ev = { seq, space: this.spaceId, type, path: o.path, task: o.task, actor: actor?.name, data: o.data ?? {}, at };
    const msg = JSON.stringify({ event: ev });
    for (const ws of this.ctx.getWebSockets()) {
      const p = ws.deserializeAttachment() as Peer | null;
      if (p && this.visible(p, ev)) try { ws.send(msg); } catch {}
    }
    if (o.task) this.webhook(ev);
    for (const w of [...this.waiters]) w();
    try { this.evFanout(ev); } catch (e) { console.error("events fanout", e); }
    return ev;
  }
  visible(peer: Peer, ev: any): boolean {
    const m = this.member(peer.id); if (!m || m.revoked) return false;
    if (ev.type === "peer.notify") return ev.data?.to === peer.name || ev.actor === peer.name; // notify is private to sender + recipient
    if (ev.type === "presence.remote") return m.kind === "runner" && ev.data?.target === peer.name; // a password typed on another device: that runner only
    if (ev.type === "connect.requested") return m.kind === "runner"; // only the owner's Macs kitebook connection approvals
    if (String(ev.type ?? "").startsWith("sessions.")) return ev.actor === peer.name || (ev.type === "sessions.requested" && m.kind === "runner" && ev.data?.target === peer.name); // the owner's sessions: asker + that runner only
    if (ev.path) return m.verbs.includes("read") && this.pathOk(m, ev.path);
    if (ev.task) { const t = this.sql.exec("select from_peer,target_peer from tasks where id=?", ev.task).toArray()[0] as any; return !!t && (t.from_peer === peer.id || t.target_peer === peer.id); }
    return true;
  }
  webhook(ev: any) { // legacy per-peer webhook: queued in the durable outbox, delivered by the alarm
    const t = this.sql.exec("select from_peer,target_peer from tasks where id=?", ev.task).toArray()[0] as any; if (!t) return;
    for (const pid of [t.from_peer, t.target_peer]) {
      const m = this.member(pid);
      if (m?.webhook && !m.revoked && m.name !== ev.actor) this.outboxAdd("peer", pid, ev.seq, ev.seq, JSON.stringify(ev));
    }
  }
  whsec(peerId: string): string { // per-peer signing secret, made on first use
    const k = `whsec:${peerId}`, cur = this.sql.exec("select v from meta where k=?", k).toArray()[0]?.v as string | undefined;
    if (cur) return cur;
    const v = "whsec_" + [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, "0")).join("");
    this.sql.exec("insert into meta values(?,?)", k, v); return v;
  }
  async peerPost(m: Member, body: string, type: string): Promise<{ ok: boolean; error?: string; final?: boolean }> { // signed like Stripe: x-relay-signature: t=<unix>,v1=hex(hmac_sha256(secret, t + "." + body))
    const t = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(this.whsec(m.peer_id)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)))].map(b => b.toString(16).padStart(2, "0")).join("");
    let wu: URL; try { wu = new URL(m.webhook!); } catch { return { ok: false, error: "bad_url", final: true }; }
    if (!(await resolvesPublic(wu, this.evPolicy))) return { ok: false, error: "connection_refused", final: true }; // SSRF guard: never POST to private/loopback addresses
    try { const r = await fetch(wu.href, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/json", "x-relay-signature": `t=${t},v1=${sig}`, "x-relay-event": type }, body });
      await r.body?.cancel(); if (r.ok) return { ok: true };
      return { ok: false, error: category(r.status), final: r.status >= 400 && r.status < 500 && r.status !== 429 }; } catch (e) { return { ok: false, error: category(null, e) }; }
  }

  // ---------- durable webhook outbox ----------
  // Every webhook delivery (legacy peer hooks, MCP Events subscriptions, terminated envelopes) is a row here, sent by the DO alarm
  // with exponential backoff. Nothing lives only in memory, so an evicted or restarted DO picks up where it left off.
  hookBatch: Raw[] | null = null;
  outboxAdd(kind: "peer" | "sub" | "term", target: string, lo: number, seq: number, body: string, extra?: any) {
    this.sql.exec("insert into outbox(kind,target,lo,seq,body,extra,next_at,created) values(?,?,?,?,?,?,?,?)", kind, target, lo, seq, body, extra ? JSON.stringify(extra) : null, Date.now(), now());
    this.armAlarm(Date.now()).catch(() => {});
  }
  async outboxRun(): Promise<number | null> {
    const rows = this.sql.exec("select * from outbox where next_at<=? order by id limit 32", Date.now()).toArray() as any[];
    const byTarget = new Map<string, any[]>(); for (const r of rows) { const k = r.kind + ":" + r.target; byTarget.set(k, [...(byTarget.get(k) ?? []), r]); }
    // In order per receiver, receivers in parallel.
    await Promise.all([...byTarget.values()].map(async rs => { for (const r of rs) await this.outboxSend(r).catch(e => { console.error("outbox", e); this.outboxResult(r, { ok: false, error: "delivery_exception" }); }); }));
    return (this.sql.exec("select min(next_at) t from outbox").one().t as number | null) ?? null;
  }
  async outboxSend(r: any) {
    const drop = () => { this.sql.exec("delete from outbox where id=?", r.id); };
    let res: { ok: boolean; error?: string; final?: boolean };
    if (r.kind === "peer") {
      const m = this.member(r.target); if (!m?.webhook || m.revoked) return drop();
      res = await this.peerPost(m, r.body, JSON.parse(r.body).type);
    } else if (r.kind === "sub") {
      const sub = this.evSubRow(r.target), t = sub && typeOf(sub.name);
      if (!sub || !t || this.evExpired(sub) || !sub.active) return drop(); // lapsed or suspended: the client cursor recovers the gap
      try { this.evAuthorize(sub.peer_id, t); } catch { return drop(); }
      // The cursor never runs ahead of an earlier event still waiting in the outbox for this subscription.
      const lower = this.sql.exec("select min(lo) s from outbox where kind='sub' and target=? and lo<?", r.target, r.lo).one().s as number | null;
      const occ = JSON.parse(r.body);
      res = await this.evPost(sub, occ.eventId, JSON.stringify({ ...occ, cursor: encCursor(this.spaceId, lower != null ? lower - 1 : r.seq) }));
    } else { const x = JSON.parse(r.extra); res = await this.evPost(x, x.wid, r.body); }
    this.outboxResult(r, res);
  }
  // Unexpected adapter/JSON failures consume the same finite budget as HTTP failures, including across eviction.
  outboxResult(r: any, res: { ok: boolean; error?: string; final?: boolean }) {
    const drop = () => { this.sql.exec("delete from outbox where id=?", r.id); };
    const tries = (Number(r.attempts) || 0) + 1, max = r.kind === "term" ? 3 : Math.min(32, this.evNum("OUTBOX_MAX_ATTEMPTS", 8));
    if (res.ok || res.final || tries >= max) {
      drop();
      if (r.kind === "sub") {
        if (res.ok) this.sql.exec("update event_subs set last_delivery_at=?, last_error=null, failed_since=null, fails=0 where id=?", now(), r.target);
        else this.sql.exec("update event_subs set last_error=?, failed_since=coalesce(failed_since,?), fails=fails+1, active=case when fails+1>=? then 0 else active end where id=?",
          res.error ?? "connection_refused", now(), this.evNum("EVENTS_SUSPEND_AFTER", 20), r.target);
      }
      return;
    }
    const wait = Math.min(this.evNum("OUTBOX_BASE_MS", 2000) * 2 ** (tries - 1), 600_000) * (0.85 + Math.random() * 0.3); // exponential backoff, jittered
    this.sql.exec("update outbox set attempts=?, next_at=?, last_error=? where id=?", tries, Math.round(Date.now() + wait), res.error ?? "error", r.id);
    if (r.kind === "sub") this.sql.exec("update event_subs set last_error=?, failed_since=coalesce(failed_since,?) where id=?", res.error ?? "connection_refused", now(), r.target);
  }
  // ---------- MCP Events (io.modelcontextprotocol/events): poll, push (SSE), webhook ----------
  // Event types are filtered views over the `events` log above; cursors are positions in it, so every mode can replay.
  evStreams = new Map<number, EvStream>();
  evStreamSeq = 0;
  get evPolicy() { return { allowLoopback: (this.env as any).EVENTS_ALLOW_LOOPBACK === "1" }; } // dev/test only
  evNum(k: string, d: number) { const v = Number((this.env as any)[k]); return Number.isFinite(v) && v > 0 ? v : d; }
  evHead(): number { return (this.sql.exec("select max(seq) s from events").one().s as number) ?? 0; }
  evRaw(r: any): Raw { return { seq: r.seq, type: r.type, path: r.path ?? null, task: r.task_id ?? r.task ?? null, actor: r.actor ?? null, data: typeof r.data === "string" ? JSON.parse(r.data) : r.data ?? {}, at: r.at }; }
  evTask = (id: string) => {
    const t = this.sql.exec("select from_peer,target_peer,title,project from tasks where id=?", id).toArray()[0] as any; if (!t) return null;
    return { title: t.title, from: this.member(t.from_peer)?.name ?? t.from_peer, target: this.member(t.target_peer)?.name ?? t.target_peer, project: t.project ?? null };
  };
  evType(p: any, mode: "poll" | "push" | "webhook"): EvType {
    const t = typeOf(p?.name); if (!t) throw evErr("NotFound", { kind: "event" });
    if (!t.delivery.includes(mode)) throw evErr("Unsupported", { feature: "deliveryMode", value: mode });
    return t;
  }
  // Same principal + verbs as tools, re-checked at every delivery, heartbeat and refresh.
  evAuthorize(peerId: string, t: EvType): Member {
    const m = this.member(peerId);
    if (!m || m.revoked) throw evErr("Forbidden", { reason: "Access revoked" });
    if (t.verbs.length && !t.verbs.some(v => m.verbs.includes(v))) throw evErr("Forbidden", { reason: `needs ${t.verbs.join(" or ")} access to workspace ${this.spaceId}` });
    return m;
  }
  evOcc(peer: Peer, t: EvType, args: any, ev: Raw) {
    if (!this.visible(peer, { path: ev.path ?? undefined, task: ev.task ?? undefined })) return null;
    const data = payloadFor(t, args, ev, peer.name, this.evTask); if (!data) return null;
    return { eventId: `evt_${this.spaceId}_${ev.seq}`, name: t.name, timestamp: ev.at, data };
  }
  // Where delivery starts for a client cursor: null = now; maxAgeMs floor; a server ceiling (`cap` rows) -> truncated.
  evStart(cursor: any, maxAgeMs: any, cap = Infinity): { from: number; truncated: boolean; fresh: boolean } {
    const head = this.evHead(); let from = decCursor(this.spaceId, cursor);
    if (from === null) return { from: head, truncated: false, fresh: true };
    let truncated = false; from = Math.min(from, head);
    if (maxAgeMs !== undefined && maxAgeMs !== null) {
      const ms = Number(maxAgeMs); if (!Number.isFinite(ms) || ms < 0) throw evErr("InvalidParams", { reason: "maxAgeMs must be a non-negative integer" });
      const f = this.sql.exec("select min(seq) s from events where seq>? and at>=?", from, new Date(Date.now() - ms).toISOString()).one().s as number | null;
      const floor = (f ?? head + 1) - 1; if (floor > from) { truncated = true; from = floor; }
    }
    if (head - from > cap) { truncated = true; from = head; }
    return { from, truncated, fresh: false };
  }
  peerOf(id: string): Peer { const m = this.member(id); return { id, name: m?.name ?? id, kind: m?.kind ?? "?" }; }

  async events(peer: Peer, method: string, params: any): Promise<{ result: any } | { error: any }> {
    try { this.seen(peer.id); } catch {}
    const lim = this.rateHit(peer); if (lim) return { error: { code: CODES.ResourceExhausted, message: "ResourceExhausted", data: { reason: lim.error, retry_after: lim.retry_after } } };
    try {
      const p = params ?? {};
      if (method === "events/poll") return { result: this.evPoll(peer, p) };
      if (method === "events/subscribe") return { result: await this.evSubscribe(peer, p) };
      if (method === "events/unsubscribe") return { result: await this.evUnsubscribe(peer, p) };
      return { error: { code: -32601, message: "method not found" } };
    } catch (e: any) {
      if (e instanceof EventsError) return { error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } };
      console.error(e); return { error: { code: -32603, message: "internal error" } };
    }
  }

  evPoll(peer: Peer, p: any) {
    const t = this.evType(p, "poll"), args = validateArgs(t, p.arguments); this.evAuthorize(peer.id, t);
    const sp = this.spaceId, st = this.evStart(p.cursor, p.maxAgeMs), next = this.evNum("EVENTS_POLL_MS", 10000);
    if (st.fresh) return { resultType: "complete", events: [], cursor: encCursor(sp, st.from), truncated: false, hasMore: false, nextPollMs: next };
    const max = Math.min(Math.max(Math.floor(Number(p.maxEvents ?? 100)) || 100, 1), 500);
    const out: any[] = []; let last = st.from;
    for (const r of this.sql.exec("select * from events where seq>? order by seq limit 2000", st.from)) {
      const occ = this.evOcc(peer, t, args, this.evRaw(r));
      if (occ && out.length >= max) break;
      if (occ) out.push(occ); last = r.seq as number;
    }
    const hasMore = last < this.evHead();
    return { resultType: "complete", events: out, cursor: encCursor(sp, last), truncated: st.truncated, hasMore, nextPollMs: hasMore ? 0 : next };
  }

  // Push: the POST's response is an SSE stream carrying only this subscription's notifications/events/*.
  evStream(peer: Peer, rpcId: any, p: any): Response {
    let t: EvType, args: any, st: { from: number; truncated: boolean };
    try { t = this.evType(p, "push"); args = validateArgs(t, p.arguments); this.evAuthorize(peer.id, t); st = this.evStart(p.cursor, p.maxAgeMs, 10000);
      // Cost cap: an open stream keeps the DO awake (no hibernation), so each peer gets a few streams of bounded life.
      const maxStreams = this.evNum("EVENTS_MAX_STREAMS", 4);
      if ([...this.evStreams.values()].filter(x => x.peer.id === peer.id).length >= maxStreams) throw evErr("ResourceExhausted", { limit: "streams", max: maxStreams }); }
    catch (e: any) {
      if (!(e instanceof EventsError)) throw e;
      return Response.json({ jsonrpc: "2.0", id: rpcId ?? null, error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } });
    }
    const sp = this.spaceId, head = this.evHead(), meta = { [SUB_META]: rpcId };
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>(), w = writable.getWriter(), te = new TextEncoder();
    const frame = (o: any) => w.write(te.encode(`data: ${JSON.stringify(o)}\n\n`)).catch(() => this.evStreamClose(s, false));
    const s: EvStream = { key: ++this.evStreamSeq, peer, t, args, last: head, closed: false, timer: undefined,
      send: (method, params) => { if (!s.closed) frame({ jsonrpc: "2.0", method, params: { ...params, _meta: meta } }); },
      finish: (reason?: string) => { frame({ jsonrpc: "2.0", id: rpcId, result: { resultType: "complete", cursor: encCursor(sp, s.last), ...(reason ? { reason } : {}), _meta: meta } }); w.close().catch(() => {}); } };
    s.send("notifications/events/active", { cursor: encCursor(sp, st.from), truncated: st.truncated });
    if (st.from < head) for (const r of this.sql.exec("select * from events where seq>? and seq<=? order by seq", st.from, head)) {
      const ev = this.evRaw(r), occ = this.evOcc(peer, t, args, ev); if (occ) s.send("notifications/events/event", { ...occ, cursor: encCursor(sp, ev.seq) });
    }
    this.evStreams.set(s.key, s);
    s.timer = setInterval(() => {
      try { this.evAuthorize(peer.id, t); } catch (e: any) { return this.evTerminate(s, e); }
      s.send("notifications/events/heartbeat", { cursor: encCursor(sp, s.last) });
    }, Math.min(this.evNum("EVENTS_HEARTBEAT_MS", 15000), 30000));
    // Max life (default 5 min): end with a final result carrying the cursor; the client reconnects with it and loses nothing.
    s.ttl = setTimeout(() => this.evStreamClose(s, true, "max_duration"), Math.min(this.evNum("EVENTS_STREAM_MAX_MS", 300000), 3600000));
    w.closed.catch(() => this.evStreamClose(s, false)); // client aborted the request
    return new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
  }
  evStreamClose(s: EvStream, final: boolean, reason?: string) {
    if (s.closed) return; s.closed = true; clearInterval(s.timer); clearTimeout(s.ttl); this.evStreams.delete(s.key);
    if (final) s.finish(reason);
  }
  evTerminate(s: EvStream, e: EventsError) {
    s.send("notifications/events/terminated", { error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } });
    this.evStreamClose(s, true);
  }

  // Webhook mode. Key = (principal, delivery.url, name, arguments); principal = this peer (its account + space are the DO itself).
  evSubRow(id: string): any { return this.sql.exec("select * from event_subs where id=?", id).toArray()[0] ?? null; }
  evExpired = (sub: any) => !!sub.refresh_before && Date.parse(sub.refresh_before) <= Date.now();
  async evSubscribe(peer: Peer, p: any) {
    const t = this.evType(p, "webhook"), args = validateArgs(t, p.arguments); this.evAuthorize(peer.id, t);
    const d = p.delivery;
    if (!d || typeof d !== "object") throw evErr("InvalidParams", { reason: "delivery {mode, url, secret} is required" });
    if (d.mode !== undefined && d.mode !== "webhook") throw evErr("Unsupported", { feature: "deliveryMode", value: d.mode });
    const url = checkCallbackUrl(d.url, this.evPolicy).href; secretBytes(d.secret);
    const sp = this.spaceId, id = await subId(peer.id, url, t.name, args);
    if (p.cursor != null) decCursor(sp, p.cursor);
    let cur = this.evSubRow(id); if (cur && this.evExpired(cur)) { this.sql.exec("delete from event_subs where id=?", id); cur = null; }
    const max = this.evNum("EVENTS_MAX_SUBS", 50);
    if (!cur && (this.sql.exec("select count(*) n from event_subs where peer_id=?", peer.id).one().n as number) >= max) throw evErr("ResourceExhausted", { limit: "subscriptions", max });
    // TTL: client suggests, server grants <= suggestion, clamped up to a floor. No-expiry (ttlMs:null) is never granted: the TTL is the revocation window.
    const minTtl = this.evNum("EVENTS_MIN_TTL_MS", 60_000), maxTtl = 86_400_000;
    const sugg = p.ttlMs === undefined ? 3_600_000 : p.ttlMs === null ? maxTtl : Number(p.ttlMs);
    if (!Number.isFinite(sugg) || sugg <= 0) throw evErr("InvalidParams", { reason: "ttlMs must be a positive integer or null" });
    const ttl = Math.min(Math.max(sugg, minTtl), maxTtl);
    await this.evVerify(peer.id, url, d.secret, id); // endpoint must prove intent before any delivery
    const live = this.evSubRow(id) && !this.evExpired(this.evSubRow(id)) ? this.evSubRow(id) : null, head = this.evHead();
    let truncated = false, replayFrom: number | null = null;
    if (!live && p.cursor != null) { const st = this.evStart(p.cursor, p.maxAgeMs, 10000); truncated = st.truncated; if (st.from < head) replayFrom = st.from; }
    const refreshBefore = new Date(Date.now() + ttl).toISOString(), ts = now();
    if (live) {
      const rotated = live.secret !== d.secret;
      this.sql.exec("update event_subs set secret=?, prev_secret=?, prev_until=?, refresh_before=?, active=1, fails=0, updated=?, grant_id=? where id=?",
        d.secret, rotated ? live.secret : live.prev_secret, rotated ? new Date(Date.now() + 300_000).toISOString() : live.prev_until, refreshBefore, ts, peer.grant ?? null, id);
    } else {
      this.sql.exec("insert or replace into event_subs(id,peer_id,name,args,url,secret,refresh_before,active,fails,created,updated,grant_id) values(?,?,?,?,?,?,?,1,0,?,?,?)",
        id, peer.id, t.name, JSON.stringify(args), url, d.secret, refreshBefore, ts, ts, peer.grant ?? null);
    }
    this.armAlarm(Date.parse(refreshBefore)).catch(() => {}); // the alarm sweeps lapsed subscriptions
    if (replayFrom !== null) this.evEnqueue(id, peer, t, args, this.sql.exec("select * from events where seq>? and seq<=? order by seq", replayFrom, head).toArray().map(r => this.evRaw(r)));
    const pend = this.sql.exec("select min(lo) s from outbox where kind='sub' and target=?", id).one().s as number | null, wm = pend != null ? pend - 1 : head;
    return { resultType: "complete", id, refreshBefore, cursor: encCursor(sp, wm), truncated,
      ...(live ? { deliveryStatus: { active: !!live.active, lastDeliveryAt: live.last_delivery_at ?? null, lastError: live.last_error ?? null, ...(live.failed_since ? { failedSince: live.failed_since } : {}) } } : {}) };
  }
  async evUnsubscribe(peer: Peer, p: any) {
    const t = typeOf(p?.name); if (!t) throw evErr("NotFound", { kind: "event" });
    const args = validateArgs(t, p.arguments), url = checkCallbackUrl(p.delivery?.url, this.evPolicy).href;
    const id = await subId(peer.id, url, t.name, args), sub = this.evSubRow(id);
    if (!sub || sub.peer_id !== peer.id || this.evExpired(sub)) throw evErr("NotFound", { kind: "subscription" });
    this.sql.exec("delete from event_subs where id=?", id); this.sql.exec("delete from outbox where kind='sub' and target=?", id);
    return { resultType: "complete" };
  }
  // Verification handshake (cached per (principal, url) for 24h): signed {"type":"verification","challenge"}; the endpoint echoes it.
  async evVerify(peerId: string, url: string, secret: string, id: string) {
    const v = this.sql.exec("select at from event_verified where peer_id=? and url=?", peerId, url).toArray()[0] as any;
    if (v && Date.parse(v.at) > Date.now() - 86_400_000) return;
    const challenge = [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, "0")).join("");
    const r = await this.evPost({ id, url, secret }, rid("msg_verification"), JSON.stringify({ type: "verification", challenge }), true);
    if (!r.ok) throw evErr("CallbackEndpointError", { reason: r.error });
    let echoed: any = null; try { echoed = JSON.parse(r.text ?? "").challenge; } catch {}
    if (typeof echoed !== "string" || !(await ctEqual(echoed, challenge))) throw evErr("CallbackEndpointError", { reason: "challenge_failed" });
    this.sql.exec("insert or replace into event_verified values(?,?,?)", peerId, url, now());
  }
  // One signed POST (Standard Webhooks + X-MCP-Subscription-Id). Re-checks the resolved address every time; never follows redirects.
  async evPost(sub: any, webhookId: string, body: string, wantText = false): Promise<{ ok: boolean; error?: string; final?: boolean; text?: string }> {
    let u: URL; try { u = new URL(sub.url); } catch { return { ok: false, error: "connection_refused", final: true }; }
    if (!(await resolvesPublic(u, this.evPolicy))) return { ok: false, error: "connection_refused" };
    const ts = Math.floor(Date.now() / 1000);
    let sig = await signV1(sub.secret, webhookId, ts, body);
    if (sub.prev_secret && sub.prev_until && Date.parse(sub.prev_until) > Date.now()) sig += " " + await signV1(sub.prev_secret, webhookId, ts, body); // rotation grace
    try {
      const r = await fetch(u.href, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000), body,
        headers: { "content-type": "application/json", "webhook-id": webhookId, "webhook-timestamp": String(ts), "webhook-signature": sig, "X-MCP-Subscription-Id": sub.id } });
      if (r.status >= 200 && r.status < 300) return { ok: true, text: wantText ? (await r.text()).slice(0, 4096) : (await r.body?.cancel(), undefined) };
      await r.body?.cancel();
      return { ok: false, error: category(r.status), final: r.status === 410 || r.status === 413 };
    } catch (e) { return { ok: false, error: category(null, e) }; }
  }
  // Queue a subscription's matching events. File changes from one commit become ONE delivery (the last event's id and cursor,
  // the first path in `path`, all of them in `paths`), so a 50-file batch is one POST, not 50.
  evEnqueue(id: string, peer: Peer, t: EvType, args: any, evs: Raw[]) {
    const groups: { ev: Raw; occ: any }[][] = [];
    for (const ev of evs) {
      const occ = this.evOcc(peer, t, args, ev); if (!occ) continue;
      const g = groups[groups.length - 1], c = occ.data?.commit;
      if (g && c && t.name === "file.changed" && g[0].occ.data.commit === c) g.push({ ev, occ }); else groups.push([{ ev, occ }]);
    }
    for (const g of groups) {
      const last = g[g.length - 1], occ = g.length === 1 ? last.occ
        : { ...last.occ, data: { ...g[0].occ.data, paths: g.map(x => ({ path: x.occ.data.path, change: x.occ.data.change, sha: x.occ.data.sha })) } };
      this.outboxAdd("sub", id, g[0].ev.seq, last.ev.seq, JSON.stringify(occ));
    }
  }
  evKillSub(sub: any, e: EventsError) {
    this.sql.exec("delete from event_subs where id=?", sub.id); this.sql.exec("delete from outbox where kind='sub' and target=?", sub.id);
    const body = JSON.stringify({ type: "terminated", error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } });
    // The subscription row is gone, so the envelope carries its own address and keys.
    this.outboxAdd("term", sub.id, 0, 0, body, { id: sub.id, url: sub.url, secret: sub.secret, prev_secret: sub.prev_secret, prev_until: sub.prev_until, wid: rid("msg_terminated") });
  }
  evEndPeer(peerId: string, e: EventsError) {
    for (const sub of this.sql.exec("select * from event_subs where peer_id=?", peerId).toArray()) this.evKillSub(sub, e);
    for (const s of [...this.evStreams.values()]) if (s.peer.id === peerId) this.evTerminate(s, e);
  }
  evRecheck(peerId: string) {
    for (const sub of this.sql.exec("select * from event_subs where peer_id=?", peerId).toArray() as any[]) {
      const t = typeOf(sub.name); try { if (!t) throw evErr("NotFound", { kind: "event" }); this.evAuthorize(peerId, t); } catch (e: any) { this.evKillSub(sub, e); }
    }
    for (const s of [...this.evStreams.values()]) if (s.peer.id === peerId) try { this.evAuthorize(peerId, s.t); } catch (e: any) { this.evTerminate(s, e); }
  }
  evFanout(e: any) {
    const ev = this.evRaw(e), sp = this.spaceId;
    for (const s of [...this.evStreams.values()]) {
      s.last = ev.seq;
      try { this.evAuthorize(s.peer.id, s.t); } catch (err: any) { this.evTerminate(s, err); continue; }
      const occ = this.evOcc(s.peer, s.t, s.args, ev); if (occ) s.send("notifications/events/event", { ...occ, cursor: encCursor(sp, ev.seq) });
    }
    if (this.hookBatch) this.hookBatch.push(ev); else this.evHooks([ev]); // inside a commit: one delivery per commit
  }
  evHooks(evs: Raw[]) {
    evs = evs.filter(ev => ev.type.startsWith("file.") || ev.type.startsWith("task.") || ev.type === "peer.notify"); if (!evs.length) return;
    for (const sub of this.sql.exec("select * from event_subs").toArray() as any[]) {
      if (this.evExpired(sub)) { this.sql.exec("delete from event_subs where id=?", sub.id); continue; }
      if (!sub.active) continue; // suspended after repeated failures; a refresh reactivates it, the client cursor recovers the gap
      const t = typeOf(sub.name); if (!t) continue;
      try { this.evAuthorize(sub.peer_id, t); } catch (err: any) { this.evKillSub(sub, err); continue; }
      this.evEnqueue(sub.id, this.peerOf(sub.peer_id), t, JSON.parse(sub.args), evs);
    }
  }
  evSweep(): number | null { // drop lapsed webhook subscriptions; returns the next expiry
    this.sql.exec("delete from event_subs where refresh_before is not null and refresh_before<=?", now());
    const n = this.sql.exec("select min(refresh_before) t from event_subs").one().t as string | null;
    return n ? Date.parse(n) : null;
  }
}
