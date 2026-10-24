// Real retry/GC/alarm methods, synthetic SQLite + failing adapters. No Cloudflare account or network.
import { test, expect, mock } from "bun:test";
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
