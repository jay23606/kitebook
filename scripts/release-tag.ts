// Calendar tags use UTC; signed numeric release counters still enforce update order.
export function releaseTag(date = new Date(), existing: Iterable<string> = []): string {
  if (!Number.isFinite(date.getTime())) throw new Error("invalid release date");
  const iso = date.toISOString();
  const base = `v${iso.slice(0, 10).replaceAll("-", ".")}`, tags = new Set(existing);
  if (!tags.has(base)) return base;
  let revision = 2;
  while (tags.has(`${base}.${revision}`)) revision++;
  return `${base}.${revision}`;
}
if (import.meta.main) {
  const tags = Bun.spawnSync(["git", "tag", "--list"], { stdout: "pipe", stderr: "pipe" });
  if (tags.exitCode !== 0) throw new Error("could not read existing release tags");
  console.log(releaseTag(new Date(), tags.stdout.toString().trim().split("\n")));
}
