import { readFile } from "node:fs/promises";
import { z } from "zod";
import { PolicySchema } from "./policy.ts";

const RepoConfig = z.strictObject({
	/** GitHub repository ("owner/name") the build is made from. */
	githubRepository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
	/** CEL expression deciding whether a request may publish; see docs/authorization.md. */
	policy: PolicySchema,
	/** Argument for rapid-buildgit; see its usage for details. */
	modRoot: z.string().default("/"),
	/** Argument for rapid-buildgit; see its usage for details. */
	modinfo: z.string().default("modinfo.lua"),
});

const Config = z.strictObject({
	/** Expected "aud" claim of the GitHub Actions OIDC token. */
	audience: z.string().min(1),
	/** Expected "iss" claim, and where the signing keys are fetched from. */
	oidcIssuer: z.url().default("https://token.actions.githubusercontent.com"),
	bunny: z.strictObject({
		/** Storage zone the rapid repos are uploaded to. */
		storageZone: z.string().min(1),
		/**
		 * Storage API base URL, e.g. "https://storage.bunnycdn.com".
		 *
		 * See https://bunny.net/docs/storage/http#storage-endpoints.
		 */
		storageUrl: z.url(),
		/** Management API base URL. */
		apiUrl: z.url().default("https://api.bunny.net"),
		/** Name of the pull zone serving the rapid repos, where the edge rules live. */
		pullZone: z.string().min(1),
		/** Public base URL of the pull zone serving the rapid repos. */
		baseUrl: z.url(),
	}),
	/** Rapid repos that can be built, by the name the request asks for. */
	repos: z
		.record(z.string().regex(/^[a-z0-9-]{2,20}$/), RepoConfig)
		.refine((repos) => Object.keys(repos).length > 0, "at least one repo is required"),
});

export type Config = z.infer<typeof Config>;
export type RepoConfig = z.infer<typeof RepoConfig>;
/** The config as it is written in JSON, before defaults are filled in. */
export type ConfigInput = z.input<typeof Config>;

export function parseConfig(value: unknown): Config {
	const parsed = Config.safeParse(value);
	if (!parsed.success) throw new Error(`Invalid config: ${z.prettifyError(parsed.error)}`);
	return parsed.data;
}

export async function loadConfig(path: string): Promise<Config> {
	return parseConfig(JSON.parse(await readFile(path, "utf8")));
}
