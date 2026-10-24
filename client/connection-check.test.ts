import { test, expect } from "bun:test";
import { connectionPath,connectionCheck } from "./connection-check.ts";
test("address diagnostics distinguish local, Tailscale and changing public addresses without inventing provider approval",()=>{
  expect(connectionPath("http://127.0.0.1:7820").remote_reachability).toBe("local-only");
  expect(connectionPath("https://mac.tail.ts.net").path).toBe("tailscale");expect(connectionPath("https://random.trycloudflare.com").path).toBe("quick-tunnel");
  for(const a of ["https://mac.tail.ts.net","https://example.com"])expect(connectionPath(a).provider_policy).toBe("unknown");
  expect(()=>connectionPath("https://token@example.com")).toThrow();expect(()=>connectionPath("https://example.com?token=secret")).toThrow();
});
test("connection checks separate reachability, TLS/DNS, expired credentials and denied grants without printing credentials",async()=>{
  const probe=(health:number,auth:number)=>connectionCheck("https://example.com","synthetic-secret","main",(async(input:any)=>Response.json({ok:true,result:{name:"synthetic"}},{status:String(input).endsWith("/health")?health:auth})));
  expect((await probe(200,401)).authentication).toBe("invalid-or-expired");expect((await probe(200,403)).authentication).toBe("permission-denied");
  const good=await probe(200,200);expect(good.health).toBe("reachable");expect(good.provider_policy).toBe("unknown");expect(JSON.stringify(good)).not.toContain("synthetic-secret");
  for(const [code,want]of [["ENOTFOUND","dns"],["CERT_HAS_EXPIRED","tls"]]){let n=0;const r=await connectionCheck("https://example.com","synthetic-secret",undefined,(async()=>{n++;throw Object.assign(Error("private error"),{cause:{code}});}));expect(r.health).toBe(want);expect(n).toBe(1);expect(r.authentication).toBe("not-checked");}
});

test("account-scoped endpoints retain their account path during diagnostics",async()=>{
  const urls:string[]=[];await connectionCheck("https://example.com/u/daily/","synthetic-token","main",async input=>{urls.push(input);return new Response("",{status:200});});
  expect(urls).toEqual(["https://example.com/u/daily/health","https://example.com/u/daily/v1/whoami"]);
});

test("a proxy login page returning 200 cannot be mistaken for a successful Kitebook sign-in",async()=>{
  const r=await connectionCheck("https://example.com","synthetic-token",undefined,async()=>new Response("<html>Sign in</html>"));expect(r.health).toBe("reachable");expect(r.authentication).toBe("invalid-response");
});
