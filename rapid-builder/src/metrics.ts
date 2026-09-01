import { statfs } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import client from "prom-client";
import { logger } from "./log.ts";

client.collectDefaultMetrics();

/** Returns Fibonacci bounds scaled to start at `min`, up to the last under `max`. */
function fibonacciBuckets(min: number, max: number): number[] {
	const buckets: number[] = [];
	for (let a = 1, b = 2; a * min <= max; [a, b] = [b, a + b]) {
		buckets.push(Number((a * min).toPrecision(2)));
	}
	return buckets;
}

export const buildsTotal = new client.Counter({
	name: "rapid_build_builds_total",
	help: "Builds that ran to completion, by final outcome",
	labelNames: ["repo", "outcome"] as const,
});

export const buildDuration = new client.Histogram({
	name: "rapid_build_duration_seconds",
	help: "Build duration from lock acquisition to completion (queue wait excluded)",
	labelNames: ["repo", "outcome"] as const,
	buckets: fibonacciBuckets(15, 2400),
});

// Labelling by outcome makes the histogram's `_count{outcome="failure"}` series
// a per-step failure counter, so no separate counter is needed. It also keeps
// failed runs out of the success latency distribution they would otherwise skew.
export const stepDuration = new client.Histogram({
	name: "rapid_build_step_duration_seconds",
	help: "Duration of individual build pipeline steps, by final outcome",
	labelNames: ["repo", "step", "outcome"] as const,
	buckets: fibonacciBuckets(1, 2400),
});

export const queueWait = new client.Histogram({
	name: "rapid_build_queue_wait_seconds",
	help: "Time a build spent waiting for the per-repo lock",
	labelNames: ["repo"] as const,
	buckets: fibonacciBuckets(1, 3600),
});

export const queuedBuilds = new client.Gauge({
	name: "rapid_build_queued_builds",
	help: 'Builds in the per-repo queue: state="running" holds the lock, state="waiting" is queued behind it',
	labelNames: ["repo", "state"] as const,
});

export const lastSuccess = new client.Gauge({
	name: "rapid_build_last_success_timestamp_seconds",
	help: "Unix time of the last successful build, per repo",
	labelNames: ["repo"] as const,
});

export const cdnVisibilityWait = new client.Histogram({
	name: "rapid_build_cdn_visibility_wait_seconds",
	help: "Time until the CDN served the freshly uploaded versions.gz copy",
	labelNames: ["repo"] as const,
	buckets: fibonacciBuckets(0.25, 600),
});

export const cdnVisibilityNotFound = new client.Counter({
	name: "rapid_build_cdn_visibility_not_found_total",
	help: "404 responses while polling for the freshly uploaded versions.gz copy",
	labelNames: ["repo"] as const,
});

export const rejectedRequests = new client.Counter({
	name: "rapid_build_rejected_requests_total",
	help: "Requests answered with an error before a build ran, by HTTP status",
	labelNames: ["status"] as const,
});

/** Serves GET /metrics on its own port, not exposed publicly. */
export function startMetricsServer(port: number, dataDir: string): Server {
	new client.Gauge({
		name: "rapid_build_data_disk_free_bytes",
		help: "Free space on the filesystem holding DATA_DIR",
		async collect() {
			const fs = await statfs(dataDir);
			this.set(fs.bavail * fs.bsize);
		},
	});

	const server = createServer(async (req, res) => {
		try {
			// Match on the path only: the exposition format takes no arguments, but
			// Prometheus scrape configs can append arbitrary `params:` to the URL.
			const path = new URL(req.url ?? "/", "http://localhost").pathname;
			if (req.method === "GET" && path === "/metrics") {
				const body = await client.register.metrics();
				res.writeHead(200, { "content-type": client.register.contentType });
				res.end(body);
			} else {
				res.writeHead(404).end("Not found\n");
			}
		} catch (err) {
			logger.error({ err }, "Metrics collection failed");
			if (!res.headersSent) res.writeHead(500);
			res.end(`${err instanceof Error ? err.message : err}\n`);
		}
	});
	server.listen(port, () => {
		logger.info(
			{ port: (server.address() as AddressInfo).port },
			"Listening for metrics scrapes",
		);
	});
	return server;
}
