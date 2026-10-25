// A browser proves possession of its private poll token before relaying a password.
// The Mac checks the password and signs this request; no Keychain dialog or password storage here.
export async function passwordLogin(d: any, poll: string, password: string) {
  const q = await d.oauth("loginView", poll), action = `connect:${q.id}`;
  const r = await d.rpw("ask", { action, password, from: "browser sign-in" });
  if (!r.ok) return r;
  const proof = await d.dev("assert", r.presence, action, r.peer);
  if (!proof.ok) return { ok: false, status: 401, error: "Your Mac couldn't confirm this sign-in. Try again." };
  await d.oauth("connectDecide", { id: q.id, nonce: q.nonce, yes: true, by: r.peer });
  return { ok: true, device: proof.device };
}
