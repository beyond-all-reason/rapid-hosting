import { randomUUID } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type OutgoingHttpHeaders,
	type Server,
	type ServerResponse,
} from "node:http";
import type { JWTPayload } from "jose";
import { z } from "zod";
import type { TokenVerifier } from "./auth.ts";
import type { BunnyMode, runBuild } from "./build.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./log.ts";
import * as metrics from "./metrics.ts";
import { authorize } from "./policy.ts";
import { ReposQueue } from "./queue.ts";
import type { Log } from "./run.ts";

/** Query parameters of a build request. */
const BuildParams = z.strictObject({
	/** Repo to build, by its name in the config. It is rapid-buildgit's prefix. */
	repo: z.string(),
	/** Rapid branch to publish: the build becomes "<repo>:<branch>". */
	branch: z.string().regex(/^(?!.*\.\.)[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,63}$/),
	/** Replaces rapid-buildgit's generated "{branch}-{commit count}-{short sha}". */
	version: z
		.string()
		.regex(/^(?!.*\.\.)[a-zA-Z0-9][ a-zA-Z0-9._:+/-]{0,62}[a-zA-Z0-9]$/)
		.optional(),
	/** Full sha of the commit to build. The caller resolves the ref it wants. */
	commit: z.string().regex(/^[0-9a-f]{40}$/),
});

/** Error codes that can be returned before the token is verified. */
const PRE_AUTH_STATUSES = new Set([401, 404, 405, 505]);

interface HttpErrorOptions {
	/** Internal details for our log that the response body must not include. */
	reason?: string;
	headers?: OutgoingHttpHeaders;
}

class HttpError extends Error {
	status: number;
	reason: string | undefined;
	headers: OutgoingHttpHeaders;
	constructor(status: number, message: string, options: HttpErrorOptions = {}) {
		super(message);
		this.status = status;
		this.reason = options.reason;
		this.headers = options.headers ?? {};
	}
}

/**
 * Ends a response mid-body.
 *
 * We use `Transfer-Encoding: chunked` and all HTTP clients detect that
 * response is not finished. We use it to communicate that build failed
 * after sending 200 status code in headers. The FIN is queued behind data.
 */
function truncate(res: ServerResponse): void {
	res.socket?.end();
}

export interface BuildServerDeps {
	config: Config;
	dataDir: string;
	bunnyApiKey: string;
	bunnyStorageAccessKey: string;
	bunnyMode: BunnyMode;
	/** How many builds may wait for a repo's lock before requests are shed. */
	maxWaitingBuilds: number;
	verifyToken: TokenVerifier;
	/** Allow override for testing. Production passes runBuild from build.ts. */
	build: typeof runBuild;
	logger: Logger;
}

/**
 * The public build API: POST /build and GET /healthz.
 *
 * A build streams its log as it happens.
 */
// Important: keep documentation in docs/api.md in sync with this code.
export function createBuildServer(deps: BuildServerDeps): Server {
	const { config, logger } = deps;
	const buildQueue = new ReposQueue(deps.maxWaitingBuilds);

	async function handleBuild(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.httpVersionMajor === 1 && req.httpVersionMinor === 0) {
			throw new HttpError(505, "HTTP/1.1 is required for chunked encoding");
		}

		const auth = req.headers.authorization ?? "";
		if (!auth.startsWith("Bearer "))
			throw new HttpError(401, "Missing bearer token", {
				headers: { "www-authenticate": "Bearer" },
			});
		let claims: JWTPayload;
		try {
			claims = await deps.verifyToken(auth.slice("Bearer ".length), config.audience);
		} catch (err) {
			throw new HttpError(
				401,
				`Invalid OIDC token: ${err instanceof Error ? err.message : err}`,
				{ headers: { "www-authenticate": 'Bearer error="invalid_token"' } },
			);
		}
		logger.trace({ claims }, "Verified OIDC token");

		const parsed = BuildParams.safeParse(Object.fromEntries(url.searchParams));
		if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
		const { repo: repoName, branch, commit, version } = parsed.data;

		const repo = config.repos[repoName];
		if (!repo) throw new HttpError(400, `Unknown repo: ${repoName}`);

		const authz = authorize(repo, claims, { branch, commit, version });
		if (!authz.ok) {
			throw new HttpError(403, `This token may not publish ${repoName}:${branch}`, {
				reason: authz.reason,
			});
		}

		// There must be no async work between the check and the run below.
		if (buildQueue.isFull(repoName)) {
			throw new HttpError(
				429,
				`${deps.maxWaitingBuilds} builds already queued for ${repoName}, try again later`,
			);
		}

		const buildId = randomUUID().slice(0, 8);
		const buildLog = logger.child({ buildId, repo: repoName, branch });
		res.writeHead(200, {
			"content-type": "text/plain",
			// nginx buffers a proxied response by default, undoing the streaming.
			"x-accel-buffering": "no",
		});
		// Don't crash when client disconnects.
		res.on("error", (err) => buildLog.warn({ err }, "Build response stream failed"));
		const logLine = (level: "info" | "error", line: string, fields: object = {}) => {
			if (!res.writableEnded && !res.destroyed) res.write(`${line}\n`);
			buildLog[level](fields, line);
		};
		const log: Log = (line) => logLine("info", line);
		logLine(
			"info",
			`Build requested: repo=${repoName} branch=${branch} commit=${commit} ` +
				`version=${version ?? "-"} by sub=${claims.sub} run=${claims.run_id} ` +
				`actor=${claims.actor}`,
			{
				commit,
				version,
				sub: claims.sub,
				runId: claims.run_id,
				actor: claims.actor,
			},
		);

		// Started once the build has the lock, so the queue wait stays out of it.
		let endBuild!: ReturnType<typeof metrics.buildDuration.startTimer>;
		const record = (outcome: "success" | "failure") => {
			endBuild({ outcome });
			metrics.buildsTotal.inc({ repo: repoName, outcome });
			if (outcome === "success")
				metrics.lastSuccess.set({ repo: repoName }, Date.now() / 1000);
		};
		try {
			await buildQueue.run(repoName, () => {
				endBuild = metrics.buildDuration.startTimer({ repo: repoName });
				return deps.build({
					bunny: config.bunny,
					repoName,
					repo,
					commit,
					branch,
					version,
					dataDir: deps.dataDir,
					bunnyApiKey: deps.bunnyApiKey,
					bunnyStorageAccessKey: deps.bunnyStorageAccessKey,
					bunnyMode: deps.bunnyMode,
					log,
				});
			});
			record("success");
			logLine("info", `Build succeeded: ${repoName}:${branch} at ${commit}`, { commit });
			res.end();
		} catch (err) {
			record("failure");
			logLine("error", `Build failed: ${err instanceof Error ? err.message : err}`, { err });
			truncate(res);
		}
	}

	return createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		// Nothing reads body, let's drain it,
		req.resume();
		try {
			if (url.pathname === "/healthz") {
				if (req.method !== "GET")
					throw new HttpError(405, "Method not allowed", { headers: { allow: "GET" } });
				res.writeHead(200, { "content-type": "text/plain" });
				res.end("ok\n");
			} else if (url.pathname === "/build") {
				if (req.method !== "POST")
					throw new HttpError(405, "Method not allowed", { headers: { allow: "POST" } });
				await handleBuild(url, req, res);
			} else {
				throw new HttpError(404, "Not found");
			}
		} catch (err) {
			const status = err instanceof HttpError ? err.status : 500;
			const headers = err instanceof HttpError ? err.headers : {};
			const message = err instanceof Error ? err.message : String(err);
			const context = { method: req.method, url: req.url, status };
			if (err instanceof HttpError) {
				const level = PRE_AUTH_STATUSES.has(status) ? "debug" : "info";
				logger[level]({ ...context, reason: err.reason ?? message }, "Request rejected");
			} else {
				logger.error({ ...context, err }, "Request failed");
			}
			metrics.rejectedRequests.inc({ status });
			// If something throws after sending headers, that's our bug, because the
			// build reports it's own failures.
			if (res.headersSent) {
				res.write(`${message}\n`);
				truncate(res);
			} else {
				res.writeHead(status, { "content-type": "text/plain", ...headers });
				res.end(`${message}\n`);
			}
		}
	});
}
