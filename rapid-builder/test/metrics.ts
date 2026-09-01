// Unit test of the metrics endpoint.
//
// We assert a series' numbers where it is set: test/server.ts reads the build
// counters as deltas around each request. What is left here is the exposition
// endpoint itself.

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import * as metrics from "../src/metrics.ts";

const server = metrics.startMetricsServer(0, ".");
await new Promise<void>((resolve) => server.once("listening", resolve));
after(() => {
	server.close();
	server.closeAllConnections();
});
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test("the registry is served on /metrics, and nothing else is", async () => {
	metrics.buildsTotal.inc({ repo: "testrepo", outcome: "success" });

	const body = await (await fetch(`${base}/metrics`)).text();
	assert.match(body, /rapid_build_builds_total\{repo="testrepo",outcome="success"\} 1/);
	// Collected at scrape time, from the directory the server was given.
	assert.match(body, /rapid_build_data_disk_free_bytes [0-9]/);

	// Scrape configs can append arbitrary params, so we match on the path alone.
	assert.equal((await fetch(`${base}/metrics?x=1`)).status, 200);
	assert.equal((await fetch(`${base}/nope`)).status, 404);
});
