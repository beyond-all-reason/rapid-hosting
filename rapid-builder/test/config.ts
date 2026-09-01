// Unit test of the config schema: the rules that are ours rather than Zod's.
// Policy parsing is covered in test/policy.ts, which owns that half of the
// schema.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";

/** The smallest config that loads. Tests override one part at a time. */
const minimal = {
	audience: "bar-rapid-build",
	bunny: {
		storageZone: "zone",
		storageUrl: "https://storage.bunnycdn.com",
		pullZone: "pz",
		baseUrl: "https://cdn.example.com",
	},
	repos: { mod: { githubRepository: "acme/mod", policy: "true" } },
};

/** Applies a patch to the single repo of the minimal config. */
function withRepo(repo: Record<string, unknown>): unknown {
	return { ...minimal, repos: { byar: { ...minimal.repos.mod, ...repo } } };
}

test("a config with no repos would leave the service unable to build anything", () => {
	assert.throws(() => parseConfig({ ...minimal, repos: {} }), /at least one repo is required/);
});

test("a github repository has to name an owner and a repository", () => {
	for (const name of ["widgets", "acme/wid gets"]) {
		assert.throws(
			() => parseConfig(withRepo({ githubRepository: name })),
			/githubRepository/,
			name,
		);
	}
});

test("a repo name has to survive being pasted into a URL and a rapid tag", () => {
	const accepts = (name: string) =>
		parseConfig({ ...minimal, repos: { [name]: minimal.repos.mod } });
	for (const name of ["by", "byar", "beyond-all-reason", "b2", "a".repeat(20)]) {
		assert.ok(accepts(name), name);
	}
	for (const name of ["b", "a".repeat(21), "BYAR", "by_ar", "by ar", "by.ar", "by/ar", ""]) {
		assert.throws(() => accepts(name), /Invalid config/, name);
	}
});
