// Real retry/GC/alarm methods, synthetic SQLite + failing adapters. No Cloudflare account or network.
import { test, expect, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const { SpaceEvents } = await import("../src/space/events.ts"), { SpaceGc } = await import("../src/space/gc.ts"), { SpaceCore } = await import("../src/space/core.ts");
function fixture(proto: any) {
  const db = new Database(":memory:"); db.run("create table meta(k text primary key,v text);create table blobs(sha text primary key,size integer,loc text);create table changes(sha text,path text);create table blob_gc(sha text primary key,marked integer);create table blob_put(sha text primary key,at integer,size integer);create table outbox(id integer primary key,kind text,target text,lo integer,seq integer,body text,extra text,attempts integer default 0,next_at integer,last_error text,created text)");
  const alarms: number[] = [], sp = Object.create(proto);
  sp.env = {};sp.sql = { exec: (q: string,...a: any[]) => {const rows = db.query(q).all(...a);return {toArray:()=>rows,one:()=>rows[0]};} };
  sp.ctx = {id:{toString:()=>"test-object"},storage:{transactionSync:(fn:()=>any)=>fn(),getAlarm:async()=>null,setAlarm:async(at:number)=>{alarms.push(at);}}};
  sp.putting=new Map();sp.sweeping=new Map();sp.member=()=>({webhook:"https://example.com"});
  return {db,sp,alarms};
}
test("unexpected webhook exceptions advance durable backoff and terminate after the normal finite budget",async()=>{
  const {db,sp}=fixture(SpaceEvents.prototype);sp.peerPost=async()=>{throw new Error("synthetic adapter failure");};
  db.run("insert into outbox(id,kind,target,lo,seq,body,next_at) values(1,'peer','app',1,1,'{}',0)");
  for(let n=1;n<=8;n++) {const before=Date.now();await sp.outboxRun();const row:any=db.query("select * from outbox").get();if(n<8){expect(row.attempts).toBe(n);expect(row.next_at).toBeGreaterThan(before+1000);db.run("update outbox set next_at=0");}else expect(row).toBe(null);}
  db.run("insert into outbox(id,kind,target,lo,seq,body,next_at) values(2,'peer','app',1,1,'bad json',0)");await sp.outboxRun();expect((db.query("select attempts from outbox").get() as any).attempts).toBe(1);db.close();
});
test("blob deletion failure keeps the orphan retry durable and at least one minute away, including zero GC grace",async()=>{
  const {db,sp,alarms}=fixture(SpaceGc.prototype);sp.env.BLOB_GC_GRACE_SEC="0";let calls=0;
  sp.store={unref:async()=>{},refs:async()=>0,del:async()=>{calls++;throw new Error("storage down");}};
  db.run("insert into meta values('id','test')");db.run("insert into blob_put values('orphan',0,42)");
  const before=Date.now();await sp.gc();expect(calls).toBe(1);expect(sp.gcDue()).toBeGreaterThanOrEqual(before+60000);expect(alarms[0]).toBeGreaterThanOrEqual(before+60000);
  await sp.gc();expect(calls).toBe(1);expect((db.query("select size from blob_put").get() as any).size).toBe(42);db.close();
});
test("alarm scheduler ignores invalid deadlines and floors overdue work",async()=>{
  const {sp,alarms,db}=fixture(SpaceCore.prototype);await sp.armAlarm(Infinity);await sp.armAlarm(NaN);expect(alarms).toHaveLength(0);
  const before=Date.now();await sp.armAlarm(0);expect(alarms[0]).toBeGreaterThanOrEqual(before+1000);db.close();
});

test("storage retry circuit survives object reconstruction and stops after eight failed sweeps until operator resumes",async()=>{
  const {db,sp}=fixture(SpaceGc.prototype);sp.env.BLOB_GC_GRACE_SEC="0";let calls=0;
  sp.store={unref:async()=>{},refs:async()=>0,del:async()=>{calls++;throw Error("storage unavailable");}};
  db.run("insert into blob_put values('orphan',0,42)");
  for(let i=1;i<=8;i++) {await sp.gc();expect(calls).toBe(i);expect(sp.gcStats().retry_failures).toBe(i);
    expect(sp.gcDue()).toBeGreaterThan(Date.now());db.run("update meta set v='0' where k='gc_retry_at'");db.run("update blob_put set at=0");}
  const restarted=Object.assign(Object.create(SpaceGc.prototype),sp);await restarted.gc();expect(calls).toBe(8);expect(restarted.gcDue()).toBe(Infinity);expect(restarted.gcStats().retry_paused).toBe(true);
  restarted.store.del=async()=>{calls++;};await restarted.gc(0,true);expect(calls).toBe(9);expect(restarted.gcStats().retry_paused).toBe(false);expect((db.query("select count(*) n from blob_put").get() as any).n).toBe(0);db.close();
});

test("overlapping GC invocations share the sweep and cannot reset each other's durable failure counter",async()=>{
  const {db,sp}=fixture(SpaceGc.prototype);sp.env.BLOB_GC_GRACE_SEC="0";let calls=0,release!:()=>void;
  const gate=new Promise<void>(r=>release=r);sp.store={unref:async()=>{},refs:async()=>0,del:async()=>{calls++;await gate;throw Error("storage down");}};
  db.run("insert into blob_put values('orphan',0,1)");const a=sp.gc(),b=sp.gc();expect(a).toBe(b);release();await a;
  expect(calls).toBe(1);expect(sp.gcStats().retry_failures).toBe(1);db.close();
});

test("server dispatch and peer capabilities preserve catalog provenance and owner restrictions",async()=>{
  const {SpaceTasks}=await import("../src/space/tasks.ts"),{db,sp}=fixture(SpaceTasks.prototype);let authoritative=false;
  sp.blobAt=()=>"ad";sp.content=async()=>JSON.stringify({agents:["codex"],default_agent:"codex",models:{codex:["older-model"]},model_catalogs:{codex:{authoritative,source:"native"}}});
  try {await sp.checkAgentModel("mac",{agent:"codex",model:"new-model"});expect((await sp.runnerCaps("mac")).model_catalogs.codex.authoritative).toBe(false);
    authoritative=true;await expect(sp.checkAgentModel("mac",{agent:"codex",model:"new-model"})).rejects.toThrow("models: older-model");
  }finally{db.close();}
});
test("duplicate runner-failure deliveries cannot consume retries twice, and the task stops at its retry limit",async()=>{
  const {SpaceTasks}=await import("../src/space/tasks.ts"),{db,sp}=fixture(SpaceTasks.prototype);let events=0;
  db.run("create table tasks(id text primary key,state text,attempt integer,max_retries integer,attempts text,result text,updated text,held_since text,held_acc integer);create table task_live(task_id text)");
  db.run("insert into tasks(id,state,attempt,max_retries) values('job','running',1,2)");
  sp.sql.exec=(q:string,...a:any[])=>{const rows=db.query(q).all(...a),n=(db.query("select changes() n").get() as any).n;return {toArray:()=>rows,one:()=>rows[0],rowsWritten:n};};
  sp.loadTask=()=>{const t:any=db.query("select * from tasks where id='job'").get();return {...t,attempts:JSON.parse(t.attempts??"[]")};};
  sp.emit=()=>{events++;};sp.setState=(_t:any,state:string)=>db.query("update tasks set state=? where id='job'").run(state);
  try {const first=sp.loadTask();sp.failOrRetry(first,{id:"runner"},{summary:"crashed",reason:"runner_crash"},{},["running"]);
    expect(sp.loadTask().attempt).toBe(2);expect(events).toBe(2);
    expect(()=>sp.failOrRetry(first,{id:"runner"},{summary:"duplicate",reason:"runner_crash"},{},["running"])).toThrow("task is queued");expect(sp.loadTask().attempt).toBe(2);expect(events).toBe(2);
    db.run("update tasks set state='running'");sp.failOrRetry(sp.loadTask(),{}, {summary:"again",reason:"runner_crash"},{},["running"]);expect(sp.loadTask().attempt).toBe(3);
    db.run("update tasks set state='running'");sp.failOrRetry(sp.loadTask(),{}, {summary:"last",reason:"runner_crash"},{},["running"]);expect(sp.loadTask().state).toBe("failed");expect(events).toBe(4);
  }finally{db.close();}
});

test("SSE slots remain occupied during graceful close and stalled readers are actually aborted",async()=>{
  const {sp,db}=fixture(SpaceEvents.prototype);sp.evStreams=new Map();sp.evStreamSeq=0;sp.evType=()=>({inputSchema:{properties:{}}});sp.evAuthorize=()=>({});sp.evStart=()=>({from:0,truncated:false});sp.evHead=()=>0;
  sp.evNum=(key:string,d:number)=>key==="EVENTS_STREAM_MAX_MS"?10:key==="EVENTS_MAX_STREAMS"?1:d;
  const first=sp.evStream({id:"reader"},1,{}),reader=first.body!.getReader(),closed=reader.closed.catch(()=>{});
  await Bun.sleep(30);expect(sp.evStreams.size).toBe(1);expect(sp.evStream({id:"reader"},2,{}).headers.get("content-type")).not.toBe("text/event-stream");
  await closed;expect(sp.evStreams.size).toBe(0);await expect(reader.read()).rejects.toThrow("deadline");db.close();
});

test("approval failures stop durably after five releases and do not revive on a new runner",async()=>{
  const {SpaceTasks,taskOps}=await import("../src/space/tasks.ts"),{db,sp}=fixture(SpaceTasks.prototype);
  db.run("create table tasks(id text primary key,state text,attempt integer,max_retries integer,result text,updated text,held_since text,held_acc integer default 0);insert into tasks(id,state,attempt,max_retries) values('approval','queued',1,1)");
  sp.sql.exec=(q:string,...a:any[])=>{const rows=db.query(q).all(...a);return{toArray:()=>rows,one:()=>rows[0],rowsWritten:(db.query('select changes() n').get() as any).n};};
  sp.loadTask=()=>({...db.query("select * from tasks where id='approval'").get() as any,needs_approval:true,limits:{},target:"runner"});sp.taskFor=()=>sp.loadTask();sp.emit=()=>{};sp.projectContext=async()=>null;
  const runner:any={id:"runner",name:"runner",kind:"runner"};
  for(let n=1;n<=5;n++) {const ops=taskOps.call(sp);await ops.task_claim(runner,{id:"approval"});const r=await ops.task_release(runner,{id:"approval",reason:"approval_unreachable"});expect(r.paused).toBe(n===5);
    if(n<5){await expect(ops.task_claim(runner,{id:"approval"})).rejects.toThrow("cooldown");const state=sp.resourceState("approval","approval");state.nextAt=0;db.query("update meta set v=? where k=?").run(JSON.stringify(state),"resource:approval:approval");}}
  expect(sp.loadTask().state).toBe("failed");expect(JSON.parse(sp.loadTask().result).approval_paused).toBe(true);expect(sp.loadTask().attempt).toBe(1);
  const restarted=Object.assign(Object.create(SpaceTasks.prototype),sp);expect(restarted.resourceState("approval","approval").failures).toBe(5);
  await expect(taskOps.call(restarted).task_claim(runner,{id:"approval"})).rejects.toThrow("task is failed");db.close();
});

test("alarm exceptions pause across object reconstruction; workspace and account pauses remain independent",async()=>{
  const {Space}=await import("../src/space.ts"),{db,sp,alarms}=fixture(Space.prototype);let calls=0;
  sp.ctx.storage.deleteAlarm=async()=>{};sp.alarmWork=async()=>{calls++;throw Error("unavailable");};
  for(let n=1;n<=5;n++){await sp.alarm();expect(calls).toBe(n);const state=sp.resourceState("alarm");if(n<5){expect(state.nextAt).toBeGreaterThan(Date.now());state.nextAt=0;db.query("update meta set v=? where k='resource:alarm:'").run(JSON.stringify(state));}}
  const restarted=Object.assign(Object.create(Space.prototype),sp);for(let n=0;n<10;n++)await restarted.alarm();expect(calls).toBe(5);expect(restarted.resourcesPaused()).toBe(true);
  await restarted.resourceControl("resume");expect(restarted.resourcesPaused()).toBe(false);await restarted.resourceControl("pause",true);await restarted.resourceControl("pause");
  await restarted.resourceControl("resume",true);expect(restarted.resourcesPaused()).toBe(true);const count=alarms.length;await restarted.armAlarm(Date.now());expect(alarms.length).toBe(count);
  await restarted.resourceControl("resume");expect(restarted.resourcesPaused()).toBe(false);db.close();
});


test("S3 failures make one attempt; the workflow owns the retry budget",async()=>{
  const {blobStore}=await import("../src/blobs.ts");let calls=0;
  const preconnect=globalThis.fetch.preconnect;
  const fetch=spyOn(globalThis,"fetch").mockImplementation(Object.assign(async()=>{calls++;return new Response("unavailable",{status:503});},{preconnect}));
  try {const store=blobStore({BLOB_STORE:"s3",S3_ENDPOINT:"https://storage.example.test",S3_BUCKET:"fixture",S3_ACCESS_KEY_ID:"fixture",S3_SECRET_ACCESS_KEY:"fixture"});
    await expect(store!.get("a".repeat(64))).rejects.toThrow("HTTP 503");expect(calls).toBe(1);
  }finally{fetch.mockRestore();}
});

test("large SSE replay pages advance instead of repeatedly overflowing the same buffer",async()=>{
  const {sp,db}=fixture(SpaceEvents.prototype);sp.evStreams=new Map();sp.evStreamSeq=0;sp.evType=()=>({inputSchema:{properties:{}}});sp.evAuthorize=()=>({});sp.evHead=()=>60;
  sp.evNum=(key:string,d:number)=>key==="EVENTS_STREAM_MAX_MS"?10:d;
  const exec=sp.sql.exec;sp.sql.exec=(q:string,...a:any[])=>q.startsWith("select * from events where")?Array.from({length:60},(_,i)=>({seq:i+1,type:"file.changed",data:"{}"})).filter(r=>r.seq>a[0]):exec(q,...a);
  sp.evOcc=(_p:any,_t:any,_a:any,ev:any)=>({eventId:String(ev.seq),data:{text:"x".repeat(8192)}});
  let cursor=0,pages=0;const ids:string[]=[];
  try {while(cursor<60&&pages++<5){sp.evStart=()=>({from:cursor,truncated:false});const response=sp.evStream({id:"reader"},pages,{}),text=await response.text();
      const frames=text.trim().split("\n\n").map((x:string)=>JSON.parse(x.slice(6)));for(const f of frames)if(f.method==="notifications/events/event")ids.push(f.params.eventId);
      const last=frames.at(-1);expect(last.result).toBeDefined();const {decCursor}=await import("../src/events.ts");const next=decCursor("?",last.result.cursor);expect(next).not.toBeNull();expect(next!).toBeGreaterThan(cursor);cursor=next!;}
    expect(cursor).toBe(60);expect(ids).toHaveLength(60);expect(new Set(ids).size).toBe(60);expect(pages).toBeGreaterThan(1);
  }finally{for(const s of sp.evStreams.values())sp.evStreamClose(s,false);db.close();}
});


test("blob reference backfill cannot retry forever on cold starts or multiply concurrent calls",async()=>{
  const {db,sp}=fixture(SpaceGc.prototype);let calls=0;
  db.run("insert into blobs values('old',1,'s3')");sp.store={ref:async()=>{calls++;await Bun.sleep(1);throw Error("storage unavailable");}};
  try {for(let n=1;n<=8;n++){const first=sp.backfillRefs();expect(sp.backfillRefs()).toBe(first);await expect(first).rejects.toThrow("storage unavailable");
      expect(calls).toBe(n);await expect(sp.backfillRefs()).rejects.toThrow("paused or cooling down");expect(calls).toBe(n);
      const state=sp.resourceState("refs");state.nextAt=0;db.query("update meta set v=? where k='resource:refs:'").run(JSON.stringify(state));}
    const restarted=Object.assign(Object.create(SpaceGc.prototype),sp);await expect(restarted.backfillRefs()).rejects.toThrow("paused");expect(calls).toBe(8);
  }finally{db.close();}
});

test("unexpected GC errors reach the alarm circuit instead of silently rearming forever",async()=>{
  const {Space}=await import("../src/space.ts"),{db,sp}=fixture(Space.prototype);let calls=0;
  sp.ctx.storage.deleteAlarm=async()=>{};sp.evSweep=()=>null;sp.outboxRun=async()=>null;sp.retentionDays=()=>0;sp.gcDue=()=>0;sp.gc=async()=>{calls++;throw Error("unexpected GC bug");};
  try {for(let n=1;n<=5;n++){await sp.alarm();expect(calls).toBe(n);const state=sp.resourceState("alarm");state.nextAt=0;db.query("update meta set v=? where k='resource:alarm:'").run(JSON.stringify(state));}
    for(let n=0;n<10;n++)await sp.alarm();expect(calls).toBe(5);expect(sp.resourcesPaused()).toBe(true);
  }finally{db.close();}
});
