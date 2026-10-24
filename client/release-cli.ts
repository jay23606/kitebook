// The release key, without opening a file or copying a value: `kitebook release-key create|show|rotate` makes the Ed25519 key that signs
// runner releases and keeps the private half in the OS secret store (macOS Keychain via `security`, libsecret via `secret-tool` on Linux,
// Windows Credential Manager through PowerShell; client/platform.ts),
// else a 0600 file next to scripts/sign-release.ts's default, ~/.config/kitebook/release-key.json). In a Kitebook checkout (or with --repo) it
// also pins the public half into client/release-key.ts, and `kitebook release sign` signs that checkout's runner manifest into
// release/manifest.sig. Settings -> Releases -> Create release key asks the Mac's runner to run create (an owner-signed change,
// client/settings-sync.ts), so the private key is made on the Mac and never leaves it. KITEBOOK_KEYCHAIN=file forces the file store.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { generateKeyPairSync, createPrivateKey, createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, readdirSync, rmSync } from "fs";
import { join, resolve, dirname } from "path";
import { homedir } from "os";
import * as PL from "./platform.ts";
import { manifestText, versionOf, signManifest, pubOf, nextRelease } from "./integrity.ts";

const DIR = () => join(homedir(), ".config", "kitebook"), FILE = () => join(DIR(), "release-key.json"), PUB = () => join(DIR(), "release-key.pub");
const SVC = "dev.kitebook.release-key", ACC = "kitebook";
export const store = (): PL.Store => PL.secretStore();
const where = (s: string) => s === "file" ? FILE().replace(homedir(), "~") + " (only you can read it)" : PL.storeName(s as PL.Store);
function savePriv(pem: string, pub: string) {
  const s = store(); mkdirSync(DIR(), { recursive: true, mode: 0o700 });
  if (s === "keychain") { PL.secretDel(s, SVC, ACC); if (!PL.secretSet(s, SVC, ACC, Buffer.from(pem).toString("base64"))) throw new Error("couldn't save the key in the Keychain"); }
  else if (s === "libsecret" || s === "wincred") { if (!PL.secretSet(s, SVC, ACC, pem, "Kitebook release key")) throw new Error(`couldn't save the key in ${PL.storeName(s)}`); }
  else { writeFileSync(FILE(), JSON.stringify({ alg: "ed25519", use: "relay-release", public: pub, private: pem, created: new Date().toISOString() }, null, 1), { mode: 0o600 }); chmodSync(FILE(), 0o600); }
  writeFileSync(PUB(), pub + "\n", { mode: 0o644 }); return s;
}
function loadPriv(): string | null {
  const s = store();
  if (s === "keychain") { const v = PL.secretGet(s, SVC, ACC); if (v) return Buffer.from(v, "base64").toString("utf8"); }
  if (s === "libsecret" || s === "wincred") { const v = PL.secretGet(s, SVC, ACC); if (v) return v; }
  try { return String(JSON.parse(readFileSync(FILE(), "utf8")).private); } catch { return null; }
}
export const fingerprint = (pub: string) => createHash("sha256").update(pub).digest("hex").slice(0, 16).match(/..../g)!.join("-");
export function current(): string | null { try { const p = readFileSync(PUB(), "utf8").trim(); if (p) return p; } catch {} const k = loadPriv(); return k ? pubOf(createPrivateKey(k)) : null; }
// create (keeps an existing key unless rotate) -> the public key; the private half only ever goes into the store
export function createKey(rotate = false): { pub: string; made: boolean; store: string } {
  const have = current(); if (have && !rotate && loadPriv()) return { pub: have, made: false, store: store() };
  const { privateKey } = generateKeyPairSync("ed25519"), pub = pubOf(privateKey);
  return { pub, made: true, store: savePriv(String(privateKey.export({ format: "pem", type: "pkcs8" })), pub) };
}
// a Kitebook checkout: has client/release-key.ts and scripts/sign-release.ts
const repoOf = (flag?: string) => { const d = resolve(flag ?? process.cwd()); return existsSync(join(d, "client", "release-key.ts")) && existsSync(join(d, "scripts", "sign-release.ts")) ? d : null; };
function pin(repo: string, pub: string) { const f = join(repo, "client", "release-key.ts"), t = readFileSync(f, "utf8"), n = t.replace(/export const RELEASE_KEY = "[^"]*";/, `export const RELEASE_KEY = "${pub}";`); if (n !== t) writeFileSync(f, n); return n !== t; }
function sign(repo: string) {
  const k = loadPriv(); if (!k) throw new Error("no release key yet: make one with kitebook release-key create (or Settings -> Releases)");
  const dir = join(repo, "client"), files: Record<string, string> = {};
  for (const f of readdirSync(dir)) if (/^[a-z0-9-]+\.(?:ts|mjs)$/.test(f) && !f.endsWith(".test.ts")) files[f] = readFileSync(join(dir, f), "utf8");
  const text = manifestText(files), out = join(repo, "release", "manifest.sig"), rel = nextRelease(existsSync(out) ? readFileSync(out, "utf8") : null);
  mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, signManifest(text, createPrivateKey(k), rel));
  return { version: versionOf(text), release: rel, out };
}
// kitebook release-key create|show|rotate [--repo <dir>] | kitebook release sign [--repo <dir>]   (--json: machine output)
export async function releaseCli(argv: string[]): Promise<number> {
  const top = argv[0], cmd = top === "release" ? "sign:" + (argv[1] ?? "") : argv[1] ?? "show", i = argv.indexOf("--repo"), repo = repoOf(i > 0 ? argv[i + 1] : undefined), json = argv.includes("--json");
  const say = (o: any, line: string) => console.log(json ? JSON.stringify(o) : line);
  try {
    if (cmd === "create" || cmd === "rotate") { const r = createKey(cmd === "rotate"), pinned = repo ? pin(repo, r.pub) : false;
      say({ public: r.pub, fingerprint: fingerprint(r.pub), made: r.made, store: r.store, pinned: pinned ? join(repo!, "client", "release-key.ts") : null },
        `${r.made ? "✓ Made a release key" : "✓ You already have a release key"} (${fingerprint(r.pub)}), kept in ${where(r.store)}.\n${pinned ? `Pinned it in ${join(repo!, "client", "release-key.ts")}. ` : ""}Sign a release with: kitebook release sign${repo ? "" : " (in your Kitebook checkout)"}\nPublic key (also on Settings -> Releases): ${r.pub}`); return 0; }
    if (cmd === "show") { const p = current(); if (!p) { say({ public: null }, "No release key yet. Make one with: kitebook release-key create (or Settings -> Releases -> Create release key)"); return 1; }
      say({ public: p, fingerprint: fingerprint(p), store: store() }, `Release key ${fingerprint(p)}, kept in ${where(store())}\n${p}`); return 0; }
    if (cmd === "sign:" || cmd === "sign:sign") { if (!repo) { console.error("run this in your Kitebook checkout, or add --repo <dir>"); return 2; } const r = sign(repo);
      say({ signed: r.version, release: r.release, out: r.out, key: current() }, `✓ Signed runner release ${r.release} (${r.version}) with ${fingerprint(current()!)} -> ${r.out}. Deploy to publish it.`); return 0; }
    if (cmd === "forget" && argv.includes("--yes")) { if (store() !== "file") PL.secretDel(store(), SVC, ACC); rmSync(FILE(), { force: true }); rmSync(PUB(), { force: true }); console.log("forgot the release key"); return 0; }
  } catch (e: any) { console.error(e.message); return 1; }
  console.error("usage: kitebook release-key create | show | rotate [--repo <dir>]   ·   kitebook release sign [--repo <dir>]"); return 2;
}
