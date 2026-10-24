// Relay -> Kitebook: what an install from before the rename keeps (client/brand.ts env, client/rebrand.ts folders, job text, the relay shim)
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, existsSync, readlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { aliasEnv, DEPRECATION } from "./brand.ts";
import { moveDir, dirPairs, rewritePaths, jobText, jobObj, shimText, migrateCommands } from "./rebrand.ts";

test("RELAY_* env names still work; a KITEBOOK_* value wins", () => {
  const e: Record<string, string | undefined> = { RELAY_URL: "http://old", RELAY_TOKEN: "t1", KITEBOOK_TOKEN: "t2", OTHER: "x" };
  aliasEnv(e);
  expect(e.KITEBOOK_URL).toBe("http://old"); expect(e.KITEBOOK_TOKEN).toBe("t2"); expect(e.RELAY_URL).toBe("http://old"); expect(e.KITEBOOK_OTHER).toBeUndefined();
});

test("a folder moves to its new name and the old name links to it; a folder both names have is merged", () => {
  const h = mkdtempSync(join(tmpdir(), "rb-")), o = join(h, ".relay-runner"), n = join(h, ".kitebook");
  mkdirSync(join(o, "versions"), { recursive: true }); writeFileSync(join(o, "runner.json"), "{}");
  expect(moveDir(o, n)).toBe("moved");
  expect(lstatSync(o).isSymbolicLink()).toBe(true); expect(readFileSync(join(o, "runner.json"), "utf8")).toBe("{}"); expect(existsSync(join(n, "versions"))).toBe(true);
  expect(moveDir(o, n)).toBeNull(); // already a link: nothing to do
  const o2 = join(h, ".relay"), n2 = join(h, ".kitebook-kb"); mkdirSync(join(o2, "kb"), { recursive: true }); mkdirSync(join(n2, "outbox"), { recursive: true });
  expect(moveDir(o2, n2)).toBe("merged"); expect(existsSync(join(n2, "kb"))).toBe(true); expect(readlinkSync(o2)).toBe(n2);
  expect(dirPairs(h, {}, "linux").map(p => p[0].slice(h.length).replace(/\\/g, "/"))).toEqual(["/.relay-runner", "/.relay-server", "/.relay-app", "/.relay-node", "/.config/relay", "/.local/state/relay", "/.relay"]);
});

test("paths into moved folders and the job's names are carried over; a folder that stayed keeps its path", () => {
  const h = mkdtempSync(join(tmpdir(), "rb-")); mkdirSync(join(h, ".relay-app")); expect(moveDir(join(h, ".relay-app"), join(h, ".kitebook-app"))).toBe("moved");
  mkdirSync(join(h, ".relay-server")); // not moved (still a real folder)
  const plist = `<key>Label</key><string>dev.relay.server</string><string>${join(h, ".relay-app", "scripts", "serve.sh")}</string><key>RELAY_DATA</key><string>${join(h, ".relay-server")}</string>` +
    `<string>${join(h, "Library", "Logs", "relay-server.log")}</string><string>${join(h, ".relay-application")}</string>`;
  const t = jobText(plist, h);
  expect(t).toContain("<string>dev.kitebook.server</string>"); expect(t).toContain(join(h, ".kitebook-app", "scripts", "serve.sh")); expect(t).toContain("<key>KITEBOOK_DATA</key>");
  expect(t).toContain(`<string>${join(h, ".relay-server")}</string>`); expect(t).toContain("kitebook-server.log"); expect(t).toContain(join(h, ".relay-application"));
  expect(rewritePaths(`"source": "~/.relay-app"`, h)).toBe(`"source": "~/.kitebook-app"`);
  const unit = jobText(`Description=Relay server\nExecStart="/b/bun" "${join(h, ".relay-app", "scripts", "serve.ts")}"\nEnvironment="RELAY_DATA=/d"\n`, h);
  expect(unit).toContain("Description=Kitebook server"); expect(unit).toContain(join(h, ".kitebook-app", "scripts", "serve.ts")); expect(unit).toContain(`Environment="KITEBOOK_DATA=/d"`);
  const j = jobObj({ argv: ["/b/bun", join(h, ".relay-app", "client", "runner.ts")], env: { RELAY_SERVICE: "supervise", PATH: "/x" }, log: join(h, ".local", "state", "relay", "relay-runner.log") }, h);
  expect(j.argv[1]).toBe(join(h, ".kitebook-app", "client", "runner.ts")); expect(j.env).toEqual({ KITEBOOK_SERVICE: "supervise", PATH: "/x" }); expect(j.log).toEndWith("kitebook-runner.log");
});

test("the relay command becomes kitebook, and relay a one-line shim; a relay that isn't ours is left alone", () => {
  const d = mkdtempSync(join(tmpdir(), "rb-")), o = join(d, "relay");
  writeFileSync(o, `#!/bin/sh\n# Relay CLI, installed by http://127.0.0.1:7820/install.sh (scripts/get.sh): relay help\nexport RELAY_RUNNER_CONFIG="\${RELAY_RUNNER_CONFIG:-/h/.relay-runner/runner.json}"\nexec "/b/bun" "/a/client/cli.ts" "$@"\n`);
  expect(migrateCommands(() => {}, [d], "linux").length).toBe(1);
  const k = readFileSync(join(d, "kitebook"), "utf8"), s = readFileSync(o, "utf8");
  expect(k).toStartWith("#!/bin/sh\n# Kitebook CLI"); expect(k).toContain("KITEBOOK_RUNNER_CONFIG"); expect(k).toContain("kitebook help"); expect(k).toContain('exec "/b/bun" "/a/client/cli.ts" "$@"');
  expect(s).toBe(shimText(join(d, "kitebook"), "linux").text); expect(s).toContain(DEPRECATION); expect(s).toContain(`exec "${join(d, "kitebook")}" "$@"`);
  expect(migrateCommands(() => {}, [d], "linux").length).toBe(0); // already a shim
  const d2 = mkdtempSync(join(tmpdir(), "rb-")); writeFileSync(join(d2, "relay"), "#!/bin/sh\necho someone else's relay\n");
  expect(migrateCommands(() => {}, [d2], "linux").length).toBe(0); expect(existsSync(join(d2, "kitebook"))).toBe(false);
  expect(shimText("C:\\K\\kitebook.cmd", "win32").text).toContain('"C:\\K\\kitebook.cmd" %*');
});
