import { rename, rm } from "node:fs/promises";
import { type Log, run } from "./run.ts";

/** Synchonizes the working copy at gitDir to clean state at the given commit */
export async function syncGitRepo(
	log: Log,
	gitDir: string,
	url: string,
	commit: string,
): Promise<void> {
	const isRepo = await run("git", ["-C", gitDir, "rev-parse", "--git-dir"], {
		check: false,
	});
	if (isRepo.exitCode !== 0) {
		// Clone via tmp + atomic rename so a crash mid-clone leaves no partial
		// gitDir behind. --no-checkout keeps the flow uniform with later runs:
		// the checkout/submodule/clean steps below handle the rest.
		const tmpDir = `${gitDir}.tmp`;
		await rm(tmpDir, { recursive: true, force: true });
		await run("git", ["clone", "--no-checkout", url, tmpDir], { log });
		await rename(tmpDir, gitDir);
	}

	const git = (...args: string[]) => run("git", args, { cwd: gitDir, log });
	await git("remote", "set-url", "origin", url);
	await git("fetch", "origin", commit);
	await git("checkout", "--detach", "--force", "FETCH_HEAD");
	await git("submodule", "sync", "--recursive");
	await git("submodule", "update", "--init", "--recursive", "--force");
	await git("submodule", "foreach", "--recursive", "git", "reset", "--hard");
	await git("clean", "-xffd");
	await git("submodule", "foreach", "--recursive", "git", "clean", "-xffd");
}
