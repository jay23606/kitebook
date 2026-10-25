// The owner's standing permissions, runner side (client/payload.ts says what a policy holds; src/policy.ts is the server side).
// The owner sets them once on /start (Permissions), on the consent page when an app connects, or with "Always allow" on a review
// page; the browser signs each version with the owner's P-256 key. This runner acts on a policy only if:
//   - a key in runner.json "ownerKeys" signed it (pinned here: `init` pins the keys the server lists at install, like install.sh itself;
//     later ones by themselves (kitebook open) or with Trust in Settings, client/settings-sync.ts), so neither the server nor a stolen token can write one;
//   - it is for this workspace, and not older than the newest one this Mac has accepted (~/.kitebook/policy-<name>.json), so a
//     kitebook can't roll a revoked permission back.
// Then a task runs on its own only when the policy lets its sender run in its project now (not expired) AND the task carries a
// valid signature from a key the policy names for that sender (client/sign.ts verifyTask, 24 h window), or "Run tasks without asking" is on (policy.autorun, once called dev mode:
// the server's autorun key signed it, and the sender is one of the owner's own apps, still connected). Push asks unless the entry
// says push; the guard, the deploy/spend/send gate and worktree isolation are unchanged. Anything else asks the owner as before.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { createPublicKey, verify as cverify, createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { canon, policyMsg, POLICY_TYPE, standingEntry, autorunOn, sessionsOf, type PolicyEntry } from "./payload.ts";

export const fingerprint = (k: string) => createHash("sha256").update(String(k)).digest("hex").slice(0, 16).match(/..../g)!.join("-"); // = src/policy.ts
const keyOf = (k: string) => createPublicKey({ key: Buffer.from(String(k).slice(5), "base64url"), format: "der", type: "spki" });
export const validOwnerKey = (k: string) => { if (!/^p256:[A-Za-z0-9_-]{80,200}$/.test(String(k))) return false; try { return (keyOf(k) as any).asymmetricKeyDetails?.namedCurve === "prime256v1"; } catch { return false; } };
// the policy inside env when one of `pinned` signed it for `space`, else why not
export function verifyEnvelope(env: any, pinned: string[], space: string): { policy: any } | { error: string } {
  if (!env || typeof env !== "object" || typeof env.sig !== "string" || typeof env.policy !== "object") return { error: "no signed permissions" };
  const p = env.policy;
  if (p?.v !== 1 || p.type !== POLICY_TYPE || !Number.isInteger(p.seq) || typeof p.apps !== "object") return { error: "not a relay-policy v1" };
  if (p.space !== space) return { error: `signed for workspace ${p.space}, this runner is in ${space}` };
  if (!pinned.includes(env.key)) return { error: `signed by key ${fingerprint(env.key)}, which this Mac hasn't pinned (trust that browser in Settings, under Devices & passkeys)` };
  let ok = false; try { ok = cverify("sha256", Buffer.from(policyMsg(p)), { key: keyOf(env.key), dsaEncoding: "ieee-p1363" }, Buffer.from(String(env.sig), "base64url")); } catch { ok = false; }
  return ok ? { policy: p } : { error: "bad signature (changed after the owner signed it)" };
}
// Newest accepted policy per runner, so a lower seq (rollback) or a different policy at the same seq is refused.
export class PolicyStore {
  constructor(private f: string) {}
  last(): { seq: number; hash: string } | null { try { return JSON.parse(readFileSync(this.f, "utf8")); } catch { return null; } }
  accept(p: any): string | null {
    const l = this.last(), h = createHash("sha256").update(canon(p)).digest("hex");
    if (l && p.seq < l.seq) return `version ${p.seq} is older than version ${l.seq} this Mac already has (rollback refused)`;
    if (l && p.seq === l.seq && l.hash !== h) return `version ${p.seq} differs from the one this Mac accepted`;
    if (!l || p.seq > l.seq) { mkdirSync(dirname(this.f), { recursive: true }); writeFileSync(this.f, JSON.stringify({ seq: p.seq, hash: h, at: new Date().toISOString() }), { mode: 0o600 }); }
    return null;
  }
}
export const storeFor = (name: string) => new PolicyStore(join(homedir(), ".kitebook", `policy-${name}.json`));
// The enabled default applies only inside a verified, non-rolled-back owner policy.
export function sessionAccess(env: any, pinned: string[], space: string, store: PolicyStore, app: string): { level: "off" | "read" | "write"; why?: string } {
  const v = verifyEnvelope(env, pinned, space);
  if ("error" in v) return { level: "off", why: `the permissions on the server aren't usable here: ${v.error}` };
  const rb = store.accept(v.policy); if (rb) return { level: "off", why: rb };
  const level = sessionsOf(v.policy.apps?.[app]);
  return level === "off" ? { level, why: `session access for ${app} is off (Settings -> Assistants -> Agent sessions)` } : { level };
}
export type Standing = { entry: PolicyEntry; seq: number; autorun?: true } | { why: string; seq: number | null; quiet?: boolean };
// What the owner's standing permission says for this task now. quiet: the sender has no standing permission at all (ask as always).
// autorun: it comes from "Run tasks without asking" (payload.ts autorunOn), so the caller also checks that the sender is one of the owner's own, still-connected apps.
export function standingFor(env: any, pinned: string[], space: string, store: PolicyStore, from: string, project: string | null | undefined, now = Date.now()): Standing {
  if (!env) return { why: "no standing permissions", seq: null, quiet: true };
  const v = verifyEnvelope(env, pinned, space); if ("error" in v) return { why: `the permissions on the server aren't usable here: ${v.error}`, seq: null };
  const rb = store.accept(v.policy); if (rb) return { why: rb, seq: null };
  const e = v.policy.apps?.[from]; if ((!e || e.tasks !== "auto") && !autorunOn(v.policy, now) && !v.policy.autorun && !v.policy.dev) return { why: `you haven't let ${from} run tasks on its own`, seq: v.policy.seq, quiet: true };
  const a = standingEntry(v.policy, from, project, now); return "entry" in a ? { entry: a.entry, seq: v.policy.seq, ...(a.autorun ? { autorun: true as const } : {}) } : { why: a.why, seq: v.policy.seq };
}

// Pinning a browser by hand (the old owner command) is gone: a browser signed in with `kitebook open` is trusted by this Mac by itself (the link's #fragment secret proves it,
// client/settings-sync.ts), and any other browser is trusted by click in Settings -> Devices & passkeys.
export const OWNER_PIN_GONE = "That command is gone: a browser you sign in to with kitebook open is trusted by this Mac by itself. To trust another browser, open Settings (kitebook settings) -> Devices & passkeys -> Trust.";
