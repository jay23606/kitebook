// Owner-only workspace browser. Server dispatch is deliberately a small allowlist, not a browser-to-admin RPC proxy.
import * as KB from "./kb.ts";
import { OWNER, normPath } from "./space/util.ts";
import { RelayError } from "./ops.ts";
import type { Space } from "./space.ts";

export async function ownerWorkspace(sp: Space, a: any) {
  const args = a.args ?? {}, op = String(a.action ?? "");
  if (op === "knowledge") return sp.impl.kb_list(OWNER, { scope: args.scope || undefined, kinds: args.kind ? [args.kind] : undefined, origin: args.origin || undefined, limit: 200, recent: true });
  if (op === "search") return sp.impl.kb_search(OWNER, { query: String(args.query ?? "").slice(0, 1000), scope: args.scope || undefined, kinds: args.kind ? [args.kind] : undefined, origin: args.origin || undefined, k: 100 });
  if (op === "entry") return sp.impl.kb_get(OWNER, { id: args.id });
  if (op === "files") return sp.impl.ls(OWNER, { path: normPath(args.path ?? "shared") });
  if (op === "file") { const path = normPath(args.path), stat = await sp.impl.stat(OWNER, { path });
    if (stat.size > 8 * 1024 * 1024) throw new RelayError(413, "file over 8 MB: download it with kitebook cat or workspace pull");
    return { ...await sp.impl.read(OWNER, { path }), ...stat }; }
  if (op === "history") return sp.impl.log(OWNER, { path: normPath(args.path), limit: 30 });
  if (op === "replicas") return sp.impl.sync_status(OWNER, {});
  if (op === "save") {
    if (!args.id) return sp.impl.kb_add(OWNER, { text: args.text, title: args.title, kind: args.kind, scope: args.scope, origin: "owner-workspace" });
    const old = await sp.impl.kb_get(OWNER, { id: args.id });
    if (old.id !== old.path || !old.path.startsWith("kb/")) throw new RelayError(409, "This is a section of a source file; edit that file with your connected agent.");
    if (typeof args.if_match !== "string") throw new RelayError(400, "if_match required");
    if (!KB.KB_KINDS.includes(args.kind)) throw new RelayError(400, "invalid kind");
    const text = String(args.text ?? "").trim(); if (!text || text.length > 20000) throw new RelayError(400, "text must be 1-20000 characters");
    return sp.impl.write(OWNER, { path: old.path, if_match: args.if_match, content: KB.fmt({ ...old, title: args.title, kind: args.kind }, text), message: "Correct shared knowledge" });
  }
  if (op === "forget") {
    const old = await sp.impl.kb_get(OWNER, { id: args.id });
    if (old.id !== old.path || !old.path.startsWith("kb/")) throw new RelayError(409, "Edit the source file to remove this section.");
    if (typeof args.if_match !== "string") throw new RelayError(400, "if_match required");
    return sp.impl.rm(OWNER, { path: old.path, if_match: args.if_match });
  }
  throw new RelayError(400, "unknown workspace action");
}

export const KNOWLEDGE_HTML = `<main id="knowledge"><div class="memory-toolbar"><div><h2>Shared knowledge</h2><p class="note">Decisions, files and handoffs your next agent can pick up.</p></div><button id="memory-new">Save a note</button></div>
<a id="memory-attention" class="warn" href="#tasks" role="status" hidden></a><form id="memory-search" class="memory-filters"><label>Workspace<select id="memory-space"></select></label><label>Search<input id="memory-query" type="search" placeholder="Find a decision or useful detail"></label><label>Scope<input id="memory-scope" placeholder="global or project:name"></label><label>Kind<select id="memory-kind"><option value="">All kinds</option>${KB.KB_KINDS.map(k => `<option>${k}</option>`).join("")}</select></label><label>Origin<input id="memory-origin" placeholder="Any origin"></label><button class="sec">Search</button></form>
<div class="bar memory-tabs"><button class="sec" id="memory-notes">Knowledge</button><button class="sec" id="memory-files">Files & handoffs</button><button class="link" id="memory-refresh">Refresh</button><a href="#tasks">Tasks & approvals</a></div>
<p id="memory-state" class="note" role="status" aria-live="polite">Loading shared knowledge…</p><div class="memory-grid"><section id="memory-list" aria-label="Shared entries"></section><section id="memory-detail" aria-label="Selected entry"><p class="note">Select an entry to see its source and version, or save a note.</p></section></div>
<details class="fold"><summary>Recovery & connected copies</summary><p class="note">Published files live on Kitebook. A new sandbox can pull them again. Acknowledgements below describe copies that reported applying a version; they do not prove an agent is online or its cache still exists.</p><pre id="memory-replicas">Loading…</pre><p class="note">Use <code>kitebook workspace pull ./daily --path shared/project</code> in a fresh sandbox. Keep credentials in your platform's connection settings.</p></details></main>`;
export const KNOWLEDGE_CSS = `
.memory-toolbar{display:flex;justify-content:space-between;align-items:center;gap:18px}.memory-toolbar h2{margin:0;font-size:25px}.memory-toolbar p{margin:6px 0 20px}.memory-filters{display:grid;grid-template-columns:minmax(100px,.65fr) minmax(180px,2fr) minmax(120px,1fr) minmax(100px,.6fr) minmax(110px,.8fr) auto;gap:12px;align-items:end}.memory-filters label{font-size:12px;color:var(--mut);margin:0}.memory-filters input,.memory-filters select{width:100%;margin-top:6px;min-width:0}.memory-tabs{border-bottom:1px solid var(--line);padding:18px 0 14px;flex-wrap:wrap}.memory-tabs a{margin-left:auto;font-size:14px}.memory-grid{display:grid;grid-template-columns:minmax(240px,.85fr) minmax(0,1.5fr);gap:24px;min-height:420px;margin:18px 0 28px}.memory-grid>section{margin:0;min-width:0}.memory-item{display:block;width:100%;text-align:left;background:transparent;color:var(--fg);border:0;border-bottom:1px solid var(--line);border-radius:0;padding:15px 10px;white-space:normal;overflow-wrap:anywhere}.memory-item:hover,.memory-item[aria-pressed=true]{background:var(--soft);color:var(--fg)}.memory-item strong{display:block;font-size:15px}.memory-item small{display:block;color:var(--mut);font-size:12px;margin-top:5px}.memory-grid #memory-detail{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:24px}.memory-grid pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:50vh;overflow:auto}.memory-grid textarea{width:100%;min-height:230px;box-sizing:border-box}.memory-grid label{display:block;font-size:13px;margin:12px 0 5px}.memory-grid input,.memory-grid select{max-width:100%;box-sizing:border-box}.memory-meta{font-size:12px;color:var(--mut);overflow-wrap:anywhere}.memory-grid h3{margin-top:0}.memory-grid .bar{flex-wrap:wrap}.memory-grid [role=alert]{color:var(--danger)}
.memory-toolbar>button{background:var(--acc);color:var(--onacc)}.memory-tabs>button,.memory-grid .bar>button{flex:none;background:var(--soft);color:var(--fg)}.memory-tabs>button[aria-pressed=true],.memory-grid .bar>button.pri{background:var(--acc);color:var(--onacc)}.memory-tabs>button.link,.memory-grid .bar>button.link{background:transparent;color:var(--link)}
@media(max-width:1100px){.memory-filters{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:760px){.memory-grid{grid-template-columns:minmax(0,1fr);gap:18px}.memory-toolbar{align-items:flex-start}.memory-filters{grid-template-columns:repeat(2,minmax(0,1fr))}.memory-grid #memory-detail{padding:18px}.memory-tabs a{margin-left:0}.memory-toolbar h2{font-size:22px}}
`;
export const KNOWLEDGE_JS = `
if(S.acct)(()=>{
let mode="knowledge",folder="shared",selected=null,dirty=false,request=0;const list=$("memory-list"),detail=$("memory-detail"),state=$("memory-state");
const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n};
const api=async(action,args={},write=false)=>{let nonce;if(write){const n=await post({op:"nonce"});if(!n.ok)throw Error(n.error);nonce=n.result.nonce}const r=await post({op:"workspace",space:$("memory-space").value||"main",action,args,nonce});if(!r.ok)throw Error(r.error);return r.result};
const fail=e=>{state.textContent=e.message||String(e);state.setAttribute("role","alert")};
const button=(text,fn,cls="sec")=>{const b=node("button",text,cls);b.type="button";b.onclick=()=>Promise.resolve().then(fn).catch(fail);return b};
function clear(){selected=null;dirty=false;detail.replaceChildren(node("p","Select an entry or save a note.","note"))}
async function history(path){const r=await api("history",{path});detail.append(node("pre",r.commits.map(c=>c.at+"  "+c.author+"\\n"+c.commit+"  "+c.message).join("\\n\\n")||"No history"))}
async function edit(entry){selected=entry;dirty=false;detail.replaceChildren(node("h3",entry?"Edit knowledge":"Save shared knowledge"));
const fields={};for(const [name,label,value] of [["title","Title",entry?.title||""],["scope","Scope",entry?.scope||$("memory-scope").value||"global"],["kind","Kind",entry?.kind||"fact"],["text","Knowledge",entry?.text||""]]){const id="memory-edit-"+name,l=node("label",label);l.htmlFor=id;const input=name==="text"?node("textarea"):name==="kind"?node("select"):node("input");input.id=id;if(name==="kind")for(const k of ["fact","decision","gotcha","pref","learned","memory"]){const o=node("option",k);input.append(o)}input.value=value;if(name==="scope"&&entry)input.disabled=true;input.oninput=()=>dirty=true;fields[name]=input;detail.append(l,input)}
if(entry)detail.append(node("p","Author: "+(entry.author||"unknown")+" | Reported origin: "+(entry.origin||"unspecified")+" | Updated: "+entry.updated+" | Version: "+entry.version+" | "+entry.path,"memory-meta"));
const actions=node("div",null,"bar"),error=node("p",null,"note");error.setAttribute("role","alert");detail.append(actions,error);
actions.append(button("Save",async()=>{try{await api("save",{id:entry?.id,if_match:entry?.sha,title:fields.title.value,text:fields.text.value,scope:fields.scope.value,kind:fields.kind.value},true);dirty=false;clear();await load();state.textContent="Published to shared knowledge."}catch(e){error.textContent=e.message}}));
if(entry){actions.firstChild.className="pri";actions.append(button("History",()=>history(entry.path)));actions.append(button("Forget",async()=>{if(!confirm("Remove this entry from current knowledge? Its version history remains."))return;await api("forget",{id:entry.id,if_match:entry.sha},true);clear();await load();state.textContent="Removed from current knowledge. Version history remains."},"link"))}}
async function file(p){const r=await api("file",{path:p});detail.replaceChildren(node("h3",p),node("p",r.size+" bytes | "+r.sha+" | "+r.last.author+" | "+r.last.at,"memory-meta"));
if(r.content!==undefined)detail.append(node("pre",r.content));else detail.append(node("p","Binary artifact. Download to open it."));
const a=node("div",null,"bar");a.append(button("Download",()=>{const bytes=r.content_base64!==undefined?Uint8Array.from(atob(r.content_base64),c=>c.charCodeAt(0)):new TextEncoder().encode(r.content);const url=URL.createObjectURL(new Blob([bytes],{type:"application/octet-stream"})),link=node("a");link.href=url;link.download=p.split("/").pop();link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}),button("History",()=>history(p)));detail.append(a)}
async function load(){$("memory-notes").setAttribute("aria-pressed",String(mode==="knowledge"));$("memory-files").setAttribute("aria-pressed",String(mode==="files"));const own=++request;state.setAttribute("role","status");state.textContent="Loading…";list.replaceChildren();const args={scope:$("memory-scope").value||undefined,kind:$("memory-kind").value||undefined,origin:$("memory-origin").value||undefined,query:$("memory-query").value};
const r=await api(mode==="files"?"files":args.query?"search":"knowledge",mode==="files"?{path:folder}:args);if(own!==request)return;
const entries=mode==="files"?r.entries:r.results||r.entries;state.textContent=mode==="files"?folder+" / "+entries.length+" items":entries.length+" entries"+(r.more?" (narrow your filters to see more)":"")+" | Knowledge version "+r.kb_version;
if(mode==="files"){const top=node("div",null,"bar");for(const root of ["shared","kb","context"])top.append(button(root,()=>{folder=root;clear();return load()}));if(folder.includes("/"))top.append(button("Parent folder",()=>{folder=folder.slice(0,folder.lastIndexOf("/"));return load()}));list.append(top)}
if(!entries.length)list.append(node("p",mode==="files"?"No files here yet. Publish artifacts from a connected agent or the workspace CLI.":"No matching knowledge yet. Save a note or change your filters.","note"));
for(const e of entries){const b=button("",async()=>{if(dirty&&!confirm("Discard unsaved note changes?"))return;clear();if(mode==="files"){if(e.type==="dir"){folder=e.path;await load()}else await file(e.path)}else await edit(await api("entry",{id:e.id}));for(const x of list.querySelectorAll(".memory-item"))x.setAttribute("aria-pressed",String(x===b))},"memory-item");b.append(node("strong",mode==="files"?(e.type==="dir"?"Folder: ":"")+e.name:e.title||e.text.slice(0,90)),node("small",mode==="files"?(e.size==null?e.path:e.size+" bytes"):e.scope+" | "+e.kind+" | "+(e.author||"unknown")));list.append(b)}}
const refresh=()=>load().catch(fail);$("memory-search").onsubmit=e=>{e.preventDefault();mode="knowledge";clear();refresh()};$("memory-refresh").onclick=refresh;
$("memory-space").onchange=()=>{request++;clear();refresh();replicas()};$("memory-notes").onclick=()=>{mode="knowledge";clear();refresh()};$("memory-files").onclick=()=>{mode="files";clear();refresh()};$("memory-new").onclick=()=>edit(null).catch(fail);
async function replicas(){try{const r=await api("replicas");$("memory-replicas").textContent="Published version: "+r.version+"\\n"+(r.replicas.map(x=>x.replica+" ("+x.path+"): version "+x.version+", acknowledged "+x.updated).join("\\n")||"No local copies have acknowledged a version yet.")}catch(e){$("memory-replicas").textContent=e.message}}
post({op:"status"}).then(r=>{if(!r.ok)throw Error(r.error);for(const sp of r.result.spaces){const o=node("option",sp.space);$("memory-space").append(o)}refresh();replicas()}).catch(fail);
setInterval(()=>{if(!document.hidden&&!$("knowledge").hidden&&!dirty&&!list.contains(document.activeElement)){refresh();replicas()}},15000);
addEventListener("beforeunload",e=>{if(dirty){e.preventDefault();e.returnValue=""}});
})();
`;
