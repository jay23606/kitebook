// A phone's passkey as an approval device (src/passkey.ts) against a software authenticator (scripts/passkey-sim.ts), the Dir on bun:sqlite.
// Run: bun test client/passkey.test.ts
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { passkeyFns as P, derToRaw } from "../src/passkey.ts";
import { DEVICE_SCHEMA, deviceFns as F } from "../src/devices.ts";
import { newAuth, created, asserted, rawToDer } from "../scripts/passkey-sim.ts";

const O = "https://kb.example.com";
function fakeDir() {
  const db = new Database(":memory:"); db.run("create table acct(k text primary key, v text)");
  for (const q of DEVICE_SCHEMA.split(";").map(x => x.trim()).filter(Boolean)) db.run(q);
  return { acct: "root", sql: { exec: (q: string, ...a: any[]) => { const st = db.query(q); if (/^\s*select/i.test(q)) { const rows = st.all(...a); return { toArray: () => rows, one: () => rows[0] }; } st.run(...a); return { toArray: () => [], one: () => undefined }; } } } as any;
}
async function enrolled(d: any) { const a = await newAuth(), b = await P.begin(d, { name: "Pixel" }); const f = await P.finish(d, { id: b.id, origin: O, ...created(a, b.challenge, O) }); return { a, b, f }; }

test("DER <-> raw signatures", () => { const raw = crypto.getRandomValues(new Uint8Array(64)); raw[0] = 0x80; raw[32] = 0; raw[33] = 0x01; expect([...derToRaw(rawToDer(raw))!]).toEqual([...raw]); expect(derToRaw(new Uint8Array([1, 2]))).toBeNull(); });

test("enroll: approves nothing until the owner approves its code; then an owner device (via passkey, no runner) shown in the devices list", async () => {
  const d = fakeDir(), { a, b, f } = await enrolled(d); expect(f.state).toBe("waiting"); expect(f.code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
  expect((await P.challenge(d, { action: "device_grant:BCDF-GHJK" })).challenge).toBeNull(); // nothing active yet
  expect(await P.pending(d, f.code)).toBeTruthy(); const r = await P.approve(d, f.code); expect((await P.state(d, b.id)).state).toBe("active");
  const l = await F.list(d); const dv = l.devices.find((x: any) => x.id === r.device); expect(dv).toMatchObject({ name: "Pixel", os: "Passkey", passkey: true, locked: false, state: "active", peer: null });
  await expect(P.approve(d, f.code)).rejects.toThrow(/no passkey waits/);
  // a create for another challenge / origin is refused
  const b2 = await P.begin(d, {}); await expect(P.finish(d, { id: b2.id, origin: O, ...created(a, "other", O) })).rejects.toThrow(/wasn't made for this/);
  await expect(P.finish(d, { id: b2.id, origin: "https://evil.example", ...created(a, b2.challenge, "https://kb.example.com") })).rejects.toThrow(/wasn't made for this/);
});

test("approve: a challenge bound to exactly one action, single use, this origin and host, user-verified, signed by an active passkey; revoke ends it", async () => {
  const d = fakeDir(), { a, f } = await enrolled(d), { device } = await P.approve(d, f.code), act = "device_grant:BCDF-GHJK";
  let c = await P.challenge(d, { action: act }); expect(c.allow).toEqual([a.credId]);
  const good = await asserted(a, c.challenge, O); expect(await P.verify(d, { action: act, origin: O, cred: good })).toEqual({ ok: true, device });
  expect((await P.verify(d, { action: act, origin: O, cred: good })).why).toMatch(/expired/); // single use
  c = await P.challenge(d, { action: act }); expect((await P.verify(d, { action: "device_grant:ZZZZ-ZZZZ", origin: O, cred: await asserted(a, c.challenge, O) })).why).toMatch(/something else/);
  c = await P.challenge(d, { action: act }); expect((await P.verify(d, { action: act, origin: O, cred: await asserted(a, c.challenge, "https://evil.example", { rpId: "kb.example.com" }) })).why).toMatch(/another page/);
  c = await P.challenge(d, { action: act }); expect((await P.verify(d, { action: act, origin: O, cred: await asserted(a, c.challenge, O, { rpId: "evil.example" }) })).why).toMatch(/another site/);
  c = await P.challenge(d, { action: act }); expect((await P.verify(d, { action: act, origin: O, cred: await asserted(a, c.challenge, O, { uv: false }) })).why).toMatch(/didn't verify/);
  const other = await newAuth(); c = await P.challenge(d, { action: act }); const forged = await asserted(other, c.challenge, O); forged.id = a.credId;
  expect((await P.verify(d, { action: act, origin: O, cred: forged })).why).toMatch(/bad passkey signature/);
  a.count = 0; c = await P.challenge(d, { action: act }); expect((await P.verify(d, { action: act, origin: O, cred: await asserted(a, c.challenge, O) })).why).toMatch(/counter went backwards/);
  await F.revoke(d, device); a.count = 100; c = await P.challenge(d, { action: act }); expect(c.challenge).toBeNull();
});
