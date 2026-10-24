// Prebuilt releases: the compiled `kitebook` binary (client/kitebook-bin.ts, built by scripts/release-build.ts in .github/workflows/release.yml)
// installs and updates itself from GitHub Releases, so nobody needs a git clone, bun or a build step.
//   ~/.kitebook-app/bin/kitebook[.exe]        what runs (KITEBOOK_APP_HOME moves the folder)
//   ~/.kitebook-app/bin/kitebook.prev[.exe]   the version before, kept for `kitebook update --rollback` and the automatic rollback
//   ~/.kitebook-app/state.json             { version, release, channel, sha256, installed_at, previous }
// A release carries one binary per platform (kitebook-<darwin|linux|windows>-<arm64|x64>[.exe]), SHA256SUMS and SHA256SUMS.sig:
//   ed25519:<public key> <signature> <release> <version>   (base64url; the signature is over
//   "relay-binary-sums:v1\nrelease <n>\nversion <v>\n" + SHA256SUMS, so the number and the name are signed too)
// The key that checks an update is the one this binary already trusts: runner.json "releaseKey" (owner-only), else the key baked in at
// build time (KITEBOOK_BUILD.key, from the release workflow), else client/release-key.ts; never a key the new release brings along. Only a
// release numbered higher than the installed one installs (no downgrade to a known bug), the same rule as the signed runner manifest.
// Channels: stable = the newest GitHub release (/releases/latest); dev = the rolling prerelease tagged "dev" that the workflow rebuilds from
// the dev branch (runner.json "updateChannel": "dev", or `kitebook update --channel dev`).
// Swap: download -> sha256 against the signed SHA256SUMS -> the new file must answer `version --json` with the signed version -> rename the
// running binary to kitebook.prev and the new one into place (rename is atomic, and a running process keeps its old file, Windows included)
// -> `__selftest` from the installed path -> otherwise rename kitebook.prev back. The runner itself restarts on the new binary only once its
// tasks are done (the restart-runner flag), so a swap never cuts a task short.
// First install trusts HTTPS to github.com (like any curl | sh); `kitebook install --sums --sig` checks this binary against the signed sums.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, chmodSync, copyFileSync, statSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { createHash, createPublicKey, verify as cverify, sign as csign } from "crypto";
import { RELEASE_KEY } from "./release-key.ts";

declare const KITEBOOK_BUILD: { version: string; release: number; channel: string; key?: string; repo?: string; selftestFail?: boolean } | undefined;
export const BUILD = typeof KITEBOOK_BUILD !== "undefined" ? KITEBOOK_BUILD : null; // set by `bun build --define KITEBOOK_BUILD=...`; null when run from source
// bun --compile serves the bundle from a virtual folder: /$bunfs/... (macOS, Linux) or B:\~BUN\... (Windows)
export const COMPILED = /^(\/\$bunfs\/|[A-Z]:[\\/]~BUN[\\/])/i.test(import.meta.path);
export const active = () => COMPILED && !!BUILD;
export const WIN = process.platform === "win32", EXE = WIN ? ".exe" : "";
export const appHome = () => process.env.KITEBOOK_APP_HOME || join(homedir(), ".kitebook-app");
export const binPath = (h = appHome()) => join(h, "bin", "kitebook" + EXE);
const prevPath = (h: string) => join(h, "bin", "kitebook.prev" + EXE), newPath = (h: string) => join(h, "bin", "kitebook.new" + EXE), stateFile = (h: string) => join(h, "state.json");
export const target = (p = process.platform, a = process.arch) => `${p === "win32" ? "windows" : p}-${a === "arm64" ? "arm64" : "x64"}`;
export const assetName = (t = target()) => `kitebook-${t}${t.startsWith("windows") ? ".exe" : ""}`;
export const legacyAssetName = (t = target()) => `relay-${t}${t.startsWith("windows") ? ".exe" : ""}`; // what releases also carry for pre-rename updaters
export const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"];
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export type BinState = { version: string; release: number; channel: string; sha256?: string; installed_at?: string; previous?: { version: string; release: number } | null };
export function state(h = appHome()): BinState | null { try { return JSON.parse(readFileSync(stateFile(h), "utf8")); } catch { return null; } }
function saveState(s: BinState, h: string) { mkdirSync(h, { recursive: true, mode: 0o700 }); writeFileSync(stateFile(h) + ".tmp", JSON.stringify(s, null, 1)); renameSync(stateFile(h) + ".tmp", stateFile(h)); }
// what runs here: the install's record when this is the installed binary, else what the binary says about itself
export const current = (h = appHome()) => state(h) ?? (BUILD ? { version: BUILD.version, release: BUILD.release, channel: BUILD.channel } : null);
export const channelOf = (cfg: any) => String(process.env.KITEBOOK_UPDATE_CHANNEL || cfg?.updateChannel || "stable") === "dev" ? "dev" : "stable";
export const repoOf = (cfg: any) => String(cfg?.releaseRepo || process.env.KITEBOOK_RELEASE_REPO || BUILD?.repo || "um1b/kitebook");
const apiOf = (cfg: any) => String(cfg?.releasesApi || process.env.KITEBOOK_RELEASES_API || "https://api.github.com").replace(/\/+$/, "");
export const keyOf = (cfg: any) => String(cfg?.releaseKey || BUILD?.key || RELEASE_KEY || "");
// Homebrew owns its own copies: brew upgrade updates them (a self-swap would fight the Cellar)
export const brewed = () => /\/Cellar\/(kitebook|relay)\//.test(process.execPath);

// ---- signatures over SHA256SUMS ----
const PFX = "ed25519:", SPKI = Buffer.from("302a300506032b6570032100", "hex");
const MSG = (rel: number, ver: string) => `relay-binary-sums:v1\nrelease ${rel}\nversion ${ver}\n`;
const pub = (s: string) => { const raw = Buffer.from(String(s).slice(PFX.length), "base64url"); if (!String(s).startsWith(PFX) || raw.length !== 32) throw new Error("release key must look like ed25519:<32 bytes, base64url>"); return createPublicKey({ key: Buffer.concat([SPKI, raw]), format: "der", type: "spki" }); };
const pubOf = (k: any) => PFX + createPublicKey(k).export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
export const signSums = (sums: string, priv: any, rel: number, ver: string) => `${pubOf(priv)} ${csign(null, Buffer.from(MSG(rel, ver) + sums), priv).toString("base64url")} ${rel} ${ver}\n`;
export function checkSums(sums: string, sig: string | null, key: string): { ok: true; release: number; version: string } | { ok: false; error: string } {
  if (!sig?.trim()) return { ok: false, error: "the release has no SHA256SUMS.sig" };
  const [k, s, r, v] = sig.trim().split(/\s+/), rel = Number(r);
  if (!k || !s || !Number.isSafeInteger(rel) || rel < 1 || !v) return { ok: false, error: "SHA256SUMS.sig is malformed" };
  if (k !== key) return { ok: false, error: `signed by ${k.slice(0, 20)}…, not the release key this install trusts` };
  try { if (!cverify(null, Buffer.from(MSG(rel, v) + sums), pub(key), Buffer.from(s, "base64url"))) return { ok: false, error: "the signature doesn't match SHA256SUMS (tampered or corrupt)" }; }
  catch (e: any) { return { ok: false, error: e.message }; }
  return { ok: true, release: rel, version: v };
}
export const parseSums = (t: string) => Object.fromEntries(t.split("\n").map(l => l.match(/^([0-9a-f]{64})\s+\*?(\S+)$/)).filter(Boolean).map(m => [m![2], m![1]]));

// ---- GitHub Releases ----
type Rel = { tag: string; notes: string | null; assets: Record<string, string> };
const get = async (u: string, json = false) => { const r = await fetch(u, { headers: { accept: json ? "application/vnd.github+json" : "application/octet-stream", "user-agent": "kitebook-updater" }, signal: AbortSignal.timeout(json ? 15_000 : 300_000), redirect: "follow" });
  if (!r.ok) throw new Error(`${u.replace(/\?.*/, "")}: HTTP ${r.status}`); return r; };
export async function latest(cfg: any): Promise<Rel> {
  const ch = channelOf(cfg), j: any = await (await get(`${apiOf(cfg)}/repos/${repoOf(cfg)}/releases/${ch === "dev" ? "tags/dev" : "latest"}`, true)).json();
  return { tag: String(j.tag_name), notes: j.html_url ?? null, assets: Object.fromEntries((j.assets ?? []).map((a: any) => [String(a.name), String(a.browser_download_url)])) };
}

// Same shapes as client/updater.ts (Check, Outcome), so Settings -> Updates, kitebook update, relay_update and automatic updates need no new paths.
export async function check(cfg: any, h = appHome()) {
  const cur = current(h), key = keyOf(cfg), at = new Date().toISOString();
  const base = { kind: "binary", channel: channelOf(cfg), current: cur?.version ?? null, current_release: cur?.release ?? 0, latest: null as string | null, latest_release: null as number | null, notes: null as string | null, key_pinned: !!key, checked_at: at };
  if (brewed()) return { ...base, state: "not_installed" as const, why: "Installed with Homebrew: update with brew upgrade kitebook." };
  let r: Rel, sums: string, sig: string | null;
  try { r = await latest(cfg); if (!r.assets.SHA256SUMS) throw new Error(`release ${r.tag} has no SHA256SUMS`);
    sums = await (await get(r.assets.SHA256SUMS)).text(); sig = r.assets["SHA256SUMS.sig"] ? await (await get(r.assets["SHA256SUMS.sig"])).text() : null; }
  catch (e: any) { return { ...base, state: "unreachable" as const, why: `couldn't read the latest release (${e.message})` }; }
  const x = { ...base, notes: r.notes, latest: sig?.trim().split(/\s+/)[3] ?? r.tag };
  if (!key) return { ...x, state: "no_key" as const, why: "This install has no release key, so it can't tell an official release from any other code by itself." };
  const c = checkSums(sums, sig, key);
  if (!c.ok) return { ...x, state: (sig ? "bad" : "unsigned") as "bad" | "unsigned", why: `release signature refused: ${c.error}` };
  const y = { ...x, latest: c.version, latest_release: c.release };
  if (c.release === cur?.release && c.version === cur?.version) return { ...y, state: "up_to_date" as const, why: null };
  if (cur && c.release <= cur.release) return { ...y, state: "older" as const, why: `release ${c.version} (${c.release}) is not newer than the installed ${cur.version} (${cur.release}); going back is refused${base.channel === "stable" && cur.channel === "dev" ? " (this install follows dev, which is ahead of stable)" : ""}` };
  if (!parseSums(sums)[assetName()] || !r.assets[assetName()]) return { ...y, state: "bad" as const, why: `release ${c.version} has no build for ${target()}` };
  return { ...y, state: "newer" as const, why: null };
}

// The new binary must load: `version --json` names exactly the signed version; after the swap `__selftest` runs from the installed path.
function probe(file: string, args: string[], want?: string): string | null {
  try { const p = Bun.spawnSync([file, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000, env: { ...process.env, KITEBOOK_TASK_ID: "" } as any });
    if (p.exitCode !== 0) return (p.stderr.toString().trim().split("\n").slice(-2).join(" ") || `exit ${p.exitCode}`).slice(0, 300);
    if (want != null) { let v = ""; try { v = JSON.parse(p.stdout.toString()).version; } catch {} if (v !== want) return `it says it is ${v || "nothing"}, not ${want}`; }
    return null; } catch (e: any) { return e.message; }
}
const lockDir = (h: string) => join(h, "update.lock");
function lock(h: string) { mkdirSync(h, { recursive: true, mode: 0o700 }); try { if (Date.now() - statSync(lockDir(h)).mtimeMs > 10 * 60_000) rmSync(lockDir(h), { recursive: true, force: true }); } catch {} try { mkdirSync(lockDir(h)); return true; } catch { return false; } }

export async function apply(cfg: any, o: { by: string; approved?: string; home?: string }) {
  const h = o.home ?? appHome(), at = new Date().toISOString(), c = await check(cfg, h);
  const done = (x: { result: "installed" | "up to date" | "refused" | "rolled back"; why: string | null; to?: string | null }) => ({ from: c.current, to: c.latest, release: c.latest_release, by: o.by, at, ...x });
  if (c.state === "up_to_date") return done({ result: "up to date", why: null, to: c.current });
  const owner = !!o.approved && o.approved === c.latest && c.state === "no_key"; // the owner's click/terminal approves an install with no key (never a bad signature)
  if (c.state !== "newer" && !owner) return done({ result: "refused", why: c.why });
  if (!lock(h)) return done({ result: "refused", why: "another update is running right now" });
  try {
    const r = await latest(cfg), sums = parseSums(await (await get(r.assets.SHA256SUMS)).text()), want = sums[assetName()];
    if (!want || !r.assets[assetName()]) return done({ result: "refused", why: `release ${c.latest} has no build for ${target()}` });
    const body = Buffer.from(await (await get(r.assets[assetName()])).arrayBuffer());
    if (sha(body) !== want) return done({ result: "refused", why: `the downloaded ${assetName()} doesn't match the signed SHA256SUMS (refused, nothing changed)` });
    mkdirSync(dirname(newPath(h)), { recursive: true }); writeFileSync(newPath(h), body, { mode: 0o755 }); chmodSync(newPath(h), 0o755);
    const pre = probe(newPath(h), ["version", "--json"], c.latest!);
    if (pre) { rmSync(newPath(h), { force: true }); return done({ result: "refused", why: `release ${c.latest} didn't start (${pre}); nothing changed` }); }
    const had = existsSync(binPath(h)), was = state(h);
    const keep = prevPath(h) + ".keep"; rmSync(keep, { force: true }); // the version before the current one, back in place if this swap is undone
    if (had) { if (existsSync(prevPath(h))) renameSync(prevPath(h), keep); renameSync(binPath(h), prevPath(h)); }
    renameSync(newPath(h), binPath(h));
    const post = probe(binPath(h), ["__selftest"]);
    if (!post) rmSync(keep, { force: true });
    else { if (had) { rmSync(binPath(h), { force: true }); renameSync(prevPath(h), binPath(h)); if (existsSync(keep)) renameSync(keep, prevPath(h)); }
      return done({ result: "rolled back", why: `release ${c.latest} failed its self-test after the swap (${post}); went back to ${c.current}` }); }
    saveState({ version: c.latest!, release: c.latest_release!, channel: c.channel, sha256: want, installed_at: at, previous: was ? { version: was.version, release: was.release } : c.current ? { version: c.current, release: c.current_release } : null }, h);
    return done({ result: "installed", why: null });
  } catch (e: any) { rmSync(newPath(h), { force: true }); return done({ result: "refused", why: e.message }); }
  finally { rmSync(lockDir(h), { recursive: true, force: true }); }
}

// kitebook update --rollback: back to the version kept before the last update (the owner's choice, so no release-number rule here)
export function rollback(h = appHome()): { ok: boolean; why: string | null; to?: string } {
  const s = state(h); if (!existsSync(prevPath(h)) || !s?.previous) return { ok: false, why: "there is no earlier version kept to go back to" };
  const err = probe(prevPath(h), ["version", "--json"], s.previous.version); if (err) return { ok: false, why: `the kept version doesn't start (${err})` };
  renameSync(binPath(h), newPath(h)); renameSync(prevPath(h), binPath(h)); renameSync(newPath(h), prevPath(h));
  saveState({ ...s.previous, channel: s.channel, installed_at: new Date().toISOString(), previous: { version: s.version, release: s.release } }, h);
  return { ok: true, why: null, to: s.previous.version };
}

// kitebook install [--sums SHA256SUMS --sig SHA256SUMS.sig] [--channel dev]: put this binary at ~/.kitebook-app/bin/kitebook (what get.sh runs after
// downloading it). With the sums it first checks the signature against the baked-in key and this file's sha256 against the signed list.
export function install(argv: string[], h = appHome()): number {
  if (!BUILD) { console.error("kitebook install runs from a release binary (a git checkout installs with scripts/get.sh)"); return 2; }
  const f = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; }, me = readFileSync(process.execPath), mine = sha(me);
  if (f("sums")) { const sums = readFileSync(f("sums")!, "utf8"), c = checkSums(sums, f("sig") ? readFileSync(f("sig")!, "utf8") : null, keyOf({}));
    if (!c.ok) { console.error(`refused: ${c.error}`); return 1; }
    if (parseSums(sums)[assetName()] !== mine) { console.error(`refused: this file's sha256 isn't the one SHA256SUMS signs for ${assetName()}`); return 1; }
    if (c.version !== BUILD.version) { console.error(`refused: the signed sums are for ${c.version}, this binary is ${BUILD.version}`); return 1; } }
  else if (keyOf({})) console.error("note: no --sums/--sig given, so only HTTPS vouches for this download (get.sh passes them)");
  mkdirSync(join(h, "bin"), { recursive: true }); if (process.execPath !== binPath(h)) { copyFileSync(process.execPath, newPath(h)); chmodSync(newPath(h), 0o755); renameSync(newPath(h), binPath(h)); }
  saveState({ version: BUILD.version, release: BUILD.release, channel: f("channel") === "dev" ? "dev" : BUILD.channel, sha256: mine, installed_at: new Date().toISOString(), previous: null }, h);
  console.log(JSON.stringify({ installed: BUILD.version, release: BUILD.release, path: binPath(h), on_path: (process.env.PATH ?? "").split(WIN ? ";" : ":").includes(dirname(binPath(h))) }));
  return 0;
}
