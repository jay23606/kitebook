// CI reports can arrive out of order. A completed run is immutable; its id belongs to the runner that first reported it.
const terminal = (state: string) => ["passed", "failed", "error", "cancelled", "skipped"].includes(state);
export function mergeCiRuns(current: any[], runner: string, incoming: any[]): any[] {
  const keep = new Map<string, any>(current.filter(r => r?.id).map(r => [String(r.id), r]));
  for (const run of incoming) {
    if (!run?.id) continue;
    const id = String(run.id), old = keep.get(id);
    if (old && (old.runner !== runner || terminal(old.state))) continue;
    if (old && !terminal(run.state) && ((old.at ?? 0) > (run.at ?? 0) || old.state === "running" && run.state === "queued")) continue;
    keep.set(id, { ...run, runner });
  }
  return [...keep.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 40);
}
