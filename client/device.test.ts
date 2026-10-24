// Device identity (src/devices.ts + client/keystore.ts + client/device.ts) without a Durable Object: the Dir side runs on bun:sqlite (same
// SQL), the client side on the file keystore and the fake presence backend (KITEBOOK_TEST). Run: bun test client/device.test.ts
import { test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DEVICE_SCHEMA, deviceFns as F, verifyP256 } from "../src/devices.ts";
import { firstRunnerClaim, setClaimStrategy, claimStrategy } from "../src/principal.ts";

beforeAll(() => { process.env.HOME = mkdtempSync(join(tmpdir(), "kbdev-")); process.env.KITEBOOK_TEST = "1"; process.env.KITEBOOK_KEYSTORE = "file"; process.env.KITEBOOK_PRESENCE = "fake"; });
function fakeDir(acct = "root") {
  const db = new Database(":memory:"); db.run("create table acct(k text primary key, v text)"); db.run("create table spaces(id text primary key)");
  for (const q of DEVICE_SCHEMA.split(";").map(x => x.trim()).filter(Boolean)) db.run(q);
  return { acct, db, sql: { exec: (q: string, ...a: any[]) => { const st = db.query(q); if (/^\s*select/i.test(q)) { const rows = st.all(...a); return { toArray: () => rows, one: () => rows[0], rowsWritten: 0 }; }
    const r = st.run(...a); return { toArray: () => [], one: () => undefined, rowsWritten: r.changes }; } } } as any;
}
async function client(name: string, acct = "root") {
  const K = await import("./keystore.ts"), dk = await K.deviceKey(name), pp = await K.presenceBackend().create(name);
  return { name, dk, pp, acct };
}

test("keys: file store 0600, same key on reload, raw r||s signatures the server verifies; open/presence domains don't cross", async () => {
  const K = await import("./keystore.ts"), a = await K.deviceKey("t1"), b = await K.deviceKey("t1");
  expect(a.pub).toBe(b.pub); expect(a.pub).toMatch(/^p256:[A-Za-z0-9_-]{87}$/); expect(a.store).toBe("file");
  const { statSync } = await import("fs"); expect(statSync(join(K.keyDir(), "t1.device.key")).mode & 0o777).toBe(0o600);
  const sig = await a.sign("kitebook-open:v1.abc"); expect(await verifyP256(a.pub, sig, "kitebook-open:v1.abc")).toBe(true);
  expect(await verifyP256(a.pub, sig, "kitebook-presence:v1.abc")).toBe(false);
});
test("keys: a secure store that can't save falls back to the 0600 file once, and later starts keep that same key", async () => {
  const K = await import("./keystore.ts"), was = process.env.KITEBOOK_KEYSTORE, path = process.env.PATH;
  process.env.KITEBOOK_KEYSTORE = "secret-service"; process.env.PATH = "/nonexistent"; // no secret-tool: load finds nothing, save throws
  try { const a = await K.deviceKey("t9"), b = await K.deviceKey("t9"); expect(a.store).toBe("file"); expect(b.store).toBe("file"); expect(b.pub).toBe(a.pub); }
  finally { process.env.KITEBOOK_KEYSTORE = was; process.env.PATH = path; if (was === undefined) delete process.env.KITEBOOK_KEYSTORE; }
});
test("fake presence: signs only with KITEBOOK_FAKE_PRESENCE=yes; refuses to exist outside tests", async () => {
  const K = await import("./keystore.ts"), p = K.presenceBackend(); await p.create("t2");
  process.env.KITEBOOK_FAKE_PRESENCE = "no"; expect(await p.sign("t2", "m", "r")).toBeNull();
  process.env.KITEBOOK_FAKE_PRESENCE = "yes"; expect(await p.sign("t2", "m", "r")).toMatch(/^[A-Za-z0-9_-]{86}$/);
  delete process.env.KITEBOOK_TEST; expect(() => K.presenceBackend()).toThrow(/tests/); process.env.KITEBOOK_TEST = "1";
});
test("enroll: first runner = owner #1 (migration), heartbeat keeps it, a second machine waits, agents can't claim; gate sticks", async () => {
  const d = fakeDir(); d.db.run("insert into spaces values('main')");
  const mac = await client("mac"), other = await client("pc");
  expect(await F.enforced(d)).toBe(false); expect((await F.gate(d, { action: "x" })).ok).toBe(true); // before enrolling: nothing changes
  const r1 = await F.enroll(d, { peer: "mac", peerKind: "runner", name: "Mac", os: "macOS", pubkey: mac.dk.pub, presence_key: mac.pp });
  expect(r1.state).toBe("active"); expect(r1.via).toBe("migrated"); expect(await F.enforced(d)).toBe(true);
  expect((await F.enroll(d, { peer: "mac", peerKind: "runner", pubkey: mac.dk.pub })).id).toBe(r1.id);
  const r2 = await F.enroll(d, { peer: "pc", peerKind: "runner", pubkey: other.dk.pub, presence_key: other.pp }); expect(r2.state).toBe("pending");
  await expect(F.enroll(d, { peer: "evil", peerKind: "runner", pubkey: mac.dk.pub })).rejects.toThrow(/another machine/);
  const e = fakeDir("x"), ag = await client("agent"); expect((await F.enroll(e, { peer: "pi", peerKind: "coding_agent", pubkey: ag.dk.pub })).state).toBe("pending");
  await F.revoke(d, r1.id); expect(await F.enforced(d)).toBe(true); // revoking every device never turns the gate off
  const again = await client("mac2"); expect((await F.enroll(d, { peer: "mac2", peerKind: "runner", pubkey: again.dk.pub })).state).toBe("pending");
});
test("claim strategy is pluggable (a hosted module swaps the bootstrap)", async () => {
  const d = fakeDir(), c = await client("h1"); setClaimStrategy({ name: "never", decide: () => "pending" });
  try { expect((await F.enroll(d, { peer: "h1", peerKind: "runner", pubkey: c.dk.pub })).state).toBe("pending"); } finally { setClaimStrategy(firstRunnerClaim); }
  expect(claimStrategy().name).toBe("first-runner");
});
test("open token: single use, 60 s, bound to the device and the CLI nonce; revoked device and session die", async () => {
  const d = fakeDir(), c = await client("o1"); const r = await F.enroll(d, { peer: "o1", peerKind: "runner", pubkey: c.dk.pub, presence_key: c.pp });
  const DV = await import("./device.ts"), st: any = { slot: "o1", account: "root", id: r.id, state: "active" }, nonce = "n".repeat(32), nh = await DV.sha256hex(nonce);
  const t = await DV.openToken(st, nh);
  expect((await F.openUse(d, t, "wrong-nonce-wrong-nonce")).state).toBe("nonce");
  expect((await F.openUse(d, t, nonce)).state).toBe("used"); // a wrong nonce burned it
  const t2 = await DV.openToken(st, nh); expect((await F.openUse(d, t2, nonce)).state).toBe("ok"); expect((await F.openUse(d, t2, nonce)).state).toBe("used");
  const tamper = t2.replace(/^[^.]+/, Buffer.from(JSON.stringify({ v: 1, k: "open", a: "root", d: r.id, j: "x".repeat(20), e: Date.now() + 50_000, n: nh })).toString("base64url"));
  expect((await F.openUse(d, tamper, nonce)).state).toBe("bad");
  const enc = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url"), old = enc({ v: 1, k: "open", a: "root", d: r.id, j: "y".repeat(20), e: Date.now() - 1000, n: nh });
  expect((await F.openUse(d, `${old}.${await c.dk.sign(`kitebook-open:v1.${old}`)}`, nonce)).state).toBe("expired");
  const long = enc({ v: 1, k: "open", a: "root", d: r.id, j: "z".repeat(20), e: Date.now() + 3600_000, n: nh });
  expect((await F.openUse(d, `${long}.${await c.dk.sign(`kitebook-open:v1.${long}`)}`, nonce)).state).toBe("bad"); // never longer than 60 s
  const other = enc({ v: 1, k: "open", a: "acme", d: r.id, j: "w".repeat(20), e: Date.now() + 50_000, n: nh });
  expect((await F.openUse(d, `${other}.${await c.dk.sign(`kitebook-open:v1.${other}`)}`, nonce)).state).toBe("bad"); // another account's token
  const s = await F.sessNew(d, r.id, "ua", null); expect((await F.sessGet(d, s.secret))?.device).toBe(r.id);
  await F.revoke(d, r.id); expect(await F.sessGet(d, s.secret)).toBeNull();
  expect((await F.openUse(d, await DV.openToken(st, nh), nonce)).state).toBe("device");
});
test("presence: exact action, single use, presence key only (not the device key), 5-minute window per asking session", async () => {
  const d = fakeDir(), c = await client("p1"); const r = await F.enroll(d, { peer: "p1", peerKind: "runner", pubkey: c.dk.pub, presence_key: c.pp });
  const DV = await import("./device.ts"), st: any = { slot: "p1", account: "root", id: r.id, state: "active" };
  process.env.KITEBOOK_FAKE_PRESENCE = "no"; expect(await DV.presenceAssert(st, "device_approve:x")).toBeNull();
  process.env.KITEBOOK_FAKE_PRESENCE = "yes"; const a = (await DV.presenceAssert(st, "device_approve:x"))!;
  expect((await F.gate(d, { action: "device_approve:y", presence: a, peer: "p1" })).ok).toBe(false);
  expect((await F.gate(d, { action: "device_approve:x", presence: a, peer: "other" })).ok).toBe(false);
  expect((await F.gate(d, { action: "device_approve:x", presence: a, peer: "p1" })).ok).toBe(true);
  expect((await F.gate(d, { action: "device_approve:x", presence: a, peer: "p1" })).ok).toBe(false); // replay
  const raw = a.split(".")[0];
  expect((await F.assert(d, `${raw}.${await c.dk.sign(`kitebook-presence:v1.${raw}`)}`, "device_approve:x")).ok).toBe(false); // the device key can't stand in
  expect((await F.gate(d, { action: "policy_set", cred: "sess1" })).need).toBe(true);
  const q = await F.ask(d, { cred: "sess1", action: "policy_set" });
  const ca = (await DV.presenceAssert(st, `confirm:${q.code}`))!; await F.confirm(d, { code: q.code, presence: ca, peer: "p1" });
  expect((await F.askState(d, "sess1", q.id)).state).toBe("confirmed");
  expect((await F.gate(d, { action: "policy_set", cred: "sess1" })).ok).toBe(true); expect((await F.gate(d, { action: "policy_set", cred: "sess2" })).ok).toBe(false);
  await expect(F.confirm(d, { code: q.code, presence: (await DV.presenceAssert(st, `confirm:${q.code}`))!, peer: "p1" })).rejects.toThrow(/nothing waits/);
  await F.revoke(d, r.id); expect((await F.gate(d, { action: "policy_set", cred: "sess1" })).ok).toBe(false); // the window dies with the device
});
