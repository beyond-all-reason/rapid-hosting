// End-to-end test of the real pipeline: the actual rapid-buildgit and the
// actual bunny-enabled rclone, against a real git origin, driven through the
// service's own HTTP API.
//
// Requires both tools on PATH. `npm run test:e2e` runs it in the container that
// has them. Without them the whole file skips.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { STORAGE_KEY } from "../dev/bunny.ts";
import { startSandbox } from "../dev/sandbox.ts";
import { run } from "../src/run.ts";

async function toolsMissing(): Promise<string | false> {
	try {
		await run("rapid-buildgit", [], { check: false });
		await run("rclone", ["help", "backend", "bunny"]);
		return false;
	} catch {
		return "rapid-buildgit or a bunny-enabled rclone is not available, run `npm run test:e2e` to get them in a container that has them";
	}
}

test("the real pipeline", { skip: await toolsMissing(), timeout: 300_000 }, async (t) => {
	const work = await mkdtemp(path.join(tmpdir(), "rapid-build-e2e-"));
	t.after(() => rm(work, { recursive: true, force: true }));
	const dataDir = path.join(work, "data");
	const originDir = path.join(work, "origin");
	const storeDir = path.join(dataDir, "store", "testrepo");

	// --- The origin, the fakes and the config the service loads ---------------

	execFileSync(path.join(import.meta.dirname, "../dev/seed-origin.sh"), [originDir]);
	const git = (args: string[]) => execFileSync("git", args, { cwd: originDir }).toString().trim();
	const firstSha = git(["rev-parse", "HEAD"]);
	const prSha = git(["rev-parse", "refs/pull/7/head"]);

	const sandbox = await startSandbox({ dir: path.join(work, "sandbox"), originDir });
	t.after(() => sandbox.close());
	const { bunny, oidc } = sandbox;
	assert.ok(bunny, "the sandbox started the fake Bunny");
	assert.ok(oidc, "the sandbox started the fake issuer");

	const storageKeyFile = path.join(work, "storage-key");
	await writeFile(storageKeyFile, `${STORAGE_KEY}\n`); // add newline to test trimming

	/** Starts the real service against the fakes above, plus any extra env. */
	async function startService(extraEnv: Record<string, string> = {}, keys = true) {
		const env: Record<string, string | undefined> = {
			...process.env,
			...sandbox.env,
			PORT: "0",
			METRICS_PORT: "0",
			DATA_DIR: dataDir,
			...extraEnv,
		};
		// One secret each way, so both forms are exercised for real.
		delete env.BUNNY_STORAGE_ACCESS_KEY;
		if (keys) {
			env.BUNNY_STORAGE_ACCESS_KEY_PATH = storageKeyFile;
		} else {
			delete env.BUNNY_API_KEY;
		}

		const srv = spawn(
			process.execPath,
			[...process.execArgv, path.join(import.meta.dirname, "../src/main.ts")],
			{ env, stdio: ["ignore", "pipe", "inherit"] },
		);
		// Runs even when an assertion fails: a leftover server would break the
		// following test runs.
		t.after(() => srv.kill("SIGKILL"));
		const exited = new Promise<number | null>((resolve) => srv.once("exit", resolve));

		const port = await new Promise<number>((resolve) => {
			createInterface({ input: srv.stdout }).on("line", (line) => {
				const record = JSON.parse(line) as { msg: string; port?: number };
				if (record.msg === "Listening for build requests") resolve(record.port ?? 0);
			});
		});
		return { port, kill: (signal: NodeJS.Signals) => void srv.kill(signal), exited };
	}

	const service = await startService();

	/** Asks `on` service for a build. */
	const build = async (
		params: Record<string, string>,
		on: typeof service = service,
	): Promise<{ status: number; text: string }> => {
		const query = new URLSearchParams({ repo: "testrepo", branch: "pr-7", ...params });
		const res = await fetch(`http://127.0.0.1:${on.port}/build?${query}`, {
			method: "POST",
			headers: { authorization: `Bearer ${await oidc.mint()}` },
		});
		return { status: res.status, text: await res.text() };
	};

	const storageKeys = () => bunny.storage.keys().sort();
	const poolObjects = () => storageKeys().filter((k) => k.startsWith("testrepo/pool/"));
	/** Where the edge rule currently redirects versions.gz. */
	const ruleTarget = () => String(bunny.zones[0]?.EdgeRules[0]?.ActionParameter1 ?? "");

	function readSdp(gz: Buffer): Map<string, string> {
		const buf = gunzipSync(gz);
		const files = new Map<string, string>();
		for (let at = 0; at < buf.length; ) {
			const length = buf.readUInt8(at);
			const name = buf.subarray(at + 1, at + 1 + length).toString();
			const md5 = buf.subarray(at + 1 + length, at + 1 + length + 16).toString("hex");
			files.set(name, `${md5.slice(0, 2)}/${md5.slice(2)}.gz`);
			at += 1 + length + 24;
		}
		return files;
	}

	/** Reads a pooled file back, which is the form clients download it in. */
	const readPooled = async (poolPath: string) =>
		gunzipSync(await readFile(path.join(storeDir, "pool", poolPath))).toString();

	/** Every file under a directory of the local store, relative to it. */
	async function storeFiles(dir: string): Promise<string[]> {
		const entries = await readdir(path.join(storeDir, dir), {
			recursive: true,
			withFileTypes: true,
		});
		return entries
			.filter((e) => e.isFile())
			.map((e) => path.relative(path.join(storeDir, dir), path.join(e.parentPath, e.name)))
			.sort();
	}

	let firstBuildPool: string[] = [];

	await t.test("a cold build publishes a real rapid repository", async () => {
		const res = await build({ commit: firstSha });
		assert.equal(res.status, 200, res.text);

		// --- What rapid-buildgit produced on disk ---------------------------
		const packages = await storeFiles("packages");
		assert.equal(packages.length, 1, `one package: ${packages.join()}`);
		const pool = await storeFiles("pool");
		assert.ok(pool.length >= 3, `pooled files: ${pool.join()}`);

		const files = readSdp(await readFile(path.join(storeDir, "packages", packages[0] ?? "")));
		assert.deepEqual(
			[...files.keys()].sort(),
			["modinfo.lua", "readme.md", "units/tank.lua"],
			"the package lists the game, and nothing about the repository",
		);

		const versions = gunzipSync(await readFile(path.join(storeDir, "versions.gz"))).toString();
		const version = `pr-7-1-${firstSha.slice(0, 7)}`;
		assert.match(
			versions,
			new RegExp(`^testrepo:pr-7,[0-9a-f]{32},,Test Game ${version}$`, "m"),
			`the rapid tag and generated version: ${versions}`,
		);
		// The modinfo.lua the package points at is the substituted one, not the
		// blob as committed. The substitution is rapid-buildgit's own work.
		// biome-ignore lint/style/noNonNullAssertion: asserted present just above
		const modinfo = await readPooled(files.get("modinfo.lua")!);
		assert.equal(modinfo, `return { name = "Test Game", version = "${version}" }\n`);

		// --- What rclone uploaded, and in what order ------------------------
		firstBuildPool = poolObjects();
		assert.deepEqual(
			firstBuildPool.map((k) => k.slice("testrepo/pool/".length)),
			pool,
			"every pooled file reached storage",
		);
		assert.deepEqual(
			storageKeys().filter((k) => k.startsWith("testrepo/packages/")),
			[`testrepo/packages/${packages[0]}`],
		);
		assert.ok(
			bunny.storage.has("testrepo/versions.gz"),
			`where a client looks: ${storageKeys()}`,
		);

		const puts = bunny.calls.filter((c) => c.startsWith("PUT "));
		const first = (part: string) => puts.findIndex((c) => c.includes(part));
		const last = (part: string) => puts.findLastIndex((c) => c.includes(part));
		assert.ok(last("/pool/") < first("/packages/"), `pool before packages: ${puts.join("\n")}`);
		assert.ok(
			last("/packages/") < first("/testrepo/versions.gz"),
			`versions.gz goes last, so no client sees a version missing its files:\n${puts.join("\n")}`,
		);

		// --- What the edge rule now points at -------------------------------
		const target = ruleTarget();
		const cdn = bunny.config.baseUrl;
		assert.match(target, new RegExp(`^${cdn}/testrepo/fresh/versions_[0-9T]{18}\\.gz$`));
		const freshKey = target.slice(`${cdn}/`.length);
		assert.deepEqual(
			bunny.storage.get(freshKey)?.body,
			await readFile(path.join(storeDir, "versions.gz")),
			"the fresh copy is the versions.gz that was just built",
		);
	});

	await t.test("a rebuild uploads only what changed", async () => {
		const previousTarget = ruleTarget();
		bunny.calls = [];

		const res = await build({ commit: prSha });
		assert.equal(res.status, 200, res.text);

		assert.ok(!res.text.includes("$ git clone"), "reused the checkout");
		assert.ok(
			res.text.includes("Performing incremental update"),
			"rapid-buildgit picked up where the last build left off",
		);
		assert.match(res.text, /^A\tunits\/ship\.lua$/m, "and only diffed the new file");

		// --size-only skipped everything already there: the only pool objects
		// uploaded are the new file and the re-substituted modinfo.lua.
		const rePut = bunny.calls.filter(
			(c) => c.startsWith("PUT ") && firstBuildPool.some((k) => c.endsWith(`/zone1/${k}`)),
		);
		assert.deepEqual(rePut, [], "nothing already in storage was uploaded again");
		assert.equal(poolObjects().length, firstBuildPool.length + 2);

		const versions = gunzipSync(await readFile(path.join(storeDir, "versions.gz"))).toString();
		const version = `pr-7-2-${prSha.slice(0, 7)}`;
		const tag = new RegExp(`^testrepo:pr-7,([0-9a-f]{32}),,Test Game ${version}$`, "m").exec(
			versions,
		);
		assert.ok(tag, `the tag moved to the rebuild: ${versions}`);
		assert.match(versions, new RegExp(`^testrepo:git:${firstSha},`, "m"), "the old tag stayed");

		// The package the tag now points at is the second one.
		assert.equal((await storeFiles("packages")).length, 2, "the first package is untouched");
		const digest = tag[1] ?? "";
		const files = readSdp(await readFile(path.join(storeDir, "packages", `${digest}.sdp`)));
		assert.deepEqual([...files.keys()].sort(), [
			"modinfo.lua",
			"readme.md",
			"units/ship.lua",
			"units/tank.lua",
		]);
		// biome-ignore lint/style/noNonNullAssertion: asserted present just above
		const modinfo = await readPooled(files.get("modinfo.lua")!);
		assert.equal(modinfo, `return { name = "Test Game", version = "${version}" }\n`);

		assert.notEqual(ruleTarget(), previousTarget, "the rule moved to the new copy");
	});

	await t.test("a dry run builds for real and publishes nothing", async () => {
		await writeFile(path.join(originDir, "units", "plane.lua"), "return { hp = 300 }\n");
		git(["add", "-A"]);
		git(["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-qm", "add a plane"]);
		const sha = git(["rev-parse", "HEAD"]);

		// We have to start another service because the mode is part of environment.
		const dryRun = await startService({ BUNNY_MODE: "dry-run" });
		bunny.calls = [];

		const res = await build({ commit: sha }, dryRun);
		assert.equal(res.status, 200, res.text);
		assert.equal((await storeFiles("packages")).length, 3, "a package for the new commit");
		const versions = gunzipSync(await readFile(path.join(storeDir, "versions.gz"))).toString();
		assert.match(
			versions,
			new RegExp(`^testrepo:pr-7,[0-9a-f]{32},,Test Game pr-7-\\d+-${sha.slice(0, 7)}$`, "m"),
			`the tag moved locally: ${versions}`,
		);

		// We expect reads here, from rclone's listings and from the edge rule
		// refresh, so we check only the methods that could have changed something.
		// test/bunny.ts covers that the service itself doesn't write in a dry run.
		// What only a real run adds is that rclone --dry-run doesn't write either,
		// so we assert over every request the fake saw.
		assert.deepEqual(
			bunny.calls.filter((c) => /^(PUT|POST|DELETE|PATCH) /.test(c)),
			[],
			"not one request that could change anything, rclone's included",
		);
		assert.ok(
			res.text.includes("Dry run: would upload testrepo/fresh/versions_"),
			`reported the publish it did not make:\n${res.text}`,
		);

		dryRun.kill("SIGTERM");
		assert.equal(await dryRun.exited, 0);
	});

	await t.test("a disabled Bunny builds without keys and never calls it", async () => {
		await writeFile(path.join(originDir, "units", "sub.lua"), "return { hp = 400 }\n");
		git(["add", "-A"]);
		git(["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-qm", "add a sub"]);
		const sha = git(["rev-parse", "HEAD"]);

		// No credentials of any kind, like a dev deployment without an account.
		const disabled = await startService({ BUNNY_MODE: "disabled" }, false);
		bunny.calls = [];

		const res = await build({ commit: sha }, disabled);
		assert.equal(res.status, 200, res.text);
		assert.equal((await storeFiles("packages")).length, 4, "a package for the new commit");
		const versions = gunzipSync(await readFile(path.join(storeDir, "versions.gz"))).toString();
		assert.match(
			versions,
			new RegExp(`^testrepo:pr-7,[0-9a-f]{32},,Test Game pr-7-\\d+-${sha.slice(0, 7)}$`, "m"),
			`the tag moved locally: ${versions}`,
		);
		assert.deepEqual(bunny.calls, [], "not one request to Bunny, not even a read");

		disabled.kill("SIGTERM");
		assert.equal(await disabled.exited, 0);
	});
});
