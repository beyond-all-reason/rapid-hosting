// Unit test of the command runner: what it logs, what it captures, how it
// reports a failure, and what it does to a command that outlives its timeout.
//
// Nothing is faked. Every test spawns a real process.

import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { run } from "../src/run.ts";

/** Collects a log so a test can assert on what a run would have printed. */
function recordLog() {
	const lines: string[] = [];
	return { log: (line: string) => lines.push(line), lines };
}

test("streams the command line and both output streams to the log", async () => {
	const { log, lines } = recordLog();
	const { stdout } = await run("sh", ["-c", "echo out1; echo err1 >&2; echo out2"], { log });

	assert.equal(lines[0], "$ sh -c echo out1; echo err1 >&2; echo out2");
	// The OS does not guarantee ordering between two pipes.
	assert.deepEqual(lines.slice(1).sort(), ["err1", "out1", "out2"]);
	assert.equal(stdout, "");
});

test("captures stdout when there is no log", async () => {
	const { stdout } = await run("sh", ["-c", "echo captured; echo noise >&2"]);
	assert.equal(stdout, "captured\n");
});

test("a non-zero exit rejects with the tail of stderr", async () => {
	await assert.rejects(run("sh", ["-c", "echo boom >&2; exit 3"]), {
		message: "sh exited with 3: boom",
	});

	await assert.rejects(
		run(process.execPath, [
			"-e",
			"process.stderr.write('START' + 'A'.repeat(600) + 'END'); process.exit(1)",
		]),
		(err: Error) => {
			assert.match(err.message, /END$/);
			assert.ok(!err.message.includes("START"), "kept the head of stderr, not the tail");
			return true;
		},
	);
});

test("check: false hands back the exit code instead of rejecting", async () => {
	const { exitCode, stdout } = await run("sh", ["-c", "echo still-mine; exit 7"], {
		check: false,
	});
	assert.equal(exitCode, 7);
	assert.equal(stdout, "still-mine\n");
});

test("input is delivered on stdin", async () => {
	const { stdout } = await run("cat", [], { input: "s3cret-key" });
	assert.equal(stdout, "s3cret-key");

	// Without input stdin is still closed, so a reader sees EOF.
	assert.equal((await run("cat", [])).stdout, "");
});

test("input to a command that never reads it is not fatal", async () => {
	// The child exits first, so the write gets EPIPE. Unhandled, that error
	// would crash the whole service rather than fail this one run.
	assert.equal((await run("true", [], { input: "x".repeat(1_000_000) })).exitCode, 0);
});

test("a command that outlives its timeout is killed", async () => {
	await assert.rejects(run("sleep", ["30"], { timeout: 50 }), {
		message: "sleep exited with SIGTERM",
	});

	// A grandchild holds the pipes open, so without killing the whole process
	// group the run would only end when the sleep does. We time it because it
	// still rejects with the same message either way, 10s later.
	const started = Date.now();
	await assert.rejects(run("sh", ["-c", "echo stalled >&2; sleep 10"], { timeout: 50 }), {
		message: "sh exited with SIGTERM: stalled",
	});
	assert.ok(Date.now() - started < 5_000, "the grandchild was killed, not waited for");
});

test("commands inherit the git and locale defaults, and opts.env wins", async () => {
	const echoEnv = ["-c", "echo $GIT_TERMINAL_PROMPT $LC_ALL $EXTRA"];
	assert.equal((await run("sh", echoEnv, { env: { EXTRA: "extra" } })).stdout, "0 C extra\n");
	assert.equal(
		(await run("sh", echoEnv, { env: { LC_ALL: "en_US.UTF-8" } })).stdout,
		"0 en_US.UTF-8\n",
	);

	const dir = await realpath(tmpdir());
	assert.equal((await run("pwd", [], { cwd: dir })).stdout.trim(), dir);
});
