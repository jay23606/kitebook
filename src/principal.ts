// Who is acting as the owner, and how a tenant gets its first owner device: two small seams, so a hosted module can add account sign-in
// (Google, orgs) as one more principal and swap the bootstrap without touching device keys, `kitebook open` or the presence gate.
// OSS registers exactly two owner providers (a device-minted browser session, then the legacy Better Auth session) and one claim strategy
// (the first device a tenant ever sees is its owner; after that a device waits for approval on an owner device or the server shell).
// Every device/session/presence row carries a tenant key; OSS has one tenant per account, "owner". Nothing here hard-wires that.
import { OWNER_USER } from "../client/account.ts";
export const DEFAULT_TENANT = OWNER_USER; // the tenant key is the user id (client/account.ts): today every account's only user, its owner
export type Owner = { acct: string; dir: any; via: string; cred: string; tenant: string; device?: string | null };
export interface OwnerProvider { name: string; resolve(req: Request, dir: (acct: string) => any): Promise<Owner | null> }
const providers: OwnerProvider[] = [];
// first = true: ahead of the built-in ones (a hosted module's account session); otherwise after them
export function registerOwnerProvider(p: OwnerProvider, first = false) { const i = providers.findIndex(x => x.name === p.name); if (i >= 0) providers.splice(i, 1); first ? providers.unshift(p) : providers.push(p); }
export const ownerProviders = () => providers.map(p => p.name);
export async function resolveOwner(req: Request, dir: (acct: string) => any): Promise<Owner | null> {
  for (const p of providers) { const o = await p.resolve(req, dir).catch(() => null); if (o) return o; }
  return null;
}

// Bootstrap: what a newly enrolling device becomes. ctx.ever = this tenant has had an owner device before (the gate is on for good);
// active = owner devices not revoked. "owner" enrolls it active at once; "pending" waits for approve (presence-gated) or the server shell.
export type ClaimCtx = { tenant: string; ever: boolean; active: number; peerKind: string };
export interface ClaimStrategy { name: string; decide(ctx: ClaimCtx): "owner" | "pending" }
// OSS default: the owner's Mac runner that first starts after the upgrade (or the install's own first runner) is owner device #1, so the
// upgrade never locks the owner out; every later machine is approved on an existing device (or `kitebook admin device approve` on the server).
// Only a runner token (the install was the owner's approval) can claim; it never re-opens once a tenant had an owner device.
export const firstRunnerClaim: ClaimStrategy = { name: "first-runner", decide: c => !c.ever && c.peerKind === "runner" ? "owner" : "pending" };
let claim: ClaimStrategy = firstRunnerClaim;
export const claimStrategy = () => claim;
export function setClaimStrategy(c: ClaimStrategy) { claim = c; }
