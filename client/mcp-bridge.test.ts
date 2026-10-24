import { test, expect } from "bun:test";
import { createHash } from "crypto";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
test("stdio bridge detects contract changes without replaying calls, refreshes tools only after host fetch, and reads rotated credentials",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"kb-bridge-")),file=join(dir,"token");writeFileSync(file,"synthetic-one");
  let token="synthetic-one",calls=0,statuses=0;const seen:string[]=[];
  const server=Bun.serve({port:0,fetch:async req=>{
    expect(req.headers.get("authorization")).toBe("Bearer "+token);const m:any=await req.json();seen.push(m.method);
    let result:any={};if(m.method==="initialize")result={serverInfo:{name:"old"},instructions:"old brief",capabilities:{tools:{listChanged:false}}};
    if(m.method==="tools/list")result={tools:[]};
    if(m.method==="tools/call"&&m.params.name==="mcp_status"){statuses++;result={content:[{type:"text",text:JSON.stringify({tool_revision:hash('[1]'),instructions_revision:hash("new brief")})}]};}
    else if(m.method==="tools/call"){calls++;result={content:[{type:"text",text:"ok"}]};}
    return Response.json({jsonrpc:"2.0",id:m.id,result});
  }});
  const proc=Bun.spawn(["node",new URL("./mcp-stdio.mjs",import.meta.url).pathname,`http://127.0.0.1:${server.port}`,file],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  const queue:any[]=[],waiters:((m:any)=>void)[]=[];let buf="";
  const read=(async()=>{for await(const bytes of proc.stdout){buf+=new TextDecoder().decode(bytes);let i;while((i=buf.indexOf("\n"))>=0){const m=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);const w=waiters.shift();if(w)w(m);else queue.push(m);}}})();
  const next=()=>queue.length?Promise.resolve(queue.shift()):new Promise<any>((r,j)=>{const t=setTimeout(()=>j(Error("bridge didn't answer")),5000);waiters.push(m=>{clearTimeout(t);r(m);});});
  const send=(id:number,method:string,params?:any)=>{proc.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");proc.stdin.flush();};
  try {
    send(1,"initialize");expect((await next()).result.capabilities.tools.listChanged).toBe(true);
    send(2,"tools/list");await next();token="synthetic-two";writeFileSync(file,token);
    send(3,"tools/call",{name:"describe"});expect((await next()).method).toBe("notifications/tools/list_changed");
    const changed=await next();expect(changed.id).toBe(3);expect(changed.result._meta["kitebook/mcpUpdate"].instructions_changed).toBe(true);
    send(4,"tools/call",{name:"describe"});await next();expect(statuses).toBe(1);expect(calls).toBe(2);
    send(5,"tools/list");expect((await next()).id).toBe(5);expect(seen.filter(x=>x==="tools/list")).toHaveLength(2);
  }finally{proc.kill();await proc.exited;await read;server.stop(true);rmSync(dir,{recursive:true,force:true});}
},15000);
