// Diagnostics run from the caller's machine. A successful Mac probe cannot establish a cloud provider's hostname policy.
export function connectionPath(address: string) {
  const u=new URL(address),h=u.hostname.toLowerCase();if(!/^https?:$/.test(u.protocol)||u.username||u.password||u.search||u.hash)throw Error("use an HTTP(S) server address without credentials or query parameters");
  const local=h==="localhost"||h==="[::1]"||/^127\./.test(h);
  return {origin:u.origin,server:u.origin+u.pathname.replace(/\/+$/, ""),path:local?"loopback":h.endsWith(".ts.net")?"tailscale":h.endsWith(".trycloudflare.com")?"quick-tunnel":"server",remote_reachability:local?"local-only":"unknown",provider_policy:"unknown",
    note:local?"Coding agents on this computer can use this address. Cloud assistants need a reachable HTTPS endpoint.":h.endsWith(".ts.net")?"Funnel is public; Serve needs tailnet access. The hostname alone cannot identify which is enabled. Verify access and hostname acceptance from the actual assistant.":h.endsWith(".trycloudflare.com")?"No domain purchase required. This address may change after restart; provider acceptance must be checked in that provider.":"Provider hostname acceptance must be checked from the actual assistant. A custom domain is a fallback for a restricted provider."};
}
export async function connectionCheck(address:string, token:string|null, space:string|undefined, fetcher:(input:string,init?:RequestInit)=>Promise<Response>=fetch) {
  const result:any={...connectionPath(address),checked_at:new Date().toISOString(),vantage:"this client",health:"unknown",authentication:"not-checked"};
  const failure=(e:any)=>{const code=String(e?.cause?.code??e?.code??"");return /ENOTFOUND|EAI_AGAIN/.test(code)?"dns":/CERT|TLS|SSL/.test(code)?"tls":/timeout|abort/i.test(String(e?.name))?"timeout":"network";};
  try {const r=await fetcher(result.server+"/health",{signal:AbortSignal.timeout(10000),redirect:"error"});result.health=r.ok?"reachable":"http-"+r.status;await r.body?.cancel();}
  catch(e){result.health=failure(e);return result;}
  if(token)try {const r=await fetcher(result.server+"/v1/whoami",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({space}),signal:AbortSignal.timeout(10000),redirect:"error"});result.authentication=r.ok?"accepted":r.status===401?"invalid-or-expired":r.status===403?"permission-denied":"http-"+r.status;await r.body?.cancel();}
  catch(e){result.authentication=failure(e);}
  return result;
}
