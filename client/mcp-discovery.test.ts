import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { callerTools, mcpStatus, mcpBaseRevision, mcp } from "../src/mcp.ts";
import { peerOps } from "../src/space/peers.ts";
import { OPS, type Res } from "../src/ops.ts";
import { sessionOps } from "../src/space/sessions.ts";

test("MCP revisions match actual caller tools, respond to permission/schema/brief changes, and never acknowledge application", async () => {
  let level = "off", text = "Owner instructions", etag = "a";
  const call = async (op: string): Promise<Res> => ({ ok: true, result: op === "whoami" ? { kind: "assistant", spaces: [{ space: "main" }] } : op === "describe" ? { sessions: { allowed: level } } : op === "brief" ? { text, etag } : { tasks: [] } });
  const s = await mcpStatus({},call); expect(s.reload_required).toBe(true); expect(s.applied).toBe(false); expect(s.tools).toEqual((await callerTools(call)).map(x=>x.name)); expect(s.tools).not.toContain("session_status");
  const known = { known_tool_revision: s.tool_revision, known_instructions_revision: s.instructions_revision };
  expect((await mcpStatus(known,call)).reload_required).toBe(false);
  level = "read"; const p = await mcpStatus(known,call); expect(p.tools_state).toBe("changed"); expect(p.instructions_state).toBe("current"); expect(p.tools).toContain("session_status");
  text = "New instructions"; etag = "b"; expect((await mcpStatus(known,call)).instructions_state).toBe("changed");
  const old = OPS.agent_models.desc; try { OPS.agent_models.desc += " revised schema"; expect((await mcpStatus(known,call)).tool_revision).not.toBe(s.tool_revision); } finally { OPS.agent_models.desc = old; }
  const init = await mcp({ method: "initialize", id: 1 },call, async()=>({result:{}})); expect(init.result._meta["kitebook/mcpUpdate"].check).toBe("mcp_status");
  expect(await mcpBaseRevision()).toMatch(/^[a-f0-9]{64}$/);
});
function fixture() {
  const db = new Database(":memory:"); db.run("create table members(peer_id text, name text, kind text, revoked integer)"); db.run("insert into members values('app','hark','assistant',0),('runner','mac','runner',0)");
  let level = "read", revoked = false, revokeInWait = false, op: any, response: any = { id: "native-id", agent: "codex", model: null }, online = true, capable = true;
  const app: any = { id: "app", name: "hark", kind: "assistant" }, runner: any = { id: "runner", name: "mac", kind: "runner" };
  const sp: any = { spaceId: "main", sql: { exec: (q: string,...a: any[]) => ({toArray:()=>db.query(q).all(...a)}) }, member:()=>({kind:"assistant",revoked:revoked?1:0}),
    need:()=>{if(revoked) throw new Error("revoked");}, metaJ:(key:string)=>key==="policy"?{policy:{apps:{hark:{sessions:level}}}}:[],metaSet:()=>{},presence:()=>({online}),
    runnerAd:async()=>({agents:["codex"],models:{codex:["legacy"]},sessions:{v:1},...(capable?{model_discovery:{v:1}}:{})}), waiters: [],
    emit:(name:string,_p:any,d:any)=>{if(name==="sessions.requested") op=d.data;}, wait:async()=>{ const q=await ops.sessions_take(runner,{id:op.id}); expect(q.op).toBe(op.op); await ops.sessions_reply(runner,{id:op.id,result:response}); if(revokeInWait) { level="off"; revokeInWait=false; }; },
  }; const ops=sessionOps.call(sp);
  return {ops,app,runner,change:(x:any)=>{if(x.level)level=x.level;if(x.revokeInWait)revokeInWait=true;if(x.revoked)revoked=true;if(x.response)response=x.response;if(x.online!==undefined)online=x.online;if(x.capable!==undefined)capable=x.capable;}, db};
}
test("session metadata is denied without read grant and withheld if grant/member is revoked while the runner answers", async()=>{
  const f=fixture(), args={agent:"codex",session_id:"native-id"};
  const s=await f.ops.session_status(f.app,args);expect(s.id).toBe("native-id");
  f.change({level:"off"});await expect(f.ops.session_status(f.app,args)).rejects.toThrow(/may not read/);
  f.change({level:"read",revokeInWait:true});await expect(f.ops.session_status(f.app,args)).rejects.toThrow(/may not read/);
  f.change({level:"read",revoked:true});await expect(f.ops.session_status(f.app,args)).rejects.toThrow(/no access/);
  f.db.close();
});
test("legacy/offline runner discovery returns explicitly stale cached evidence and models refresh does not require session access",async()=>{
  const f=fixture();f.change({level:"off",capable:false});
  const legacy=await f.ops.agent_models(f.app,{refresh:true});expect(legacy.refresh).toBe("unsupported");expect(legacy.catalogs[0]).toMatchObject({source:"legacy_unverified",stale:true,checked_at:null,authoritative:false});
  f.change({capable:true,online:false});expect((await f.ops.agent_models(f.app,{refresh:true})).refresh).toBe("offline");
  f.change({online:true,response:{catalogs:[{agent:"codex",source:"native"}]}});expect((await f.ops.agent_models(f.app,{refresh:true})).refresh).toBe("completed");f.db.close();
});


test("WebSocket callers can check the current workspace MCP contract without bypassing workspace read permission",async()=>{
  let permitted=true;const sp:any={spaceId:"main",need:()=>{if(!permitted)throw new Error("read denied");}};
  const ops=peerOps.call(sp);sp.impl={...ops,describe:async()=>({sessions:{allowed:"off"}}),brief:async()=>({text:""}),task_list:async()=>({tasks:[]})};
  const peer:any={id:"a",name:"hark",kind:"assistant"};expect((await ops.mcp_status(peer,{})).tools).toContain("agent_models");
  permitted=false;await expect(ops.mcp_status(peer,{})).rejects.toThrow(/read denied/);
});
