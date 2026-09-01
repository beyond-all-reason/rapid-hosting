// Unit test of the Bunny side of a build: the CDN visibility poll, and the edge
// rule refresh that works around storage replication lag.
//
// Bunny is faked with dev/bunny.ts, everything else is real.
//
// Tests reset the fake between them and run in declaration order. Don't enable
// concurrency.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { API_KEY, type FakeEdgeRule, STORAGE_KEY, startFakeBunny } from "../dev/bunny.ts";
import { refreshVersionsEdgeRule, waitForCdnVisibility } from "../src/bunny.ts";

const dir = await mkdtemp(path.join(tmpdir(), "rapid-build-bunny-"));
const bunny = await startFakeBunny({ dir });
after(async () => {
	bunny.close();
	await rm(dir, { recursive: true, force: true });
});
const cdn = bunny.config.baseUrl;

// --- The visibility poll ------------------------------------------------------
//
// What matters is that a miss is retried and that the wait ends. The schedule is
// a tuning decision, so these set their own rather than asserting production's.

const PROBE = "testrepo/fresh/probe.gz";

/** Arms the edge to miss `misses` times, then polls it for a file it does have. */
function poll(misses: number, opts: { status?: number; timeoutMs?: number } = {}) {
	bunny.reset();
	bunny.storage.set(PROBE, { body: Buffer.from("the fresh copy"), created: new Date() });
	bunny.cdnFailures.push({ prefix: PROBE, status: opts.status ?? 404, times: misses });
	const lines: string[] = [];
	let notFound = 0;
	const waited = waitForCdnVisibility({
		url: `${cdn}/${PROBE}`,
		log: (line) => lines.push(line),
		timeoutMs: opts.timeoutMs,
		initialBackoffMs: 1,
		maxBackoffMs: 4,
		onNotFound: () => notFound++,
	});
	return { waited, lines, notFound: () => notFound };
}

test("a file already at the edge is not waited for at all", async () => {
	const { waited, lines, notFound } = poll(0);
	await waited;
	assert.deepEqual(lines, [], "nothing to report");
	assert.equal(notFound(), 0, "no 404 to count");
	assert.equal(bunny.calls.length, 1, "asked once and was done");
});

test("misses are retried until the file appears", async () => {
	const { waited, lines, notFound } = poll(2);
	await waited;
	assert.equal(bunny.calls.length, 3, "two misses and the hit");
	assert.match(lines[0] ?? "", /probe\.gz not yet visible on CDN \(404\), retrying in \d+ms/);
	assert.equal(lines.length, 2, "one line per miss");
	assert.equal(notFound(), 2, "each 404 is counted");
});

test("an edge error is a miss like any other, not a failure", async () => {
	// The poll asks whether the file is servable, and 500 says it is not.
	const { waited, lines, notFound } = poll(1, { status: 500 });
	await waited;
	assert.match(lines[0] ?? "", /not yet visible on CDN \(500\)/);
	assert.equal(notFound(), 0, "only a 404 counts as replication lag");
});

test("the wait gives up once the timeout has passed", async () => {
	const { waited, notFound } = poll(Infinity, { timeoutMs: 20 });
	await assert.rejects(waited, {
		message: `Timed out waiting for ${cdn}/${PROBE} to become visible`,
	});
	assert.equal(notFound(), bunny.calls.length, "the 404 that timed out is counted too");
});

// --- The edge rule refresh ----------------------------------------------------
//
// Verify that the fresh copy and the rule end up configuring the versions.gz the
// build produced, that they do so in an order no client can read a broken
// state from, and that old copies are collected.

const DESCRIPTION = "Redirect to fresh testrepo version";
const DAY = 24 * 60 * 60 * 1000;

const versionsGz = Buffer.from("the freshly built versions.gz");

/** Runs the refresh for "testrepo", collecting what it logged. */
async function refresh(opts: { dryRun?: boolean } = {}): Promise<string[]> {
	const lines: string[] = [];
	await refreshVersionsEdgeRule({
		repoName: "testrepo",
		versionsGz,
		bunny: bunny.config,
		apiKey: API_KEY,
		storageAccessKey: STORAGE_KEY,
		dryRun: opts.dryRun ?? false,
		log: (line) => lines.push(line),
	});
	return lines;
}

/**
 * A rule already on the pull zone, pointing at `target`, plus any extra fields.
 *
 * Complete, because Bunny returns complete rules and the fake refuses anything
 * less.
 */
function existingRule(target: string, extra: Partial<FakeEdgeRule> = {}): FakeEdgeRule {
	return {
		Description: DESCRIPTION,
		ActionType: 1,
		ActionParameter1: target,
		ActionParameter2: "301",
		ActionParameter3: null,
		TriggerMatchingType: 1,
		Enabled: true,
		OrderIndex: 0,
		ReadOnly: false,
		Triggers: [
			{
				Type: 0,
				PatternMatches: [`${cdn}/testrepo/versions.gz`],
				PatternMatchingType: 0,
				Parameter1: "",
			},
		],
		...extra,
	};
}

/**
 * Saves the `body` under `versions.gz`, fresh copy, and updates edge rule.
 * Returns the name of the fresh copy.
 */
function setFreshVersionsGz(body: Buffer): string {
	const name = "versions_PREVIOUS.gz";
	const created = new Date();
	bunny.storage.set("testrepo/versions.gz", { body, created });
	bunny.storage.set(`testrepo/fresh/${name}`, { body, created });
	bunny.zones[0]?.EdgeRules.push(existingRule(`${cdn}/testrepo/fresh/${name}`));
	return name;
}

/** The rule the fake pull zone holds, which is what the refresh left behind. */
function storedRule(): FakeEdgeRule {
	const rule = bunny.zones[0]?.EdgeRules.find((r) => r.Description === DESCRIPTION);
	assert.ok(rule, "the pull zone has the versions.gz rule");
	return rule;
}

/** The fresh copies currently in storage, by name. */
const freshCopies = () =>
	bunny.storage
		.keys()
		.filter((k) => k.startsWith("testrepo/fresh/"))
		.map((k) => k.slice("testrepo/fresh/".length))
		.sort();

test("a rule already pointing at the new bytes needs nothing done to it", async () => {
	bunny.reset();
	const previous = setFreshVersionsGz(versionsGz);

	const lines = await refresh();

	assert.deepEqual(lines, ["CDN already serves the new testrepo versions.gz"]);
	assert.deepEqual(
		bunny.calls,
		["GET /api/pullzone?includeCertificate=false", `GET /cdn/testrepo/fresh/${previous}`],
		"asked, then stopped",
	);
	assert.deepEqual(freshCopies(), [previous], "no second copy was uploaded");
});

test("a pull zone without the rule gets one, pointed at a fresh copy", async () => {
	bunny.reset();

	const lines = await refresh();

	const [name] = freshCopies();
	assert.match(name ?? "", /^versions_[0-9T]{18}\.gz$/, "stamped with the upload time");
	assert.deepEqual(
		bunny.storage.get(`testrepo/fresh/${name}`)?.body,
		versionsGz,
		"the fresh copy is the versions.gz the build produced",
	);

	const rule = storedRule();
	assert.equal(rule.ActionParameter1, `${cdn}/testrepo/fresh/${name}`);
	assert.equal(rule.ActionType, 1, "redirect");
	assert.equal(rule.ActionParameter2, "301");
	assert.equal(rule.Enabled, true);
	assert.equal(rule.TriggerMatchingType, 1, "every trigger has to match");
	assert.deepEqual(rule.Triggers, [
		{
			Type: 0,
			PatternMatches: [`${cdn}/testrepo/versions.gz`],
			PatternMatchingType: 0,
			Parameter1: "",
		},
		{
			Type: 1,
			PatternMatches: ["*latestreplicated*"],
			PatternMatchingType: 2,
			Parameter1: "User-Agent",
		},
	]);
	assert.ok(
		lines.some((l) => l.includes(`Edge rule "${DESCRIPTION}" not found`)),
		"said it was creating one",
	);
	assert.ok(lines.some((l) => l.startsWith("Edge rule updated to redirect")));
});

test("the redirect only moves once the CDN can serve what it points at", async () => {
	bunny.reset();
	// A fresh copy is uploaded before the edge can serve it, which is the whole
	// reason the poll exists. Whichever name it gets, the edge misses it once.
	bunny.cdnFailures.push({ prefix: "testrepo/fresh/", status: 404, times: 1 });

	const lines = await refresh();

	assert.ok(
		lines.some((l) => l.includes("not yet visible on CDN")),
		"the poll had to wait",
	);
	const name = storedRule().ActionParameter1.split("/").pop();
	const freshGet = bunny.calls.lastIndexOf(`GET /cdn/testrepo/fresh/${name}`);
	const ruleUpdate = bunny.calls.indexOf("POST /api/pullzone/5/edgerules/addOrUpdate");
	assert.ok(freshGet >= 0 && ruleUpdate >= 0);
	assert.ok(freshGet < ruleUpdate, "the CDN served it before the rule was repointed");
});

test("an existing rule is repointed and otherwise left exactly as it was", async () => {
	bunny.reset();
	// Fields we do not model, that the API round-trips and we must not drop.
	bunny.zones[0]?.EdgeRules.push(
		existingRule(`${cdn}/testrepo/fresh/versions_OLD.gz`, {
			Guid: "rule-guid-1",
			OrderIndex: 4,
			SomeFieldWeHaveNeverHeardOf: true,
		}),
	);

	const lines = await refresh();

	const rule = storedRule();
	const [name] = freshCopies();
	assert.equal(rule.ActionParameter1, `${cdn}/testrepo/fresh/${name}`, "repointed");
	assert.equal(rule.Guid, "rule-guid-1");
	assert.equal(rule.OrderIndex, 4);
	assert.equal(rule.SomeFieldWeHaveNeverHeardOf, true);
	assert.ok(!lines.some((l) => l.includes("not found")), "did not create a second rule");
	assert.equal(bunny.zones[0]?.EdgeRules.length, 1);
});

test("old fresh copies are collected, the ones still in use are not", async () => {
	bunny.reset();
	const ago = (ms: number) => new Date(Date.now() - ms);
	const seed = (name: string, created: Date) =>
		bunny.storage.set(`testrepo/fresh/${name}`, { body: Buffer.from(name), created });
	seed("versions_ANCIENT.gz", ago(30 * DAY));
	seed("versions_OLD.gz", ago(2 * DAY));
	seed("versions_PREVIOUS.gz", ago(2 * DAY));
	seed("versions_RECENT.gz", ago(DAY / 2));
	// Pointing at the copy the CDN is redirecting to right now.
	bunny.zones[0]?.EdgeRules.push(existingRule(`${cdn}/testrepo/fresh/versions_PREVIOUS.gz`));

	const lines = await refresh();

	const uploaded = storedRule().ActionParameter1.split("/").pop();
	assert.deepEqual(
		freshCopies().filter((n) => n !== uploaded),
		["versions_PREVIOUS.gz", "versions_RECENT.gz"],
		"kept what is still served and anything from the last day, dropped the rest",
	);
	assert.equal(freshCopies().length, 3, "plus the copy this build just uploaded");
	assert.ok(lines.some((l) => l === "Deleted stale fresh copy versions_ANCIENT.gz"));
	assert.ok(lines.some((l) => l === "Deleted stale fresh copy versions_OLD.gz"));
});

test("a cleanup that fails does not fail the build", async () => {
	bunny.reset();
	bunny.listingStatus = 500;

	const lines = await refresh();

	const [name] = freshCopies();
	assert.equal(storedRule().ActionParameter1, `${cdn}/testrepo/fresh/${name}`);
	assert.ok(
		lines.some((l) => l.startsWith("Cleanup of old fresh copies failed (non-fatal):")),
		"said so and did not fail",
	);
});

test("an edge that will not answer for the current copy counts as stale", async () => {
	bunny.reset();
	// Only a 200 tells us what clients get. After any other status we don't
	// know, and a fresh copy plus a repointed rule is the answer either way.
	const previous = setFreshVersionsGz(versionsGz);
	bunny.cdnFailures.push({ prefix: `testrepo/fresh/${previous}`, status: 503, times: 1 });

	await refresh();

	const [name] = freshCopies().filter((n) => n !== previous);
	assert.equal(storedRule().ActionParameter1, `${cdn}/testrepo/fresh/${name}`);
});

test("refuses to guess when Bunny does not answer as expected", async () => {
	bunny.reset();
	bunny.zones = [{ Id: 9, Name: "some-other-zone", EdgeRules: [] }];
	await assert.rejects(refresh(), /Pull zone "pz" not found/);
});

// --- Dry run ------------------------------------------------------------------
//
// Verify that in dry run we only ever read, never write to Bunny.

test("a dry run reads everything and writes nothing", async () => {
	bunny.reset();
	// A real run would write to both of these.
	bunny.zones[0]?.EdgeRules.push(existingRule(`${cdn}/testrepo/fresh/versions_PREVIOUS.gz`));
	for (const name of ["versions_PREVIOUS.gz", "versions_OLD.gz"]) {
		bunny.storage.set(`testrepo/fresh/${name}`, {
			body: Buffer.from(name),
			created: new Date(Date.now() - 2 * DAY),
		});
	}

	const lines = await refresh({ dryRun: true });

	assert.deepEqual(
		bunny.calls,
		[
			"GET /api/pullzone?includeCertificate=false",
			"GET /cdn/testrepo/fresh/versions_PREVIOUS.gz",
			"GET /zone1/testrepo/fresh/",
		],
		"only reads so the whole path was exercised",
	);
	assert.equal(
		storedRule().ActionParameter1,
		`${cdn}/testrepo/fresh/versions_PREVIOUS.gz`,
		"the rule still points where it did",
	);
	assert.deepEqual(
		freshCopies(),
		["versions_OLD.gz", "versions_PREVIOUS.gz"],
		"storage as it was",
	);

	assert.ok(
		lines.some((l) =>
			/^Dry run: would upload testrepo\/fresh\/versions_[0-9T]{18}\.gz and point versions\.gz at http/.test(
				l,
			),
		),
		`said what it would have published: ${lines.join("\n")}`,
	);
	assert.ok(lines.includes("Dry run: would delete stale fresh copy versions_OLD.gz"));
});

test("a dry run does not wait for a copy it never uploaded", { timeout: 10_000 }, async () => {
	bunny.reset();
	// A real run polls for the copy it just uploaded. In a dry run we don't upload
	// anything, so polling would only timeout.
	bunny.cdnFailures.push({ prefix: "testrepo/fresh/", status: 404, times: Infinity });

	const lines = await refresh({ dryRun: true });

	assert.deepEqual(
		bunny.calls.filter((c) => c.includes("/fresh/")),
		["GET /zone1/testrepo/fresh/"],
		"the listing the cleanup needs, and no poll of the edge",
	);
	assert.ok(!lines.some((l) => l.includes("not yet visible on CDN")));
	assert.ok(
		lines.some((l) => l.endsWith("would create it")),
		"a missing rule is reported as one it would create, not one it created",
	);
	assert.deepEqual(bunny.zones[0]?.EdgeRules, [], "and the pull zone stayed empty");
});
