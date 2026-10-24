// The local proof behind `kitebook approve` / `kitebook open` (client/local-approve.ts): the Windows parsers on recorded output, the port
// way end to end on this machine (Linux: /proc/net/tcp, Windows: netstat; the CI matrix runs this file on each OS), and on Windows the
// real process table.
import { test, expect } from "bun:test";
import * as L from "./local-approve.ts";

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012
  TCP    127.0.0.1:52344        0.0.0.0:0              ABHÖREN         4242
  TCP    127.0.0.1:52344        127.0.0.1:61000        ESTABLISHED     777
  TCP    127.0.0.1:5234         0.0.0.0:0              LISTENING       999
  TCP    [::1]:52344            [::]:0                 LISTENING       555
`;
test("netstat -ano: the listener on 127.0.0.1:<port>, whatever the state word says (no connected rows, no prefix ports, no IPv6)", () => {
  expect(L.parseNetstat(NETSTAT, 52344)).toEqual([4242]);
  expect(L.parseNetstat(NETSTAT, 5234)).toEqual([999]);
  expect(L.parseNetstat(NETSTAT, 1)).toEqual([]);
});
// "<pid> <ppid> <creation filetime> <name>" from Get-CimInstance Win32_Process
const PROCS = [
  "0 0 0 System Idle Process", "4 0 0 System",
  "900 700 133000000000000000 explorer.exe", "1200 900 133000000000000100 WindowsTerminal.exe", "1300 1200 133000000000000200 pwsh.exe",
  "1400 1300 133000000000000300 bun.exe",                                  // kitebook approve typed in Windows Terminal
  "2000 600 133000000000000050 svchost.exe", "2100 2000 133000000000000060 bun.exe", // the runner, started by the logon task's supervisor
  "2200 2100 133000000000000400 codex.exe", "2300 2200 133000000000000500 bun.exe",   // an agent the runner started, running kitebook approve
  "3000 2500 133000000000000600 bun.exe",                                  // parent gone (a detached child)
  "3100 1300 133000000000000010 bun.exe",                                  // its "parent" 1300 started after it: a reused pid, not its parent
].join("\r\n");
test("Windows process table: ancestry stops at a missing or newer parent; the desktop check finds Explorer / Windows Terminal", () => {
  const t = L.parseWinProcs(PROCS);
  expect(t.get(1200)).toEqual({ ppid: 900, created: 133000000000000100, name: "WindowsTerminal.exe" });
  expect(t.get(0)?.name).toBe("System Idle Process");
  expect(L.winChain(t, 1400)).toEqual([1300, 1200, 900]);
  expect(L.winChain(t, 2300)).toEqual([2200, 2100, 2000]);
  expect(L.winChain(t, 3000)).toEqual([]);
  expect(L.winChain(t, 3100)).toEqual([]);
  expect(L.winDesktop(t, 1400)).toBe("WindowsTerminal.exe");
  expect(L.winDesktop(t, 2300)).toBeNull(); // under the runner: no desktop above it
  expect(L.winDesktop(t, 3000)).toBeNull();
  expect(L.winDesktop(t, 3100)).toBeNull();
});
test("the port way: the OS names the process listening on a loopback port (this process), nothing on a free one", async () => {
  const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(s) { s.end(); }, data() {} } });
  try { expect(L.listeners(srv.port)).toContain(process.pid); } finally { srv.stop(true); }
  await Bun.sleep(50); expect(L.listeners(srv.port)).not.toContain(process.pid);
  expect(L.listeners(0)).toEqual([]); expect(L.listeners(NaN)).toEqual([]);
});
test.if(process.platform === "win32")("Windows for real: the CIM table has this process and its parent; this process isn't its own descendant", () => {
  const t = L.winProcs(); expect(t.get(process.pid)?.ppid).toBe(process.ppid);
  expect(L.outsideOf(process.pid, 1, t)).toBe(true); expect(L.outsideOf(process.pid, process.ppid, t)).toBe(false);
  expect(L.proofWay()).toBe("port");
});
