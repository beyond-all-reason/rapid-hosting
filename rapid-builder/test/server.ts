// Unit test of the build API: routing, authentication, request validation, the
// policy verdict, backpressure, the two build outcomes and how the stream
// frames them, and what all of that leaves in the log and in the metrics.
//
// We inject the build, so nothing here spawns a tool or writes to disk.
// test/e2e.ts covers the real pipeline. Everything else is real, the OIDC
// verification included. The issuer is dev/oidc.ts.
//
// Tests share the server and the process-wide metric registry, so they run in
// declaration order and read metrics as deltas. Don't enable concurrency.

import assert from "node:assert/strict";
import { type AddressInfo, connect } from "node:net";
import { text } from "node:stream/consumers";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pino } from "pino";
import type { Counter, Gauge } from "prom-client";
import { AUDIENCE, startOidcIssuer } from "../dev/oidc.ts";
import { createOidcVerifier } from "../src/auth.ts";
import type { runBuild } from "../src/build.ts";
import { parseConfig } from "../src/config.ts";
import * as metrics from "../src/metrics.ts";
import { createBuildServer } from "../src/server.ts";

const MAX_WAITING = 3;
const COMMIT = "a".repeat(40);

// --- A local OIDC issuer ------------------------------------------------------

const oidc = await startOidcIssuer();
after(() => oidc.close());
const { issuer, mint } = oidc;

// --- The service under test ---------------------------------------------------

const config = parseConfig({
	audience: AUDIENCE,
	bunny: {
		storageZone: "zone1",
		// Never reached: the build is injected.
		storageUrl: "https://storage.invalid",
		pullZone: "pz",
		baseUrl: "https://cdn.invalid",
	},
	// What a policy can express is settled in test/policy.ts. This one only has
	// to reach a verdict for the branches these tests publish.
	repos: {
		testrepo: {
			githubRepository: "test/repo",
			policy: "request.branch.matches('^pr-[0-9]+$') || request.branch.matches('^release/')",
		},
	},
});

/** Every pino record the service wrote, parsed. */
interface LogRecord {
	level: string;
	msg: string;
	[field: string]: unknown;
}
const records: LogRecord[] = [];
const logger = pino(
	{ level: "trace", formatters: { level: (label) => ({ level: label }) } },
	{ write: (line: string) => void records.push(JSON.parse(line) as LogRecord) },
);

type BuildOptions = Parameters<typeof runBuild>[0];
const builds: BuildOptions[] = [];
/** What the injected build does. A test swaps it for the behaviour it needs. */
let onBuild: (opts: BuildOptions) => Promise<void> = async (opts) => {
	opts.log("building");
};

const server = createBuildServer({
	config,
	dataDir: "/nonexistent",
	bunnyApiKey: "api-key",
	bunnyStorageAccessKey: "storage-key",
	// Tests don't modify anything anyway, we set it only to verify it's passed
	// correctly to build function.
	bunnyMode: "dry-run",
	maxWaitingBuilds: MAX_WAITING,
	verifyToken: createOidcVerifier(issuer),
	build: (opts) => {
		builds.push(opts);
		return onBuild(opts);
	},
	logger,
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
// We call both, since a keep-alive socket the test client left open would hold
// the process after the last test.
after(() => {
	server.close();
	server.closeAllConnections();
});
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const decoder = new TextDecoder();

/** Posts a build request. */
function postBuild(
	token: string | undefined,
	params: Record<string, string> = {},
): Promise<Response> {
	const query = new URLSearchParams({
		repo: "testrepo",
		branch: "pr-7",
		commit: COMMIT,
		...params,
	});
	return fetch(`${base}/build?${query}`, {
		method: "POST",
		headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
	});
}

/** Posts a build request and reads the whole log it streams back. */
async function build(
	token: string | undefined,
	params: Record<string, string> = {},
): Promise<{ status: number; text: string; truncated: boolean }> {
	const res = await postBuild(token, params);
	let text = "";
	try {
		for await (const chunk of res.body ?? []) text += decoder.decode(chunk, { stream: true });
	} catch {
		return { status: res.status, text, truncated: true };
	}
	return { status: res.status, text, truncated: false };
}

/** Waits for the first log record satisfying `match`. */
async function waitForRecord(match: (record: LogRecord) => boolean): Promise<LogRecord> {
	for (let i = 0; i < 400; i++) {
		const found = records.find(match);
		if (found) return found;
		await sleep(5);
	}
	return assert.fail("timed out waiting for a log record");
}

/** Reads one counter series, so a test can assert on how much it moved. */
async function counter(
	metric: Counter | Gauge,
	labels: Record<string, string | number>,
): Promise<number> {
	const { values } = await metric.get();
	const found = values.find((v) =>
		Object.entries(labels).every(([k, want]) => v.labels[k] === want),
	);
	return found?.value ?? 0;
}

// --- Tests --------------------------------------------------------------------

test("only the two documented routes answer", async () => {
	const health = await fetch(`${base}/healthz`);
	assert.equal(health.status, 200);
	assert.equal(await health.text(), "ok\n");

	const wrongMethod = await fetch(`${base}/build`);
	assert.equal(wrongMethod.status, 405, "GET is not how a build is asked for");
	assert.equal(wrongMethod.headers.get("allow"), "POST", "and the answer says which is");
	assert.equal((await fetch(`${base}/healthz`, { method: "POST" })).status, 405);
	assert.equal((await fetch(`${base}/metrics`)).status, 404, "metrics have their own port");

	// Anyone can hit a route we don't serve, so it stays below the level
	// production runs on.
	const record = await waitForRecord((r) => r.msg === "Request rejected" && r.status === 404);
	assert.equal(record.level, "debug");
});

test("a request without a token it can verify is turned away", async () => {
	const before = await counter(metrics.rejectedRequests, { status: 401 });
	// jose checks expiry, signature and format on its own. It checks the audience
	// and the issuer only when src/auth.ts passes them as options.
	assert.equal((await build(undefined)).status, 401, "no authorization header");
	assert.equal((await build(await mint({ aud: "other-aud" }))).status, 401, "the wrong audience");
	assert.equal(
		(await build(await mint({ iss: "https://elsewhere.invalid" }))).status,
		401,
		"the wrong issuer",
	);
	// A header that is not a bearer token at all never reaches the verifier.
	const basic = await fetch(`${base}/build?repo=testrepo&branch=pr-7&commit=${COMMIT}`, {
		method: "POST",
		headers: { authorization: "Basic dXNlcjpwYXNz" },
	});
	assert.equal(basic.status, 401);
	assert.equal(await basic.text(), "Missing bearer token\n");
	assert.equal(basic.headers.get("www-authenticate"), "Bearer", "no bearer token is none sent");

	assert.equal(await counter(metrics.rejectedRequests, { status: 401 }), before + 4);
	assert.equal(builds.length, 0, "no build was started");
});

test("a malformed build request is refused before any policy runs", async () => {
	const token = await mint();
	// One per field the schema declares, and both names that could point outside
	// their own directory: what each pattern accepts is the schema's own
	// business.
	const cases: [Record<string, string>, string][] = [
		[{ repo: "nope" }, "unknown repo"],
		[{ branch: ".hidden" }, "branch outside the global limits"],
		[{ branch: "out/../side" }, "branch pointing outside its own directory"],
		[{ version: "../evil" }, "version outside the global limits"],
		[{ version: "out/../side" }, "version pointing outside its own directory"],
		[{ commit: "HEAD" }, "commit is not a sha"],
	];
	for (const [params, why] of cases) {
		assert.equal((await build(token, params)).status, 400, why);
	}
	assert.equal(builds.length, 0, "no build was started");
});

test("what the policy refuses stays refused, and only we learn why", async () => {
	// test/policy.ts covers which requests a policy lets through. Here we check
	// both ways a denial can arrive.
	const cases: [Record<string, unknown>, Record<string, string>, string][] = [
		[{ repository: "evil/repo" }, {}, "token of another repository"],
		[{}, { branch: "bad-branch" }, "branch the policy refuses"],
	];
	for (const [claims, params, why] of cases) {
		const res = await build(await mint(claims), params);
		assert.equal(res.status, 403, `${why}: ${res.text}`);
		assert.equal(res.text, `This token may not publish testrepo:${params.branch ?? "pr-7"}\n`);
	}
	// We log the full reason for the operator. The requester got the sanitized
	// message above.
	const record = await waitForRecord((r) => r.msg === "Request rejected" && r.status === 403);
	assert.equal(record.level, "info");
	assert.match(String(record.reason), /token repository is|policy returned/);
	assert.equal(builds.length, 0, "no build was started");
});

test("an authorized request runs a build and gets its log back", async () => {
	const before = await counter(metrics.buildsTotal, { repo: "testrepo", outcome: "success" });
	onBuild = async (opts) => {
		opts.log("$ rapid-buildgit ...");
		opts.log("done");
	};

	const res = await build(await mint(), { version: "1.2.3" });

	assert.equal(res.status, 200, res.text);
	assert.ok(!res.truncated, "a complete body is what says the build worked");
	const body = res.text.trimEnd().split("\n");
	assert.match(body[0] ?? "", /^Build requested: repo=testrepo branch=pr-7 /);
	assert.deepEqual(body.slice(1), [
		"$ rapid-buildgit ...",
		"done",
		`Build succeeded: testrepo:pr-7 at ${COMMIT}`,
	]);

	// The build was asked for exactly what the request named.
	const opts = builds.at(-1);
	assert.equal(opts?.repoName, "testrepo");
	assert.equal(opts?.branch, "pr-7");
	assert.equal(opts?.commit, COMMIT);
	assert.equal(opts?.version, "1.2.3");
	assert.equal(opts?.dataDir, "/nonexistent");
	assert.equal(opts?.bunnyApiKey, "api-key");
	assert.equal(opts?.bunnyMode, "dry-run", "the mode the service runs in reached the build");
	assert.equal(opts?.bunny, config.bunny);
	assert.equal(opts?.repo, config.repos.testrepo);

	// The same lines on stdout, tagged with the build they belong to.
	const succeeded = await waitForRecord((r) =>
		r.msg.startsWith("Build succeeded: testrepo:pr-7"),
	);
	assert.equal(succeeded.level, "info");
	assert.equal(succeeded.repo, "testrepo");
	assert.equal(succeeded.branch, "pr-7");
	assert.equal(succeeded.commit, COMMIT);
	const mine = records.filter((r) => r.buildId === succeeded.buildId);
	const requested = mine.find((r) => r.msg.startsWith("Build requested"));
	assert.equal(requested?.version, "1.2.3");
	assert.equal(requested?.sub, "repo:test/repo:pull_request");
	assert.equal(requested?.runId, "42");
	assert.equal(requested?.actor, "tester");
	assert.ok(
		mine.some((r) => r.msg === "$ rapid-buildgit ..."),
		"the build's own output shares the build id",
	);

	assert.equal(
		await counter(metrics.buildsTotal, { repo: "testrepo", outcome: "success" }),
		before + 1,
	);
	assert.ok(
		(await counter(metrics.lastSuccess, { repo: "testrepo" })) > Date.now() / 1000 - 60,
		"the success timestamp was set",
	);
});

test("a branch and a version may be named after a git ref", async () => {
	onBuild = async (opts) => {
		opts.log("done");
	};
	const branch = "release/1.2:rc.1";
	const version = "release/1.2:rc.1-4-9f3ab21";

	const res = await build(await mint(), { branch, version });

	assert.equal(res.status, 200, res.text);
	assert.ok(
		res.text.includes(`Build succeeded: testrepo:${branch} at ${COMMIT}`),
		`the tag is the branch as asked for: ${res.text}`,
	);
	const opts = builds.at(-1);
	assert.equal(opts?.branch, branch);
	assert.equal(opts?.version, version);
});

test("the log arrives while the build is still running", async () => {
	const gate = Promise.withResolvers<void>();
	onBuild = async (opts) => {
		opts.log("checking out");
		await gate.promise;
		opts.log("uploading");
	};

	const res = await postBuild(await mint(), { branch: "pr-8" });
	assert.equal(res.status, 200);
	const reader = (res.body ?? assert.fail("no body")).getReader();
	const next = async () => {
		const { value, done } = await reader.read();
		assert.ok(!done, "the response ended before the build did");
		return decoder.decode(value, { stream: true });
	};

	let text = "";
	// The build is parked mid-run, so everything read here arrived before the
	// build ended.
	while (!text.includes("checking out")) text += await next();
	assert.match(text, /^Build requested: /);
	assert.ok(!text.includes("uploading"), "only what the build has logged so far");

	gate.resolve();
	while (!text.includes("Build succeeded")) text += await next();
	assert.equal((await reader.read()).done, true, "and then the body ends, cleanly");
	assert.match(text, /^uploading$/m);
});

test("HTTP/1.0 is refused, since its framing cannot signal the outcome", async () => {
	const before = builds.length;
	const socket = connect(Number(new URL(base).port), "127.0.0.1");
	const query = `repo=testrepo&branch=pr-9&commit=${COMMIT}`;
	socket.end(`POST /build?${query} HTTP/1.0\r\nauthorization: Bearer ${await mint()}\r\n\r\n`);

	assert.match(await text(socket), /^HTTP\/1\.1 505 /);
	assert.equal(builds.length, before, "no build was started");
});

test("a failed build cuts the response short, and frees the repo", async () => {
	const before = await counter(metrics.buildsTotal, { repo: "testrepo", outcome: "failure" });
	onBuild = async (opts) => {
		opts.log("$ rapid-buildgit ...");
		throw new Error("buildgit exploded");
	};

	const res = await build(await mint(), { branch: "pr-666" });

	// We already sent the 200 with the first log line, so the cut body is the
	// only signal left.
	assert.equal(res.status, 200);
	assert.ok(res.truncated, "the body ended mid-stream");
	assert.match(res.text, /^\$ rapid-buildgit \.\.\.$/m, "the log so far is in the response");
	assert.match(res.text, /^Build failed: buildgit exploded$/m, "and what went wrong, before it");
	const record = await waitForRecord(
		(r) => r.msg.startsWith("Build failed") && r.branch === "pr-666",
	);
	assert.equal(record.level, "error", "failures are logged at error level");
	assert.equal(
		await counter(metrics.buildsTotal, { repo: "testrepo", outcome: "failure" }),
		before + 1,
	);

	// The lock and the queue slot were both released: the next build works.
	onBuild = async () => {};
	assert.equal((await build(await mint())).status, 200);
});

test("builds of a repo queue up, and the overflow gets backpressure", async () => {
	const before = await counter(metrics.rejectedRequests, { status: 429 });
	const gate = Promise.withResolvers<void>();
	onBuild = () => gate.promise;

	const inFlight = [];
	for (const branch of ["pr-71", "pr-72", "pr-73", "pr-74"]) {
		inFlight.push(build(await mint(), { branch }));
		await waitForRecord((r) => r.msg.startsWith("Build requested") && r.branch === branch);
	}

	const shed = await build(await mint(), { branch: "pr-75" });
	assert.equal(shed.status, 429, "the 5th got backpressure");
	assert.match(shed.text, /already queued for testrepo/);
	assert.ok(!shed.truncated, "a rejection is a whole response, not a cut-off one");
	assert.ok(
		!records.some((r) => r.branch === "pr-75"),
		"and never opened a build log, having never been a build",
	);

	gate.resolve();
	const results = await Promise.all(inFlight);
	assert.deepEqual(
		results.map((r) => r.status),
		[200, 200, 200, 200],
		"the four accepted builds all ran",
	);
	assert.equal(await counter(metrics.rejectedRequests, { status: 429 }), before + 1);
});
