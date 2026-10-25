// Calendar tags use UTC; signed numeric release counters still enforce update order.
export function releaseTag(date = new Date()): string {
  if (!Number.isFinite(date.getTime())) throw new Error("invalid release date");
  const iso = date.toISOString();
  return `v${iso.slice(0, 10).replaceAll("-", ".")}-${iso.slice(11, 19).replaceAll(":", "")}`;
}
if (import.meta.main) console.log(releaseTag());
