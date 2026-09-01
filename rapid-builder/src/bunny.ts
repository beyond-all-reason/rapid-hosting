import { setTimeout as sleep } from "node:timers/promises";
import type { Config } from "./config.ts";
import { cdnVisibilityNotFound, cdnVisibilityWait } from "./metrics.ts";
import type { Log } from "./run.ts";

/**
 * An edge rule on a pull zone, as embedded in a {@link PullZone}.
 *
 * https://docs.bunny.net/api-reference/core/pull-zone/addupdate-edge-rule
 */
interface EdgeRule {
	/** Used to find the rule by name among a pull zone's EdgeRules. */
	Description: string;
	/** The previous fresh-copy URL; kept around during cleanup. */
	ActionParameter1: string;
	// biome-ignore lint/suspicious/noExplicitAny: intentionally untyped passthrough for fields this module doesn't inspect
	[key: string]: any;
}

/**
 * A pull zone, as returned by the List Pull Zones endpoint.
 *
 * https://docs.bunny.net/api-reference/core/pull-zone/list-pull-zones
 */
interface PullZone {
	Id: number;
	Name: string;
	EdgeRules: EdgeRule[];
}

/**
 * A file or directory entry, as returned by the storage zone List Files
 * endpoint.
 *
 * https://docs.bunny.net/api-reference/storage/browse-files/list-files
 */
interface StorageObject {
	ObjectName: string;
	IsDirectory: boolean;
	/** ISO 8601 timestamp of when the object was created, e.g. "2023-06-19T22:56:00.85". */
	DateCreated: string;
}

/** Hard deadline for all requests to Bunny. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Like fetch, but throws on non-2xx and always consumes the body.
 */
async function fetchOk(url: string, init: RequestInit = {}): Promise<Buffer> {
	const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	const body = Buffer.from(await res.arrayBuffer());
	if (!res.ok) {
		throw new Error(
			`${init.method ?? "GET"} ${url} failed: ${res.status} ${body.toString().slice(0, 500)}`,
		);
	}
	return body;
}

/** Like {@link fetchOk}, but parses the body as JSON. */
async function fetchOkJson<T>(url: string, init: RequestInit = {}): Promise<T> {
	return JSON.parse((await fetchOk(url, init)).toString()) as T;
}

/**
 * Polls `url` until the CDN serves it, backing off exponentially.
 *
 * A freshly uploaded file 404s at the edge until replication catches up, so the
 * only way to know it is servable is to ask for it. Returns how long that took.
 */
export async function waitForCdnVisibility(opts: {
	url: string;
	log: Log;
	/** Default: 2 minutes. */
	timeoutMs?: number;
	/** How long to wait before the first retry, doubling from there. Default: 100ms. */
	initialBackoffMs?: number;
	/** The ceiling the backoff doubles up to. Default: 10 seconds. */
	maxBackoffMs?: number;
	/** Called for every 404, the answer the edge gives while replication lags. */
	onNotFound?: () => void;
}): Promise<number> {
	const {
		url,
		log,
		timeoutMs = 120_000,
		initialBackoffMs = 100,
		maxBackoffMs = 10_000,
		onNotFound = () => {},
	} = opts;
	const start = Date.now();
	const deadline = start + timeoutMs;
	for (let backoff = initialBackoffMs; ; backoff = Math.min(backoff * 2, maxBackoffMs)) {
		const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		await res.arrayBuffer();
		if (res.ok) break;
		if (res.status === 404) onNotFound();
		// Checked after the request, so a response that arrives past the deadline
		// still ends the wait rather than buying another round.
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for ${url} to become visible`);
		}
		log(`${url} not yet visible on CDN (${res.status}), retrying in ${backoff}ms`);
		await sleep(backoff);
	}
	return Date.now() - start;
}

/**
 * Refreshes the edge rule handling /<repo>/versions.gz.
 *
 * Works around Bunny storage replication lag: replication to edge regions lags
 * behind writes, so right after an upload the CDN can keep serving a stale
 * versions.gz for minutes, hours or even days. We work around this by
 * uploading /<repo>/fresh/version_<stamp>.gz and setting up an edge rule that
 * redirects /<repo>/versions.gz to it. Edge rule changes are propagated
 * globally within 1 minute.
 */
export async function refreshVersionsEdgeRule(opts: {
	repoName: string;
	/** The versions.gz that the build just produced and uploaded to storage. */
	versionsGz: Buffer;
	bunny: Config["bunny"];
	apiKey: string;
	storageAccessKey: string;
	/** Only reads, no writes. */
	dryRun: boolean;
	log: Log;
}): Promise<void> {
	const { repoName, versionsGz, bunny, dryRun, log } = opts;
	const apiHeaders = { AccessKey: opts.apiKey, accept: "application/json" };
	const storageHeaders = { AccessKey: opts.storageAccessKey };
	const storageBase = `${bunny.storageUrl}/${bunny.storageZone}`;
	const ruleDescription = `Redirect to fresh ${repoName} version`;

	const pullZones = await fetchOkJson<PullZone[]>(
		`${bunny.apiUrl}/pullzone?includeCertificate=false`,
		{ headers: apiHeaders },
	);
	const pullZone = pullZones.find((z) => z.Name === bunny.pullZone);
	if (!pullZone) throw new Error(`Pull zone "${bunny.pullZone}" not found`);

	let rule = pullZone.EdgeRules.find((r) => r.Description === ruleDescription);

	if (rule) {
		const res = await fetch(rule.ActionParameter1, {
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const served = Buffer.from(await res.arrayBuffer());
		if (res.ok && served.equals(versionsGz)) {
			log(`CDN already serves the new ${repoName} versions.gz`);
			return;
		}
	}

	if (!rule) {
		log(
			`Edge rule "${ruleDescription}" not found in pull zone "${bunny.pullZone}", ` +
				`${dryRun ? "would create it" : "creating it"}`,
		);
		// https://docs.bunny.net/api-reference/core/pull-zone/addupdate-edge-rule
		rule = {
			ActionType: 1, // Redirect
			ActionParameter1: "", // Filled in below
			ActionParameter2: "301",
			ActionParameter3: null,
			Triggers: [
				{
					Type: 0, // Url
					PatternMatches: [`${bunny.baseUrl}/${repoName}/versions.gz`],
					PatternMatchingType: 0, // MatchAny
					Parameter1: "",
				},
				{
					// This rule allows probers with `latestreplicated` in user agent to skip
					// the rule and measure real replication.
					Type: 1, // RequestHeader
					PatternMatches: ["*latestreplicated*"],
					PatternMatchingType: 2, // MatchNone
					Parameter1: "User-Agent",
				},
			],
			ExtraActions: [],
			TriggerMatchingType: 1, // MatchAll
			Description: ruleDescription,
			Enabled: true,
			OrderIndex: 0,
			ReadOnly: false,
		};
	}

	const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 18);
	const freshName = `versions_${stamp}.gz`;
	const freshPath = `${repoName}/fresh/${freshName}`;
	const freshUrl = `${bunny.baseUrl}/${freshPath}`;
	if (dryRun) {
		log(`Dry run: would upload ${freshPath} and point versions.gz at ${freshUrl}`);
	} else {
		await fetchOk(`${storageBase}/${freshPath}`, {
			method: "PUT",
			headers: { ...storageHeaders, "content-type": "application/octet-stream" },
			body: versionsGz,
		});

		// TODO: It's possible that this `waitForCdnVisibility` functionality is actually
		// entirely obsolete and no longer needed. We start to export non_founds metrics
		// to observe the real behavior and if it never registers we will be able to drop
		// this code.
		const waited = await waitForCdnVisibility({
			url: freshUrl,
			log,
			onNotFound: () => cdnVisibilityNotFound.inc({ repo: repoName }),
		});
		cdnVisibilityWait.observe({ repo: repoName }, waited / 1000);

		await fetchOk(`${bunny.apiUrl}/pullzone/${pullZone.Id}/edgerules/addOrUpdate`, {
			method: "POST",
			headers: { ...apiHeaders, "content-type": "application/json" },
			body: JSON.stringify({ ...rule, ActionParameter1: freshUrl }),
		});
		log(`Edge rule updated to redirect versions.gz to ${freshUrl}`);
	}

	// Drop old no longer needed fresh copies. Keeps current, previous and all
	// from last 24h.
	try {
		const listing = await fetchOkJson<StorageObject[]>(`${storageBase}/${repoName}/fresh/`, {
			headers: storageHeaders,
		});
		const keep = new Set([freshName, rule.ActionParameter1.split("/").pop()]);
		const minAge = Date.now() - 24 * 60 * 60 * 1000;
		for (const obj of listing) {
			if (obj.IsDirectory || keep.has(obj.ObjectName)) continue;
			if (new Date(`${obj.DateCreated}Z`).getTime() > minAge) continue;
			if (dryRun) {
				log(`Dry run: would delete stale fresh copy ${obj.ObjectName}`);
				continue;
			}
			await fetchOk(`${storageBase}/${repoName}/fresh/${obj.ObjectName}`, {
				method: "DELETE",
				headers: storageHeaders,
			});
			log(`Deleted stale fresh copy ${obj.ObjectName}`);
		}
	} catch (err) {
		log(
			`Cleanup of old fresh copies failed (non-fatal): ${err instanceof Error ? err.message : err}`,
		);
	}
}
