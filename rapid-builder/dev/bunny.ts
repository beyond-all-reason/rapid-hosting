// A local stand-in for Bunny: the storage zone, the CDN and the management API.
//
// Bunny has no emulator and three callers need the same one.
//
// The storage zone is a server of its own, mounted at the root so its paths are
// "/<zone>/<object>". The CDN and the management API share a second server,
// under /cdn/ and /api/.
//
// Objects are files under <dir>/storage/<zone>/ and the pull zones are
// <dir>/pullzones.json, so listing a directory shows what a build published.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	type Dirent,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { z } from "zod";
import type { Config } from "../src/config.ts";

/** An object in the storage zone. */
export interface StoredObject {
	body: Buffer;
	created: Date;
}

/**
 * An edge rule, in the shape the management API accepts and returns one.
 *
 * Loose, because Bunny returns fields this project never reads and expects them
 * back unchanged. The fields a rule needs in order to redirect are required, so
 * we refuse a POST that drops one the way Bunny does.
 *
 * https://docs.bunny.net/api-reference/core/pull-zone/addupdate-edge-rule
 */
const EdgeRule = z.looseObject({
	Description: z.string(),
	ActionType: z.number(),
	ActionParameter1: z.string(),
	ActionParameter2: z.string().nullable(),
	TriggerMatchingType: z.number(),
	Enabled: z.boolean(),
	Triggers: z.array(
		z.looseObject({
			Type: z.number(),
			PatternMatches: z.array(z.string()),
			PatternMatchingType: z.number(),
		}),
	),
});

export type FakeEdgeRule = z.infer<typeof EdgeRule>;

export interface FakePullZone {
	Id: number;
	Name: string;
	EdgeRules: FakeEdgeRule[];
}

/** A run of CDN responses to fail, for paths starting with `prefix`. */
export interface CdnFailure {
	prefix: string;
	status: number;
	/** Decremented per failed response. Infinity to never recover. */
	times: number;
}

export const STORAGE_KEY = "storage-key";
export const API_KEY = "api-key";

/** The one storage zone and the one pull zone the fake has. */
const ZONE = "zone1";
const PULL_ZONE = "pz";

/** The running fake: its state, its failure knobs and the config to reach it. */
export type FakeBunny = Awaited<ReturnType<typeof startFakeBunny>>;

/**
 * True for a path that names exactly one object.
 *
 * rclone hands its backend a parent path with a trailing slash, so the bunny
 * backend easily asks for "repo//versions.gz". A filesystem would collapse that
 * into the same object as "repo/versions.gz". The ambiguity has to stay visible
 * instead, so every caller here checks the path first.
 */
function isUnambiguous(objectPath: string): boolean {
	return (
		objectPath.length > 0 &&
		!objectPath.startsWith("/") &&
		!objectPath.endsWith("/") &&
		path.posix.normalize(objectPath) === objectPath
	);
}

/** The storage zone's objects, as files under a directory. */
function openStorage(root: string) {
	const file = (objectPath: string) => path.join(root, objectPath);
	const has = (objectPath: string) =>
		statSync(file(objectPath), { throwIfNoEntry: false })?.isFile() ?? false;
	return {
		has,
		get(objectPath: string): StoredObject | undefined {
			if (!isUnambiguous(objectPath)) return undefined;
			try {
				const full = file(objectPath);
				return { body: readFileSync(full), created: statSync(full).mtime };
			} catch {
				return undefined;
			}
		},
		set(objectPath: string, object: StoredObject): void {
			assert.ok(isUnambiguous(objectPath), `ambiguous object path ${objectPath}`);
			const full = file(objectPath);
			mkdirSync(path.dirname(full), { recursive: true });
			writeFileSync(full, object.body);
			utimesSync(full, object.created, object.created);
		},
		delete(objectPath: string): boolean {
			if (!has(objectPath)) return false;
			rmSync(file(objectPath));
			return true;
		},
		/** Every object in the zone, in no particular order. */
		keys(): string[] {
			return readdirSync(root, { recursive: true, withFileTypes: true })
				.filter((e) => e.isFile())
				.map((e) => path.relative(root, path.join(e.parentPath, e.name)));
		},
	};
}

/**
 * Starts the fake, by default on two free loopback ports.
 *
 * Pass `tls` to serve the storage zone over HTTPS, which rclone requires.
 */
export async function startFakeBunny(opts: {
	/** Holds the objects and the pull zones. */
	dir: string;
	tls?: { key: Buffer; cert: Buffer };
	/** Address to bind. Default: 127.0.0.1. */
	host?: string;
	/** Host the returned config reaches these servers by. Default: 127.0.0.1. */
	publicHost?: string;
	storagePort?: number;
	edgePort?: number;
}) {
	const host = opts.host ?? "127.0.0.1";
	const publicHost = opts.publicHost ?? "127.0.0.1";
	const storageRoot = path.join(opts.dir, "storage", ZONE);
	const zonesFile = path.join(opts.dir, "pullzones.json");
	mkdirSync(storageRoot, { recursive: true });

	// The pull zones are mirrored to disk after every change. The fake answers
	// from the array. The file is what you read on a sandbox and what outlives
	// a restart.
	const emptyZones = (): FakePullZone[] => [{ Id: 5, Name: PULL_ZONE, EdgeRules: [] }];
	const saveZones = (zones: FakePullZone[]) =>
		writeFileSync(zonesFile, `${JSON.stringify(zones, null, "\t")}\n`);
	function loadZones(): FakePullZone[] {
		try {
			return JSON.parse(readFileSync(zonesFile, "utf8")) as FakePullZone[];
		} catch {
			const zones = emptyZones();
			saveZones(zones);
			return zones;
		}
	}

	const fake = {
		/** Keyed by path under the storage zone, which is also the CDN path. */
		storage: openStorage(storageRoot),
		zones: loadZones(),
		/** Every request that arrived, in order, as "METHOD /path". */
		calls: [] as string[],
		cdnFailures: [] as CdnFailure[],
		/** Status the storage listing answers with instead of a listing. */
		listingStatus: 200,
		/** Returns the fake to the state it started in. */
		reset(): void {
			rmSync(storageRoot, { recursive: true, force: true });
			mkdirSync(storageRoot, { recursive: true });
			fake.zones = emptyZones();
			saveZones(fake.zones);
			fake.calls = [];
			fake.cdnFailures.length = 0;
			fake.listingStatus = 200;
		},
	};

	/** The immediate children of a prefix, as the List Files endpoint reports them. */
	function listing(prefix: string): unknown[] {
		let entries: Dirent[] = [];
		try {
			entries = readdirSync(path.join(storageRoot, prefix), { withFileTypes: true });
		} catch {
			// A prefix nothing was ever uploaded under lists as empty, the way an
			// empty directory in a storage zone does.
		}
		return entries.map((entry) => {
			if (entry.isDirectory()) {
				return { ObjectName: entry.name, IsDirectory: true, Length: 0 };
			}
			// biome-ignore lint/style/noNonNullAssertion: the entry was just listed
			const object = fake.storage.get(path.posix.join(prefix, entry.name))!;
			// Bunny reports naive timestamps, without a zone.
			const at = object.created.toISOString().slice(0, -1);
			return {
				ObjectName: entry.name,
				IsDirectory: false,
				Length: object.body.length,
				LastChanged: at,
				DateCreated: at,
				ContentType: "application/octet-stream",
				Checksum: createHash("sha256").update(object.body).digest("hex").toUpperCase(),
			};
		});
	}

	/**
	 * Reads the request, records it, and hands it to `route`.
	 *
	 * A throw is a bug in the fake. It would otherwise appear as a hung test, so
	 * we exit the process where it happened.
	 */
	function serve(
		server: Server,
		route: (req: IncomingMessage, res: ServerResponse, body: Buffer, url: string) => void,
	): Server {
		server.on("request", (req, res) => {
			void (async () => {
				const body = await buffer(req);
				// Not normalized: `calls` reports the path rclone asked for, so an
				// ambiguous one stays visible. See isUnambiguous.
				const url = decodeURIComponent(req.url ?? "");
				fake.calls.push(`${req.method} ${url}`);
				route(req, res, body, url);
			})().catch((err: unknown) => {
				console.error("fake bunny error:", err);
				process.exit(1);
			});
		});
		return server;
	}

	const storageServer = serve(
		opts.tls ? createHttpsServer({ key: opts.tls.key, cert: opts.tls.cert }) : createServer(),
		(req, res, body, url) => {
			assert.equal(req.headers.accesskey, STORAGE_KEY, `unauthenticated ${url}`);
			if (!url.startsWith(`/${ZONE}/`)) return void res.writeHead(404).end();
			const p = url.slice(`/${ZONE}/`.length);
			if (req.method === "PUT") {
				// We don't know whether Bunny collapses an ambiguous path, and nothing
				// should depend on it, so we refuse one outright.
				if (!isUnambiguous(p)) return void res.writeHead(400).end(`ambiguous path ${p}`);
				fake.storage.set(p, { body, created: new Date() });
				return void res.writeHead(201).end(JSON.stringify({ HttpCode: 201 }));
			}
			if (req.method === "DELETE") {
				if (!fake.storage.delete(p)) return void res.writeHead(404).end();
				return void res.end(JSON.stringify({ HttpCode: 200 }));
			}
			if (req.method === "GET" && p.endsWith("/")) {
				if (fake.listingStatus !== 200) {
					return void res.writeHead(fake.listingStatus).end("nope");
				}
				const json = JSON.stringify(listing(p));
				return void res.writeHead(200, { "content-type": "application/json" }).end(json);
			}
			if (req.method === "GET") {
				const object = fake.storage.get(p);
				if (!object) return void res.writeHead(404).end();
				return void res.end(object.body);
			}
			res.writeHead(405).end();
		},
	);

	const edgeServer = serve(createServer(), (req, res, body, url) => {
		if (url.startsWith("/cdn/")) {
			const p = url.slice("/cdn/".length);
			const failure = fake.cdnFailures.find((f) => f.times > 0 && p.startsWith(f.prefix));
			if (failure) {
				failure.times--;
				return void res.writeHead(failure.status).end();
			}
			const object = fake.storage.get(p);
			if (!object) return void res.writeHead(404).end();
			return void res.end(object.body);
		}
		if (url.startsWith("/api/")) {
			assert.equal(req.headers.accesskey, API_KEY, `unauthenticated ${url}`);
			if (url.startsWith("/api/pullzone?")) return void res.end(JSON.stringify(fake.zones));
			const match = /^\/api\/pullzone\/(\d+)\/edgerules\/addOrUpdate$/.exec(url);
			if (match && req.method === "POST") {
				const target = fake.zones.find((zone) => zone.Id === Number(match[1]));
				if (!target) return void res.writeHead(404).end();
				let json: unknown;
				try {
					json = JSON.parse(body.toString());
				} catch {
					// Malformed JSON stays undefined for the schema to refuse.
				}
				const parsed = EdgeRule.safeParse(json);
				if (!parsed.success) {
					// The message reaches the caller, since the service reports the
					// body of a failed request.
					return void res.writeHead(400).end(z.prettifyError(parsed.error));
				}
				const posted = parsed.data;
				const at = target.EdgeRules.findIndex((r) => r.Description === posted.Description);
				if (at >= 0) target.EdgeRules[at] = posted;
				else target.EdgeRules.push(posted);
				saveZones(fake.zones);
				return void res.end("{}");
			}
			return void res.writeHead(404).end();
		}
		res.writeHead(404).end();
	});

	/**
	 * Starts a server and returns the URL it can be reached at.
	 *
	 * A fake bound to 0.0.0.0 in a container still has to return a URL that
	 * other containers resolve, so the address we bind and `publicHost` are two
	 * different things.
	 */
	async function listen(server: Server, port?: number, scheme = "http"): Promise<string> {
		await new Promise<void>((resolve) => server.listen(port ?? 0, host, resolve));
		return `${scheme}://${publicHost}:${(server.address() as AddressInfo).port}`;
	}

	const storageUrl = await listen(storageServer, opts.storagePort, opts.tls ? "https" : "http");
	const edgeUrl = await listen(edgeServer, opts.edgePort);

	return Object.assign(fake, {
		/** The bunny section of the config, pointing at these servers. */
		config: {
			storageZone: ZONE,
			// No path: rclone's --bunny-endpoint takes only the host, so this is
			// the one shape the service and rclone agree on.
			storageUrl,
			apiUrl: `${edgeUrl}/api`,
			pullZone: PULL_ZONE,
			baseUrl: `${edgeUrl}/cdn`,
		} satisfies Config["bunny"],
		close(): void {
			for (const server of [storageServer, edgeServer]) {
				server.close();
				server.closeAllConnections();
			}
		},
	});
}
