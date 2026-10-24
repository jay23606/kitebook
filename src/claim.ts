// How a remote-hosted Kitebook gets its owner (auth spec v2, "PROPOSED" server-claim bootstrap, owner 2026-10-21): the server starts
// UNCLAIMED and serves only /health and the rate-limited claim endpoints. The owner's laptop runs `kitebook login <url>`: it sends its
// device + presence public keys and both sides show the same short code; the owner approves it ON THE SERVER'S SHELL
// (`kitebook owner approve <code>`, the ADMIN_TOKEN), never first-come. The laptop becomes owner device #1 and the claim closes for good;
// `kitebook owner reset` on the server shell reopens it (recovery). A PaaS without a shell sets KITEBOOK_OWNER_CLAIM at deploy: a secret
// the laptop presents once (`kitebook login <url> --secret`), burned on first use.
// The strategy sits behind this interface so a hosted module can swap it (account sign-up replaces the server-shell claim) without touching
// device keys, join, `kitebook open` or the presence gate. src/join.ts does the work; this file only says WHEN a server is claimable.
export interface ClaimBootstrap {
  name: string;
  // this server starts unclaimed: until its first claim, everything but /health, /claim/* and the shell's /admin/claim_* answers 404
  unclaimedGate(env: any): boolean;
  // the single-use deploy secret (PaaS without a shell), or null
  secret(env: any): string | null;
}
const on = (v: any) => ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());
// OSS default. Opt-in (KITEBOOK_CLAIM=1, or a KITEBOOK_OWNER_CLAIM secret) so a laptop/Mac install, whose own first runner is owner
// device #1 (src/principal.ts firstRunnerClaim), and every existing server keep working unchanged.
export const serverShellClaim: ClaimBootstrap = {
  name: "server-shell",
  unclaimedGate: env => on(env?.KITEBOOK_CLAIM ?? env?.CLAIM_MODE) || !!serverShellClaim.secret(env),
  secret: env => { const s = String(env?.OWNER_CLAIM ?? env?.KITEBOOK_OWNER_CLAIM ?? "").trim(); return s.length >= 16 ? s : null; }, // shorter is a typo, not a secret
};
let boot: ClaimBootstrap = serverShellClaim;
export const claimBootstrap = () => boot;
export function setClaimBootstrap(b: ClaimBootstrap) { boot = b; }
