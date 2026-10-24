import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ModelDiscovery, nativeModels, parseModels, type ModelSpec } from "./agent-models.ts";
const spec: ModelSpec = { agent: "test", env: {}, cwd: "/tmp", fallback: ["old"] };
test("catalog caches/coalesces discovery, bounds repeated refresh, and preserves stale native evidence after failure", async () => {
  let now = 1_700_000_000_000, calls = 0, fail = false;
  const d = new ModelDiscovery(async () => { calls++; await Bun.sleep(1); if (fail) throw new Error("offline"); return { ids: ["new"], defaults: ["new"] }; }, () => now);
  const [a,b] = await Promise.all([d.get(spec),d.get(spec)]);
  expect(calls).toBe(1); expect(a).toEqual(b); expect(a.models).toEqual([{ id: "new", source: "native", default: true }]); expect(a.authoritative).toBe(false); expect(a.availability).toBe("unknown");
  await d.get(spec, true); expect(calls).toBe(1);
  now += 6000; fail = true; const stale = await d.get(spec, true);
  expect(stale.source).toBe("native"); expect(stale.models[0].id).toBe("new"); expect(stale.stale).toBe(true); expect(stale.checked_at).toBe(a.checked_at);
  expect((await d.get(spec)).stale).toBe(true);
  now += 900_001; fail = false; expect((await d.get(spec)).stale).toBe(false); expect(calls).toBe(3);
});
test("fallback never claims freshness/authority; configured model constraints stay authoritative; environment changes invalidate the cache", async () => {
  let calls = 0; const d = new ModelDiscovery(async () => { calls++; throw new Error("not supported"); });
  const f = await d.get(spec); expect(f).toMatchObject({ source: "fallback", checked_at: null, expires_at: null, stale: true, authoritative: false });
  expect((await d.get({ ...spec, configured: [] })).authoritative).toBe(true); expect(calls).toBe(1);
  const c = await d.get({ ...spec, configured: ["owner-model"], extra: ["extra-model"] }); expect(c.models.map(m => m.source)).toEqual(["configured","configured"]); expect(c.stale).toBe(false);
  await d.get({ ...spec, env: { HOME: "/new-account" } }); expect(calls).toBe(2);
});
test("native Codex discovery paginates, records defaults, excludes hidden models and never starts a thread/turn", async () => {
  const t = mkdtempSync(join(tmpdir(), "kb-models-")), bin = join(t,"bin"), log = join(t,"rpc.jsonl"); mkdirSync(bin);
  writeFileSync(join(bin,"codex"), `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir,"../scripts/fake-codex-app-server.ts")}'\n`, { mode: 0o755 });
  const env = { PATH: bin + ":" + process.env.PATH, HOME: t, FAKE_CODEX_LOG: log };
  const r = await nativeModels({ ...spec, agent: "codex", codex: true, cwd: t, env });
  expect(r.ids).toEqual(["gpt-fake","gpt-next"]); expect(r.defaults).toEqual(["gpt-fake"]);
  const sent = readFileSync(log,"utf8").trim().split("\n").map(x => JSON.parse(x));
  expect(sent.map(x=>x.method)).toEqual(["initialize","initialized","model/list","model/list"]); expect(sent[3].params.cursor).toBe("page-2");
  const d = new ModelDiscovery(); const f = await d.get({ ...spec, agent: "codex", codex: true, cwd: t, env: { ...env, FAKE_CODEX_MODELS_ERROR: "1" } });
  expect(f.source).toBe("fallback"); expect(f.stale).toBe(true);
});
test("native commands reject nonzero output and oversized streams; parser supports tables and ignores headings", async () => {
  expect(parseModels("sk-proj-" + "a".repeat(48))).toEqual([]);
  expect(parseModels("provider model context\nopenai latest 1000\nprovider:\nplain-id\nplain-id")).toEqual(["openai/latest","plain-id"]);
  await expect(nativeModels({ ...spec, command: [process.execPath,"-e","console.log('invalid');process.exit(2)"] })).rejects.toThrow(/failed/);
  await expect(nativeModels({ ...spec, command: [process.execPath,"-e","console.log('x'.repeat(2*1024*1024))"] })).rejects.toThrow(/exceeded/);
});
test("native commands time out rather than leaving a discovery process running", async () => {
  await expect(nativeModels({ ...spec, command: [process.execPath,"-e",`Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{stdout:"inherit",stderr:"inherit"});setInterval(()=>{},1000)`] })).rejects.toThrow(/timed out/);
}, 15_000);

test("unverified catalogs allow newer/default models while explicit catalogs and owner deny rules still restrict dispatch", async () => {
  const C = await import("./runner-ctx.ts"), A = await import("./runner-agents.ts"), prior = C.cfg;
  const agent = "catalog-fixture", catalog = await new ModelDiscovery(async()=>({ids:["old"]})).get({ ...spec, agent });
  try { C.setCfg({ agents: { [agent]: { argv: ["test-agent","{prompt}"] } }, prefs: { defaultAgent: agent, defaultModel: "new" } });
    A.MODELS[agent] = ["old"]; A.MODEL_CATALOGS[agent] = catalog;
    expect(A.checkPick(agent,"new")).toBe(null); expect(A.resolvePick({}, { agent, auto: true })).toMatchObject({agent,model:"new"});
    C.setCfg({ ...C.cfg, prefs: { deny: [agent+"/new"] } }); expect(A.checkPick(agent,"new")).toMatch(/not allowed by the owner/);
    C.setCfg({ agents: { [agent]: { argv: ["test-agent","{prompt}"] } } });
    A.MODEL_CATALOGS[agent] = { ...catalog, authoritative: true }; expect(A.checkPick(agent,"new")).toMatch(/not available/);
    A.MODELS[agent] = []; expect(A.checkPick(agent,"new")).toMatch(/advertises no models/); expect(A.checkPick(agent,null)).toBe(null);
  } finally { C.setCfg(prior); delete A.MODELS[agent]; delete A.MODEL_CATALOGS[agent]; }
});


test("successful owner list commands constrain custom agents, while failed discovery is not an authoritative empty list", async()=> {
  const a=await new ModelDiscovery(async()=>({ids:["custom"]})).get({...spec,restrict:true});expect(a.authoritative).toBe(true);
  const b=await new ModelDiscovery(async()=>{throw new Error("unavailable");}).get({...spec,restrict:true});expect(b.authoritative).toBe(false);expect(b.stale).toBe(true);
});
