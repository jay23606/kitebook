// Standing permissions, runner side: only a policy signed by a pinned owner key, for this workspace, not older than the last one
// accepted, lets a sender run on its own, and only in its projects, before its end date. Run: bun test client/policy.test.ts
import { test, expect } from "bun:test";
import { rmSync } from "fs";
import { verifyEnvelope, PolicyStore, standingFor, fingerprint, validOwnerKey } from "./policy.ts";
import { canon, autoEntry, summarize } from "./payload.ts";

const te = new TextEncoder(), b64u = (b: ArrayBuffer) => Buffer.from(new Uint8Array(b)).toString("base64url");
async function owner() { const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]) as CryptoKeyPair;
  const pub = "p256:" + b64u(await crypto.subtle.exportKey("spki", kp.publicKey) as ArrayBuffer);
  return { pub, sign: async (p: any) => ({ policy: p, key: pub, sig: b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, te.encode("relay-policy:v1|" + canon(p)))) }) }; }
const pol = (seq: number, e: any = {}) => ({ v: 1, type: "relay-policy", space: "main", seq, at: 1, apps: { hark: { tasks: "auto", projects: ["kitebook"], push: false, until: null, keys: ["ed25519:" + "A".repeat(43)], ...e } } });
const store = () => { const f = `/tmp/relay-policy-test-${crypto.randomUUID()}.json`; rmSync(f, { force: true }); return new PolicyStore(f); };

test("a pinned owner key's signature is accepted; tampered, unsigned, unpinned or foreign-workspace ones are not", async () => {
  const o = await owner(), x = await owner(), env = await o.sign(pol(1));
  expect(validOwnerKey(o.pub)).toBe(true); expect(fingerprint(o.pub)).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  expect("policy" in verifyEnvelope(env, [o.pub], "main")).toBe(true);
  expect(verifyEnvelope({ ...env, policy: { ...env.policy, apps: { hark: { ...env.policy.apps.hark, projects: ["kitebook", "other"] } } } }, [o.pub], "main")).toEqual({ error: "bad signature (changed after the owner signed it)" });
  expect("error" in verifyEnvelope({ policy: env.policy }, [o.pub], "main")).toBe(true);
  expect((verifyEnvelope(env, [x.pub], "main") as any).error).toMatch(/hasn't pinned/);
  expect((verifyEnvelope(await o.sign({ ...pol(1), space: "other" }), [o.pub], "main") as any).error).toMatch(/workspace other/);
  expect((verifyEnvelope(await x.sign(pol(1)), [o.pub], "main") as any).error).toMatch(/hasn't pinned/);
});
test("rollback: an older version, or a different one at the same version, is refused", async () => {
  const o = await owner(), s = store();
  expect("entry" in standingFor(await o.sign(pol(3)), [o.pub], "main", s, "hark", "kitebook")).toBe(true);
  expect((standingFor(await o.sign(pol(2)), [o.pub], "main", s, "hark", "kitebook") as any).why).toMatch(/older than version 3/);
  expect((standingFor(await o.sign(pol(3, { push: true })), [o.pub], "main", s, "hark", "kitebook") as any).why).toMatch(/differs/);
  expect("entry" in standingFor(await o.sign(pol(4)), [o.pub], "main", s, "hark", "kitebook")).toBe(true);
});
test("only that app, only its projects, only until its end date", async () => {
  const o = await owner(), s = store(), env = await o.sign(pol(1, { until: 2000 }));
  expect("entry" in standingFor(env, [o.pub], "main", s, "hark", "kitebook", 1000)).toBe(true);
  expect((standingFor(env, [o.pub], "main", s, "hark", "kitebook", 3000) as any).why).toMatch(/ended/);
  expect((standingFor(env, [o.pub], "main", s, "hark", "other", 1000) as any).why).toMatch(/only in kitebook/);
  const q = standingFor(env, [o.pub], "main", s, "codex", "kitebook", 1000) as any; expect(q.quiet).toBe(true);
  expect((autoEntry(pol(1, { tasks: "ask" }), "hark", "kitebook") as any).why).toMatch(/haven't let/);
  expect(standingFor(null, [o.pub], "main", s, "hark", "kitebook")).toEqual({ why: "no standing permissions", seq: null, quiet: true });
});
test("one-line summaries", () => {
  expect(summarize("hark", null, { tasks: "auto", projects: ["kitebook"], until: Date.UTC(2026, 9, 25), push: false })).toBe("hark can now run tasks in kitebook on its own until Oct 25");
  expect(summarize("hark", { tasks: "auto", projects: ["kitebook"] }, null)).toBe("hark asks you before every task");
  expect(summarize("codex", null, { tasks: "off", projects: [] }, { mode: "read" })).toBe("codex can't send tasks or push; it can read every folder and change nothing");
});

test("Run tasks without asking (autorun): one owner-signed switch covers any sender until it ends; an app's own entry wins; off is never overridden; pushes stay off the main branch", async () => {
  const { standingEntry, autorunOn, autorunPushOk, describeAutorun } = await import("./payload.ts");
  const o = await owner(), K = "ed25519:" + "D".repeat(43), now = Date.now();
  const p = (autorun: any, apps: any = {}) => ({ v: 1, type: "relay-policy", space: "main", seq: 1, at: 1, apps, ...(autorun ? { autorun } : {}) });
  expect(autorunOn(p({ on: true, until: null, keys: [K] }))).toEqual({ until: null, keys: [K] });
  expect(autorunOn(p({ on: true, until: now - 1, keys: [K] }))).toBeNull(); // past its end: off by itself
  expect(autorunOn(p({ on: true, until: null, keys: ["nope"] }))).toBeNull(); // no usable key: off
  const e: any = standingEntry(p({ on: true, until: now + 60_000, keys: [K] }), "codex", "kitebook");
  expect(e.autorun).toBe(true); expect(e.entry.keys).toEqual([K]); expect(e.entry.projects).toEqual(["kitebook"]);
  expect((standingEntry(p({ on: true, until: null, keys: [K] }), "codex", null) as any).autorun).toBe(true); // a machine task too
  expect((standingEntry(p({ on: true, until: now - 1000, keys: [K] }), "codex", "kitebook") as any).why).toMatch(/Run tasks without asking" ended/);
  expect((standingEntry(p(null), "codex", "kitebook") as any).why).toMatch(/haven't let codex/);
  expect((standingEntry(p({ on: true, until: null, keys: [K] }, { codex: { tasks: "off", projects: [] } }), "codex", "kitebook") as any).why).toBeTruthy(); // can't send tasks: autorun doesn't change it
  const own: any = standingEntry(p({ on: true, until: null, keys: [K] }, { hark: { tasks: "auto", projects: ["kitebook"], push: false, until: null, keys: ["ed25519:" + "A".repeat(43)] } }), "hark", "kitebook");
  expect(own.autorun).toBeUndefined(); expect(own.entry.push).toBe(false); // its own entry applies (and says whether it may push)
  // signed by the pinned owner key, the runner sees autorun (standingFor); unsigned / unpinned it doesn't
  const env = await o.sign(p({ on: true, until: null, keys: [K] })), st: any = standingFor(env, [o.pub], "main", store(), "codex", "kitebook");
  expect(st.autorun).toBe(true); expect(st.entry.keys).toEqual([K]);
  expect("why" in standingFor(env, [], "main", store(), "codex", "kitebook")).toBe(true);
  expect("why" in standingFor({ ...env, policy: { ...env.policy, autorun: { on: true, until: null, keys: ["ed25519:" + "E".repeat(43)] } } }, [o.pub], "main", store(), "codex", "kitebook")).toBe(true); // tampered
  // pushes under autorun: the task's own branch only; the default branch, main/master or a force push asks
  expect(autorunPushOk("kitebook/t_abc", "main")).toBe(true); expect(autorunPushOk("hark/fix", "trunk")).toBe(true);
  expect(autorunPushOk("main", "main")).toBe(false); expect(autorunPushOk("trunk", "trunk")).toBe(false); expect(autorunPushOk("master", null)).toBe(false);
  expect(autorunPushOk("kitebook/t_abc", "main", true)).toBe(false); expect(autorunPushOk("", "main")).toBe(false);
  expect(describeAutorun({ on: true, until: null })).toBe("Run tasks without asking: on, your own apps' tasks start without asking"); expect(describeAutorun(null)).toBe("Run tasks without asking: off, tasks ask you again");
});

test("autorun: only the owner's own, still-connected apps (autorunSenderWhy)", async () => {
  process.env.KITEBOOK_TEST = "1";
  const { autorunSenderWhy: devSenderWhy } = await import("./runner-approval.ts");
  expect(devSenderWhy("codex", { connected: true, own: true })).toBeNull();
  expect(devSenderWhy("codex", { connected: false, own: true })).toMatch(/isn't connected any more/);
  expect(devSenderWhy("ann", { connected: true, own: false, why: "a person, not one of your apps" })).toMatch(/covers only your own apps .* ann is a person/);
  expect(devSenderWhy("codex", null)).toMatch(/didn't confirm/);
});

// the rename (owner, 2026-10-23): "dev mode" became two switches. A policy signed before it (policy.dev) is read as BOTH autorun (same
// permission, unchanged) and Experimental on; every new version writes autorun / experimental and never dev; Experimental alone grants nothing.
test("dev -> autorun + experimental: legacy alias read, never written; Experimental never implies running without asking", async () => {
  const { autorunOn, experimentalOn, migratePolicy, standingEntry } = await import("./payload.ts");
  const K = "ed25519:" + "D".repeat(43), now = Date.now(), base = { v: 1, type: "relay-policy", space: "main", seq: 3, at: 1, apps: {} };
  const legacy = { ...base, dev: { on: true, until: null, keys: [K] } };
  expect(autorunOn(legacy)).toEqual({ until: null, keys: [K] }); expect(experimentalOn(legacy)).toEqual({ ci: true, gh_status: false });
  const m: any = migratePolicy(legacy); expect("dev" in m).toBe(false); expect(m.autorun).toEqual(legacy.dev); expect(m.experimental).toEqual({ on: true });
  expect(experimentalOn({ ...base, dev: { on: true, until: now - 1, keys: [K] } })).toBeNull(); // an ended dev mode migrates to nothing on
  expect((migratePolicy({ ...base, dev: { on: true, until: now - 1, keys: [K] } }) as any).experimental).toBeUndefined();
  expect(migratePolicy(base)).toBe(base); // nothing to migrate: the same object
  // Experimental on, no autorun: tasks still ask (no standing entry), and its feature switches read with their defaults
  const ex = { ...base, experimental: { on: true } };
  expect(autorunOn(ex)).toBeNull(); expect("why" in standingEntry(ex, "codex", "kitebook")).toBe(true);
  expect(experimentalOn(ex)).toEqual({ ci: true, gh_status: false }); expect(experimentalOn({ ...base, experimental: { on: true, ci: false, gh_status: true } })).toEqual({ ci: false, gh_status: true });
  // autorun on, Experimental off: an explicit experimental field wins over the legacy reading; autorun alone turns no feature on
  expect(experimentalOn({ ...base, autorun: { on: true, until: null, keys: [K] } })).toBeNull();
  // the server's shape check: autorun and experimental accepted, both names at once refused, unknown experimental keys refused
  const { checkEnvelope } = await import("../src/policy.ts"); const o = await owner();
  expect(await checkEnvelope(await o.sign({ ...base, seq: 1, autorun: { on: true, until: null, keys: [K] }, experimental: { on: true, ci: false } }), [o.pub], "main")).toBeNull();
  expect(await checkEnvelope(await o.sign({ ...base, seq: 1, dev: { on: true, until: null, keys: [K] } }), [o.pub], "main")).toBeNull(); // an old stored envelope still checks
  expect(await checkEnvelope(await o.sign({ ...base, seq: 1, dev: { on: true, until: null, keys: [K] }, autorun: { on: true, until: null, keys: [K] } }), [o.pub], "main")).toMatch(/autorun replaces dev/);
  expect(await checkEnvelope(await o.sign({ ...base, seq: 1, experimental: { on: true, run_tasks: true } }), [o.pub], "main")).toMatch(/experimental:/);
});

// kb-write-default: Settings' recommended choice is the documented assistant preset (read all, write only shared/** + kb/**); sending tasks follows the policy
test("access mode shared = the assistant preset; dispatch follows tasks", async () => {
  const { accessGrant } = await import("../src/policy.ts"), cur = { verbs: ["read", "dispatch"], paths: ["**"] };
  expect(accessGrant({ mode: "shared" }, cur, "ask")).toEqual({ verbs: ["read", "write", "dispatch"], paths: ["**", "write:shared/**", "write:kb/**"] });
  expect(accessGrant({ mode: "shared" }, cur, "off")).toEqual({ verbs: ["read", "write"], paths: ["**", "write:shared/**", "write:kb/**"] });
  expect(summarize("muse", null, null, { mode: "shared", send: true })).toBe("muse can read every folder and save to shared memory (shared/ and kb/) and send tasks to your Mac (you approve each one)");
});
