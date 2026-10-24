// bun test client/approval.test.ts — approval gates v2: payload binding + WebAuthn verification.
// The WebAuthn vectors are generated here with a software authenticator (real P-256 / Ed25519 / RSA keys, real signatures over
// authenticatorData || sha256(clientDataJSON)), so the verifier is exercised exactly as a phone's passkey would exercise it.
import { test, expect } from "bun:test";
import { generateKeyPairSync, sign, createHash } from "crypto";
import * as A from "./approval.ts";

const KEY = "k".repeat(64), base = { id: "t_1", from: "hark", title: "x", instructions: "do it", project: "demo", verify: "bun test", scope: [] };
const pl = (t: any = base, x: any = {}) => A.payloadOf(t, { agent: "pi", model: null, access: "worktree", ...x });

test("nonce binds task id + exact payload, 5-minute expiry", () => {
  const h = A.payloadHash(pl()), m = A.mint(KEY, "t_1", h, 1_000_000);
  expect(A.check(KEY, "t_1", h, m.nonce, 1_000_000 + 60_000)).toBe("ok");
  expect(A.check(KEY, "t_1", h, m.nonce, 1_000_000 + A.TTL_MS + 1)).toBe("expired");
  expect(A.check(KEY, "t_2", h, m.nonce, 1_000_001)).toBe("mismatch");            // another task
  expect(A.check("other-key", "t_1", h, m.nonce, 1_000_001)).toBe("mismatch");    // forged without the runner key
  expect(A.check(KEY, "t_1", h, m.nonce.replace(/^[0-9a-z]+/, (1e13).toString(36)), 1_000_001)).toBe("mismatch"); // stretched expiry
  expect(A.check(KEY, "t_1", h, "approve", 1)).toBe("mismatch");
  expect(m.short).toBe(h.slice(0, 8));
});
test("any change to what runs changes the hash (and voids the nonce)", () => {
  const h = A.payloadHash(pl());
  const changed = [pl({ ...base, instructions: "do it!" }), pl({ ...base, project: "other" }), pl({ ...base, verify: "rm -rf /" }), pl({ ...base, spec: "v2" }),
    pl({ ...base, limits: { spec: "s" } }), pl({ ...base, scope: ["src/**"] }), pl(base, { agent: "codex" }), pl(base, { model: "opus" }), pl(base, { access: "full" }), pl(base, { gate: "irreversible" })];
  for (const p of changed) { const h2 = A.payloadHash(p); expect(h2).not.toBe(h); expect(A.check(KEY, "t_1", h2, A.mint(KEY, "t_1", h).nonce)).toBe("mismatch"); }
  expect(A.payloadHash(pl({ ...base }))).toBe(h); // key order / copies don't matter
  expect(A.canon({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
});

// ---- software authenticator ----
const ORIGIN = "https://kitebook.example", RP = "kitebook.example";
function authenticator(kind: "ec" | "ed25519" | "rsa") {
  const { publicKey, privateKey } = kind === "ec" ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : kind === "rsa" ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ed25519");
  const alg = kind === "ec" ? -7 : kind === "rsa" ? -257 : -8, id = A.b64u(crypto.getRandomValues(new Uint8Array(16)));
  const cd = (type: string, challenge: string, origin = ORIGIN) => A.b64u(JSON.stringify({ type, challenge: A.b64u(challenge), origin, crossOrigin: false }));
  return {
    register: (challenge: string, origin = ORIGIN) => ({ id, alg, publicKey: A.b64u(publicKey.export({ format: "der", type: "spki" }) as Buffer), clientDataJSON: cd("webauthn.create", challenge, origin) }),
    assert: (challenge: string, o: { origin?: string; rp?: string; flags?: number; type?: string } = {}) => {
      const ad = Buffer.concat([createHash("sha256").update(o.rp ?? RP).digest(), Buffer.from([o.flags ?? 0x05]), Buffer.from([0, 0, 0, 7])]);
      const c = cd(o.type ?? "webauthn.get", challenge, o.origin), data = Buffer.concat([ad, createHash("sha256").update(Buffer.from(A.unb64u(c))).digest()]);
      return { id, clientDataJSON: c, authenticatorData: A.b64u(ad), signature: A.b64u(sign(kind === "ed25519" ? null : "sha256", data, privateKey)) };
    },
  };
}
for (const kind of ["ec", "ed25519", "rsa"] as const) test(`WebAuthn ${kind}: registration + assertion over the approval nonce`, () => {
  const au = authenticator(kind), regCh = "reg-challenge-abc";
  const cred = A.verifyRegistration(au.register(regCh), regCh, ORIGIN); expect(typeof cred).toBe("object"); const creds = [cred as A.Cred];
  expect(A.verifyRegistration(au.register("other"), regCh, ORIGIN)).toBe("challenge does not match this approval");
  expect(String(A.verifyRegistration(au.register(regCh, "https://evil.example"), regCh, ORIGIN))).toContain("origin");
  const nonce = A.mint(KEY, "t_1", A.payloadHash(pl())).nonce;
  expect(A.verifyAssertion(creds, au.assert(nonce), nonce)).toBeNull();
  expect(A.verifyAssertion(creds, au.assert("someone-elses-nonce"), nonce)).toBe("challenge does not match this approval");
  expect(String(A.verifyAssertion(creds, au.assert(nonce, { origin: "https://evil.example" }), nonce))).toContain("origin");
  expect(A.verifyAssertion(creds, au.assert(nonce, { rp: "evil.example" }), nonce)).toBe("rpId hash mismatch");
  expect(String(A.verifyAssertion(creds, au.assert(nonce, { flags: 0x01 }), nonce))).toContain("not verified");
  expect(String(A.verifyAssertion(creds, au.assert(nonce, { type: "webauthn.create" }), nonce))).toContain("type");
  const good = au.assert(nonce), sig = A.unb64u(good.signature); sig[sig.length - 3] ^= 1;
  expect(A.verifyAssertion(creds, { ...good, signature: A.b64u(sig) }, nonce)).toBe("bad signature");
  expect(A.verifyAssertion(creds, { ...good, authenticatorData: A.b64u(Buffer.concat([Buffer.from(A.unb64u(good.authenticatorData)), Buffer.from([1])])) }, nonce)).toBe("bad signature");
  expect(A.verifyAssertion(creds, authenticator(kind).assert(nonce), nonce)).toBe("unknown passkey"); // a different passkey
});
