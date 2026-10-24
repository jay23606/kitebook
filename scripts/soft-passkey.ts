// A software passkey (P-256, "none" attestation), enough for SimpleWebAuthn's full server checks. Used by scripts/auth-e2e.ts and
// scripts/tunnel-auth-check.ts; save()/load() keep one across a server upgrade (smoke: a passkey added on the old host signs in after it).
const te = new TextEncoder();
const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as any).toString("base64url");
const unb = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const sha = async (b: Uint8Array | string) => new Uint8Array(await crypto.subtle.digest("SHA-256", (typeof b === "string" ? te.encode(b) : b) as any));
function cbor(v: any): Uint8Array {
  const head = (major: number, len: number) => len < 24 ? [major << 5 | len] : len < 256 ? [major << 5 | 24, len] : [major << 5 | 25, len >> 8, len & 255];
  if (typeof v === "number") return new Uint8Array(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (v instanceof Uint8Array) return new Uint8Array([...head(2, v.length), ...v]);
  if (typeof v === "string") { const b = te.encode(v); return new Uint8Array([...head(3, b.length), ...b]); }
  if (Array.isArray(v)) return new Uint8Array([...head(4, v.length), ...v.flatMap(x => [...cbor(x)])]);
  const e = v instanceof Map ? [...v] : Object.entries(v); return new Uint8Array([...head(5, e.length), ...e.flatMap(([k, x]) => [...cbor(k), ...cbor(x)])]);
}
const der = (raw: Uint8Array) => { const int = (b: Uint8Array) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; let x = b.slice(i); if (x[0] & 0x80) x = new Uint8Array([0, ...x]); return [2, x.length, ...x]; };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))]; return new Uint8Array([0x30, body.length, ...body]); };
export class SoftPasskey {
  id = crypto.getRandomValues(new Uint8Array(16)); keys!: CryptoKeyPair; userHandle = ""; count = 0;
  constructor(public origin: string, public rpId: string) {}
  async create(o: any) {
    this.keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", this.keys.publicKey); this.userHandle = o.user?.id ?? "";
    const cose = cbor(new Map<any, any>([[1, 2], [3, -7], [-1, 1], [-2, unb(jwk.x!)], [-3, unb(jwk.y!)]]));
    const authData = new Uint8Array([...await sha(o.rp?.id ?? this.rpId), 0x45, 0, 0, 0, 0, ...new Uint8Array(16), 0, this.id.length, ...this.id, ...cose]);
    const cd = te.encode(JSON.stringify({ type: "webauthn.create", challenge: o.challenge, origin: this.origin, crossOrigin: false }));
    return { id: b64u(this.id), rawId: b64u(this.id), type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {},
      response: { clientDataJSON: b64u(cd), attestationObject: b64u(cbor({ fmt: "none", attStmt: {}, authData })), transports: ["internal"] } };
  }
  async get(o: any, tamper = false) {
    const authData = new Uint8Array([...await sha(o.rpId ?? this.rpId), 0x05, 0, 0, 0, ++this.count]);
    const cd = te.encode(JSON.stringify({ type: "webauthn.get", challenge: o.challenge, origin: this.origin, crossOrigin: false }));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, new Uint8Array([...authData, ...await sha(cd)])));
    if (tamper) sig[5] ^= 1;
    return { id: b64u(this.id), rawId: b64u(this.id), type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {},
      response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(der(sig)), userHandle: this.userHandle || undefined } };
  }
  async save() { return { id: b64u(this.id), userHandle: this.userHandle, count: this.count, origin: this.origin, rpId: this.rpId, key: await crypto.subtle.exportKey("jwk", this.keys.privateKey) }; }
  static async load(s: any) {
    const k = new SoftPasskey(s.origin, s.rpId); k.id = unb(s.id); k.userHandle = s.userHandle; k.count = s.count;
    const pub = { kty: s.key.kty, crv: s.key.crv, x: s.key.x, y: s.key.y };
    k.keys = { privateKey: await crypto.subtle.importKey("jwk", s.key, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]), publicKey: await crypto.subtle.importKey("jwk", pub, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]) };
    return k;
  }
}
