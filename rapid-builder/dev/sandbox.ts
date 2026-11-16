// The whole environment a service needs in order to run without GitHub, without
// Bunny and without credentials: both fakes, a config.json and a gitconfig that
// points the build at a repository on disk.
//
// A base config turns any of that off: whatever it names is used as it is, and
// we fake only the rest.
//
// test/e2e.ts calls this and then spawns the real service against it.
// dev/main.ts calls it with fixed ports and leaves it running for compose.
// There is one assembly, so what the e2e test proves is what the sandbox runs.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type ConfigInput, parseConfig } from "../src/config.ts";
import { API_KEY, type FakeBunny, STORAGE_KEY, startFakeBunny } from "./bunny.ts";
import { AUDIENCE, type FakeIssuer, GITHUB_REPOSITORY, startOidcIssuer } from "./oidc.ts";
import type { FakeSshd } from "./sshd.ts";

/**
 * Name of the sandbox's own repo: what the build is published under, and the one
 * repo whose clone URL we redirect to the origin on disk.
 */
const REPO_NAME = "testrepo";
/** Name of the repo the sandbox fetches over SSH, when given an sshd. */
const SSH_REPO_NAME = "testrepo-ssh";

/** Config the sandbox builds on: whatever it names we use as it is. */
export type BaseConfig = Partial<ConfigInput>;

export interface Sandbox {
	/** Absent when the base config has a bunny block. */
	bunny?: FakeBunny;
	/** Absent when the base config names an issuer. */
	oidc?: FakeIssuer;
	/** Everything a service process needs to reach this sandbox. */
	env: Record<string, string>;
	close(): void;
}

export interface SandboxOptions {
	/** Holds the generated config and the fake's storage. */
	dir: string;
	/** Git repository the build fetches from. */
	originDir: string;
	/** Config to build on. Default: none, so everything is faked. */
	baseConfig?: BaseConfig;
	/** Host the service reaches the fakes by. Default: 127.0.0.1. */
	publicHost?: string;
	/** Address the fakes bind. Default: 127.0.0.1. */
	bindHost?: string;
	/** Default: whatever the OS gives. */
	ports?: { storage?: number; edge?: number; oidc?: number };
	/** Adds a repo that fetches the origin over SSH from this sshd. Default: none. */
	sshd?: FakeSshd;
}

export async function startSandbox(opts: SandboxOptions): Promise<Sandbox> {
	const { dir, originDir } = opts;
	const base = opts.baseConfig ?? {};
	const publicHost = opts.publicHost ?? "127.0.0.1";
	await mkdir(dir, { recursive: true });

	// Compose waits for this file, so the previous run's copy must not answer
	// for this one.
	const configFile = path.join(dir, "config.json");
	await rm(configFile, { force: true });

	let bunny: FakeBunny | undefined;
	if (base.bunny === undefined) {
		// A throwaway pair nothing verifies, see dev/tls/README.md.
		const tlsDir = path.join(import.meta.dirname, "tls");
		bunny = await startFakeBunny({
			dir: path.join(dir, "bunny"),
			tls: {
				key: await readFile(path.join(tlsDir, "key.pem")),
				cert: await readFile(path.join(tlsDir, "cert.pem")),
			},
			host: opts.bindHost,
			publicHost,
			storagePort: opts.ports?.storage,
			edgePort: opts.ports?.edge,
		});
	}

	const audience = base.audience ?? AUDIENCE;
	const repos = base.repos ?? {
		[REPO_NAME]: { githubRepository: GITHUB_REPOSITORY, policy: "true" },
		...(opts.sshd && {
			[SSH_REPO_NAME]: {
				githubRepository: GITHUB_REPOSITORY,
				policy: "true",
				ssh: opts.sshd.ssh,
			},
		}),
	};

	let oidc: FakeIssuer | undefined;
	if (base.oidcIssuer === undefined) {
		oidc = await startOidcIssuer({
			host: opts.bindHost,
			port: opts.ports?.oidc,
			publicHost,
			audience,
			repository: Object.values(repos)[0]?.githubRepository ?? GITHUB_REPOSITORY,
		});
	}

	const config = {
		...base,
		audience,
		repos,
		...(bunny && { bunny: bunny.config }),
		...(oidc && { oidcIssuer: oidc.issuer }),
	};
	// Parsed only to fail here rather than in the service. We write the object
	// itself, since a parsed policy is compiled and doesn't survive JSON.
	parseConfig(config);
	await writeFile(configFile, `${JSON.stringify(config, null, "\t")}\n`);

	// We redirect only the sandbox's own repos to the origin on disk. A base
	// config naming its own repos is built from GitHub, so this file is empty.
	const redirects: string[] = [];
	const redirect = (from: string, to: string) =>
		redirects.push(`[url "${to}"]\n\tinsteadOf = ${from}\n`);
	const sandboxRepo = repos[REPO_NAME];
	if (sandboxRepo) {
		redirect(`https://github.com/${sandboxRepo.githubRepository}.git`, `file://${originDir}`);
	}
	const sshRepo = repos[SSH_REPO_NAME];
	if (opts.sshd && sshRepo) {
		redirect(`git@github.com:${sshRepo.githubRepository}.git`, opts.sshd.url(originDir));
	}
	const gitConfigFile = path.join(dir, "gitconfig");
	await writeFile(
		gitConfigFile,
		redirects.length > 0
			? `${redirects.join("")}[protocol "file"]
\tallow = always
[safe]
\tdirectory = *
`
			: "",
	);

	return {
		bunny,
		oidc,
		env: {
			CONFIG_FILE: configFile,
			GIT_CONFIG_GLOBAL: gitConfigFile,
			GIT_CONFIG_SYSTEM: "/dev/null",
			...(bunny && {
				// The fake storage zone serves a self-signed certificate, and neither
				// our fetch nor the rclone we spawn checks it.
				NODE_TLS_REJECT_UNAUTHORIZED: "0",
				RCLONE_NO_CHECK_CERTIFICATE: "true",
				BUNNY_API_KEY: API_KEY,
				BUNNY_STORAGE_ACCESS_KEY: STORAGE_KEY,
			}),
		},
		close(): void {
			bunny?.close();
			oidc?.close();
		},
	};
}
