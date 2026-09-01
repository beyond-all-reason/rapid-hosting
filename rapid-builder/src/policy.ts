import { Environment, EvaluationError, type ParseResult } from "@marcbachmann/cel-js";
import type { JWTPayload } from "jose";
import { z } from "zod";

export interface BuildRequest {
	branch: string;
	commit: string;
	version?: string;
}

/** What data is available for policy evaluation. */
const environment = new Environment()
	.registerVariable("claims", "map")
	// `Request` type mirrors BuildRequest above.
	.registerType("Request", { fields: { branch: "string", commit: "string", version: "string" } })
	.registerVariable("request", "Request");

export type Policy = ParseResult;

/**
 * A CEL expression, compiled and type checked while the config loads.
 *
 * A broken policy then fails at boot instead of on the first build.
 */
export const PolicySchema = z
	.string()
	.min(1)
	.transform((expression, ctx) => {
		const reject = (message: string) => {
			ctx.addIssue({ code: "custom", message });
			return z.NEVER;
		};
		let policy: ParseResult;
		try {
			policy = environment.parse(expression);
		} catch (err) {
			return reject(`invalid CEL: ${err instanceof Error ? err.message : String(err)}`);
		}
		const checked = policy.check();
		if (!checked.valid) return reject(`invalid CEL: ${checked.error?.message}`);
		if (checked.type !== "bool") {
			return reject(`CEL must decide a bool, this decides ${checked.type}`);
		}
		return policy;
	});

export type AuthzResult =
	| { ok: true }
	| {
			ok: false;
			/** Private for logs etc., not returned to user. */
			reason: string;
	  };

/** Decides whether a verified token may publish what the request asks for. */
export function authorize(
	repo: { githubRepository: string; policy: Policy },
	claims: JWTPayload,
	request: BuildRequest,
): AuthzResult {
	const tokenRepo = claims.repository;
	// GitHub repository names are case-insensitive.
	if (
		typeof tokenRepo !== "string" ||
		tokenRepo.toLowerCase() !== repo.githubRepository.toLowerCase()
	) {
		const found = JSON.stringify(tokenRepo) ?? "missing";
		return {
			ok: false,
			reason: `token repository is ${found}, want "${repo.githubRepository}"`,
		};
	}

	let decision: unknown;
	try {
		decision = repo.policy({ claims, request });
	} catch (err) {
		// Policy evaluation is fail-closed.
		const summary = err instanceof EvaluationError ? err.summary : String(err);
		return { ok: false, reason: `policy failed: ${summary}` };
	}
	return decision === true ? { ok: true } : { ok: false, reason: `policy returned ${decision}` };
}
