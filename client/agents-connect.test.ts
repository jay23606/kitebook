// Isolated profiles and fake CLIs: no credentials or user configuration are read.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
const unixTest = test.skipIf(process.platform === "win32"); // fake executables use POSIX shebangs and Unix file modes
const root = mkdtempSync(join(tmpdir(),"kb-connect-"));
const fixture = async (agents: string[], seed?: (h:string)=>void, button?: "valid" | "forged") => {
 const h = mkdtempSync(join(root,"home-")), bin=join(h,"bin"); mkdirSync(bin); mkdirSync(join(h,"codex")); seed?.(h);
 const script = `#!${process.execPath}
const fs=require("fs"),a=process.argv.slice(2),name=require("path").basename(process.argv[1]);fs.appendFileSync(process.env.CLI_LOG,JSON.stringify({name,args:a})+"\\n");
 if(a[0]==="--help")console.log("pi mcp add <server>");
 if(name==="codex"&&a[1]==="add")fs.appendFileSync(process.env.CODEX_HOME+"/config.toml",'\\n[mcp_servers.kitebook]\\nurl = '+JSON.stringify(a[a.indexOf("--url")+1])+'\\n');
`;
 for(const b of ["pi","codex","claude","cursor-agent","gemini","opencode","copilot","grok"])writeFileSync(join(bin,b),script,{mode:0o700});
 let minted=0; const server=Bun.serve({port:0,fetch(req){if(new URL(req.url).pathname==="/v1/agent_connect"){minted++;return Response.json({ok:true,result:{peer:"test-agent",token:"rk.synthetic-fixture-token"}})}return Response.json({ok:false,error:"not enrolled"})}});
 let code=`const {connect}=await import(${JSON.stringify(join(import.meta.dir,"agents-connect.ts"))});console.log(JSON.stringify(await connect({url:process.env.FIXTURE_URL,token:"runner-fixture",space:"main"},${JSON.stringify(agents)})))`;
 if(button)code=`const {syncOnce}=await import(${JSON.stringify(join(import.meta.dir,"settings-sync.ts"))});const {cmdMsg}=await import(${JSON.stringify(join(import.meta.dir,"payload.ts"))});const fs=require("fs"),kp=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]),pub="p256:"+Buffer.from(await crypto.subtle.exportKey("spki",kp.publicKey)).toString("base64url"),cmd={v:1,type:"relay-owner-cmd",id:"cmd_button_test01",space:"main",runner:"mac",at:Date.now(),do:"connect_agent",agent:"pi"};
 const env={cmd,key:pub,sig:Buffer.from(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},kp.privateKey,new TextEncoder().encode(cmdMsg(cmd)))).toString("base64url")};${button === "forged" ? 'env.cmd.agent="claude";' : ''}
 const cfgPath=process.env.HOME+"/runner-fixture.json";fs.writeFileSync(cfgPath,JSON.stringify({url:process.env.FIXTURE_URL,token:"runner-fixture",space:"main",ownerKeys:[pub]}));let report;
 await syncOnce({cfgPath,name:"mac",space:"main",call:async(op,a)=>{if(op==="policy")return {cmds:[env],owner_keys:[],update_requests:[]};if(op==="settings_report")report=a.settings;return {}},log:()=>{},audit:()=>{},stamp:()=>{},darwin:false});console.log(JSON.stringify(report));`;
 const child=Bun.spawn([process.execPath,"-e",code],{env:{...process.env,HOME:h,CODEX_HOME:join(h,"codex"),COPILOT_HOME:join(h,"copilot"),PATH:bin+":"+process.env.PATH,CLI_LOG:join(h,"cli.jsonl"),FIXTURE_URL:server.url.origin},stdout:"pipe",stderr:"pipe"});
 try {const out=await new Response(child.stdout).text(),err=await new Response(child.stderr).text();expect(await child.exited).toBe(0);expect(err).toBe("");expect(out).not.toContain("rk.synthetic");return {h,minted,result:JSON.parse(out)}}finally{server.stop(true)}
};
unixTest("all setup adapters register in an isolated profile; Codex works without a shell token export",async()=>{
 const {h,result,minted}=await fixture(["pi","codex","claude","cursor","gemini","opencode","copilot","grok"],h=>{mkdirSync(join(h,".gemini"));writeFileSync(join(h,".gemini/settings.json"),JSON.stringify({theme:"kept",mcpServers:{other:{url:"http://other"}}}));writeFileSync(join(h,"codex/config.toml"),'model = "keep-me"\n')});
 expect(result.failed).toEqual([]);expect(result.ok).toHaveLength(8);expect(minted).toBe(8);
 const c:any=Bun.TOML.parse(readFileSync(join(h,"codex/config.toml"),"utf8"));expect(c.model).toBe("keep-me");expect(c.mcp_servers.kitebook.bearer_token_env_var).toBeUndefined();expect(c.mcp_servers.kitebook.http_headers.Authorization).toBe("Bearer rk.synthetic-fixture-token");expect(statSync(join(h,"codex/config.toml")).mode&0o777).toBe(0o600);
 const g=JSON.parse(readFileSync(join(h,".gemini/settings.json"),"utf8"));expect(g.theme).toBe("kept");expect(g.mcpServers.other.url).toBe("http://other");expect(g.mcpServers.kitebook.httpUrl).toContain("/mcp");expect(statSync(join(h,".gemini/settings.json")).mode&0o777).toBe(0o600);
 for(const [file,box]of [[".cursor/mcp.json","mcpServers"],[".config/opencode/opencode.json","mcp"],["copilot/mcp-config.json","mcpServers"]])expect(JSON.parse(readFileSync(join(h,file),"utf8"))[box].kitebook.headers.Authorization).toBe("Bearer rk.synthetic-fixture-token");
 rmSync(h,{recursive:true,force:true});
});
unixTest("malformed config refuses setup before minting or rotating any token",async()=>{
 for(const text of ["{broken", "[]", '{"mcpServers":[]}', '{"mcpServers":"wrong"}']){const {h,result,minted}=await fixture(["gemini"],h=>{mkdirSync(join(h,".gemini"));writeFileSync(join(h,".gemini/settings.json"),text)});expect(minted).toBe(0);expect(result.failed).toHaveLength(1);expect(readFileSync(join(h,".gemini/settings.json"),"utf8")).toBe(text);rmSync(h,{recursive:true,force:true})}
 const {h,minted,result}=await fixture(["codex"],h=>writeFileSync(join(h,"codex/config.toml"),'model = ['));expect(minted).toBe(0);expect(result.failed).toHaveLength(1);rmSync(h,{recursive:true,force:true});
});

unixTest("the settings button bridge verifies the owner's signed command before setup",async()=>{
 const valid=await fixture(["pi"],undefined,"valid");expect(valid.minted).toBe(1);expect(valid.result.done[0]).toMatchObject({do:"connect_agent",ok:true});expect(readFileSync(join(valid.h,".kitebook/agents-connected.json"),"utf8")).toContain('"pi"');rmSync(valid.h,{recursive:true,force:true});
 const forged=await fixture(["pi"],undefined,"forged");expect(forged.minted).toBe(0);expect(forged.result.done[0]).toMatchObject({do:"connect_agent",ok:false});expect(forged.result.done[0].msg).toContain("bad signature");rmSync(forged.h,{recursive:true,force:true});
});
