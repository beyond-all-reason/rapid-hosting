import { rename, rm } from "node:fs/promises";
import { type Log, run } from "./run.ts";

export interface GitSsh {
	keyFile: string;
	knownHostsFile: string;
}

/**
 * GIT_SSH_COMMAND that uses only one key and trusts only one known_hosts.
 * git runs it in a shell, so we pass the paths in env and don't need to quote them.
 */
const SSH_COMMAND = [
	"ssh",
	// Ignore ssh_config and agent.
	"-F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes",
	'-i "$RAPID_SSH_KEY_FILE"',
	// Fail instead of prompting for passphrase or unknown host.
	"-o BatchMode=yes -o StrictHostKeyChecking=yes",
	// ssh splits this option on whitespace, so we quote it for ssh too.
	'-o "UserKnownHostsFile=\\"$RAPID_SSH_KNOWN_HOSTS_FILE\\""',
	"-o GlobalKnownHostsFile=/dev/null",
].join(" ");

/** Synchonizes the working copy at gitDir to clean state at the given commit */
export async function syncGitRepo(
	log: Log,
	gitDir: string,
	url: string,
	commit: string,
	ssh?: GitSsh,
): Promise<void> {
	const env = ssh && {
		GIT_SSH_COMMAND: SSH_COMMAND,
		RAPID_SSH_KEY_FILE: ssh.keyFile,
		RAPID_SSH_KNOWN_HOSTS_FILE: ssh.knownHostsFile,
	};
	const isRepo = await run("git", ["-C", gitDir, "rev-parse", "--git-dir"], {
		check: false,
	});
	if (isRepo.exitCode !== 0) {
		// Clone via tmp + atomic rename so a crash mid-clone leaves no partial
		// gitDir behind. --no-checkout keeps the flow uniform with later runs:
		// the checkout/submodule/clean steps below handle the rest.
		const tmpDir = `${gitDir}.tmp`;
		await rm(tmpDir, { recursive: true, force: true });
		await run("git", ["clone", "--no-checkout", url, tmpDir], { env, log });
		await rename(tmpDir, gitDir);
	}

	const git = (...args: string[]) => run("git", args, { cwd: gitDir, env, log });
	await git("remote", "set-url", "origin", url);
	await git("fetch", "origin", commit);
	await git("checkout", "--detach", "--force", "FETCH_HEAD");
	await git("submodule", "sync", "--recursive");
	await git("submodule", "update", "--init", "--recursive", "--force");
	await git("submodule", "foreach", "--recursive", "git", "reset", "--hard");
	await git("clean", "-xffd");
	await git("submodule", "foreach", "--recursive", "git", "clean", "-xffd");
}
