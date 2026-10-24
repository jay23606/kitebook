// A phone as an approval device with a PASSKEY (phone-approve part 2, owner 2026-10-23 12:42): WebAuthn, the phone's platform
// authenticator, unlocked with the phone's own PIN / password / fingerprint / face (user verification required). Not the Better Auth
// sign-in passkey (src/auth.ts): this one only approves, like `kitebook confirm`, and needs no session.
//   enroll   the phone's page (/device?add=passkey) makes a credential for this Kitebook's host; the server keeps its PUBLIC key (SPKI) in
//            passkeys and an owner-device row (devices: via "passkey", no peer, no runner) once the OWNER approved the enrollment code
//            (XXXX-XXXX) with the master password (typed on the phone, checked by the Mac: src/remote-pw.ts) or `kitebook approve CODE`
//            on the Mac. Until then it approves nothing. Revoked like any device (Settings -> Devices): its row goes revoked=1.
//   approve  a single-use challenge bound to exactly one action (device_grant:<code> | confirm:<code>): challenge = random nonce stored
//            here with that action, 2 minutes; the assertion must be for this host (rpIdHash), from this origin (clientData.origin),
//            user-present AND user-verified, signed by an active passkey device's key over authenticatorData || sha256(clientDataJSON).
import { DEFAULT_TENANT } from "./principal.ts";

export const PASSKEY_SCHEMA = `
create table if not exists passkeys(device text primary key, cred_id text unique, spki text, sign_count integer default 0, created integer);
create table if not exists passkey_enroll(id text primary key, tenant text, code text unique, challenge text, cred_id text, spki text, name text, state text, device text, expires integer);
create table if not exists passkey_challenges(ch text primary key, action text, expires integer);`;
export const ENROLL_TTL = 10 * 60_000, CHALLENGE_TTL = 2 * 60_000;
const UC = "BCDFGHJKLMNPQRSTVWXZ";
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const b64ud = (s: string) => { const t = String(s ?? "").replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(t + "=".repeat((4 - t.length % 4) % 4)), c => c.charCodeAt(0)); };
const rnd = (n: number) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const sha = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));
const te = new TextEncoder();
const init = (d: any) => { for (const q of PASSKEY_SCHEMA.split(";").map(x => x.trim()).filter(Boolean)) d.sql.exec(q); };
const clean = (s: any, n = 40) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").trim().slice(0, n);
export const rpIdOf = (origin: string) => { try { return new URL(origin).hostname; } catch { return ""; } };
// ECDSA DER (SEQUENCE{INTEGER r, INTEGER s}) -> raw r||s (WebCrypto's format)
export function derToRaw(der: Uint8Array): Uint8Array | null {
  try { if (der[0] !== 0x30) return null; let i = 2; if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
    const out = new Uint8Array(64);
    for (let k = 0; k < 2; k++) { if (der[i] !== 0x02) return null; const len = der[i + 1]; let v = der.slice(i + 2, i + 2 + len); i += 2 + len;
      while (v.length > 32 && v[0] === 0) v = v.slice(1); if (v.length > 32) return null; out.set(v, k * 32 + (32 - v.length)); }
    return out; } catch { return null; }
}
const clientData = (b64: string) => { try { return JSON.parse(new TextDecoder().decode(b64ud(b64))); } catch { return null; } };

export const passkeyFns: Record<string, (d: any, ...a: any[]) => Promise<any>> = {
  // the phone starts: a code for the owner to approve and a challenge for navigator.credentials.create
  async begin(d, a: { tenant?: string; name?: string }) { init(d); const t = Date.now(); d.sql.exec("delete from passkey_enroll where expires<?", t - ENROLL_TTL);
    if (Number((d.sql.exec("select count(*) n from passkey_enroll where state in ('new','waiting') and expires>?", t).one() as any).n) >= 5) throw new Error("too many passkeys waiting for approval; finish or wait 10 minutes");
    const c = [...crypto.getRandomValues(new Uint8Array(8))].map(b => UC[b % UC.length]).join(""), code = `${c.slice(0, 4)}-${c.slice(4)}`, id = "pk_" + rnd(12), challenge = rnd(32);
    d.sql.exec("insert into passkey_enroll(id, tenant, code, challenge, name, state, expires) values(?,?,?,?,?, 'new', ?)", id, a.tenant ?? DEFAULT_TENANT, code, challenge, clean(a.name) || "Phone (passkey)", t + ENROLL_TTL);
    return { id, code, challenge, user_id: b64u(te.encode(d.acct + ":approver")), expires: t + ENROLL_TTL };
  },
  // the credential it made: clientData must be webauthn.create for that challenge and this origin; the key must be a P-256 SPKI
  async finish(d, a: { id: string; cred_id: string; spki: string; client_data: string; origin: string }) { init(d);
    const r = d.sql.exec("select * from passkey_enroll where id=? and state='new' and expires>?", String(a.id ?? ""), Date.now()).toArray()[0] as any; if (!r) throw new Error("that passkey request expired; start again");
    const cd = clientData(a.client_data); if (cd?.type !== "webauthn.create" || cd.challenge !== r.challenge || cd.origin !== a.origin) throw new Error("the passkey wasn't made for this request or this page");
    if (!/^[A-Za-z0-9_-]{16,400}$/.test(String(a.cred_id ?? ""))) throw new Error("bad credential id");
    try { await crypto.subtle.importKey("spki", b64ud(a.spki), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]); } catch { throw new Error("the passkey's key isn't P-256 (ES256); this phone can't be added"); }
    d.sql.exec("update passkey_enroll set cred_id=?, spki=?, state='waiting' where id=?", a.cred_id, a.spki, r.id);
    return { id: r.id, code: r.code, state: "waiting" };
  },
  async pending(d, code: string) { init(d); const r = d.sql.exec("select id, code, name, expires from passkey_enroll where code=? and state='waiting' and expires>?", String(code ?? ""), Date.now()).toArray()[0] as any; return r ?? null; },
  // the owner approved the code (presence checked by the caller, src/oauth.ts): the passkey becomes an owner device
  async approve(d, code: string) { init(d);
    const r = d.sql.exec("select * from passkey_enroll where code=? and state='waiting' and expires>?", String(code ?? ""), Date.now()).toArray()[0] as any; if (!r) throw new Error("no passkey waits with that code");
    const id = "dv_" + rnd(12), t = Date.now();
    d.sql.exec("insert into devices(id, tenant, name, os, pubkey, presence_key, peer, state, via, created, last_seen) values(?,?,?,?,?,null,null,'active','passkey',?,?)", id, r.tenant, r.name, "Passkey", "webauthn:" + r.cred_id, t, t);
    d.sql.exec("insert into passkeys(device, cred_id, spki, sign_count, created) values(?,?,?,0,?)", id, r.cred_id, r.spki, t);
    d.sql.exec("update passkey_enroll set state='active', device=? where id=?", id, r.id);
    return { device: id, name: r.name, code: r.code };
  },
  async state(d, id: string) { init(d); const r = d.sql.exec("select state, device, code, expires from passkey_enroll where id=?", String(id ?? "")).toArray()[0] as any;
    return { state: !r ? "unknown" : r.state !== "active" && r.expires < Date.now() ? "expired" : r.state, device: r?.device ?? null, cred_id: null }; },
  // a challenge for exactly one approval; allow = the active passkeys' credential ids
  async challenge(d, a: { action: string; tenant?: string }) { init(d); const t = Date.now(); d.sql.exec("delete from passkey_challenges where expires<?", t);
    const allow = (d.sql.exec("select p.cred_id from passkeys p join devices v on v.id=p.device where v.revoked=0 and v.state='active' and v.tenant=?", a.tenant ?? DEFAULT_TENANT).toArray() as any[]).map(r => r.cred_id as string);
    if (!allow.length) return { challenge: null, allow };
    const ch = rnd(32); d.sql.exec("insert into passkey_challenges values(?,?,?)", ch, clean(a.action, 80), t + CHALLENGE_TTL); return { challenge: ch, allow };
  },
  // verify an assertion for `action`: {ok, device} or {ok:false, why}. The challenge is used up whatever the outcome.
  async verify(d, a: { action: string; origin: string; cred: { id: string; client_data: string; auth_data: string; sig: string } }) { init(d);
    const c = a.cred ?? ({} as any), cd = clientData(c.client_data); if (cd?.type !== "webauthn.get" || typeof cd.challenge !== "string") return { ok: false, why: "not a passkey approval" };
    const ch = d.sql.exec("select * from passkey_challenges where ch=?", cd.challenge).toArray()[0] as any; d.sql.exec("delete from passkey_challenges where ch=?", cd.challenge);
    if (!ch || ch.expires < Date.now()) return { ok: false, why: "that passkey request expired; try again" };
    if (ch.action !== a.action) return { ok: false, why: "that passkey approval was for something else" };
    if (cd.origin !== a.origin) return { ok: false, why: "made on another page" };
    const pk = d.sql.exec("select p.*, v.revoked, v.state, v.id vid from passkeys p join devices v on v.id=p.device where p.cred_id=?", String(c.id ?? "")).toArray()[0] as any;
    if (!pk || pk.revoked || pk.state !== "active") return { ok: false, why: "that passkey isn't an approval device of this Kitebook (removed?)" };
    let auth: Uint8Array, sig: Uint8Array | null; try { auth = b64ud(c.auth_data); sig = derToRaw(b64ud(c.sig)); } catch { return { ok: false, why: "bad passkey answer" }; }
    if (auth.length < 37 || !sig) return { ok: false, why: "bad passkey answer" };
    const rp = await sha(te.encode(rpIdOf(a.origin))); if (rp.some((x, i) => x !== auth[i])) return { ok: false, why: "the passkey is for another site" };
    if ((auth[32] & 0x05) !== 0x05) return { ok: false, why: "the phone didn't verify it's you (its PIN, password, fingerprint or face)" };
    const msg = new Uint8Array(auth.length + 32); msg.set(auth); msg.set(await sha(b64ud(c.client_data)), auth.length);
    let good = false; try { const k = await crypto.subtle.importKey("spki", b64ud(pk.spki), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]); good = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, sig, msg); } catch {}
    if (!good) return { ok: false, why: "bad passkey signature" };
    const cnt = (auth[33] << 24 | auth[34] << 16 | auth[35] << 8 | auth[36]) >>> 0; // a cloned authenticator shows as a counter going back (0 = the phone doesn't count)
    if (cnt && pk.sign_count && cnt <= pk.sign_count) return { ok: false, why: "this passkey's counter went backwards (a copied passkey?); remove it in Settings and add it again" };
    d.sql.exec("update passkeys set sign_count=? where device=?", cnt, pk.device); d.sql.exec("update devices set last_seen=? where id=?", Date.now(), pk.device);
    return { ok: true, device: pk.device };
  },
};
