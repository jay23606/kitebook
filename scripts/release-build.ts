#!/usr/bin/env bun
// Release builds for GitHub Releases (.github/workflows/release.yml runs these; the smoke runs them against a local fake release).
//   bun scripts/release-build.ts build  --version v1.2.0 [--release <n>] [--channel stable|dev] [--targets darwin-arm64,...] [--out dist]
//                                       [--key ed25519:...] [--repo um1b/kitebook]
//        one compiled `kitebook` per target (client/kitebook-bin.ts; bun cross-compiles every platform from one Linux runner) + dist/SHA256SUMS.
//        The release number defaults to now in seconds (always rising, signed with the sums); the key is the public release key baked
//        into the binary (default: KITEBOOK_RELEASE_PUBKEY, else client/release-key.ts), which every later update is checked against.
//   bun scripts/release-build.ts sign   [--out dist] [--key-file <file>]   SHA256SUMS -> SHA256SUMS.sig with the private release key
//        (KITEBOOK_RELEASE_SIGNING_KEY: the PEM itself, as the workflow passes the secret; or --key-file / ~/.config/kitebook/release-key.json)
//   bun scripts/release-build.ts verify [--out dist] [--pub ed25519:...]    does SHA256SUMS.sig check out against the key?
//   bun scripts/release-build.ts formula [--out dist] [--repo um1b/kitebook] [--tag v1.2.0]   dist/kitebook.rb for the Homebrew tap
//        (um1b/homebrew-tap: brew install um1b/tap/kitebook, brew upgrade kitebook) and dist/relay.rb, the formula under its old name
import "../client/brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, copyFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { createHash, createPrivateKey } from "crypto";
import { TARGETS, assetName, legacyAssetName, signSums, checkSums, parseSums } from "../client/binary.ts";
import { RELEASE_KEY } from "../client/release-key.ts";
import { TAGLINE } from "../client/brand.ts";
import { releaseTag } from "./release-tag.ts";

const REPO = resolve(import.meta.dir, ".."), argv = process.argv.slice(2), cmd = argv[0];
const flag = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i > 0 ? argv[i + 1] : d; };
const die = (m: string) => { console.error(m); process.exit(1); };
const out = resolve(flag("out", join(REPO, "dist"))!), sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const info = () => { try { return JSON.parse(readFileSync(join(out, "release.json"), "utf8")); } catch { die(`no ${out}/release.json: run build first`); } };

if (cmd === "build") {
  const version = flag("version", releaseTag());
  if (!/^(v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?|dev-[0-9A-Za-z.-]+)$/.test(version!)) die(`version ${version}: use v1.2.3 or dev-<something>`);
  const release = Number(flag("release", String(Math.floor(Date.now() / 1000)))), channel = flag("channel", version!.startsWith("dev-") ? "dev" : "stable");
  if (!Number.isSafeInteger(release) || release < 1) die("--release must be a positive whole number");
  const key = flag("key", process.env.KITEBOOK_RELEASE_PUBKEY || RELEASE_KEY) ?? "", repo = flag("repo", process.env.GITHUB_REPOSITORY || "um1b/kitebook")!;
  if (!key) console.error("warning: no release key baked in (KITEBOOK_RELEASE_PUBKEY / --key): these binaries can't check updates by themselves");
  const targets = (flag("targets") ?? TARGETS.join(",")).split(",").filter(Boolean), extra = JSON.parse(process.env.KITEBOOK_BUILD_EXTRA || "{}"); // smoke-only knobs
  for (const t of targets) if (!TARGETS.includes(t)) die(`unknown target ${t} (${TARGETS.join(", ")})`);
  mkdirSync(out, { recursive: true }); const build = { version, release, channel, key, repo, ...extra };
  for (const t of targets) {
    const file = join(out, assetName(t)), p = Bun.spawnSync([process.execPath, "build", join(REPO, "client", "kitebook-bin.ts"), "--compile", `--target=bun-${t}`, "--minify-syntax",
      "--define", `KITEBOOK_BUILD=${JSON.stringify(build)}`, "--outfile", file], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) die(`build ${t} failed:\n${p.stderr.toString()}${p.stdout.toString()}`);
    console.error(`built ${assetName(t)}`);
    // the same file under its name from before the rename (relay-<target>): the updater in a pre-rename binary looks for that name, so
    // it still finds this release, installs it and the new binary renames itself (client/rebrand.ts)
    copyFileSync(file, join(out, legacyAssetName(t)));
  }
  const sums = readdirSync(out).filter(f => /^(kitebook|relay)-[a-z]+-(arm64|x64)(\.exe)?$/.test(f)).sort().map(f => `${sha(readFileSync(join(out, f)))}  ${f}\n`).join("");
  writeFileSync(join(out, "SHA256SUMS"), sums); writeFileSync(join(out, "release.json"), JSON.stringify({ version, release, channel, repo, key }, null, 1));
  console.log(JSON.stringify({ version, release, channel, out, files: Object.keys(parseSums(sums)) }));
} else if (cmd === "sign") {
  const r = info(), env = process.env.KITEBOOK_RELEASE_SIGNING_KEY, f = flag("key-file", join(homedir(), ".config", "kitebook", "release-key.json"))!;
  let pem = env && env.includes("PRIVATE KEY") ? env : null;
  if (!pem) try { const t = readFileSync(f, "utf8"); pem = t.includes("{") ? String(JSON.parse(t).private) : t; } catch { die(`no release key: set KITEBOOK_RELEASE_SIGNING_KEY (PEM) or --key-file (default ${f})`); }
  const sums = readFileSync(join(out, "SHA256SUMS"), "utf8"), sig = signSums(sums, createPrivateKey(pem!), r.release, r.version);
  if (r.key && !sig.startsWith(r.key + " ")) die(`this private key doesn't match the key baked into the binaries (${r.key}); they would refuse their own updates`);
  writeFileSync(join(out, "SHA256SUMS.sig"), sig); console.log(JSON.stringify({ signed: r.version, release: r.release, key: sig.split(" ")[0] }));
} else if (cmd === "verify") {
  const r = info(), pub = flag("pub", r.key || RELEASE_KEY)!, sums = readFileSync(join(out, "SHA256SUMS"), "utf8");
  const c = checkSums(sums, existsSync(join(out, "SHA256SUMS.sig")) ? readFileSync(join(out, "SHA256SUMS.sig"), "utf8") : null, pub);
  for (const [f, h] of Object.entries(parseSums(sums))) if (!existsSync(join(out, f)) || sha(readFileSync(join(out, f))) !== h) die(`${f} doesn't match SHA256SUMS`);
  console.log(JSON.stringify(c)); process.exit(c.ok ? 0 : 1);
} else if (cmd === "formula") {
  const r = info(), repo = flag("repo", r.repo)!, tag = flag("tag", r.version)!, sums = parseSums(readFileSync(join(out, "SHA256SUMS"), "utf8"));
  const url = (t: string) => `https://github.com/${repo}/releases/download/${tag}/${assetName(t)}`;
  const one = (t: string) => { if (!sums[assetName(t)]) die(`no ${assetName(t)} in SHA256SUMS`); return `      url "${url(t)}"\n      sha256 "${sums[assetName(t)]}"\n\n      def install\n        bin.install "${assetName(t)}" => "kitebook"\n      end`; };
  const rb = (cls: string, extra = "") => `# Generated by scripts/release-build.ts formula for ${tag}: do not edit by hand (the release workflow rewrites it).
class ${cls} < Formula
  desc "${TAGLINE.replace(/"/g, "'")}"
  homepage "https://github.com/${repo}"
  version "${tag.replace(/^v/, "")}"
  license "MIT"
${extra}
  on_macos do
    on_arm do
${one("darwin-arm64")}
    end
    on_intel do
${one("darwin-x64")}
    end
  end

  on_linux do
    on_arm do
${one("linux-arm64")}
    end
    on_intel do
${one("linux-x64")}
    end
  end

  test do
    assert_match "${tag}", shell_output("#{bin}/kitebook version")
  end
end
`;
  writeFileSync(join(out, "kitebook.rb"), rb("Kitebook", `  conflicts_with "relay", because: "relay is the same program under its old name"\n`));
  // the formula under its name from before the rename, so `brew upgrade relay` keeps working: the same binary, plus relay -> kitebook
  writeFileSync(join(out, "relay.rb"), rb("Relay", `  conflicts_with "kitebook", because: "Relay is now Kitebook (brew install um1b/tap/kitebook)"\n\n  def caveats\n    "Relay is now Kitebook: the command is kitebook (relay still works). To follow the new name: brew uninstall relay && brew install um1b/tap/kitebook"\n  end\n`)
    .replace(/bin\.install "([^"]+)" => "kitebook"/g, 'bin.install "$1" => "kitebook"\n        bin.install_symlink "kitebook" => "relay"'));
  console.log(JSON.stringify({ formula: join(out, "kitebook.rb"), legacy_formula: join(out, "relay.rb"), version: tag }));
} else die("usage: bun scripts/release-build.ts build | sign | verify | formula   (see the top of this file)");
