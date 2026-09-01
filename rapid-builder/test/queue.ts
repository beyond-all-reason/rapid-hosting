// Unit test of the per-repo build queue: mutual exclusion, ordering, the bound
// on waiting builds, and the gauges that report all of it.
//
// The queue chains promises and has no timers, so nothing here waits. Builds
// record when they start and when they end, and the resulting trace says
// whether they overlapped: "start a, end a, start b" is one build at a time,
// "start a, start b" is two builds running at once.

import assert from "node:assert/strict";
import { test } from "node:test";
import { queuedBuilds } from "../src/metrics.ts";
import { QueueFullError, ReposQueue } from "../src/queue.ts";

/** Submits a build that records itself around one turn of the event loop. */
function build(queue: ReposQueue, repo: string, name: string, trace: string[]): Promise<string> {
	return queue.run(repo, async () => {
		trace.push(`start ${name}`);
		// Yields for the one turn in which a second build would start, if the
		// queue let it. Without it a trace could never show overlap.
		await null;
		trace.push(`end ${name}`);
		return name;
	});
}

/** Both queue gauges for one repo, so the pair describes one instant. */
async function gauges(repo: string): Promise<{ running?: number; waiting?: number }> {
	const { values } = await queuedBuilds.get();
	const read = (state: string) =>
		values.find((v) => v.labels.repo === repo && v.labels.state === state)?.value;
	return { running: read("running"), waiting: read("waiting") };
}

test("a repo builds one commit at a time, in submission order", async () => {
	const queue = new ReposQueue(3);
	const trace: string[] = [];
	const names = ["a", "b", "c"];

	const results = await Promise.all(names.map((n) => build(queue, "one-at-a-time", n, trace)));

	assert.deepEqual(results, ["a", "b", "c"], "each caller got its own build's value");
	assert.deepEqual(trace, ["start a", "end a", "start b", "end b", "start c", "end c"]);
});

test("different repos do not block each other", async () => {
	const queue = new ReposQueue(3);
	const trace: string[] = [];

	await Promise.all([build(queue, "repo-a", "a", trace), build(queue, "repo-b", "b", trace)]);

	assert.deepEqual(trace, ["start a", "start b", "end a", "end b"], "both held their own lock");
});

test("waiting builds are bounded, and a shed request takes no slot", async () => {
	const queue = new ReposQueue(3);
	const gate = Promise.withResolvers<void>();
	const hang = () => queue.run("bounded", () => gate.promise);

	// One runs and three wait, so the fourth submission is the last one accepted.
	const accepted = [hang(), hang(), hang(), hang()];
	const shed = hang();
	assert.deepEqual(
		await gauges("bounded"),
		{ running: 1, waiting: 3 },
		"the shed request left the counts alone",
	);

	assert.ok(queue.isFull("bounded"), "and says so before another one is submitted");
	assert.ok(!queue.isFull("elsewhere"), "a repo nobody builds is never full");

	await assert.rejects(shed, QueueFullError);
	gate.resolve();
	await Promise.all(accepted);
	assert.deepEqual(await gauges("bounded"), { running: 0, waiting: 0 }, "drained");
});

test("a failed build hands the lock to the next one", async () => {
	const queue = new ReposQueue(3);
	const trace: string[] = [];
	const failed = queue.run("after-failure", () => Promise.reject(new Error("build exploded")));
	const next = build(queue, "after-failure", "next", trace);

	await assert.rejects(failed, { message: "build exploded" });
	assert.equal(await next, "next");
	assert.deepEqual(trace, ["start next", "end next"], "the failure did not wedge the repo");
});
