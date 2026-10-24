// The account model groundwork (client/account.ts, src/account-store.ts, src/identity.ts) without a Durable Object: the Dir side runs
// on bun:sqlite (same SQL). Run: bun test client/account-store.test.ts
import { test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ROOT_ACCOUNT, OWNER_USER, isRoot, normAcct, dirName, spaceName, acctPath } from "./account.ts";
import { ACCOUNT_SCHEMA, accountFns as A, auditTarget, AUDIT_KEEP } from "../src/account-store.ts";
import { DEVICE_SCHEMA, deviceFns as F } from "../src/devices.ts";
import { deviceIdp, masterPasswordIdp, passkeyIdp, identityProviders, identityProvider, registerIdentityProvider } from "../src/identity.ts";
import { DEFAULT_TENANT } from "../src/principal.ts";

beforeAll(() => { process.env.HOME = mkdtempSync(join(tmpdir(), "kbacct-")); process.env.KITEBOOK_TEST = "1"; process.env.KITEBOOK_KEYSTORE = "file"; process.env.KITEBOOK_PRESENCE = "fake"; });
function fakeDir(acct = ROOT_ACCOUNT, created: string | null = null) {
  const db = new Database(":memory:"); db.run("create table acct(k text primary key, v text)"); db.run("create table spaces(id text primary key)");
  if (created) db.run("insert into acct values('created', ?)", [created]);
  for (const q of [...DEVICE_SCHEMA.split(";"), ...ACCOUNT_SCHEMA.split(";")].map(x => x.trim()).filter(Boolean)) db.run(q);
  const d: any = { acct, db, sql: { exec: (q: string, ...a: any[]) => { const st = db.query(q); if (/^\s*select|\breturning\b/i.test(q)) { const rows = st.all(...a); return { toArray: () => rows, one: () => rows[0], rowsWritten: rows.length }; }
    const r = st.run(...a); return { toArray: () => [], one: () => undefined, rowsWritten: r.changes }; } } };
  d.dev = async (fn: string, ...a: any[]) => await F[fn](d, ...a); // the Dir's RPC surface identity.ts uses
  d.pk = async () => ({ ok: false, why: "that passkey isn't an approval device of this Kitebook (removed?)" });
  return d;
}

test("root account: one helper decides every name and path (legacy unprefixed root, prefixed everyone else)", () => {
  expect(isRoot(ROOT_ACCOUNT) && isRoot(undefined) && isRoot(null) && isRoot("")).toBe(true); expect(isRoot("alice")).toBe(false);
  expect(normAcct(undefined)).toBe("root"); expect(normAcct("bob")).toBe("bob");
  expect([dirName("root"), dirName("alice")]).toEqual(["root", "acct:alice"]);                  // the DO names existing installs already have
  expect([spaceName("root", "main"), spaceName("alice", "main")]).toEqual(["main", "alice:main"]);
  expect([acctPath("root", "/mcp"), acctPath("alice", "/mcp")]).toEqual(["/mcp", "/u/alice/mcp"]);
  expect(DEFAULT_TENANT).toBe(OWNER_USER);                                                      // the tenant key is the user id
});

test("users: the migration adds the owner and nothing else; running it again is a no-op", () => {
  const d = fakeDir("alice", "2026-01-02T03:04:05.000Z");
  A.ensureOwner(d); A.ensureOwner(d);
  expect(A.users(d)).toEqual([{ id: "owner", account: "alice", role: "owner", created: "2026-01-02T03:04:05.000Z" }]);
  expect(A.user(d)?.role).toBe("owner"); expect(A.user(d, "mallory")).toBeNull();
  const root = fakeDir(); A.ensureOwner(root); expect(A.users(root)).toEqual([{ id: "owner", account: "root", role: "owner", created: null }]); // an install from before accounts had 'created'
  expect(d.db.query("select count(*) n from acct").get().n).toBe(1);                           // the migration touched no other table
});

test("audit: append-only rows with a cleaned target, never a secret; newest first, paged; oldest trimmed past the cap", () => {
  const d = fakeDir("alice");
  expect(auditTarget({ peer: "hark", token: "rk.alice.SECRET" })).toBe("hark");
  expect(auditTarget({ key: "p256:abc", envelope: { x: 1 } })).toBe("");                        // keys / envelopes are never the target
  expect(auditTarget({ name: "a b<script>" })).toBe("abscript");
  A.audit(d, "admin", "peer", "hark"); A.audit(d, "Settings", "revoke", "hark", false);
  const l = A.auditList(d); expect(l.map(e => [e.actor, e.action, e.target, e.ok])).toEqual([["Settings", "revoke", "hark", false], ["admin", "peer", "hark", true]]);
  expect(A.auditList(d, { before: l[0].seq }).map(e => e.action)).toEqual(["peer"]);
  expect(JSON.stringify(l)).not.toContain("SECRET");
  for (let i = 0; i < AUDIT_KEEP + 120; i++) A.audit(d, "admin", "space", "s" + i);
  const n = d.db.query("select count(*) n, min(seq) lo from audit").get(); expect(n.n).toBeLessThanOrEqual(AUDIT_KEEP + 100); expect(n.lo).toBeGreaterThan(2);
});

test("usage counters: per UTC day and metric, summed; old days dropped", () => {
  const d = fakeDir("alice");
  d.db.run("insert into usage values('2000-01-01','requests',9)");
  A.meter(d, "requests"); A.meter(d, "requests"); A.meter(d, "admin", 3);
  const c = A.counters(d); expect(c.total).toEqual({ requests: 2, admin: 3 }); expect(c.days.length).toBe(1);
  expect(d.db.query("select count(*) n from usage where day='2000-01-01'").get().n).toBe(0);  // past USAGE_DAYS: gone
});

test("identity providers: today's three behind one interface; a device session proves the user and device; refusals carry why", async () => {
  expect(identityProviders()).toEqual([{ kind: "device", factor: "session" }, { kind: "master-password", factor: "presence" }, { kind: "passkey", factor: "presence" }]);
  const d = fakeDir("alice"), K = await import("./keystore.ts"), dk = await K.deviceKey("acct-mac"), pp = await K.presenceBackend().create("acct-mac");
  const dev = await F.enroll(d, { peer: "mac", peerKind: "runner", name: "Mac", pubkey: dk.pub, presence_key: pp });
  const s = await F.sessNew(d, dev.id, "ua", null);
  const p = await deviceIdp.verify(d, "alice", { secret: s.secret });
  expect(p).toEqual({ ok: true, subject: { account: "alice", user: "owner", via: "device", device: dev.id, session: s.id } });
  expect(await deviceIdp.verify(d, "alice", { secret: "kbd.alice.nope" })).toEqual({ ok: false, why: "no live device session" });
  expect((await masterPasswordIdp.verify(d, "alice", { assertion: "garbage", action: "x" })) as any).toEqual({ ok: false, why: "not a presence assertion" });
  expect(((await passkeyIdp.verify(d, "alice", { action: "x", origin: "https://k.test", cred: {} })) as any).ok).toBe(false);
  registerIdentityProvider({ kind: "trusted-header", factor: "session", async verify() { return { ok: false, why: "off" }; } });
  expect(identityProvider("trusted-header")?.factor).toBe("session"); expect(identityProviders().length).toBe(4);
});

test("no scattered root literals: server and runner code name the root account only through client/account.ts", async () => {
  const { readdirSync, readFileSync } = await import("fs"), files = [...readdirSync("src").filter(f => f.endsWith(".ts")).map(f => "src/" + f), ...readdirSync("src/space").filter(f => f.endsWith(".ts")).map(f => "src/space/" + f), "client/runner.ts", "client/device.ts"];
  const bad = files.flatMap(f => readFileSync(f, "utf8").split("\n").map((l, i) => [f, i + 1, l] as const)).filter(([, , l]) => !/^\s*\/\//.test(l) && /(["'`])root\1/.test(l.replace(/\/\/ .*$/, "")));
  expect(bad.map(([f, n]) => `${f}:${n}`)).toEqual([]);
});
