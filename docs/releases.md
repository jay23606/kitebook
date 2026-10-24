# Prebuilt releases, updates, Homebrew and Docker

Kitebook ships as one compiled `kitebook` binary per platform on [GitHub Releases](https://github.com/um1b/kitebook/releases), so the machine that
runs the runner needs no git clone, no bun or node and no build step. The server ships as a Docker image. A git checkout stays the
developer path (and still hosts a server with `scripts/serve.sh`).

| Platform | Release file |
| --- | --- |
| macOS Apple silicon / Intel | `kitebook-darwin-arm64` / `kitebook-darwin-x64` |
| Linux x64 / arm64 | `kitebook-linux-x64` / `kitebook-linux-arm64` |
| Windows x64 | `kitebook-windows-x64.exe` |

Every release also has `SHA256SUMS` and `SHA256SUMS.sig` (an Ed25519 signature by the release key over the sums, the release number and
the version).

## What the binary is
`client/kitebook-bin.ts`, compiled with `bun build --compile`: the server CLI (`kitebook status`, ops, `kitebook kb ...`), the runner
(`kitebook runner <runner.json>`) and the self-updater. `kitebook version` says which release it is. The server (workerd + the built Worker)
isn't in it, because workerd is its own ~100 MB native program per platform; run the server from Docker or a checkout.
That is also why a Mac that hosts its own server still installs from a git checkout; that moves to the binary once the server ships
inside it (or next to it). Until then the binary is for a runner-only machine or a hand install.

## Install by hand
```bash
# pick your platform's file from the table above
curl -fsSLO https://github.com/um1b/kitebook/releases/latest/download/kitebook-darwin-arm64
curl -fsSLO https://github.com/um1b/kitebook/releases/latest/download/SHA256SUMS
curl -fsSLO https://github.com/um1b/kitebook/releases/latest/download/SHA256SUMS.sig
grep ' kitebook-darwin-arm64$' SHA256SUMS | shasum -a 256 -c -
chmod +x kitebook-darwin-arm64 && ./kitebook-darwin-arm64 install --sums SHA256SUMS --sig SHA256SUMS.sig   # -> ~/.kitebook-app/bin/kitebook
```
`kitebook install` checks the signature with the release key built into the binary and its own sha256 against the signed list, then puts
itself in `~/.kitebook-app/bin` (add that folder to your PATH). The first download is only as trustworthy as HTTPS to github.com (like any
`curl | sh`); every update after that is checked against the key this install already has.
Homebrew: `brew install um1b/tap/kitebook` (then `brew upgrade kitebook`; the self-updater leaves Homebrew installs to brew).

## Updates
- `kitebook update`: the newest release on GitHub Releases. It installs only when SHA256SUMS is signed by the release key this install
  already trusts (`runner.json` `"releaseKey"`, else the key built into the binary, never one the release brings along), the release
  number is higher than the installed one (no downgrades), and the download matches the signed sha256. The new binary has to start and
  name the signed version, then it is swapped in with a rename (the running runner keeps its old file) and must pass `kitebook __selftest`
  from its new place; otherwise the previous binary goes back by itself. The runner restarts on the new binary once its tasks are done.
- `kitebook update --check` shows what it would do; `kitebook update --rollback` goes back to the version kept from before the last update.
- Settings -> Updates shows the version, a link to the release notes and **Update now**, and "Install signed updates automatically"
  (on by default) installs signed newer releases when the runner is idle. An agent's `relay_update` installs the same, and nothing else.
- Channels: stable follows the newest release (`/releases/latest`). `kitebook update --channel dev` (or `runner.json` `"updateChannel": "dev"`)
  follows the rolling `dev` prerelease built from the dev branch; `--channel stable` goes back to following stable from the next stable
  release that is newer.
- Where releases come from can be moved for a fork or mirror: `runner.json` `"releaseRepo": "you/kitebook"` (or `"releasesApi"`).

## Docker (the server)
```bash
docker compose up -d                                     # ghcr.io/um1b/kitebook, http://127.0.0.1:7820, data in the relay-data volume
docker compose exec kitebook cat /data/admin-token          # the admin token (recovery code), made on first start unless KITEBOOK_ADMIN_TOKEN is set
TUNNEL_TOKEN=... docker compose --profile tunnel up -d   # optional public address through a Cloudflare tunnel (route it to http://kitebook:7821, the public edge listener; 7820 stays local)
```
The image is workerd with the built Worker, running as a non-root user, with a `/health` check. The runner deliberately stays native:
it drives the coding agents, repositories, git credentials and keychain on your own computer, which a container can't (and shouldn't)
reach.

## Making a release (maintainers)
`.github/workflows/release.yml` builds on every push to dev (the rolling `dev` prerelease) and on a `v*` tag (a stable release):
compiles all five binaries from one Linux runner, signs SHA256SUMS, generates `kitebook.rb` for the tap, starts each binary on its own OS
(macOS arm64 + x64, Linux arm64, Windows) and builds the server image. **Nothing is published until the repository variable
`RELEASES_ENABLED` is `true`.** One-time setup:
1. `kitebook release-key create` (keeps the private key in your keychain), then put the public key in the repository variable
   `KITEBOOK_RELEASE_PUBKEY` and the private key (PEM) in the secret `KITEBOOK_RELEASE_SIGNING_KEY`.
2. For Homebrew: create `um1b/homebrew-tap` and a token that can push to it as the secret `HOMEBREW_TAP_TOKEN`.
3. Set `RELEASES_ENABLED=true`, then `git tag v0.1.0 && git push origin v0.1.0`.

Locally: `bun scripts/release-build.ts build --version v0.1.0 --targets linux-x64` then `sign`, `verify`, `formula` (see the script's header).
