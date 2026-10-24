// The built-in tunnel's per-OS parts (client/tunnel.ts): which pinned cloudflared each OS downloads, and where this computer's server is.
import { test, expect } from "bun:test";
import * as T from "./tunnel.ts";

test("a pinned, sha256-checked cloudflared for every OS the one-step installers support (Windows on Arm runs the x64 build)", () => {
  for (const [p, a, k] of [["darwin", "arm64", "darwin-arm64"], ["darwin", "x64", "darwin-amd64"], ["linux", "x64", "linux-amd64"], ["linux", "arm64", "linux-arm64"], ["win32", "x64", "windows-amd64"], ["win32", "arm64", "windows-amd64"]]) {
    expect(T.platformKey(p, a)).toBe(k); const as = T.CLOUDFLARED.assets[k]; expect(as.sha256).toMatch(/^[0-9a-f]{64}$/); expect(as.bin).toMatch(/^[0-9a-f]{64}$/); }
  expect(T.CLOUDFLARED.assets["windows-amd64"].file).toBe("cloudflared-windows-amd64.exe");
});
test("serverOf: the port and checkout from runner.json (server.health, else a local url), else tunnel.json, else 7820", () => {
  expect(T.serverOf({ url: "http://127.0.0.1:7830", server: { dir: "C:\\Users\\a\\.kitebook-app", health: "http://127.0.0.1:7830/health" } }, {})).toEqual({ port: 7830, dir: "C:\\Users\\a\\.kitebook-app" });
  expect(T.serverOf({ url: "http://localhost:7999" }, {})).toEqual({ port: 7999, dir: null });
  expect(T.serverOf({ url: "https://kb.example.com" }, { port: 7821, serverDir: "/srv/kb" })).toEqual({ port: 7821, dir: "/srv/kb" });
  expect(T.serverOf({}, {}).port).toBe(Number(process.env.PORT ?? 7820) || 7820);
});
test("public access off: the helper still counts as running (it waits for the switch with cloudflared stopped)", () => {
  const s: any = { mode: "off", state: "stopped", supervisor: process.pid }; expect(T.supervisorUp(s)).toBe(true); expect(T.describe(s).ok).toBe(true);
  expect(T.supervisorUp({ ...s, mode: "quick" })).toBe(false); expect(T.supervisorUp({ ...s, supervisor: 2 ** 22 + 12345 })).toBe(false);
});
