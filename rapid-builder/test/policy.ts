// Unit test of the authorization policy: what the CEL environment exposes, which
// policies the schema refuses to compile, and how a policy decision is read.

import assert from "node:assert/strict";
import { test } from "node:test";
import { authorize, PolicySchema } from "../src/policy.ts";

/** The part of a repo config a decision reads, with the policy compiled as the config does. */
function repoWith(policy: string) {
	return { githubRepository: "acme/widgets", policy: PolicySchema.parse(policy) };
}

const claims = { repository: "acme/widgets", event_name: "push", ref: "refs/heads/master" };
const request = { branch: "test", commit: "a".repeat(40) };

test("a policy decides on claims and on what the request publishes", () => {
	const repo = repoWith("claims.event_name == 'push' && request.branch.matches('^pr-[0-9]+$')");
	assert.equal(authorize(repo, claims, { ...request, branch: "pr-12" }).ok, true);
	assert.equal(authorize(repo, { ...claims, event_name: "schedule" }, request).ok, false);
});

test("the token repository is checked outside the policy", () => {
	// Even the policy that allows everything only allows its own repository,
	// and GitHub repository names compare case-insensitively.
	const repo = repoWith("true");
	assert.equal(authorize(repo, claims, request).ok, true);
	assert.equal(authorize(repo, { ...claims, repository: "ACME/Widgets" }, request).ok, true);
	// A one-element array must not pass for the name it holds.
	assert.equal(authorize(repo, { ...claims, repository: ["acme/widgets"] }, request).ok, false);
	assert.deepEqual(authorize(repo, { ...claims, repository: "acme/other" }, request), {
		ok: false,
		reason: 'token repository is "acme/other", want "acme/widgets"',
	});
	assert.deepEqual(authorize(repo, { ...claims, repository: undefined }, request), {
		ok: false,
		reason: 'token repository is missing, want "acme/widgets"',
	});
});

test("reading a value the request does not have raises, it does not read as false", () => {
	// Declaring the Request type does not make its fields required, so an
	// unguarded read raises, exactly like a claim the token does not have.
	const unguarded = repoWith("request.version == '1.2.3'");
	const noVersion = authorize(unguarded, claims, request);
	assert.ok(!noVersion.ok, "expected the request to be turned away");
	assert.match(noVersion.reason, /policy failed: .*version/);
	assert.equal(authorize(unguarded, claims, { ...request, version: "1.2.3" }).ok, true);

	// Reading a claim the token lacks is an evaluation error, not false.
	const environment = repoWith("claims.environment == 'prod'");
	const noClaim = authorize(environment, claims, request);
	assert.ok(!noClaim.ok, "expected the request to be turned away");
	assert.match(noClaim.reason, /policy failed: .*environment/);
	assert.equal(authorize(environment, { ...claims, environment: "prod" }, request).ok, true);
});

test("rejects policies that cannot be trusted to decide", () => {
	const cases: [string, string][] = [
		["claims.event_name == 'push' && (", "a syntax error"],
		["token.repository == 'x'", "a variable not in scope"],
		["request.brnch == 'test'", "a misspelled request field"],
	];
	for (const [policy, why] of cases) {
		assert.throws(() => repoWith(policy), /invalid CEL/, why);
	}
	// The only wording here that is ours rather than the type checker's.
	assert.throws(() => repoWith("request.branch"), /must decide a bool, this decides string/);
});
