// The Kitebook release key: the Ed25519 public key that signs /runner-files/manifest.sig (scripts/sign-release.ts).
// install.sh (embedded by the server), `runner.ts init`, `kitebook-svc update` and doctor refuse a manifest that this key didn't sign.
// Empty = no key pinned yet (legacy: the manifest is trusted only because the server serves it, with a warning).
// Self-hosters pin their own key instead: runner.json "releaseKey" (owner-only), KITEBOOK_RELEASE_KEY for install.sh / init,
// or KITEBOOK_RUNNER_RELEASE_KEY at deploy (embedded into the server's install.sh). The private key never lives in this repo.
// No imports: the Worker (src/start.ts) reads this too.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
export const RELEASE_KEY = "";
