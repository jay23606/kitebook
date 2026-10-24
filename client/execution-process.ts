// Shared cancellation boundary for task agents, quick asks and local CI. Killing only a shell leaves its children running.
import * as PL from "./platform.ts";
export function stopProcessTree(pid: number, signal: NodeJS.Signals = "SIGKILL", group = false): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  if (process.platform === "win32") return PL.killTreeWin(pid);
  const rows = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim().split("\n").map(l => l.trim().split(/\s+/).map(Number));
  const seen = new Set<number>([pid]), children: number[] = [];
  const visit = (parent: number) => { for (const [child, pp] of rows) if (pp === parent && child > 0 && child !== process.pid && !seen.has(child)) { seen.add(child); visit(child); children.push(child); } }; visit(pid);
  if (group) try { process.kill(-pid, signal); } catch {}
  for (const p of [...children, pid]) try { process.kill(p, signal); } catch {}
}
