// Unit test of the config schema: the rules that are ours rather than Zod's.
// Policy parsing is covered in test/policy.ts, which owns that half of the
// schema.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

test("ssh paths must be absolute and free of what ssh expands", () => {
	const ssh = (keyFile: string, knownHostsFile?: string) =>
		parseConfig(withRepo({ ssh: { keyFile, knownHostsFile } }));
	assert.ok(ssh("/run/secrets/deploy key's", "/a b's"), "a space and ' reach ssh as they are");
	// Relative paths, then the characters ssh expands or unquotes itself.
	for (const bad of ["deploy_key", "~/key", "/a%d", "/a$b", '/a"b', "/a\\b"]) {
		assert.throws(() => ssh(bad), /absolute path without/, `keyFile ${bad}`);
		assert.throws(() => ssh("/key", bad), /absolute path without/, `knownHostsFile ${bad}`);
	}
});

test("by default ssh trusts only github.com", () => {
	const { ssh } = parseConfig(withRepo({ ssh: { keyFile: "/key" } })).repos.byar ?? {};
	const listed = execFileSync("ssh-keygen", ["-l", "-f", ssh?.knownHostsFile ?? ""]).toString();
	// GitHub's published fingerprints, see src/github_known_hosts.
	assert.deepEqual(listed.trim().split("\n").sort(), [
		"256 SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU github.com (ED25519)",
		"256 SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM github.com (ECDSA)",
		"3072 SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s github.com (RSA)",
	]);
});
