# Install options, planned releases and Docker

## Available now

The current install path is the [source-based installer](../README.md#quick-start), which installs the runtime and builds Kitebook from a git checkout. A checkout can also host the server with [`scripts/serve.sh`](../scripts/serve.sh).

Availability checked on **2026-10-24**: [GitHub Releases](https://github.com/um1b/kitebook/releases) contains the `v0.0.1` preview with no binary assets. Prebuilt binaries, a Homebrew tap and an automatically published server image are planned distribution paths, not prerequisites or advertised downloads for this preview. This public checkout includes local build helpers and a Dockerfile, but no `.github/workflows/release.yml` publishing workflow. Check the release's actual assets before attempting a binary install.

## Planned binaries and Homebrew

[`scripts/release-build.ts`](../scripts/release-build.ts) can compile the CLI/runner, generate checksums, sign them and generate a Homebrew formula. The intended artifacts are:

| Platform | Build output |
| --- | --- |
| macOS Apple silicon / Intel | `kitebook-darwin-arm64` / `kitebook-darwin-x64` |
| Linux x64 / arm64 | `kitebook-linux-x64` / `kitebook-linux-arm64` |
| Windows x64 | `kitebook-windows-x64.exe` |

These are output names, not a claim that downloadable files exist. A future published release must also supply `SHA256SUMS` and `SHA256SUMS.sig`. Until those exist, use the source installer rather than `/releases/latest/download/...` or `brew install um1b/tap/kitebook`.

The compiled [`client/kitebook-bin.ts`](../client/kitebook-bin.ts) contains the CLI, runner and binary self-updater. It does not contain the server or workerd, so a runner-only binary would still need a separately hosted server.

## Updates

Stable source releases use UTC date tags: `vYYYY.MM.DD`, for example `v2026.10.25`. Further releases on the same day use `.2`, `.3`, and so on. Promotion fetches existing tags, publishes the tested `dev` commit to `main` and creates its date tag atomically. Existing tags are retained. Binary builds use a current UTC date tag when `--version` is omitted; explicit historical versions remain supported. Signed increasing numeric release counters, rather than tag string comparisons, continue to prevent downgrade/replay.

The CI `check` job runs typecheck, unit tests and the complete isolated runtime smoke on `dev` and pull requests. Promotion still requires that exact commit's CI result and a verified real-Mac run; calendar tagging does not bypass either gate.

- **Source installs, available now:** `kitebook update` moves the existing checkout to its followed channel (`main` for stable, `dev` when selected), checks the new runner/server and rolls back on failure. Settings → Updates exposes the same update path. See [runner updates](runner.md#safe-updates).
- **Binary installs, after publication:** the implemented updater verifies the pinned release key, signed checksums, an increasing release number and the new binary's self-test before replacing the old binary. These checks do not make missing release assets available. Homebrew-managed installs would update through Homebrew.

## Docker: build from source

The [`Dockerfile`](../Dockerfile) and [`docker-compose.yml`](../docker-compose.yml) build the server locally. From a source checkout, build it before starting it; do not rely on a published `ghcr.io/um1b/kitebook` tag:

```bash
docker compose build kitebook
docker compose up --pull never -d kitebook
```

The existing Compose file tags the local build with the registry-style name. `--pull never` uses that local image. The dashboard listens at `http://127.0.0.1:7820`; data stays in the `relay-data` volume. If you need the server's recovery code, read `/data/admin-token` inside the `kitebook` container privately; never share it with an assistant.

For public access, configure the optional `tunnel` profile with your Cloudflare tunnel token and route its hostname to `http://kitebook:7821`, the public edge listener. Port 7820 stays local. See [storage and ingress](storage.md) before exposing a server.

The image runs workerd and the built Worker as a non-root user, with a `/health` check. The runner stays native on your computer because it needs your coding agents, repositories and OS credentials. Starting a server container alone does not install a runner.

## Preparing publication (maintainers)

Local tooling is implemented; release automation still needs to be supplied and verified. For example, from a checkout with Bun installed:

```bash
bun scripts/release-build.ts build --version v0.1.0 --targets linux-x64
```

The helper also provides `sign`, `verify` and `formula` commands; see its header for arguments. Signing requires a maintainer-controlled release key. Never commit or post private signing material.

Before advertising packages, publish and verify the binary assets plus signed sums, test downloads and updates on the target operating systems, create and test the Homebrew tap, and publish/test the server image tags. Merely setting `RELEASES_ENABLED=true` or pushing a tag cannot publish anything without a configured workflow.
