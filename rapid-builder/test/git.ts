// Unit test of the git sync step, against real git and a real local origin.
//
// git is always on PATH, so nothing here is stubbed: the origin is a real
// repository reached over file://, and every assertion reads the checkout git
// produced. Tests share the origin and run in declaration order. A test that
// needs an untouched checkout uses a directory of its own.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { sshdMissing, sshKeygen, startSshd } from "../dev/sshd.ts";
import { type GitSsh, syncGitRepo } from "../src/git.ts";

const work = await mkdtemp(path.join(tmpdir(), "rapid-build-git-"));
after(() => rm(work, { recursive: true, force: true }));

// Inherited by the git processes syncGitRepo spawns. protocol.file.allow is
// what lets a file:// superproject clone its file:// submodule, which git
// refuses by default.
const gitConfig = path.join(work, "gitconfig");
await writeFile(
	gitConfig,
	`[user]
\tname = test
\temail = test@test.invalid
[commit]
\tgpgsign = false
[protocol "file"]
\tallow = always
`,
);
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_SYSTEM: "/dev/null" });

const git = (args: string[], cwd?: string) =>
	execFileSync("git", args, { cwd, env: process.env }).toString().trim();

// --- The origin: two commits, the second reachable only from a PR ref --------

const originDir = path.join(work, "origin");
git(["init", "-q", "-b", "master", originDir]);
await writeFile(path.join(originDir, "modinfo.lua"), "return {}\n");
await writeFile(path.join(originDir, "tracked.txt"), "original\n");
git(["add", "."], originDir);
git(["commit", "-qm", "init"], originDir);
const masterSha = git(["rev-parse", "HEAD"], originDir);
// The interesting case for fetching a bare sha: a commit on no branch at all.
git(["commit", "-q", "--allow-empty", "-m", "pr"], originDir);
git(["update-ref", "refs/pull/7/head", "HEAD"], originDir);
const prSha = git(["rev-parse", "HEAD"], originDir);
git(["update-ref", "HEAD", "HEAD^"], originDir);
const originUrl = `file://${originDir}`;
/** A commit of the right shape that the origin has never heard of. */
const unknownSha = `${"0".repeat(39)}1`;

/** Syncs a checkout, collecting the log so a test can see what git was asked. */
async function sync(
	gitDir: string,
	commit: string,
	url = originUrl,
	ssh?: GitSsh,
): Promise<string[]> {
	const lines: string[] = [];
	await syncGitRepo((line) => lines.push(line), gitDir, url, commit, ssh);
	return lines;
}

const head = (gitDir: string) => git(["rev-parse", "HEAD"], gitDir);

// --- One checkout, reused by the tests in order ------------------------------

const gitDir = path.join(work, "checkout");
await mkdir(path.dirname(gitDir), { recursive: true });

test("the first sync clones and lands on the requested commit", async () => {
	const lines = await sync(gitDir, masterSha);
	assert.ok(
		lines.some((l) => l.startsWith("$ git clone ")),
		"cloned",
	);
	assert.equal(head(gitDir), masterSha);
	assert.equal(await readFile(path.join(gitDir, "tracked.txt"), "utf8"), "original\n");
});

test("a commit that lives only under refs/pull/7/head is fetched by bare sha", async () => {
	const lines = await sync(gitDir, prSha);
	assert.ok(!lines.some((l) => l.startsWith("$ git clone ")), "reused the checkout");
	assert.equal(head(gitDir), prSha, "no ref names it, only the sha does");
});

test("whatever a crashed run left behind is discarded", async () => {
	const junk = path.join(gitDir, "junk.txt");
	await writeFile(junk, "leftover");
	await writeFile(path.join(gitDir, "tracked.txt"), "clobbered\n");
	// An ignored file is still not ours to keep: the clean is -x.
	await writeFile(path.join(gitDir, ".gitignore"), "junk.txt\n");

	await sync(gitDir, masterSha);

	assert.equal(head(gitDir), masterSha);
	assert.equal(existsSync(junk), false, "untracked leftover removed");
	assert.equal(await readFile(path.join(gitDir, "tracked.txt"), "utf8"), "original\n");
});

test("a commit the origin does not have is refused", async () => {
	const lines: string[] = [];
	await assert.rejects(
		syncGitRepo((line) => lines.push(line), gitDir, originUrl, unknownSha),
		// The fetch refuses it. Its own words go to the log, which is what the
		// requester reads, rather than into the error.
		{ message: "git exited with 128" },
	);
	assert.ok(
		lines.some((l) => /not our ref|couldn't find remote ref/.test(l)),
		`the fetch said why: ${lines.join(" | ")}`,
	);
	assert.equal(head(gitDir), masterSha, "the checkout is left where it was");
});

test("a moved origin is followed", async () => {
	const movedDir = path.join(work, "origin-moved");
	git(["clone", "-q", "--bare", originDir, movedDir]);
	git(["update-ref", "refs/pull/7/head", prSha], movedDir);

	await sync(gitDir, prSha, `file://${movedDir}`);

	assert.equal(git(["remote", "get-url", "origin"], gitDir), `file://${movedDir}`);
	assert.equal(head(gitDir), prSha);
});

// --- Cases that need a checkout of their own ---------------------------------

test("a partial clone left by a crash does not block the next one", async () => {
	const fresh = path.join(work, "after-crash");
	// What a clone that died halfway through leaves: a directory that is not a
	// repository, under the name the next clone wants.
	await mkdir(`${fresh}.tmp`, { recursive: true });
	await writeFile(path.join(`${fresh}.tmp`, "half-written"), "junk");

	await sync(fresh, masterSha);

	assert.equal(head(fresh), masterSha);
	assert.equal(existsSync(`${fresh}.tmp`), false, "the partial clone was renamed away");
});

test("submodules are initialised, updated and cleaned along with the superproject", async () => {
	const subDir = path.join(work, "sub-origin");
	git(["init", "-q", "-b", "master", subDir]);
	await writeFile(path.join(subDir, "sub.txt"), "v1\n");
	git(["add", "."], subDir);
	git(["commit", "-qm", "sub v1"], subDir);

	const superDir = path.join(work, "super-origin");
	git(["init", "-q", "-b", "master", superDir]);
	await writeFile(path.join(superDir, "modinfo.lua"), "return {}\n");
	git(["add", "."], superDir);
	git(["submodule", "add", "-q", `file://${subDir}`, "sub"], superDir);
	git(["commit", "-qm", "with submodule"], superDir);
	const withSub = git(["rev-parse", "HEAD"], superDir);

	const checkout = path.join(work, "super-checkout");
	await sync(checkout, withSub, `file://${superDir}`);
	assert.equal(await readFile(path.join(checkout, "sub", "sub.txt"), "utf8"), "v1\n");

	// Files a build changed inside the submodule must not reach the next build.
	await writeFile(path.join(checkout, "sub", "sub.txt"), "scribbled\n");
	await writeFile(path.join(checkout, "sub", "extra.txt"), "junk\n");

	// We move the submodule pointer, so the sync has to update it too.
	await writeFile(path.join(subDir, "sub.txt"), "v2\n");
	git(["commit", "-qam", "sub v2"], subDir);
	git(["-C", path.join(superDir, "sub"), "fetch", "-q", "origin"], superDir);
	git(["-C", path.join(superDir, "sub"), "checkout", "-q", "origin/master"], superDir);
	git(["commit", "-qam", "bump submodule"], superDir);
	const bumped = git(["rev-parse", "HEAD"], superDir);

	await sync(checkout, bumped, `file://${superDir}`);

	assert.equal(head(checkout), bumped);
	assert.equal(await readFile(path.join(checkout, "sub", "sub.txt"), "utf8"), "v2\n");
	assert.equal(existsSync(path.join(checkout, "sub", "extra.txt")), false, "submodule cleaned");
});

// --- Over SSH, against a real sshd -------------------------------------------

const githubKnownHosts = path.join(import.meta.dirname, "../src/github_known_hosts");

test("over ssh", { skip: sshdMissing() }, async (t) => {
	// A space and a quote, to test that the ssh command line handles them.
	const sshDir = path.join(work, "ssh dir's");
	const sshd = await startSshd(sshDir);
	t.after(sshd.close);
	const { ssh } = sshd;
	const sshUrl = sshd.url(originDir);
	const checkout = path.join(work, "ssh-checkout");

	await t.test("a first sync clones over ssh", async () => {
		await sync(checkout, prSha, sshUrl, ssh);
		assert.equal(head(checkout), prSha);
	});

	/** Checks that the sync over ssh fails and the log says why. */
	async function refused(sshOpts: GitSsh, why: RegExp) {
		const lines: string[] = [];
		await assert.rejects(
			syncGitRepo((line) => lines.push(line), checkout, sshUrl, masterSha, sshOpts),
			{ message: "git exited with 128" },
		);
		assert.ok(
			lines.some((l) => why.test(l)),
			`the fetch said why: ${lines.join(" | ")}`,
		);
		assert.equal(head(checkout), prSha, "the checkout is left where it was");
	}

	await t.test("an unknown host is refused, not trusted", async () => {
		const unrelated = path.join(sshDir, "unrelated_known_hosts");
		await copyFile(githubKnownHosts, unrelated);
		await refused({ ...ssh, knownHostsFile: unrelated }, /Host key verification failed/);
		assert.equal(
			await readFile(unrelated, "utf8"),
			await readFile(githubKnownHosts, "utf8"),
			"nothing was added to it",
		);
	});

	await t.test("a host whose key changed is refused", async () => {
		const impostor = path.join(sshDir, "impostor");
		sshKeygen(impostor);
		const [host] = (await readFile(ssh.knownHostsFile, "utf8")).split(" ");
		const changed = path.join(sshDir, "changed_known_hosts");
		await writeFile(changed, `${host} ${await readFile(`${impostor}.pub`, "utf8")}`);
		await refused(
			{ ...ssh, knownHostsFile: changed },
			/REMOTE HOST IDENTIFICATION HAS CHANGED/,
		);
	});
});
