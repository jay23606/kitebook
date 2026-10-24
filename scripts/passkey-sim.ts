// A software WebAuthn platform authenticator (tests only): what a phone's passkey sends, made with WebCrypto, so the unit tests
// (client/passkey.test.ts) and smoke.sh exercise src/passkey.ts end to end without a browser. State lives in a JSON file for the CLI.
//   bun scripts/passkey-sim.ts enroll <kitebook url> <state.json> [account]    -> prints the enrollment code (the owner approves it)
//   bun scripts/passkey-sim.ts wait <kitebook url> <state.json>                -> exits 0 once the enrollment is approved
//   bun scripts/passkey-sim.ts approve <kitebook url> <state.json> <code> [uv=1] -> approves a /connect pairing code with the passkey
import { readFileSync, writeFileSync } from "fs";

export const B = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
export const D = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const sha = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as any));
// raw r||s -> DER, what authenticators send
export function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (v: Uint8Array) => { let i = 0; while (i < v.length - 1 && v[i] === 0) i++; v = v.slice(i); if (v[0] & 0x80) v = Uint8Array.from([0, ...v]); return [0x02, v.length, ...v]; };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))]; return Uint8Array.from([0x30, body.length, ...body]);
}
export type Auth = { priv: CryptoKey; spki: string; credId: string; count: number };
export async function newAuth(): Promise<Auth> {
  const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return { priv: k.privateKey, spki: B(await crypto.subtle.exportKey("spki", k.publicKey) as ArrayBuffer), credId: B(crypto.getRandomValues(new Uint8Array(32))), count: 0 };
}
export const created = (a: Auth, challenge: string, origin: string) => ({ cred_id: a.credId, spki: a.spki, client_data: B(new TextEncoder().encode(JSON.stringify({ type: "webauthn.create", challenge, origin }))) });
export async function asserted(a: Auth, challenge: string, origin: string, o: { uv?: boolean; rpId?: string } = {}) {
  const cd = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false })), rp = await sha(new TextEncoder().encode(o.rpId ?? new URL(origin).hostname));
  a.count++; const auth = new Uint8Array(37); auth.set(rp); auth[32] = o.uv === false ? 0x01 : 0x05; new DataView(auth.buffer).setUint32(33, a.count);
  const msg = new Uint8Array(auth.length + 32); msg.set(auth); msg.set(await sha(cd), auth.length);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, a.priv, msg));
  return { id: a.credId, client_data: B(cd), auth_data: B(auth), sig: B(rawToDer(sig)) };
}

if (import.meta.main) {
  const [cmd, url, file, x, y] = process.argv.slice(2), o = new URL(url).origin;
  const dev = async (b: any) => { const r = await fetch(`${o}/device`, { method: "POST", headers: { "content-type": "application/json", origin: o }, body: JSON.stringify(b) }); return { s: r.status, j: await r.json() as any }; };
  const load = async () => { const s = JSON.parse(readFileSync(file, "utf8")); const priv = await crypto.subtle.importKey("jwk", s.jwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]); return { s, a: { priv, spki: s.spki, credId: s.credId, count: s.count } as Auth }; };
  const save = async (a: Auth, extra: any) => writeFileSync(file, JSON.stringify({ jwk: await crypto.subtle.exportKey("jwk", a.priv), spki: a.spki, credId: a.credId, count: a.count, ...extra }));
  if (cmd === "enroll") { const a = await newAuth(), acct = x ?? "root", b = await dev({ op: "passkey_begin", account: acct, name: "Sim phone" }); if (b.s !== 200) { console.error(JSON.stringify(b.j)); process.exit(1); }
    const f = await dev({ op: "passkey_finish", account: acct, id: b.j.id, ...created(a, b.j.challenge, o) }); if (f.s !== 200) { console.error(JSON.stringify(f.j)); process.exit(1); }
    await save(a, { id: b.j.id, acct }); console.log(f.j.code); }
  else if (cmd === "wait") { const { s } = await load(); for (let i = 0; i < 40; i++) { const r = await dev({ op: "passkey_state", account: s.acct, id: s.id }); if (r.j.state === "active") { console.log("active"); process.exit(0); } await Bun.sleep(250); } console.error("not approved"); process.exit(1); }
  else if (cmd === "approve") { const { s, a } = await load(), act = `device_grant:${x}`;
    const c = await dev({ op: "passkey_challenge", account: s.acct, action: act }); if (c.s !== 200 || !c.j.challenge) { console.error(JSON.stringify(c.j)); process.exit(1); }
    const r = await dev({ op: "approve", user_code: x, account: s.acct, passkey: await asserted(a, c.j.challenge, o, { uv: y !== "uv=0" }) }); await save(a, { id: s.id, acct: s.acct });
    console.log(r.s, JSON.stringify(r.j)); process.exit(r.s === 200 ? 0 : 1); }
  else { console.error("enroll|wait|approve"); process.exit(2); }
}
