// scripts/serve.sh for every OS (Windows has no bash): Kitebook's production server on one machine, the built Worker on plain workerd
// (selfhost/config.capnp). Never `cf dev`, which also serves this folder. Data lives outside the folder ($KITEBOOK_DATA, default ~/.kitebook-server).
//   bun scripts/serve.ts          build if the bundle is missing or older than the sources, then serve on 127.0.0.1:$PORT (default 7820, local)
//                                 and 127.0.0.1:$KITEBOOK_EDGE_PORT (default PORT+1: the public edge a tunnel points at; src/ingress.ts)
//   bun scripts/serve.ts build    only (re)build when needed
// The admin token comes from .dev.vars (mode 600) into workerd's environment, never argv. scripts/get.ps1 (Windows) and get.sh on Linux run
// this under Kitebook's service manager (kitebook-server: systemd --user, or client/supervise.ts with a logon task).
import "../client/brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, existsSync, mkdirSync, statSync, readdirSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { homedir, tmpdir } from "os";

const root = join(dirname(import.meta.path), ".."); process.chdir(root);
const port = process.env.PORT || "7820", edge = process.env.KITEBOOK_EDGE_PORT || String(Number(port) + 1), data = process.env.KITEBOOK_DATA || join(homedir(), ".kitebook-server");
const bundle = join(".cloudflare", "output", "v0", "workers", "default", "bundle", "index.js");
const newest = (p: string): number => { try { const s = statSync(p); return s.isDirectory() ? Math.max(0, ...readdirSync(p).map(f => newest(join(p, f)))) : s.mtimeMs; } catch { return 0; } };
const stale = () => !existsSync(bundle) || Math.max(...["src", "client", "cloudflare.config.ts", "vite.config.ts", "package-lock.json", "selfhost"].map(newest)) > statSync(bundle).mtimeMs;
if (stale()) {
  console.log("building the kitebook bundle (cf build)");
  // cf is a node script (#!/usr/bin/env node): run it with node on every OS (Windows can't run a shebang file)
  const log = join(tmpdir(), "kitebook-build.log"), b = Bun.spawnSync(["node", join(root, "node_modules", "cf", "bin", "cf"), "build"], { stdout: Bun.file(log), stderr: Bun.file(log), windowsHide: true } as any);
  if (b.exitCode) { console.log(`cf build failed (see ${log})`); if (!existsSync(bundle)) process.exit(1); console.log("serving the previous bundle"); }
}
if (process.argv[2] === "build") process.exit(0);
const T = (() => { try { return readFileSync(".dev.vars", "utf8").match(/^ADMIN_TOKEN=(.*)$/m)?.[1]?.trim(); } catch { return ""; } })();
if (!T) { console.error(`no ADMIN_TOKEN in ${join(root, ".dev.vars")}`); process.exit(1); }
for (const d of ["do", "blobs"]) mkdirSync(join(data, d), { recursive: true }); try { chmodSync(data, 0o700); } catch {}
// workerd's own binary: the npm package's main export is its path (node_modules/@cloudflare/workerd-<os>-<arch>/bin/workerd[.exe])
const wd: string = (await import("workerd" as string)).default;
const p = Bun.spawn([wd, "serve", join("selfhost", "config.capnp"), "--experimental",
  "--directory-path", `relay-do=${join(data, "do")}`, "--directory-path", `relay-blobs=${join(data, "blobs")}`, "--socket-addr", `http=127.0.0.1:${port}`, "--socket-addr", `edge=127.0.0.1:${edge}`],
  { stdout: "inherit", stderr: "inherit", env: { ...process.env, KITEBOOK_ADMIN_TOKEN: T }, windowsHide: true } as any);
for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => { p.kill(); process.exit(0); });
process.exit(await p.exited);
