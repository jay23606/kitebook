// Join + remote claim (src/join.ts, src/claim.ts) without a Durable Object: the Dir side on bun:sqlite (same SQL), keys from the file
// keystore (KITEBOOK_TEST). Run: bun test client/join.test.ts
import { test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DEVICE_SCHEMA, verifyP256 } from "../src/devices.ts";
import { JOIN_SCHEMA, joinFns as J, normCode, JOIN_CODE_RE } from "../src/join.ts";
import { serverShellClaim, claimBootstrap, setClaimBootstrap } from "../src/claim.ts";

beforeAll(() => { process.env.HOME = mkdtempSync(join(tmpdir(), "kbjoin-")); process.env.KITEBOOK_TEST = "1"; process.env.KITEBOOK_KEYSTORE = "file"; process.env.KITEBOOK_PRESENCE = "fake"; });
function fakeDir(o: { owner?: boolean; spaces?: boolean; ttl?: string } = {}) {
  const db = new Database(":memory:"); db.run("create table acct(k text primary key, v text)"); db.run("create table spaces(id text primary key)");
  db.run("create table peers(id text primary key, name text unique, kind text, token_hash text, revoked integer default 0)"); db.run("create table caps(peer text, space text, verbs text, paths text)");
  db.run("create table oauth_rate(k text, win integer, n integer, primary key(k, win))");
  for (const q of (DEVICE_SCHEMA + JOIN_SCHEMA).split(";").map(x => x.trim()).filter(Boolean)) db.run(q);
  if (o.owner) db.run("insert into acct values('devices:ever:owner','1')"); if (o.spaces) db.run("insert into spaces values('main')");
  let n = 0;
  return { acct: "root", db, env: { JOIN_TTL: o.ttl ?? "600", OAUTH_INTERVAL: "1" },
    sql: { exec: (q: string, ...a: any[]) => { const st = db.query(q); if (/^\s*select/i.test(q) || /returning/i.test(q)) { const rows = st.all(...a) as any[]; return { toArray: () => rows, one: () => rows[0] }; } st.run(...a); return { toArray: () => [], one: () => undefined }; } },
    async ensureMain() { db.run("insert or ignore into spaces values('main')"); },
    async admin(cmd: string, a: any) { if (cmd === "peer") { db.query("insert into peers(id,name,kind,token_hash) values(?,?,?,?)").run("p" + ++n, a.name, a.kind, "h"); return { token: "rk_test" + n }; }
      if (cmd === "grant") { db.query("insert into caps values(?,?,?,?)").run(a.peer, a.space, JSON.stringify(a.verbs), JSON.stringify(a.paths)); return {}; } throw new Error("admin " + cmd); } } as any;
}
const machine = async (slot: string) => { const K = await import("./keystore.ts"), dk = await K.deviceKey(slot); return { dk, pp: await K.presenceBackend().create(slot) }; };
const poll = async (d: any, m: any, dc: string, other?: any) => J.poll(d, dc, await (other ?? m).dk.sign(`kitebook-join:v1.${dc}`));

test("join: needs an owner device; code + phishing info; device-key-signed poll gets the runner token once; device active and bound", async () => {
  const m = await machine("vm1"), base = { kind: "join", name: "vm1", os: "Linux 6.1", pubkey: m.dk.pub, presence_key: m.pp, ip: "203.0.113.9", loc: "Frankfurt, HE, DE" };
  await expect(J.start(fakeDir(), base)).rejects.toThrow(/no owner device/);
  const d = fakeDir({ owner: true }), s = await J.start(d, base);
  expect(s.user_code).toMatch(JOIN_CODE_RE); expect(s.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/); expect(s.expires_in).toBe(600); expect(s.device_code).toMatch(/^kjd_/);
  const v = await J.show(d, s.user_code.toLowerCase().replace("-", ""));
  expect(v).toMatchObject({ name: "vm1", os: "Linux 6.1", ip: "203.0.113.9", location: "Frankfurt, HE, DE" }); expect(v.warning).toMatch(/If someone sent you this code/);
  expect((await poll(d, m, s.device_code)).state).toBe("pending");
  const r = await J.decide(d, s.user_code, true, "mac"); expect(r).toMatchObject({ name: "vm1", ip: "203.0.113.9" });
  const dev = d.db.query("select * from devices where id=?").get(r.device) as any; expect(dev).toMatchObject({ state: "active", peer: "vm1", via: "join", pubkey: m.dk.pub, presence_key: m.pp, revoked: 0 });
  expect((await poll(d, m, s.device_code, await machine("thief"))).state).toBe("bad_signature"); // a leaked device code alone gets nothing
  const ok = await poll(d, m, s.device_code); expect(ok.state).toBe("approved"); expect(ok.result).toMatchObject({ name: "vm1", token: "rk_test1", space: "main", device: r.device, owner: false });
  expect(ok.result.verbs).toContain("dispatch"); expect(ok.result.paths).toEqual(["tasks/**", "shared/**", "repos/**", "kb/**"]);
  expect((await poll(d, m, s.device_code)).state).toBe("used"); expect((d.db.query("select result from device_joins").get() as any).result).toBeNull(); // wiped
  await expect(J.decide(d, s.user_code, true, "mac")).rejects.toThrow(/already approved/);
  await expect(J.start(d, { ...base })).rejects.toThrow(/taken/); // the name is a peer now
  await expect(J.start(d, { ...base, name: "vm1b" })).rejects.toThrow(/already registered/); // and the key a device
});
test("join: deny, wrong code, expiry after JOIN_TTL", async () => {
  const d = fakeDir({ owner: true, ttl: "0.3" }), m = await machine("vm2"), s = await J.start(d, { kind: "join", name: "vm2", pubkey: m.dk.pub });
  await expect(J.decide(d, "BBBB-CCCC", true, "mac")).rejects.toThrow(/no machine waits with code BBBB-CCCC/);
  await J.decide(d, s.user_code, false, "mac"); expect((await poll(d, m, s.device_code)).state).toBe("denied");
  await expect(J.decide(d, s.user_code, true, "mac")).rejects.toThrow(/already denied/);
  const m3 = await machine("vm3"), s3 = await J.start(d, { kind: "join", name: "vm3", pubkey: m3.dk.pub }); await Bun.sleep(400);
  expect((await poll(d, m3, s3.device_code)).state).toBe("expired"); await expect(J.decide(d, s3.user_code, true, "mac")).rejects.toThrow(/expired/);
  expect(await J.pending(d)).toEqual([]); expect(d.db.query("select count(*) n from peers").get()).toEqual({ n: 0 });
});
test("claim: unclaimed -> code -> server shell approves -> owner device, closed for good; second claim refused; reset reopens", async () => {
  const d = fakeDir(), lap = await machine("laptop");
  expect(await J.claimState(d)).toMatchObject({ claimed: false, open: true });
  const s = await J.claimStart(d, { name: "laptop", os: "macOS 15", pubkey: lap.dk.pub, presence_key: lap.pp, ip: "198.51.100.4" }, null);
  expect((await J.pending(d, "claim"))[0]).toMatchObject({ code: s.user_code, name: "laptop", ip: "198.51.100.4" });
  await expect(J.decide(d, "ZZZZ-ZZZZ", true, "server shell", "claim")).rejects.toThrow(/no claim waits/);
  await expect(J.decide(d, s.user_code, true, "server shell")).rejects.toThrow(/no machine waits/); // a claim code isn't a join code
  const r = await J.decide(d, s.user_code, true, "server shell", "claim");
  expect(await J.claimState(d)).toMatchObject({ claimed: true, open: false, owner: { device: r.device } });
  expect((await poll(d, lap, s.device_code)).result).toMatchObject({ owner: true, name: "laptop" });
  expect(d.db.query("select v from acct where k='devices:ever:owner'").get()).toEqual({ v: "1" }); // the presence gate is on from here
  const evil = await machine("evil"); await expect(J.claimStart(d, { name: "evil", pubkey: evil.dk.pub }, null)).rejects.toThrow(/already has its owner/);
  expect((await J.claimReset(d)).devices.map((x: any) => x.name)).toEqual(["laptop"]);
  const s2 = await J.claimStart(d, { name: "laptop2", pubkey: (await machine("laptop2")).dk.pub }, null); await J.decide(d, s2.user_code, true, "server shell", "claim");
  expect((await J.claimState(d)).open).toBe(false);
});
test("claim: KITEBOOK_OWNER_CLAIM approves at once and burns; wrong secret refused; an existing server counts as claimed", async () => {
  const d = fakeDir(), SEC = "s3cret-deploy-value-0123456789";
  await expect(J.claimStart(d, { name: "a1", pubkey: (await machine("a1")).dk.pub, secret: "nope-nope-nope-nope" }, SEC)).rejects.toThrow(/wrong/);
  await expect(J.claimStart(d, { name: "a1", pubkey: (await machine("a1")).dk.pub, secret: SEC }, null)).rejects.toThrow(/no KITEBOOK_OWNER_CLAIM/);
  const a = await machine("a2"), r = await J.claimStart(d, { name: "a2", pubkey: a.dk.pub, secret: SEC }, SEC); expect(r.approved).toBe(true);
  expect((await poll(d, a, r.device_code)).state).toBe("approved"); expect((await J.claimState(d)).open).toBe(false);
  await J.claimReset(d); await expect(J.claimStart(d, { name: "a3", pubkey: (await machine("a3")).dk.pub, secret: SEC }, SEC)).rejects.toThrow(/already used/);
  const old = fakeDir({ spaces: true }); expect(await J.claimState(old)).toMatchObject({ claimed: true, open: false }); // turning claim mode on never locks an existing server
});
test("ClaimBootstrap: opt-in (KITEBOOK_CLAIM=1 or a 16+ char secret), swappable", () => {
  expect(serverShellClaim.unclaimedGate({})).toBe(false); expect(serverShellClaim.unclaimedGate({ KITEBOOK_CLAIM: "1" })).toBe(true);
  expect(serverShellClaim.unclaimedGate({ OWNER_CLAIM: "short" })).toBe(false); expect(serverShellClaim.unclaimedGate({ KITEBOOK_OWNER_CLAIM: "x".repeat(16) })).toBe(true);
  const hosted = { name: "signup", unclaimedGate: () => false, secret: () => null }; setClaimBootstrap(hosted); expect(claimBootstrap().name).toBe("signup"); setClaimBootstrap(serverShellClaim);
  expect(normCode("bcdf ghjk")).toBe("BCDF-GHJK");
});
test("poll signature domain: a join-poll signature never verifies as an open token", async () => {
  const m = await machine("vm9"), sig = await m.dk.sign("kitebook-join:v1.kjd_x"); expect(await verifyP256(m.dk.pub, sig, "kitebook-open:v1.kjd_x")).toBe(false);
});
