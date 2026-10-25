// The master password (client/password.ts + src/devices.ts setPassword/shortcut/resetPassword + client/device.ts presenceAssert), without a
// Durable Object: the Dir side on bun:sqlite (same SQL as client/device.test.ts), the client on the file keystore. KITEBOOK_TEST_PASSWORD
// stands in for a person typing at a terminal (unset = no terminal, like an agent). Run: bun test client/password.test.ts
import { test, expect, beforeAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, existsSync, statSync, readFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { DEVICE_SCHEMA, deviceFns as F } from "../src/devices.ts";

beforeAll(() => { process.env.KITEBOOK_TEST = "1"; process.env.KITEBOOK_KEYSTORE = "file"; process.env.KITEBOOK_PW_DELAY_MS = "60000"; delete process.env.KITEBOOK_DEVICE; delete process.env.KITEBOOK_NO_TTY; });
beforeAll(() => { process.env.HOME = mkdtempSync(join(tmpdir(), "kbpw-")); });
// bun's os.homedir() ignores a HOME set at runtime, so the slots below land in the real ~/.kitebook: clear this file's own slots first, so a
// second run doesn't find the first run's password/device state (other slot names are left alone)
beforeAll(() => { const h = homedir(), k = join(h, ".kitebook", "keys"); for (const n of ["lap6", "mac4", "mac5", "mac6", "own6", "vm6", "s1", "s2"]) {
  rmSync(join(h, ".kitebook", `device-${n}.json`), { force: true }); if (existsSync(k)) for (const f of readdirSync(k)) if (f.startsWith(n + ".")) rmSync(join(k, f), { force: true }); } });
beforeEach(() => { delete process.env.KITEBOOK_PRESENCE; delete process.env.KITEBOOK_TEST_PASSWORD; delete process.env.KITEBOOK_FAKE_PRESENCE; delete process.env.KITEBOOK_PW_KDF; });
function fakeDir(acct = "root") {
  const db = new Database(":memory:"); db.run("create table acct(k text primary key, v text)"); db.run("create table spaces(id text primary key)");
  for (const q of DEVICE_SCHEMA.split(";").map(x => x.trim()).filter(Boolean)) db.run(q);
  return { acct, db, sql: { exec: (q: string, ...a: any[]) => { const st = db.query(q); if (/^\s*select/i.test(q)) { const rows = st.all(...a); return { toArray: () => rows, one: () => rows[0], rowsWritten: 0 }; }
    const r = st.run(...a); return { toArray: () => [], one: () => undefined, rowsWritten: r.changes }; } } } as any;
}
// the runner's start (client/device.ts ensureDevice) against the fake Dir: device_enroll / device_password as src/index.ts routes them
const enroll = async (d: any, name: string) => { const DV = await import("./device.ts");
  return (await DV.ensureDevice({ name, url: "http://x", account: d.acct, log: () => {}, call: async (op: string, a: any) => op === "device_enroll" ? F.enroll(d, { ...a, peer: name, peerKind: "runner" }) : op === "device_password" ? F.setPassword(d, { ...a, peer: name }) : null }))!; };

test("wrap/unwrap: Argon2id (RFC 9106) by default, scrypt fallback recorded in the file; a wrong password unwraps nothing; the file is 0600 and holds no plaintext key", async () => {
  const C = await import("crypto"), P = await import("./password.ts");
  // RFC 9106 test vector: bun's argon2Sync is the real Argon2id
  expect((C as any).argon2Sync("argon2id", { message: Buffer.alloc(32, 1), nonce: Buffer.alloc(16, 2), secret: Buffer.alloc(8, 3), associatedData: Buffer.alloc(12, 4), parallelism: 4, tagLength: 32, memory: 32, passes: 3 }).toString("hex"))
    .toBe("0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659");
  const w = await P.wrapNew("correct horse battery", "terminal"); expect(w.file.kdf).toEqual({ alg: "argon2id", m: 65536, t: 3, p: 1 });
  P.commit("s1", w.file); expect(statSync(P.pwFile("s1")).mode & 0o777).toBe(0o600); expect(P.passwordPub("s1")).toBe(w.pub);
  const priv = P.unwrap(P.readPw("s1")!, "correct horse battery")!; expect(priv).toBeTruthy(); expect(readFileSync(P.pwFile("s1"), "utf8")).not.toContain(priv);
  const K = await import("./keystore.ts"); expect(await K.pubOf(priv)).toBe(w.pub);
  expect(P.unwrap(P.readPw("s1")!, "correct horse batterY")).toBeNull();
  const t = { ...P.readPw("s1")!, pub: (await K.newKey()).pub }; expect(P.unwrap(t, "correct horse battery")).toBeNull(); // the public half is bound in (AAD)
  process.env.KITEBOOK_PW_KDF = "scrypt"; const s = await P.wrapNew("another one here", "terminal"); expect(s.file.kdf.alg).toBe("scrypt"); expect(P.unwrap(s.file, "another one here")).toBeTruthy();
});

test("wrong passwords: three typos free, then growing waits that refuse even the right one; a right one clears the count", async () => {
  const P = await import("./password.ts"); P.commit("s2", (await P.wrapNew("right password 1", "terminal")).file);
  for (let i = 1; i <= 3; i++) expect(() => P.unlock("s2", "nope " + i)).toThrow(/^wrong master password$/);
  expect(() => P.unlock("s2", "nope 4")).toThrow(/4 wrong in a row: the next try waits 60 s/);
  expect(P.waitLeft("s2")).toBeGreaterThan(50_000);
  expect(() => P.unlock("s2", "right password 1")).toThrow(/too many wrong master passwords.*try again in/);
  const f = P.pwFile("s2").replace(".password.json", ".password.fails"); require("fs").writeFileSync(f, JSON.stringify({ n: 4, until: Date.now() - 1 })); // the wait is over
  expect(() => P.unlock("s2", "nope 5")).toThrow(/5 wrong in a row: the next try waits 2 min/); // doubled
  require("fs").writeFileSync(f, JSON.stringify({ n: 5, until: 0 })); expect(P.unlock("s2", "right password 1")).toBeTruthy(); expect(existsSync(f)).toBe(false);
});

test("strength: under 8 characters or a common password is refused; short single-class ones get a hint", async () => {
  const P = await import("./password.ts");
  expect(P.check("short").ok).toBe(false); expect(P.check("password").ok).toBe(false); expect(P.check("12345678").why).toMatch(/common/);
  expect(P.check("abcdefgh")).toEqual({ ok: true, hint: expect.stringMatching(/weak/) }); expect(P.check("cactus river lamp tuesday").hint).toBeUndefined();
  process.env.KITEBOOK_TEST_PASSWORD = "short\nlonger password\nlonger passwerd\nlonger password\nlonger password"; // too short, then a mismatch, then right
  expect(await P.promptNew()).toBe("longer password");
  delete process.env.KITEBOOK_TEST_PASSWORD; expect(P.canPrompt()).toBe(false); expect(await P.promptNew()).toBeNull(); // no terminal: nobody to ask
});

test("no terminal (an agent installs): the device enrolls LOCKED (no presence key at all), nothing can be confirmed, and the first password (the setup link / a terminal) needs no proof", async () => {
  const d = fakeDir(), DV = await import("./device.ts"), P = await import("./password.ts");
  const s = await enroll(d, "mac4"); const v = await F.get(d, s.id!);
  expect(s.state).toBe("active"); expect(v).toMatchObject({ locked: true, presence: false, password: false, shortcut: false }); expect(s.locked).toBe(true);
  expect(await DV.presenceAssert(s, "device_approve:x")).toBeNull();
  expect((await F.gate(d, { action: "device_approve:x", presence: "a.b" })).ok).toBe(false);
  // the setup link is shown in Settings while the device is locked, and only a loopback setup URL is taken
  await expect(F.setupLink(d, { peer: "mac4", url: "https://evil.example/setup-password#t=" + "a".repeat(43), expires: Date.now() + 60_000 })).rejects.toThrow(/127\.0\.0\.1/);
  const url = "http://127.0.0.1:43210/setup-password#t=" + "a".repeat(43); expect((await F.setupLink(d, { peer: "mac4", url, expires: Date.now() + 60_000 })).setup.url).toBe(url);
  // the person types it on the link's page (setLocal -> device_password, no proof: the device had no key)
  const w = await P.wrapNew("set by a person", "setup-link"); const r = await F.setPassword(d, { peer: "mac4", password_key: w.pub, via: "setup-link" }); P.commit(s.slot, w.file);
  expect(r).toMatchObject({ locked: false, password: true, password_via: "setup-link", setup: null });
  process.env.KITEBOOK_TEST_PASSWORD = "set by a person"; const a = await DV.presenceAssert({ ...s, locked: false, password: true }, "device_approve:x");
  expect(a).toBeTruthy(); expect(await F.assert(d, a!, "device_approve:x", "mac4")).toMatchObject({ ok: true, by: "password" });
  // from now on, replacing it needs proof from a key it has (a runner token alone can't swap in its own password key)
  const w2 = await P.wrapNew("agent's own pick", "terminal"); await expect(F.setPassword(d, { peer: "mac4", password_key: w2.pub })).rejects.toThrow(/needs the old one/);
  // and enroll never adds a key to a device that exists (a locked device can't be unlocked by re-enrolling with keys)
  await F.enroll(d, { peer: "mac4", peerKind: "runner", pubkey: v.fingerprint ? (d.db.query("select pubkey from devices").get() as any).pubkey : "", password_key: w2.pub });
  expect((d.db.query("select password_key from devices").get() as any).password_key).toBe(w.pub);
});

test("fallback: a broken Touch ID helper (fake-broken) or a declined one still confirms with the master password; the server accepts either key", async () => {
  const d = fakeDir(), DV = await import("./device.ts"), P = await import("./password.ts"), K = await import("./keystore.ts");
  process.env.KITEBOOK_PRESENCE = "fake-broken"; process.env.KITEBOOK_TEST_PASSWORD = "baseline password";
  P.commit("mac5", (await P.wrapNew("baseline password", "install")).file); // set at install, before the runner's first start
  const s = await enroll(d, "mac5"); const v = await F.get(d, s.id!);
  expect(v).toMatchObject({ shortcut: true, password: true, password_via: "install" }); expect(K.presencePub("mac5")).toBeTruthy();
  const err: string[] = [], w = process.stderr.write; (process.stderr as any).write = (x: string) => { err.push(String(x)); return true; };
  let a: string | null; try { a = await DV.presenceAssert(s, "join_approve:ABCD-EFGH"); } finally { (process.stderr as any).write = w; }
  expect(a).toBeTruthy(); expect(err.join("")).toMatch(/fake-broken didn't confirm: the Touch ID helper crashed.*master password instead/);
  expect(await F.assert(d, a!, "join_approve:ABCD-EFGH", "mac5")).toMatchObject({ ok: true, by: "password" });
  // a working shortcut that the human declines falls back too; one that says yes signs with the shortcut key (no password asked)
  process.env.KITEBOOK_PRESENCE = "fake"; process.env.KITEBOOK_FAKE_PRESENCE = "no"; process.env.KITEBOOK_TEST_PASSWORD = "baseline password";
  expect(await F.assert(d, (await DV.presenceAssert(s, "act:1"))!, "act:1", "mac5")).toMatchObject({ ok: true, by: "password" });
  process.env.KITEBOOK_FAKE_PRESENCE = "yes"; delete process.env.KITEBOOK_TEST_PASSWORD;
  expect(await F.assert(d, (await DV.presenceAssert(s, "act:2"))!, "act:2", "mac5")).toMatchObject({ ok: true, by: "shortcut" });
  // a wrong password: nothing signed
  process.env.KITEBOOK_FAKE_PRESENCE = "no"; process.env.KITEBOOK_TEST_PASSWORD = "wrong one\nwrong two\nwrong three"; expect(await DV.presenceAssert(s, "act:3")).toBeNull();
  // The legacy OS-password Keychain backend must not run before the Kitebook password.
  process.env.KITEBOOK_PRESENCE = "keychain-acl"; process.env.KITEBOOK_TEST_PASSWORD = "baseline password";
  expect(await F.assert(d, (await DV.presenceAssert(s, "act:4"))!, "act:4", "mac5")).toMatchObject({ ok: true, by: "password" });
});

test("change, reset, shortcut: change needs the old key's signature; a reset (server shell / another device) opens 15 minutes without it; the shortcut needs the password, off is free", async () => {
  const d = fakeDir(), DV = await import("./device.ts"), P = await import("./password.ts"), K = await import("./keystore.ts");
  P.commit("mac6", (await P.wrapNew("old password 1", "install")).file); const s = await enroll(d, "mac6");
  const nk = await K.newKey(); process.env.KITEBOOK_TEST_PASSWORD = "old password 1";
  const a = await DV.presenceAssert(s, `device_password:${nk.pub.slice(5, 21)}`); expect(a).toBeTruthy();
  await expect(F.setPassword(d, { peer: "mac6", password_key: nk.pub, presence: await DV.presenceAssert(s, "device_password:wrong") })).rejects.toThrow(/presence refused/);
  expect(await F.setPassword(d, { peer: "mac6", password_key: nk.pub, via: "change", presence: a })).toMatchObject({ password: true, password_via: "change" });
  // forgotten: the shell resets it; the device sets a new one without proof for 15 minutes, then the window closes
  const r = await F.resetPassword(d, s.id!); expect(r).toMatchObject({ password: false, locked: true }); expect(r.reset_until).toBeGreaterThan(Date.now() + 14 * 60_000);
  const k3 = await K.newKey(); expect(await F.setPassword(d, { peer: "mac6", password_key: k3.pub, via: "terminal" })).toMatchObject({ password: true, password_via: "terminal (after reset)", password_reset: null });
  await F.resetPassword(d, s.id!); d.db.run("update devices set pw_reset=?", Date.now() - 1);
  expect(await F.setPassword(d, { peer: "mac6", password_key: (await K.newKey()).pub })).toMatchObject({ password: true }); // no key left at all: locked, so its first key needs no proof (like a fresh install)
  // shortcut: refused without a master password; with one, on needs a signature by it; off needs nothing
  const d2 = fakeDir(); const s2 = await enroll(d2, "lap6"); const sc = await K.newKey();
  await expect(F.shortcut(d2, { peer: "lap6", on: true, presence_key: sc.pub, presence: "x.y" })).rejects.toThrow(/master password on this computer first/);
  P.commit("lap6", (await P.wrapNew("laptop password", "terminal")).file); await F.setPassword(d2, { peer: "lap6", password_key: P.passwordPub("lap6")! });
  process.env.KITEBOOK_TEST_PASSWORD = "laptop password";
  const on = await DV.assertWith(s2, `device_shortcut:${sc.pub.slice(5, 21)}`, m => P.passwordSign("lap6", m, "turn on the shortcut"));
  expect(await F.shortcut(d2, { peer: "lap6", on: true, presence_key: sc.pub, presence: on })).toMatchObject({ shortcut: true, password: true });
  // a reset keeps the shortcut (it still confirms meanwhile); once the 15 minutes are over, a new password needs the shortcut's signature
  await F.resetPassword(d2, s2.id!); d2.db.run("update devices set pw_reset=?", Date.now() - 1);
  await expect(F.setPassword(d2, { peer: "lap6", password_key: (await K.newKey()).pub })).rejects.toThrow(/needs the old one/);
  expect(await F.shortcut(d2, { peer: "lap6", on: false })).toMatchObject({ shortcut: false, password: false, locked: true }); // off is never gated, even when it leaves the device locked
  // a computer that joined without a password (a cloud VM) can't give itself one: its runner token alone would make it an approver.
  // The owner allows it from another device (the same 15-minute window), then it can.
  const d3 = fakeDir(); await enroll(d3, "own6"); const vm = await enroll(d3, "vm6"); expect(vm.state).toBe("pending");
  await expect(F.setPassword(d3, { peer: "vm6", password_key: (await K.newKey()).pub })).rejects.toThrow(/joined without a master password, so it can't give itself one/);
  await F.approve(d3, vm.id!); await expect(F.setPassword(d3, { peer: "vm6", password_key: (await K.newKey()).pub })).rejects.toThrow(/can't give itself one/);
  await F.resetPassword(d3, vm.id!); expect(await F.setPassword(d3, { peer: "vm6", password_key: (await K.newKey()).pub })).toMatchObject({ password: true, via: "join" });
});
