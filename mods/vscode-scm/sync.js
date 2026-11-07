// The Changes button when nothing is left to commit, as VS Code's: push, pull, sync or publish the branch.
// No Herdr imports, so node tests load it.

// repo: the repo list's row ({ branch, oid, upstream, ahead, behind }; ahead is null when the upstream is unset
// or gone). Answers { kind, label } or null (keep the Commit button): there are changes, the repo is unknown,
// HEAD is detached or unborn, or the branch is even with its upstream.
export function syncAction(repo, changes) {
  if (changes > 0 || !repo?.branch || repo.branch === "(detached)" || repo.oid === "(initial)") return null;
  if (repo.ahead === null || !repo.upstream) return { kind: "publish", label: `↑ Publish Branch ${repo.branch}` };
  const s = (n) => `${n} commit${n === 1 ? "" : "s"}`;
  if (repo.ahead && repo.behind) return { kind: "sync", label: `⇅ Sync Changes ↓${repo.behind} ↑${repo.ahead}` };
  if (repo.ahead) return { kind: "push", label: `↑ Push ${s(repo.ahead)} to ${repo.upstream}` };
  if (repo.behind) return { kind: "pull", label: `↓ Pull ${s(repo.behind)} from ${repo.upstream}` };
  return null;
}

export const BUSY = { push: "Pushing…", pull: "Pulling…", sync: "Syncing…", publish: "Publishing…" };

// The git commands for a kind, in order (argv after `git`). Sync is VS Code's: the repo's own pull, then push.
// Publish pushes to origin when the repo has it, else its first remote. Never a force push.
export function syncSteps(kind, branch, remotes = []) {
  if (kind === "push") return [["push"]];
  if (kind === "pull") return [["pull"]];
  if (kind === "sync") return [["pull"], ["push"]];
  if (kind !== "publish") return [];
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (!remote) throw new Error("This repository has no remote to publish to. Add one with `git remote add`.");
  return [["push", "-u", remote, branch]];
}

// git's own output with a hint for the failures people hit: a rejected push, a credential git could not ask for.
export function syncError(text) {
  const out = String(text ?? "").trim();
  if (/\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i.test(out)) return `${out}\nThe remote has commits you don't have: Pull first.`;
  if (/terminal prompts disabled|Authentication failed|could not read (Username|Password)|Permission denied \(publickey|returned error: 403/i.test(out))
    return `${out}\nAuthentication failed: set up a git credential helper or ssh agent (no prompt can be shown here).`;
  return out || "git exited with an error";
}
