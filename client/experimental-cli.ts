// kitebook experimental [status|on|off] (old name: kitebook dev): Experimental from the owner's terminal (secondary: the switch in Settings
// -> More -> Experimental is the way). The switch is part of the owner's policy, which only a browser this Mac trusts can sign, so `on` /
// `off` open Settings signed in (kitebook settings) at the switch; `status` reads the policy from the server and checks its signature
// against the browsers this Mac trusts (runner.json ownerKeys), so it says what this Mac will actually do, not just what the server claims.
// It also says how "Run tasks without asking" stands: that is a separate switch (a permission), which Experimental never turns on.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, existsSync } from "fs";
import { verifyEnvelope } from "./policy.ts";
import { autorunOn, autorunEnded, experimentalOn } from "./payload.ts";

export async function experimentalCli(cfgPath: string, argv: string[]): Promise<number> {
  const sub = argv[0] ?? "status";
  if (sub === "on" || sub === "off") {
    console.log(`Experimental is one switch in Settings (More -> Experimental). Opening Settings so you can turn it ${sub}:`);
    const L = await import("./local-approve.ts"); return await L.openCli([...argv.slice(1), "--settings"]);
  }
  if (sub !== "status") { console.error("usage: kitebook experimental [status|on|off]"); return 2; }
  if (!existsSync(cfgPath)) { console.error(`kitebook: no runner config at ${cfgPath} (install the runner from your Kitebook's /start, Connect your Mac; or --config <runner.json>)`); return 1; }
  const c = JSON.parse(readFileSync(cfgPath, "utf8"));
  let r: any; try { const res = await fetch(`${String(c.url).replace(/\/$/, "")}/v1/policy`, { method: "POST", headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" }, body: JSON.stringify({ space: c.space }) });
    const j: any = await res.json(); if (!j.ok) throw new Error(j.error); r = j.result; } catch (e: any) { console.error(`kitebook experimental: couldn't read your settings from the server (${e.message})`); return 1; }
  if (!r.envelope) { console.log("Experimental is off. Turn it on in Settings (kitebook experimental on).\nRun tasks without asking is off."); return 0; }
  const v = verifyEnvelope(r.envelope, Array.isArray(c.ownerKeys) ? c.ownerKeys.map(String) : [], c.space);
  if ("error" in v) { console.log(`This Mac can't use the settings on the server (${v.error}), so Experimental is off here and it asks you for every task.`); return 0; }
  const x = experimentalOn(v.policy), d = autorunOn(v.policy);
  console.log(x ? `Experimental is on${x.ci ? " (Test every push on)" : ""}. Turn it off with kitebook experimental off.` : "Experimental is off. Turn it on in Settings (kitebook experimental on).");
  console.log(d ? `Run tasks without asking is on${d.until ? ` until ${new Date(d.until).toLocaleString()}` : ""}: tasks from your own connected apps start without asking (a separate switch at the top of Settings).`
    : autorunEnded(v.policy) ? "Run tasks without asking is off (it turned itself off at the time you picked)." : "Run tasks without asking is off.");
  return 0;
}
