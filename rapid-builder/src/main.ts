import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { createOidcVerifier } from "./auth.ts";
import { runBuild } from "./build.ts";
import { loadConfig } from "./config.ts";
import { logger } from "./log.ts";
import * as metrics from "./metrics.ts";
import { createBuildServer } from "./server.ts";

const env = z
	.object({
		/** Port the build API listens on. */
		PORT: z.coerce.number().int().min(0).default(8080),
		/** Port serving Prometheus metrics; keep it off the public internet. */
		METRICS_PORT: z.coerce.number().int().min(0).default(9464),
		/**
		 * Directory holding the state we keep between builds, one entry per repo
		 * name from the config:
		 *
		 * - `git/<repo>` is the git working copy we build from. `git/<repo>.tmp`
		 *   is a clone still in progress.
		 * - `store/<repo>` is the rapid store rapid-buildgit writes and we upload
		 *   from: `pool/`, `packages/` and `versions.gz`.
		 *
		 * Both grow incrementally, so this has to be a persistent volume.
		 */
		DATA_DIR: z.string().default("/data"),
		/** Path to config.json; see src/config.ts for its schema. */
		CONFIG_FILE: z.string().default("/etc/rapid-build/config.json"),
		/** Rehearses a publish: we build and read as usual, but never write to Bunny. */
		BUNNY_DRY_RUN: z.stringbool().default(false),
		/** Secrets: each is `NAME` or `NAME_PATH`, see readSecret. */
		BUNNY_API_KEY: z.string().min(1).optional(),
		BUNNY_API_KEY_PATH: z.string().min(1).optional(),
		BUNNY_STORAGE_ACCESS_KEY: z.string().min(1).optional(),
		BUNNY_STORAGE_ACCESS_KEY_PATH: z.string().min(1).optional(),
	})
	.parse(process.env);

/** The `NAME` of every `NAME`/`NAME_PATH` pair declared above. */
type Secret = {
	[K in keyof typeof env]-?: K extends `${infer N}_PATH` ? N : never;
}[keyof typeof env];

/** Resolves a secret from `NAME`, or reads it from the file `NAME_PATH` names. */
async function readSecret(name: Secret): Promise<string> {
	const value = env[name];
	const file = env[`${name}_PATH`];
	if (value !== undefined) {
		if (file !== undefined) throw new Error(`Set ${name} or ${name}_PATH, not both`);
		return value;
	}
	if (file === undefined) throw new Error(`${name} or ${name}_PATH is required`);
	const secret = (await readFile(file, "utf8")).trim();
	if (!secret) throw new Error(`${name}_PATH file ${file} holds no secret`);
	return secret;
}

const [config, bunnyApiKey, bunnyStorageAccessKey] = await Promise.all([
	loadConfig(env.CONFIG_FILE),
	readSecret("BUNNY_API_KEY"),
	readSecret("BUNNY_STORAGE_ACCESS_KEY"),
]);

const server = createBuildServer({
	config,
	dataDir: env.DATA_DIR,
	bunnyApiKey,
	bunnyStorageAccessKey,
	bunnyDryRun: env.BUNNY_DRY_RUN,
	maxWaitingBuilds: 3,
	verifyToken: createOidcVerifier(config.oidcIssuer),
	build: runBuild,
	logger,
});

const metricsServer = metrics.startMetricsServer(env.METRICS_PORT, env.DATA_DIR);

// First signal attempts graceful shutdown, another one kills instantly.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, () => {
		logger.info({ signal }, "Signal received, draining in-flight builds");
		for (const s of [server, metricsServer]) {
			s.close();
			s.closeIdleConnections();
		}
	});
}

server.listen(env.PORT, () => {
	const { port } = server.address() as AddressInfo;
	logger.info(
		{ port, repos: Object.keys(config.repos), bunnyDryRun: env.BUNNY_DRY_RUN },
		"Listening for build requests",
	);
});
