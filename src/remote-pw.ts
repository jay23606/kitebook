// Approve from another device with the master password (phone-approve, owner 2026-10-23; runner side: client/remote-presence.ts).
// A page opened on a phone (the /device pairing page, a presence prompt in Settings/consent/join) can't reach the Mac's loopback helper, so
// it POSTs the typed password here over HTTPS; this relays it to the owner's Mac runner(s) and waits up to RELAY_WAIT for the answer:
//   - the password is held in THIS object's memory only, for one request (taken by the runner = wiped here; a request nobody took is
//     dropped after KEEP_MS). Never written to storage, never logged, never in an event (presence.remote carries only the request id and
//     the runner's name, and only that runner sees it: src/space/events.ts visible). It is never checked here: the Mac unlocks its own
//     password key with it and answers with a presence assertion for exactly that action, which src/devices.ts assert verifies like any other.
//   - every owner device with a master password is asked (each has its own); the first one that confirms wins.
//   - rate limit here too (the Mac has its own): 5 wrong for one action ends its remote tries; 5 wrong in 15 minutes, any action, locks
//     remote password approval for the account for 15 minutes. Audited (Settings -> More -> Approve from other devices: recent tries).
//   - the switch (acct key remote_pw:<tenant> = "off"; absent = on, the owner's default) is Settings -> More -> "Approve from other devices
//     with my password"; changing it either way needs presence (src/start.ts).
import { DEFAULT_TENANT } from "./principal.ts";

export const RELAY_WAIT = 20_000, KEEP_MS = 60_000, MAX_WRONG = 5, LOCK_MS = 15 * 60_000;
type Ans = { ok: boolean; presence?: string; error?: string; wrong?: boolean; locked?: boolean; peer: string };
type Pend = { acct: string; action: string; password: string; targets: string[]; at: number; taken: Set<string>; answers: Ans[] };
const pending = new Map<string, Pend>(); // key acct:id; one Dir object per account, so one map entry is only ever touched by its account
const rnd = () => [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, "0")).join("");
const kv = (d: any, k: string) => (d.sql.exec("select v from acct where k=?", k).toArray()[0] as any)?.v as string | undefined;
const kset = (d: any, k: string, v: string | null) => v == null ? d.sql.exec("delete from acct where k=?", k) : d.sql.exec("insert or replace into acct values(?,?)", k, v);
const J = (d: any, k: string, def: any) => { try { const v = kv(d, k); return v ? JSON.parse(v) : def; } catch { return def; } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const log = (d: any, e: any) => { const l = J(d, "remote_pw:log", []) as any[]; l.push({ at: Date.now(), ...e }); kset(d, "remote_pw:log", JSON.stringify(l.slice(-30))); };

export const remotePwFns: Record<string, (d: any, ...a: any[]) => Promise<any>> = {
  async setting(d, tenant = DEFAULT_TENANT) {
    const lock = Number(kv(d, "remote_pw:lock")) || 0;
    return { on: kv(d, `remote_pw:${tenant}`) !== "off", locked_until: lock > Date.now() ? lock : null, log: (J(d, "remote_pw:log", []) as any[]).slice(-10).reverse(),
      devices: (d.sql.exec("select count(*) n from devices where tenant=? and state='active' and revoked=0 and password_key is not null and peer is not null", tenant).one() as any).n };
  },
  async set(d, a: { on: boolean; tenant?: string }) { kset(d, `remote_pw:${a.tenant ?? DEFAULT_TENANT}`, a.on ? null : "off"); log(d, { kind: a.on ? "turned_on" : "turned_off" }); return await remotePwFns.setting(d, a.tenant); },
  // the page's request: {ok, presence, peer} or {ok:false, status, error}
  async ask(d, a: { action: string; password: string; tenant?: string; from?: string }) {
    const tenant = a.tenant ?? DEFAULT_TENANT, t = Date.now(), action = String(a.action ?? "").slice(0, 80);
    for (const [k, p] of pending) if (t - p.at > KEEP_MS) pending.delete(k);
    if (kv(d, `remote_pw:${tenant}`) === "off") return { ok: false, status: 403, error: "Approving with your password from other devices is off (Settings -> More). Approve on your Mac (kitebook approve)." };
    if (typeof a.password !== "string" || !a.password || a.password.length > 1024) return { ok: false, status: 400, error: "Type your Kitebook master password." };
    const lock = Number(kv(d, "remote_pw:lock")) || 0;
    if (lock > t) return { ok: false, status: 429, error: `Too many wrong passwords: locked for ${Math.ceil((lock - t) / 60_000)} more min. On your Mac: kitebook approve.`, retry_after: Math.ceil((lock - t) / 1000) };
    const per = J(d, `remote_pw:wrong:${action}`, 0) as number;
    if (per >= MAX_WRONG) return { ok: false, status: 429, error: `${MAX_WRONG} wrong passwords for this: approve it on your Mac (kitebook approve).` };
    // every owner device with a master password, through its runner in the workspaces it is in
    const devs = d.sql.exec("select id, peer from devices where tenant=? and state='active' and revoked=0 and password_key is not null and peer is not null", tenant).toArray() as any[];
    if (!devs.length) return { ok: false, status: 409, error: "None of your computers has a master password yet (kitebook password set on your Mac)." };
    const id = rnd(), key = `${d.acct}:${id}`, targets: string[] = []; let online = 0;
    pending.set(key, { acct: d.acct, action, password: a.password, targets, at: t, taken: new Set(), answers: [] });
    try {
      for (const v of devs) { const p = d.sql.exec("select id from peers where name=? and revoked=0", v.peer).toArray()[0] as any; if (!p) continue;
        const sps = (d.sql.exec("select space_id from caps where peer_id=?", p.id).toArray() as any[]).map(r => r.space_id as string); if (!sps.length) continue; targets.push(v.peer);
        for (const s of sps) { try { const r = await d.space(s).remotePresence(id, v.peer); if (r?.online) { online++; break; } } catch {} } }
      if (!online) { log(d, { kind: "offline", action }); return { ok: false, status: 503, error: "Your Mac didn't answer: it may be asleep, offline, or Kitebook isn't running there. Approve when it's back, or on the Mac itself (kitebook approve)." }; }
      const end = Date.now() + RELAY_WAIT;
      for (;;) { const p = pending.get(key)!, good = p.answers.find(x => x.ok);
        if (good) { kset(d, `remote_pw:wrong:${action}`, null); log(d, { kind: "approved", action, by: good.peer }); return { ok: true, presence: good.presence, peer: good.peer }; }
        if (p.answers.length >= online || Date.now() > end) break; await sleep(150); }
      const p = pending.get(key)!;
      if (!p.answers.length) { log(d, { kind: "offline", action }); return { ok: false, status: 503, error: "Your Mac didn't answer in time (asleep or offline?). Try again when it's awake, or on the Mac: kitebook approve." }; }
      const wrong = p.answers.some(x => x.wrong), lockedMac = p.answers.find(x => x.locked && !x.wrong);
      if (lockedMac) return { ok: false, status: 429, error: String(lockedMac.error ?? "locked on your Mac") };
      if (!wrong) return { ok: false, status: 400, error: String(p.answers[0].error ?? "not confirmed") };
      kset(d, `remote_pw:wrong:${action}`, JSON.stringify(per + 1));
      const recent = (J(d, "remote_pw:recent", []) as number[]).filter(x => t - x < LOCK_MS).concat(t);
      if (recent.length >= MAX_WRONG) { kset(d, "remote_pw:lock", String(t + LOCK_MS)); kset(d, "remote_pw:recent", null); log(d, { kind: "locked", action, from: a.from ?? null });
        return { ok: false, status: 429, error: `Wrong master password. ${MAX_WRONG} wrong: locked for 15 min (on your Mac: kitebook approve).`, wrong: true }; }
      kset(d, "remote_pw:recent", JSON.stringify(recent)); log(d, { kind: "wrong", action, from: a.from ?? null });
      return { ok: false, status: 401, error: "Wrong master password.", wrong: true };
    } finally { pending.delete(key); }
  },
  // runner side (src/index.ts: only a runner token, an active device): fetch the request once; the password is wiped from here as it goes
  async take(d, a: { id: string; peer: string }) {
    const p = pending.get(`${d.acct}:${String(a.id ?? "")}`); if (!p || !p.targets.includes(a.peer) || p.taken.has(a.peer)) throw new Error("no such request (it expired)");
    p.taken.add(a.peer); const pw = p.password; if (p.taken.size >= p.targets.length) p.password = "";
    return { id: a.id, action: p.action, password: pw };
  },
  async reply(d, a: { id: string; peer: string; ok?: boolean; presence?: string; error?: string; wrong?: boolean; locked?: boolean }) {
    const p = pending.get(`${d.acct}:${String(a.id ?? "")}`); if (!p || !p.taken.has(a.peer)) throw new Error("no such request (it expired)");
    p.answers.push({ ok: a.ok === true && typeof a.presence === "string", ...(typeof a.presence === "string" ? { presence: a.presence.slice(0, 2000) } : {}), error: String(a.error ?? "").slice(0, 300), wrong: a.wrong === true, locked: a.locked === true, peer: a.peer });
    return { ok: true };
  },
};
