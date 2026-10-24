// Identity providers: the ways a person proves who they are to an account, behind one interface, so Teams / a hosted Kitebook can add
// OIDC, GitHub or a trusted proxy header as one more provider instead of a new code path (research/auth-selfhosted-to-hosted.md,
// "Pluggable identity provider"). OSS registers exactly today's three, each a thin adapter over the code that already does the work, so
// nothing about how they behave changes:
//   device           a device-minted browser session (kitebook open's cookie, src/devices.ts sessGet): who is signed in, on which machine
//   master-password  a presence assertion signed on an owner device by its master-password key, or its optional Touch ID / Windows Hello
//                    shortcut (src/devices.ts assert): a human confirming one action on that device
//   passkey          a phone's passkey approval for one action (src/passkey.ts verify)
// factor says what a proof is good for: "session" answers who is signed in; "presence" confirms one named action and is single use.
// A proof always names the account (the Dir it was checked in) and the user (the tenant key on the device row; today the owner).
import { OWNER_USER } from "../client/account.ts";

export type Subject = { account: string; user: string; via: string; device: string | null; session?: string; method?: string };
export type Proof = { ok: true; subject: Subject } | { ok: false; why: string };
export interface IdentityProvider<I = any> {
  kind: string;
  factor: "session" | "presence";
  // dir: the account's Dir stub (its .acct is not readable over RPC, so the caller names the account)
  verify(dir: any, account: string, input: I): Promise<Proof>;
}
const no = (why: string): Proof => ({ ok: false, why });
// the user a device belongs to (its tenant); a device row without one is the owner's
const userOf = async (dir: any, device: string | null | undefined) => { try { const t = device ? await dir.dev("tenantOf", device) : null; return typeof t === "string" && t ? t : OWNER_USER; } catch { return OWNER_USER; } };

export const deviceIdp: IdentityProvider<{ secret: string }> = { kind: "device", factor: "session",
  async verify(dir, account, a) { const s = await dir.dev("sessGet", a?.secret).catch(() => null); if (!s) return no("no live device session");
    return { ok: true, subject: { account, user: s.tenant || OWNER_USER, via: "device", device: s.device ?? null, session: s.id } }; } };
export const masterPasswordIdp: IdentityProvider<{ assertion: string; action: string; peer?: string | null }> = { kind: "master-password", factor: "presence",
  async verify(dir, account, a) { const r = await dir.dev("assert", a?.assertion, a?.action, a?.peer ?? null).catch((e: any) => ({ ok: false, why: String(e?.message ?? e) }));
    if (!r?.ok) return no(r?.why ?? "presence refused");
    return { ok: true, subject: { account, user: await userOf(dir, r.device), via: "master-password", device: r.device ?? null, method: r.by } }; } };
export const passkeyIdp: IdentityProvider<{ action: string; origin: string; cred: any }> = { kind: "passkey", factor: "presence",
  async verify(dir, account, a) { const r = await dir.pk("verify", { action: a?.action, origin: a?.origin, cred: a?.cred }).catch((e: any) => ({ ok: false, why: String(e?.message ?? e) }));
    if (!r?.ok) return no(r?.why ?? "passkey refused");
    return { ok: true, subject: { account, user: await userOf(dir, r.device), via: "passkey", device: r.device ?? null } }; } };

const providers = new Map<string, IdentityProvider>([[deviceIdp.kind, deviceIdp], [masterPasswordIdp.kind, masterPasswordIdp], [passkeyIdp.kind, passkeyIdp]]);
// a hosted module adds one (oidc, github, trusted-header); registering an existing kind replaces it
export function registerIdentityProvider(p: IdentityProvider) { providers.set(p.kind, p); }
export const identityProvider = (kind: string) => providers.get(kind) ?? null;
export const identityProviders = () => [...providers.values()].map(p => ({ kind: p.kind, factor: p.factor }));
