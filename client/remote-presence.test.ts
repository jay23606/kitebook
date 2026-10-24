// Approve from another device with the master password (phone-approve): the runner's check (client/remote-presence.ts) and the server's
// relay (src/remote-pw.ts) without a Durable Object: the Dir on bun:sqlite, the runner on the file keystore. Run: bun test client/remote-presence.test.ts
import { test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { RemoteLimiter, remoteAnswer, MAX_WRONG, LOCK_MS, REMOTE_ACTION } from "./remote-presence.ts";
import { remotePwFns as R } from "../src/remote-pw.ts";
import { DEVICE_SCHEMA, verifyP256, parseSigned, PRESENCE_DOMAIN } from "../src/devices.ts";

beforeAll(() => { process.env.KITEBOOK_TEST = "1"; process.env.KITEBOOK_KEYSTORE = "file"; process.env.KITEBOOK_PW_DELAY_MS = "60000"; process.env.HOME = mkdtempSync(join(tmpdir(), "kbrp-"));
  const k = join(homedir(), ".kitebook", "keys"); if (existsSync(k)) for (const f of readdirSync(k)) if (f.startsWith("rp1.")) rmSync(join(k, f), { force: true }); });

const PW = "phone typed password 9";
async function setup() { const P = await import("./password.ts"), DV = await import("./device.ts"), { signWith } = await import("./keystore.ts");
  P.forget("rp1"); const w = await P.wrapNew(PW, "terminal"); P.commit("rp1", w.file);
  const s: any = { slot: "rp1", id: "dv_rp1", account: "root", state: "active" };
  return { pub: w.pub, opts: (lim: RemoteLimiter, audit: any[] = [], enabled = true) => ({ enabled, hasPassword: P.hasPassword("rp1"), limiter: lim, audit: (e: any) => audit.push(e),
    assert: (a: string, sign: (m: string) => Promise<string | null>) => DV.assertWith(s, a, sign), unlockSign: async (pw: string, m: string) => await signWith(P.unlock("rp1", pw), m) }) };
}

test("runner: the right password signs exactly that action (the server's normal presence check verifies it); wrong ones don't; the password isn't kept", async () => {
  const { pub, opts } = await setup(), audit: any[] = [], lim = new RemoteLimiter();
  const r = await remoteAnswer({ action: "device_grant:BCDF-GHJK", password: PW }, opts(lim, audit)); expect(r.ok).toBe(true);
  const s = parseSigned((r as any).presence)!; expect(s.p.act).toBe("device_grant:BCDF-GHJK"); expect(s.p.d).toBe("dv_rp1");
  expect(await verifyP256(pub, s.sig, `${PRESENCE_DOMAIN}.${s.raw}`)).toBe(true);
  const w = await remoteAnswer({ action: "device_grant:BCDF-GHJK", password: "not it" }, opts(lim, audit)); expect(w).toMatchObject({ ok: false, wrong: true, error: "wrong master password" });
  expect(JSON.stringify(audit)).not.toContain(PW); expect(JSON.stringify(audit)).not.toContain("not it");
  (await import("./password.ts")).forget("rp1"); // unlock()'s own fail counter: start clean for the next test
});

test("runner: only the owner's approvals that take the password (pairing code, presence confirmation); the off switch in runner.json", async () => {
  const { opts } = await setup(), lim = new RemoteLimiter(), audit: any[] = [];
  expect(REMOTE_ACTION.test("confirm:BCDFGH")).toBe(true); expect(REMOTE_ACTION.test("device_password:abc")).toBe(false);
  for (const a of ["device_password:abcd", "device_shortcut:x", "app_add:evil", "confirm:BCDFGH\n", "device_grant:bcdf-ghjk"]) {
    const r = await remoteAnswer({ action: a, password: PW }, opts(lim, audit)); expect(r.ok).toBe(false); expect((r as any).error).toMatch(/^refused/); }
  expect(audit.every(e => e.type === "remote_password_refused")).toBe(true);
  const off = await remoteAnswer({ action: "confirm:BCDFGH", password: PW }, opts(lim, [], false)); expect(off.ok).toBe(false); expect((off as any).error).toMatch(/remotePassword/);
});

test("rate limit: 5 wrong for one code end that code; 5 wrong in 15 min lock remote approval for 15 min (audited); a right one clears its code", () => {
  let t = 1_000_000; const lim = new RemoteLimiter(() => t);
  for (let i = 0; i < MAX_WRONG - 1; i++) { expect(lim.check("confirm:AAAAAA")).toBeNull(); expect(lim.wrong("confirm:AAAAAA")).toBe(false); t += 1000; }
  lim.right("confirm:AAAAAA"); expect(lim.byCode.has("confirm:AAAAAA")).toBe(false); expect(lim.check("confirm:AAAAAA")).toBeNull();
  expect(lim.wrong("confirm:BBBBBB")).toBe(true); // the 5th wrong within 15 minutes, any code
  expect(lim.check("device_grant:BCDF-GHJK")).toMatch(/locked for 15 min/);
  t += LOCK_MS + 1; expect(lim.check("device_grant:BCDF-GHJK")).toBeNull();
  const l2 = new RemoteLimiter(() => t); for (let i = 0; i < MAX_WRONG; i++) { l2.wrong("confirm:CCCCCC"); t += 4 * 60_000; } // spread out: no global lock
  expect(l2.until).toBe(0); expect(l2.check("confirm:CCCCCC")).toMatch(/can't be approved with a password/); expect(l2.check("confirm:DDDDDD")).toBeNull();
});

test("runner: a lock answers without even trying the password, and is audited as remote_password_locked", async () => {
  const { opts } = await setup(), audit: any[] = []; let t = 5_000_000; const lim = new RemoteLimiter(() => t);
  for (let i = 0; i < MAX_WRONG - 1; i++) lim.wrong("confirm:EEEEEE");
  // unlock()'s own growing waits would also stop it; take them out of the way so the limiter decides
  const o = { ...opts(lim, audit), unlockSign: async () => { throw new Error("wrong master password"); } };
  const r = await remoteAnswer({ action: "confirm:FFFFFF", password: "x" }, o); expect(r).toMatchObject({ ok: false, wrong: true, locked: true });
  expect(audit.at(-1).type).toBe("remote_password_locked");
  let tried = false; const r2 = await remoteAnswer({ action: "confirm:GGGGGG", password: PW }, { ...o, unlockSign: async () => { tried = true; return ""; } });
  expect(r2).toMatchObject({ ok: false, locked: true }); expect(tried).toBe(false);
});

// ---- the server relay (src/remote-pw.ts) ----
function fakeDir(online = true) {
  const db = new Database(":memory:"); db.run("create table acct(k text primary key, v text)");
  db.run("create table peers(id text primary key, name text unique, kind text, token_hash text, webhook text, created text, revoked integer default 0)"); db.run("create table caps(peer_id text, space_id text, verbs text, paths text)");
  for (const q of DEVICE_SCHEMA.split(";").map(x => x.trim()).filter(Boolean)) db.run(q);
  db.run("insert into devices(id, name, pubkey, password_key, peer, state, created) values('dv1','mac','p256:a','p256:b','mac','active',1)");
  db.run("insert into peers(id, name, kind) values('p1','mac','runner')"); db.run("insert into caps values('p1','main','[]','[]')");
  const asked: any[] = [];
  const d: any = { acct: "root", asked, space: (s: string) => ({ remotePresence: async (id: string, target: string) => { asked.push({ s, id, target }); return { online }; } }),
    sql: { exec: (q: string, ...a: any[]) => { const st = db.query(q); if (/^\s*select/i.test(q)) { const rows = st.all(...a); return { toArray: () => rows, one: () => rows[0] }; } st.run(...a); return { toArray: () => [], one: () => undefined }; } } };
  return d;
}
const runner = (d: any, answer: (q: any) => any) => { const iv = setInterval(async () => { const a = d.asked.shift(); if (!a) return; const q = await R.take(d, { id: a.id, peer: a.target }); await R.reply(d, { id: a.id, peer: a.target, ...answer(q) }); }, 20); return () => clearInterval(iv); };

test("server: relays the password to the Mac's runner once, takes its assertion back; never stores the password", async () => {
  const d = fakeDir(); let seen = ""; const stop = runner(d, q => { seen = q.password; return { ok: true, presence: "signed-assertion" }; });
  const r = await R.ask(d, { action: "device_grant:BCDF-GHJK", password: PW }); stop();
  expect(r).toMatchObject({ ok: true, presence: "signed-assertion", peer: "mac" }); expect(seen).toBe(PW);
  const all = JSON.stringify(d.sql.exec("select * from acct").toArray()); expect(all).not.toContain(PW);
  await expect(R.take(d, { id: "nope", peer: "mac" })).rejects.toThrow(/expired/);
});

test("server: Mac offline -> 503 with a plain message; switch off -> 403; 5 wrong -> locked for 15 min (429), logged", async () => {
  expect(await R.ask(fakeDir(false), { action: "confirm:BCDFGH", password: PW })).toMatchObject({ ok: false, status: 503, error: expect.stringMatching(/didn't answer/) });
  const d = fakeDir(); await R.set(d, { on: false }); expect((await R.setting(d)).on).toBe(false);
  expect(await R.ask(d, { action: "confirm:BCDFGH", password: PW })).toMatchObject({ ok: false, status: 403 }); await R.set(d, { on: true });
  const stop = runner(d, () => ({ ok: false, wrong: true, error: "wrong master password" }));
  for (let i = 0; i < MAX_WRONG - 1; i++) expect(await R.ask(d, { action: `confirm:BCDFG${"HJKLM"[i]}`, password: "bad" })).toMatchObject({ ok: false, status: 401, wrong: true });
  expect(await R.ask(d, { action: "confirm:BCDFGZ", password: "bad" })).toMatchObject({ ok: false, status: 429 }); stop();
  const st = await R.setting(d); expect(st.locked_until).toBeGreaterThan(Date.now()); expect(st.log[0].kind).toBe("locked");
  expect(await R.ask(d, { action: "confirm:BCDFGX", password: PW })).toMatchObject({ ok: false, status: 429 });
  expect(JSON.stringify(d.sql.exec("select * from acct").toArray())).not.toContain("bad\"");
});
