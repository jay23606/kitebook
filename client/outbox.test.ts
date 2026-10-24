import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
test("durable KB notes survive throttling and lost write responses, then replay exactly once after client restart",async()=>{
  // Separate process: no real HOME, queue or runner is touched, and unit tests can run together.
  const home=mkdtempSync(join(tmpdir(),"kb-outbox-"));
  const script=`import {enqueue,drainOutbox,depth} from ${JSON.stringify(new URL("./outbox.ts",import.meta.url).pathname)};
    import {hashOf} from ${JSON.stringify(new URL("./kb.ts",import.meta.url).pathname)};
    import {readFileSync,writeFileSync} from "fs";
    const phase=process.argv[1],stateFile=process.env.HOME+"/server.json";
    const entries=phase==="recover"?JSON.parse(readFileSync(stateFile,"utf8")):[];let adds=0;
    const call=async(op,a)=>{if(phase==="throttle")throw Error("kb_list: answered HTTP 429");if(op==="kb_list")return {entries};adds++;entries.push({id:"one",key:a.key,hash:hashOf(a.text)});writeFileSync(stateFile,JSON.stringify(entries));throw Error("fetch failed: lost response");};
    if(phase==="throttle")enqueue({text:"remember this",key:"stable"},"https://example.invalid","main");
    const result=await drainOutbox(call,"https://example.invalid","main");console.log(JSON.stringify({result,depth:depth(),adds}));`;
  const run=async(phase:string)=>{const p=Bun.spawn([process.execPath,"-e",script,phase],{env:{...process.env,HOME:home},stdout:"pipe",stderr:"pipe"});const text=await new Response(p.stdout).text(),err=await new Response(p.stderr).text();expect(await p.exited).toBe(0);if(err)throw Error(err);return JSON.parse(text);};
  try {const a=await run("throttle");expect(a.result.offline).toBe(true);expect(a.depth.outbox).toBe(1);expect(a.depth.rejected).toBe(0);
    const b=await run("lost");expect(b.adds).toBe(1);expect(b.depth.outbox).toBe(1);
    const c=await run("recover");expect(c.adds).toBe(0);expect(c.result.duplicate).toBe(1);expect(c.depth.outbox).toBe(0);
  }finally{rmSync(home,{recursive:true,force:true});}
});
