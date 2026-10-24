#!/usr/bin/env bun
// Sign a runner release: the Ed25519 release key signs the runner manifest (the sha256 of every client file, exactly what the
// kitebook serves as /runner-files/manifest.txt), written to release/manifest.sig, which Kitebook bundles and serves next to it.
// Clients that pin the public key (client/release-key.ts, runner.json "releaseKey", KITEBOOK_RELEASE_KEY) refuse anything else.
//   bun scripts/sign-release.ts keygen [--key <file>]          new release key (default ~/.config/kitebook/release-key.json, 0600);
//                                                              prints the public key to put in client/release-key.ts
//   bun scripts/sign-release.ts sign   [--key <file>] [--out release/manifest.sig] [--release <n>]   sign the current client/ files
//                                                              with a release number (default: now in seconds, always above the last one),
//                                                              so installs can update to it without a y and never back to an older one
//   bun scripts/sign-release.ts check  [--pub ed25519:...] [--sig release/manifest.sig] does the signature match client/ and the key?
// Sign after every change to client/ (and after changing client/release-key.ts, which is itself a runner file), then deploy.
// The private key lives outside the repo: a key path inside this checkout is refused, so it can't be committed by accident.
import "../client/brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { generateKeyPairSync, createPrivateKey } from "crypto";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, chmodSync, realpathSync } from "fs";
import { join, resolve, dirname, relative } from "path";
import { homedir } from "os";
import { manifestText, versionOf, signManifest, checkSig, pubOf, validKey, BUILTIN_KEY, nextRelease } from "../client/integrity.ts";

const REPO = resolve(import.meta.dir, ".."), argv = process.argv.slice(2), cmd = argv[0];
const flag = (k: string) => { const i = argv.indexOf(`--${k}`); return i > 0 ? argv[i + 1] : undefined; };
const tilde = (p: string) => p.replace(/^~(?=\/|$)/, homedir());
const keyFile = resolve(tilde(flag("key") ?? process.env.KITEBOOK_RELEASE_SIGNING_KEY ?? "~/.config/kitebook/release-key.json"));
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const inRepo = (p: string) => { const r = relative(real(REPO), real(dirname(p))); return !r.startsWith("..") && !r.startsWith("/"); };
const die = (m: string) => { console.error(m); process.exit(1); };
if (inRepo(keyFile)) die(`refusing: ${keyFile} is inside the repo (${REPO}); keep the release key outside it (default ~/.config/kitebook/release-key.json)`);

// The same files the Worker bundles (src/start.ts): client/*.ts and *.mjs, minus tests.
function manifest() { const dir = join(REPO, "client"), files: Record<string, string> = {};
  for (const f of readdirSync(dir)) if (/^[a-z0-9-]+\.(?:ts|mjs)$/.test(f) && !f.endsWith(".test.ts")) files[f] = readFileSync(join(dir, f), "utf8");
  const text = manifestText(files); return { text, version: versionOf(text) }; }

if (cmd === "keygen") {
  if (existsSync(keyFile) && !argv.includes("--force")) die(`${keyFile} exists (--force replaces it; installs pinned to the old key then refuse new releases)`);
  const { privateKey } = generateKeyPairSync("ed25519"), pub = pubOf(privateKey);
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  writeFileSync(keyFile, JSON.stringify({ alg: "ed25519", use: "relay-release", public: pub, private: privateKey.export({ format: "pem", type: "pkcs8" }), created: new Date().toISOString() }, null, 1), { mode: 0o600 }); chmodSync(keyFile, 0o600);
  console.log(JSON.stringify({ key: keyFile, public: pub, next: `put it in client/release-key.ts (RELEASE_KEY = "${pub}"), or for a self-hosted Kitebook deploy with KITEBOOK_RUNNER_RELEASE_KEY=${pub}; then: bun scripts/sign-release.ts sign` }, null, 2));
} else if (cmd === "sign") {
  let k: any; try { k = JSON.parse(readFileSync(keyFile, "utf8")); } catch (e: any) { die(`can't read the release key ${keyFile}: ${e.message} (create one: bun scripts/sign-release.ts keygen)`); }
  const out = resolve(flag("out") ?? join(REPO, "release", "manifest.sig")), prev = existsSync(out) ? readFileSync(out, "utf8") : null;
  const rel = flag("release") != null ? Number(flag("release")) : nextRelease(prev); if (!Number.isSafeInteger(rel) || rel < 1) die("--release must be a positive whole number");
  const priv = createPrivateKey(String(k.private)), m = manifest(), sig = signManifest(m.text, priv, rel);
  mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, sig);
  const pub = pubOf(priv), pinned = BUILTIN_KEY;
  console.log(JSON.stringify({ signed: m.version, release: rel, key: pub, out, pinned_in_repo: pinned === pub ? true : pinned ? `no: client/release-key.ts pins ${pinned}` : "no key in client/release-key.ts (self-host: KITEBOOK_RUNNER_RELEASE_KEY)" }, null, 2));
} else if (cmd === "check") {
  const pub = flag("pub") ?? BUILTIN_KEY, sigFile = resolve(flag("sig") ?? join(REPO, "release", "manifest.sig")), m = manifest();
  if (!pub || !validKey(pub)) die(`no valid release key to check with (--pub ed25519:... or client/release-key.ts)`);
  const sig = existsSync(sigFile) ? readFileSync(sigFile, "utf8") : null, c = checkSig(m.text, sig, pub);
  console.log(JSON.stringify({ version: m.version, release: c.release ?? null, ok: c.ok, error: c.error ?? null }, null, 2)); process.exit(c.ok ? 0 : 1);
} else die("usage: bun scripts/sign-release.ts keygen | sign | check   [--key <file>] [--out <file>] [--pub ed25519:...] [--sig <file>]");
