// Approval gates v2 (runner side). Every approval is bound to the exact payload it was asked for:
//   hash  = sha256(canonical JSON of what will run: instructions, project, agent, model, verify, access, spec, ...)
//   nonce = <expiry>.<HMAC(runner-only key, task id | hash | expiry)>, valid 5 minutes
// The nonce travels with the ask (ntfy buttons, the server's review page, the WebAuthn challenge). On an answer the runner
// re-fetches the task, recomputes the hash and re-checks the HMAC: if anything changed, or the answer came after expiry,
// the approval is void and the owner is asked again. The server never sees the key, so it can't mint a nonce for other content.
// Optional passkey (runner.json "approvePasskey": true): the review page signs the nonce with the owner's WebAuthn passkey and
// the runner verifies the signature against the public key it registered, so not even the server can approve on its own.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { createHash, createHmac, timingSafeEqual, verify as cverify, createPublicKey } from "crypto";
import { readFileSync, writeFileSync } from "fs";

export const TTL_MS = 5 * 60_000;
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest();
export const b64u = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
export const unb64u = (s: string) => new Uint8Array(Buffer.from(String(s ?? ""), "base64url"));

// canon + payloadOf live in client/payload.ts (pure: the server and the owner's browser use the same code)
import { canon, payloadOf } from "./payload.ts";
export { canon, payloadOf };
export const payloadHash = (p: any) => sha(canon(p)).toString("hex");
export const shortHash = (h: string) => h.slice(0, 8);
const mac = (key: string, task: string, hash: string, exp: number) => createHmac("sha256", key).update(`relay-approval:v2|${task}|${hash}|${exp}`).digest("hex").slice(0, 32);
export function mint(key: string, task: string, hash: string, now = Date.now(), ttl = TTL_MS) {
  const exp = now + ttl; return { hash, short: shortHash(hash), exp, nonce: `${exp.toString(36)}.${mac(key, task, hash, exp)}` };
}
// "ok" only if the nonce was minted by this runner for this task and this exact payload hash, and hasn't expired
export function check(key: string, task: string, hash: string, nonce: string, now = Date.now()): "ok" | "expired" | "mismatch" {
  const m = String(nonce ?? "").match(/^([0-9a-z]+)\.([0-9a-f]{32})$/); if (!m) return "mismatch";
  const exp = parseInt(m[1], 36), want = Buffer.from(mac(key, task, hash, exp)), got = Buffer.from(m[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return "mismatch";
  return now > exp ? "expired" : "ok";
}
export const sameNonce = (a: string, b: string) => { const x = sha(String(a)), y = sha(String(b)); return timingSafeEqual(x, y); };

// ---------- WebAuthn (passkey) verification, no dependencies ----------
// Stored credential: { id: base64url credential id, alg: COSE alg (-7 ES256, -8 EdDSA, -257 RS256), pk: base64url SPKI DER, rp: rpId, origin }
export type Cred = { id: string; alg: number; pk: string; rp: string; origin: string; name?: string; added?: string };
const keyOf = (c: Cred) => createPublicKey({ key: Buffer.from(unb64u(c.pk)), format: "der", type: "spki" });
function clientData(b64: string, type: string, challenge: string, origin: string): string | null {
  let cd: any; try { cd = JSON.parse(Buffer.from(unb64u(b64)).toString("utf8")); } catch { return "clientDataJSON is not JSON"; }
  if (cd.type !== type) return `clientData.type is ${cd.type}, want ${type}`;
  if (cd.challenge !== b64u(challenge)) return "challenge does not match this approval";
  if (cd.origin !== origin) return `origin ${cd.origin} is not ${origin}`;
  if (cd.crossOrigin === true) return "cross-origin ceremony";
  return null;
}
// Registration through the owner's one-time link (attestation "none": trust comes from the link only the owner has).
export function verifyRegistration(r: any, challenge: string, origin: string): Cred | string {
  const e = clientData(r?.clientDataJSON, "webauthn.create", challenge, origin); if (e) return e;
  if (![-7, -8, -257].includes(Number(r?.alg))) return `unsupported key algorithm ${r?.alg} (ES256, EdDSA, RS256 only)`;
  if (!r?.id || !r?.publicKey) return "missing credential id or public key";
  const c: Cred = { id: String(r.id), alg: Number(r.alg), pk: String(r.publicKey), rp: new URL(origin).hostname, origin };
  try { keyOf(c); } catch { return "public key is not a valid SPKI key"; }
  return c;
}
// An assertion over the approval nonce: right credential, right challenge/origin/rpId, user present AND verified, valid signature.
export function verifyAssertion(creds: Cred[], a: any, challenge: string): string | null {
  const c = creds.find(x => x.id === a?.id); if (!c) return "unknown passkey";
  const e = clientData(a.clientDataJSON, "webauthn.get", challenge, c.origin); if (e) return e;
  const ad = unb64u(a.authenticatorData); if (ad.length < 37) return "authenticatorData too short";
  if (!timingSafeEqual(Buffer.from(ad.subarray(0, 32)), sha(c.rp))) return "rpId hash mismatch";
  if (!(ad[32] & 0x01)) return "user not present"; if (!(ad[32] & 0x04)) return "user not verified (passkey needs PIN/biometric)";
  const data = Buffer.concat([Buffer.from(ad), sha(Buffer.from(unb64u(a.clientDataJSON)))]), sig = Buffer.from(unb64u(a.signature));
  let ok = false; try { ok = cverify(c.alg === -8 ? null : "sha256", data, keyOf(c), sig); } catch { ok = false; }
  return ok ? null : "bad signature";
}

// ---------- owner CLI: bun runner.ts passkey register|list|remove <runner.json> ----------
// register: asks the server for a one-time registration page, prints the link, waits up to 10 minutes for the passkey,
// verifies it and stores its public key in runner.json (a protected file agents can't edit).
export async function passkeyCli(argv: string[], stamp: (f: string) => void): Promise<number> {
  const [cmd, f = "runner.json", arg] = argv, c = JSON.parse(readFileSync(f, "utf8"));
  const save = () => { writeFileSync(f, JSON.stringify(c, null, 2)); stamp(f); };
  if (cmd === "list") { console.log(JSON.stringify({ approvePasskey: !!c.approvePasskey, passkeys: (c.passkeys ?? []).map((p: Cred) => ({ id: p.id, name: p.name, rp: p.rp, added: p.added })) }, null, 2)); return 0; }
  if (cmd === "remove") { c.passkeys = (c.passkeys ?? []).filter((p: Cred) => p.id !== arg); if (!c.passkeys.length) c.approvePasskey = false; save(); console.log(`removed; ${c.passkeys.length} passkey(s) left${c.passkeys.length ? "" : ", approvePasskey off"}`); return 0; }
  if (cmd !== "register") { console.error("usage: passkey register|list|remove <runner.json> [id]"); return 2; }
  const H = { authorization: `Bearer ${c.token}`, "content-type": "application/json" };
  const call = async (op: string, a: any) => { const j: any = await (await fetch(`${c.url}/v1/${op}`, { method: "POST", headers: H, body: JSON.stringify({ space: c.space, ...a }) })).json(); if (!j.ok) throw new Error(`${op}: ${j.error}`); return j.result; };
  const challenge = b64u(crypto.getRandomValues(new Uint8Array(32))), origin = new URL(c.url).origin;
  const page = await call("approval_page", { kind: "register", nonce: challenge, expires_at: Date.now() + 10 * 60_000, view: { title: "Register a passkey for phone approvals", name: arg ?? "owner" } });
  console.log(`Open this link on your phone (one-time, 10 minutes) and create the passkey:\n${c.url}${page.path}`);
  const end = Date.now() + 10 * 60_000;
  while (Date.now() < end) {
    const w = await call("approval_wait", { id: page.id, wait: 20 });
    if (w.state === "pending") continue;
    if (w.state !== "registered") { console.error(`registration ${w.state}`); return 1; }
    const cred = verifyRegistration(w.response?.credential, challenge, origin);
    if (typeof cred === "string") { console.error("passkey rejected: " + cred); return 1; }
    const fresh = JSON.parse(readFileSync(f, "utf8")); Object.assign(c, fresh); // keep edits made while we waited
    c.passkeys = [...(c.passkeys ?? []).filter((p: Cred) => p.id !== cred.id), { ...cred, name: arg ?? "owner", added: new Date().toISOString() }]; save();
    console.log(`passkey saved (${cred.id.slice(0, 12)}…, rp ${cred.rp}). Turn it on: bun client/runner.ts set ${f} approvePasskey true`); return 0;
  }
  console.error("no passkey registered within 10 minutes"); return 1;
}
