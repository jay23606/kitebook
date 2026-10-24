// Runner integrity: the runner runs from a pinned, read-only, versioned copy, never from a checkout builders push to.
//   ~/.kitebook/versions/<version>/   the client files + manifest.txt, files 0444, dir 0555
//   ~/.kitebook/current -> versions/<version>      what launchd starts (re-resolved on every restart)
//   ~/.kitebook/client  -> current                 back-compat for plists written by older installers
// The server serves /runner-files/manifest.txt: one `sha256  name` line per client file (sha256sum -c format), sorted.
// The version is the first 16 hex of the manifest's own sha256, so a version name pins every byte of every file.
// install.sh, `init` and `kitebook-svc update` all land here: each file is checked against the manifest before anything
// switches, a mismatch is refused and leaves `current` untouched. doctor re-checks the installed copy (tampering), and
// the guard treats any change under versions/ or to the links as a protectedFiles violation.
// Signed releases: the manifest is also signed by the release key (client/release-key.ts, or the owner's runner.json "releaseKey"),
// served as /runner-files/manifest.sig: one line `ed25519:<public key> <signature>`, both base64url, the signature over
// "relay-runner-manifest:v1\n" + manifest.txt. With a key pinned, an unsigned or badly signed manifest is refused before any file
// is fetched, so a Kitebook server (or anyone between it and this machine) can't hand out runner code the release key never signed.
// Release numbers (v2): `ed25519:<key> <signature> <release>`, the signature over "relay-runner-manifest:v2\nrelease <n>\n" + manifest.txt,
// so the number is signed too. Updates that need nobody's y (client/updater.ts) only ever move to a higher number: an older signed
// release served again (a downgrade to a known bug) is refused. A two-field v1 line still verifies, with no number.
// No key pinned = a legacy install: it still installs, with a warning. The key that checks an update is always the one already
// installed (its release-key.ts or runner.json), never one the new version brings along.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, lstatSync, readlinkSync, realpathSync, symlinkSync, renameSync, rmSync, chmodSync } from "fs";
import { join, dirname, basename, relative } from "path";
import { homedir } from "os";
import { createHash, createPublicKey, verify as cverify, sign as csign } from "crypto";
import { RELEASE_KEY } from "./release-key.ts";

export const home = () => join(homedir(), ".kitebook");
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const versionOf = (manifest: string) => sha(manifest).slice(0, 16);
const NAME = /^[a-z0-9-]+\.(?:ts|mjs)$/, VER = /^[0-9a-f]{16}$/;
export const isVersion = (v: string) => VER.test(v);

// Same text the server builds (src/start.ts): sorted by name, two spaces, trailing newline.
export const manifestText = (files: Record<string, string>) => Object.keys(files).sort().map(f => `${sha(files[f])}  ${f}\n`).join("");
export function parseManifest(txt: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of txt.split("\n").filter(Boolean)) { const m = l.match(/^([0-9a-f]{64})  (\S+)$/); if (!m || !NAME.test(m[2])) throw new Error(`bad manifest line: ${l.slice(0, 80)}`); out[m[2]] = m[1]; }
  if (!out["runner.ts"]) throw new Error("manifest has no runner.ts");
  return out;
}
const base = (url: string) => String(url).replace(/\/+$/, "");
export async function fetchManifest(url: string): Promise<{ text: string; version: string; files: Record<string, string>; sig: string | null }> {
  const r = await fetch(`${base(url)}/runner-files/manifest.txt`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${base(url)} serves no runner manifest (HTTP ${r.status}; kitebook older than pinned installs?)`);
  const text = await r.text();
  const s = await fetch(`${base(url)}/runner-files/manifest.sig`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
  return { text, version: versionOf(text), files: parseManifest(text), sig: s?.ok ? (await s.text()).trim() : null };
}

// ---- release signatures ----
const PFX = "ed25519:", SPKI = Buffer.from("302a300506032b6570032100", "hex"), MSG = "relay-runner-manifest:v1\n";
const pubKey = (s: string) => { const raw = Buffer.from(String(s).slice(PFX.length), "base64url");
  if (!String(s).startsWith(PFX) || raw.length !== 32) throw new Error(`release key must look like ${PFX}<32 bytes, base64url>`); return createPublicKey({ key: Buffer.concat([SPKI, raw]), format: "der", type: "spki" }); };
export const validKey = (s: string) => { try { pubKey(s); return true; } catch { return false; } };
export const pubOf = (k: any) => PFX + createPublicKey(k).export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
const MSG2 = (n: number) => `relay-runner-manifest:v2\nrelease ${n}\n`;
// release: the release number (sign-release.ts uses the signing time in seconds); omitted = a v1 line with no number
export const signManifest = (text: string, priv: any, release?: number) => release == null ? `${pubOf(priv)} ${csign(null, Buffer.from(MSG + text), priv).toString("base64url")}\n`
  : `${pubOf(priv)} ${csign(null, Buffer.from(MSG2(release) + text), priv).toString("base64url")} ${release}\n`;
// the next release number: the signing time in seconds, but always above the previous signature's number
export const nextRelease = (prevSig?: string | null, now = Date.now()) => Math.max(Math.floor(now / 1000), (sigRelease(prevSig) ?? 0) + 1);
// the release number a signature line claims (null: v1, unsigned, malformed). Only trust it after checkSig said ok.
export const sigRelease = (sig: string | null | undefined): number | null => { const m = String(sig ?? "").trim().match(/^ed25519:\S+ \S+ ([0-9]{1,15})$/); return m ? Number(m[1]) : null; };
// The pinned key: runner.json "releaseKey" (owner-only, protected from agents) wins, then the one this runner shipped with.
// Deliberately no env var here: a task's environment must not be able to swap the key the update path checks with.
export const releaseKey = (cfg?: any): string => String(cfg?.releaseKey || RELEASE_KEY || "");
export const BUILTIN_KEY = RELEASE_KEY;
// ok: signed by `key`. Otherwise why, in words the owner can act on.
export function checkSig(text: string, sig: string | null, key: string): { ok: boolean; error?: string; release?: number | null } {
  if (!sig) return { ok: false, error: "the manifest is unsigned (no manifest.sig)" };
  const m = sig.trim().match(/^(ed25519:[A-Za-z0-9_-]+) ([A-Za-z0-9_-]+)(?: ([0-9]{1,15}))?$/); if (!m) return { ok: false, error: "manifest.sig is malformed" };
  if (m[1] !== key) return { ok: false, error: `the manifest is signed by ${m[1].slice(0, 20)}…, not the pinned release key ${key.slice(0, 20)}…` };
  const n = m[3] == null ? null : Number(m[3]);
  try { return cverify(null, Buffer.from((n == null ? MSG : MSG2(n)) + text), pubKey(key), Buffer.from(m[2], "base64url")) ? { ok: true, release: n } : { ok: false, error: "bad signature (the manifest was changed after signing, or signed for another release)" }; }
  catch (e: any) { return { ok: false, error: `bad signature (${e.message})` }; }
}
// What install/update do with a fetched manifest: with a key, refuse unless signed by it; without one, install with a warning.
export function requireSig(m: { text: string; sig: string | null }, key: string): string | null {
  if (!key) return `note: no release key is pinned, so these runner files are trusted only because the server sent them${m.sig ? " (they are signed, but there is no key here to check the signature)" : ""}. To pin one: KITEBOOK_RELEASE_KEY=ed25519:... or "releaseKey" in runner.json`;
  const c = checkSig(m.text, m.sig, key); if (!c.ok) throw new Error(`release signature refused: ${c.error}; nothing installed`); return null;
}
// The installed copy keeps its manifest.sig, so doctor and the runner's start can re-check it with the key pinned now.
export function verifyInstalledSig(dir: string, key: string): { state: "ok" | "legacy" | "unsigned" | "bad"; error?: string } {
  if (!key) return { state: "legacy" };
  let text = "", sig: string | null = null; try { text = readFileSync(join(dir, "manifest.txt"), "utf8"); } catch {} try { sig = readFileSync(join(dir, "manifest.sig"), "utf8"); } catch {}
  const c = checkSig(text, sig, key); return c.ok ? { state: "ok" } : { state: sig ? "bad" : "unsigned", error: c.error };
}

// Check one version dir against its own manifest. The dir name must be the manifest's version, so editing the
// manifest to match a tampered file is caught too.
export function verifyDir(dir: string): { ok: boolean; version: string; files: number; problems: string[] } {
  const version = basename(dir), problems: string[] = [];
  let want: Record<string, string> = {};
  try { const txt = readFileSync(join(dir, "manifest.txt"), "utf8"); want = parseManifest(txt); if (versionOf(txt) !== version) problems.push("manifest.txt (doesn't match the version it is installed as)"); }
  catch (e: any) { return { ok: false, version, files: 0, problems: [`manifest.txt (${e.code === "ENOENT" ? "missing" : e.message})`] }; }
  for (const [f, h] of Object.entries(want)) { try { if (sha(readFileSync(join(dir, f))) !== h) problems.push(`${f} (changed)`); } catch { problems.push(`${f} (missing)`); } }
  try { for (const f of readdirSync(dir)) if (f !== "manifest.txt" && f !== "manifest.sig" && !want[f]) problems.push(`${f} (not in the manifest)`); } catch {}
  return { ok: !problems.length, version, files: Object.keys(want).length, problems };
}

// What `current` points at, and whether it still matches. installed=false: no pinned install in this home.
export function verifyInstall(h = home()) {
  const cur = join(h, "current");
  let target: string; try { target = realpathSync(cur); } catch { return { installed: false, ok: false, version: null as string | null, dir: null as string | null, files: 0, problems: [] as string[] }; }
  const r = verifyDir(target);
  if (dirname(target) !== realpathSync(join(h, "versions"))) r.problems.push(`current points outside ${join(h, "versions")} (${target})`);
  try { if (statSync(target).mode & 0o222) r.problems.push("version dir is writable (should be read-only)"); } catch {}
  return { installed: true, ...r, ok: !r.problems.length, dir: target };
}
export const isInstalledPath = (p: string, h = home()) => { try { return dirname(dirname(realpathSync(p))) === realpathSync(join(h, "versions")); } catch { return false; } };
// launchd must start `current`, not the version it happens to resolve to now (bun resolves symlinks in import.meta.path)
export const launchPath = (p: string, h = home()) => isInstalledPath(p, h) ? join(h, "current", basename(p)) : p;

const writable = (p: string) => { try { if (!existsSync(p)) return; chmodSync(p, 0o755); for (const e of readdirSync(p, { withFileTypes: true })) { const q = join(p, e.name); if (e.isDirectory()) writable(q); else if (e.isFile()) chmodSync(q, 0o644); } } catch {} };
export const rmTree = (p: string) => { if (lstatSync(p, { throwIfNoEntry: false })?.isDirectory()) writable(p); rmSync(p, { recursive: true, force: true }); };
export const installedRelease = (h = home()): number => { try { return sigRelease(readFileSync(join(h, "current", "manifest.sig"), "utf8")) ?? 0; } catch { return 0; } };
// back to a version that is still installed (rollback after a failed health check); its files are re-checked first
export function switchTo(version: string, h = home()) { const d = join(h, "versions", version); if (!isVersion(version) || !verifyDir(d).ok) throw new Error(`can't go back to ${version}: it isn't intact`); relink(join(h, "current"), join("versions", version)); }
const relink = (link: string, to: string) => { const tmp = `${link}.new-${process.pid}`; rmSync(tmp, { force: true }); symlinkSync(to, tmp); renameSync(tmp, link); }; // rename(2): atomic swap of the link itself

// Fetch the server's manifest, download + verify every file, then switch `current`. `expect`: the version the owner
// approved; anything else is refused before a byte is written. Keeps the previous version for rollback.
// `key`: the pinned release key ("" = legacy, warns); the signature is checked before a single runner file is downloaded.
// `above`: the signed release number must be higher than this (no downgrade), re-checked on what is actually installed.
export async function installVersion(url: string, o: { expect?: string; home?: string; key?: string; above?: number } = {}): Promise<{ version: string; dir: string; previous: string | null; fresh: boolean; warning: string | null }> {
  const h = o.home ?? home(), versions = join(h, "versions");
  const m = await fetchManifest(url);
  if (o.expect && m.version !== o.expect) throw new Error(`manifest mismatch: ${base(url)} serves runner version ${m.version}, but ${o.expect} was approved; nothing installed`);
  const warning = requireSig(m, o.key ?? "");
  if (o.above != null) { const n = sigRelease(m.sig); if (n == null || n <= o.above) throw new Error(`release ${n ?? "without a number"} is not newer than the installed release ${o.above}; nothing installed`); }
  mkdirSync(versions, { recursive: true, mode: 0o700 });
  const dir = join(versions, m.version), prev = verifyInstall(h).version;
  let fresh = false;
  // an existing dir is reused only if it's intact and holds this exact signature (an older unsigned copy gets the .sig)
  const sigSame = () => { try { return readFileSync(join(dir, "manifest.sig"), "utf8").trim() === (m.sig ?? ""); } catch { return !m.sig; } };
  if (!existsSync(dir) || !verifyDir(dir).ok || !sigSame()) {
    const tmp = join(versions, `.tmp-${m.version}-${process.pid}`); rmTree(tmp); mkdirSync(tmp, { recursive: true });
    try {
      for (const [f, want] of Object.entries(m.files)) {
        const r = await fetch(`${base(url)}/runner-files/${f}`, { signal: AbortSignal.timeout(30_000) });
        if (!r.ok) throw new Error(`could not download ${f} (HTTP ${r.status})`);
        const body = Buffer.from(await r.arrayBuffer()), got = sha(body);
        if (got !== want) throw new Error(`manifest mismatch: ${f} has sha256 ${got.slice(0, 16)}…, the manifest says ${want.slice(0, 16)}…; nothing installed`);
        writeFileSync(join(tmp, f), body, { mode: 0o444 });
      }
      writeFileSync(join(tmp, "manifest.txt"), m.text, { mode: 0o444 });
      if (m.sig) writeFileSync(join(tmp, "manifest.sig"), m.sig + "\n", { mode: 0o444 });
      rmTree(dir); renameSync(tmp, dir); chmodSync(dir, 0o555); fresh = true;
    } catch (e) { rmTree(tmp); throw e; }
  }
  relink(join(h, "current"), join("versions", m.version));
  const cl = join(h, "client"), st = lstatSync(cl, { throwIfNoEntry: false });
  if (!st?.isSymbolicLink()) { if (st) rmTree(cl); symlinkSync("current", cl); }
  for (const v of readdirSync(versions)) if (v !== m.version && v !== prev && (isVersion(v) || v.startsWith(".tmp-"))) rmTree(join(versions, v)); // keep current + previous
  return { version: m.version, dir, previous: prev && prev !== m.version ? prev : null, fresh, warning };
}

// One hash over the whole install (every path, mode, content, link target) for the guard's before/after check.
export function treeHash(h = home()): string {
  const lines: string[] = [];
  const walk = (p: string) => { let st; try { st = lstatSync(p); } catch { return; }
    const rel = relative(h, p);
    if (st.isSymbolicLink()) lines.push(`${rel} -> ${readlinkSync(p)}`);
    else if (st.isDirectory()) { lines.push(`${rel}/ ${st.mode & 0o777}`); for (const e of readdirSync(p).sort()) walk(join(p, e)); }
    else lines.push(`${rel} ${st.mode & 0o777} ${sha(readFileSync(p))}`); };
  for (const p of ["versions", "current", "client"]) walk(join(h, p));
  return lines.length ? sha(lines.join("\n")) : "";
}
const stampFile = (h: string) => join(h, "owner-install-stamp");
export const stampInstall = (h = home()) => { try { writeFileSync(stampFile(h), treeHash(h), { mode: 0o600 }); } catch {} };
export const installStamp = (h = home()) => { try { return readFileSync(stampFile(h), "utf8").trim(); } catch { return ""; } };
