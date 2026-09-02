import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { refreshVersionsEdgeRule } from "./bunny.ts";
import type { Config, RepoConfig } from "./config.ts";
import { syncGitRepo } from "./git.ts";
import { stepDuration } from "./metrics.ts";
import { type Log, run } from "./run.ts";

/**
 * How much of a build reaches Bunny:
 * - `publish`: full upload and changes edge rule
 * - `dry-run`: only reads, don't change anything
 * - `disabled`: never contacts it and needs no keys
 */
export const BunnyMode = z.enum(["publish", "dry-run", "disabled"]);
export type BunnyMode = z.infer<typeof BunnyMode>;

export async function runBuild(opts: {
	bunny: Config["bunny"];
	repoName: string;
	repo: RepoConfig;
	commit: string;
	branch: string;
	version?: string | undefined;
	dataDir: string;
	bunnyApiKey: string;
	bunnyStorageAccessKey: string;
	bunnyMode: BunnyMode;
	log: Log;
}): Promise<void> {
	const { bunny, repoName, repo, commit, branch, version, bunnyMode, log } = opts;
	const gitDir = path.join(opts.dataDir, "git", repoName);
	const storeDir = path.join(opts.dataDir, "store", repoName);
	await mkdir(path.dirname(gitDir), { recursive: true });
	await mkdir(storeDir, { recursive: true });

	const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
		const end = stepDuration.startTimer({ repo: repoName, step: name });
		try {
			const result = await fn();
			end({ outcome: "success" });
			return result;
		} catch (err) {
			end({ outcome: "failure" });
			throw err;
		}
	};

	const url = `https://github.com/${repo.githubRepository}.git`;
	await step("git_sync", () => syncGitRepo(log, gitDir, url, commit));
	log(`Building ${repoName}:${branch} at ${commit}. Bunny mode: ${bunnyMode}`);

	const args = [gitDir, repo.modRoot, repo.modinfo, storeDir, commit, repoName, branch];
	if (version !== undefined) args.push(version);
	await step("rapid_buildgit", () => run("rapid-buildgit", args, { log }));

	if (bunnyMode === "disabled") return;

	// Order matters: versions.gz must go last so clients never see a version
	// that references missing pool/package files.
	// Pool and package files are content-addressed and immutable, so
	// --size-only is a safe and cheap way to skip what's already uploaded.
	await step("upload", async () => {
		const obscured = await run("rclone", ["obscure", "-"], {
			input: opts.bunnyStorageAccessKey,
		});
		const rclone = (args: string[]) =>
			run(
				"rclone",
				[
					`--bunny-storage-zone=${bunny.storageZone}`,
					`--bunny-endpoint=${new URL(bunny.storageUrl).host}`,
					"--stats-log-level=NOTICE",
					...(bunnyMode === "dry-run" ? ["--dry-run"] : []),
					...args,
				],
				{ env: { RCLONE_BUNNY_ACCESS_KEY: obscured.stdout.trim() }, log },
			);
		const remote = (p: string) => `:bunny:${repoName}/${p}`;
		await rclone(["copy", "--size-only", path.join(storeDir, "pool"), remote("pool")]);
		await rclone(["copy", "--size-only", path.join(storeDir, "packages"), remote("packages")]);
		// `--ignore-times` is a weirdly named option, its description is:
		// > Don't skip items that match size and time - transfer all unconditionally
		// and we want to always upload as bunny backend doesn't support time, and
		// size might coincidentally match with compression. We also use `copy`
		// instead of `copyto` because there is a bug in bunny backend that adds
		// additional `/` when creating target url.
		await rclone([
			"copy",
			"--ignore-times",
			path.join(storeDir, "versions.gz"),
			`:bunny:${repoName}`,
		]);
	});

	await step("edge_rule", async () =>
		refreshVersionsEdgeRule({
			repoName,
			versionsGz: await readFile(path.join(storeDir, "versions.gz")),
			bunny,
			apiKey: opts.bunnyApiKey,
			storageAccessKey: opts.bunnyStorageAccessKey,
			dryRun: bunnyMode === "dry-run",
			log,
		}),
	);
}
