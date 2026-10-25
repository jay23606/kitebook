// connect-any-app: connect by name / pairing names, redirect rules, the short aliases, and the pairing helper's answer (no real keys)
import { test, expect } from "bun:test";
import { connName, redirectWhy, redirectKey, shortAlias } from "../src/named.ts";
import { helperAnswer, PAIR_ACTION } from "./device.ts";
import { setupState } from "../src/onboarding.ts";

test("daily-assistant setup needs a connected app and shared context, without a runner or coding task", () => {
  expect(setupState(null)).toMatchObject({ agent: false, shared: false, all: false });
  expect(setupState({ spaces: [{ peers: [{ kind: "runner", online: true }], done_tasks: 1, has_shared: true }] })).toMatchObject({ mac: true, agent: false, task: true, all: false });
  expect(setupState({ spaces: [{ peers: [{ kind: "assistant", never_connected: true }], has_shared: true }] }).all).toBe(false);
  expect(setupState({ spaces: [{ peers: [{ kind: "assistant", never_connected: false }] }] })).toMatchObject({ agent: true, shared: false, all: false });
  expect(setupState({ spaces: [{ peers: [{ kind: "assistant", never_connected: false }], has_shared: true }] })).toEqual({ mac: false, agent: true, shared: true, task: false, all: true });
  expect(setupState({ spaces: [{ peers: [{ kind: "coding_agent", never_connected: false }], has_shared: true }] }).all).toBe(true);
});

test("names: <agent>-<name>, slugged, one of them alone, max 40", () => {
  expect(connName("Muse", "Luna")).toBe("muse-luna"); expect(connName("hark", "Hark")).toBe("hark-hark");
  expect(connName("muse", "")).toBe("muse"); expect(connName("", "My Bot!")).toBe("my-bot"); expect(connName("a".repeat(30), "b".repeat(30)).length).toBe(40);
});
test("redirects: https or loopback http only; a loopback port may change", () => {
  expect(redirectWhy("https://muse.example.com/cb")).toBeNull(); expect(redirectWhy("http://127.0.0.1:5555/cb")).toBeNull();
  expect(redirectWhy("http://evil.example/cb")).toContain("https"); expect(redirectWhy("nope")).toContain("full address");
  expect(redirectKey("http://127.0.0.1:1/cb")).toBe(redirectKey("http://127.0.0.1:2/cb")); expect(redirectKey("https://a.example/cb")).not.toBe(redirectKey("https://b.example/cb"));
  expect(shortAlias("/token")).toEqual({ acct: "root", path: "/api/auth/oauth2/token" }); expect(shortAlias("/u/erin/authorize")).toEqual({ acct: "erin", path: "/u/erin/api/auth/oauth2/authorize" }); expect(shortAlias("/tokens")).toBeNull();
});
test("pairing helper: signs only a pairing code, only for an active device, password or shortcut", async () => {
  const s: any = { slot: "x", account: "root", id: "d_1", state: "active" }, signed: string[] = [];
  const sign = { password: async (pw: string, m: string) => { if (pw !== "right") throw new Error("wrong master password"); signed.push(m); return "sig"; }, shortcut: async () => null };
  expect((await helperAnswer(s, { action: "consent:x", password: "right" }, sign)).ok).toBe(false);
  expect((await helperAnswer({ ...s, state: "pending" }, { action: "device_grant:ABCD-EFGH", password: "right" }, sign)).ok).toBe(false);
  expect((await helperAnswer(s, { action: "device_grant:ABCD-EFGH", password: "nope" }, sign)).error).toBe("wrong master password");
  expect((await helperAnswer(s, { action: "device_grant:ABCD-EFGH", shortcut: true }, sign)).ok).toBe(false);
  const ok = await helperAnswer(s, { action: "device_grant:ABCD-EFGH", password: "right" }, sign);
  expect(ok.ok).toBe(true); const p = JSON.parse(Buffer.from(ok.presence!.split(".")[0], "base64url").toString());
  expect(p).toMatchObject({ k: "presence", a: "root", d: "d_1", act: "device_grant:ABCD-EFGH" }); expect(signed[0].startsWith("kitebook-presence:v1.")).toBe(true);
  expect(PAIR_ACTION.test("device_grant:abcd-efgh")).toBe(false);
});

// Prefer host-managed integrations; the device fallback must still lead with named pairing rather than the legacy grant.
test("agent guide prefers native integration, then named pairing before the legacy client_id device grant", async () => {
  const { guide } = await import("../src/guide.ts"), g = guide("https://kb.example");
  const c = g.indexOf("https://kb.example/connect"), id = g.indexOf("client_id=");
  expect(c).toBeGreaterThan(0); expect(id).toBeGreaterThan(c);
  const native = g.indexOf("Prefer your platform's native connection");
  expect(native).toBeGreaterThan(0); expect(native).toBeLessThan(c);
  const line = g.split("\n").find(l => l.startsWith("- No token yet?"))!;
  expect(line.indexOf("/connect")).toBeLessThan(line.indexOf("device_authorization")); expect(line).toMatch(/Legacy/);
});
