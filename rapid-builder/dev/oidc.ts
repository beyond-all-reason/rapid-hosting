// A local OIDC issuer that signs the tokens GitHub Actions would sign.

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

/** The "aud" claim both the issuer and the local configs use. */
export const AUDIENCE = "test-aud";

/** The repository the tokens claim to come from, and the configs build. */
export const GITHUB_REPOSITORY = "test/repo";

export type FakeIssuer = Awaited<ReturnType<typeof startOidcIssuer>>;

/** Reads a value as JSON, falling back to the string itself. */
function claimValue(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

export async function startOidcIssuer(
	opts: {
		/** Address to bind. Default: 127.0.0.1. */
		host?: string;
		port?: number;
		/** Host the issuer URL names. Default: 127.0.0.1. */
		publicHost?: string;
		/** Value of the "aud" claim in the tokens. Default: {@link AUDIENCE}. */
		audience?: string;
		/** The repository the tokens claim. Default: {@link GITHUB_REPOSITORY}. */
		repository?: string;
	} = {},
) {
	const audience = opts.audience ?? AUDIENCE;
	const repository = opts.repository ?? GITHUB_REPOSITORY;
	const { publicKey, privateKey } = await generateKeyPair("RS256");
	const stranger = await generateKeyPair("RS256");
	// Unique per process: a verifier caches the JWKS by key id, so a fresh id is
	// what makes it refetch after this issuer is restarted under it.
	const kid = randomUUID();
	const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };

	let issuer = "";

	// We build one payload object rather than call setIssuer, setAudience and the
	// rest, so a caller can override any claim by name.
	function mint(claims: Record<string, unknown> = {}, key?: CryptoKey) {
		const payload = {
			iss: issuer,
			aud: audience,
			sub: `repo:${repository}:pull_request`,
			exp: Math.floor(Date.now() / 1000) + 5 * 60,
			repository,
			event_name: "pull_request_target",
			ref: "refs/heads/master",
			run_id: "42",
			actor: "tester",
			// A claim set to undefined drops the default rather than overriding it,
			// since JSON.stringify leaves it out of the payload jose signs.
			...claims,
		};
		return new SignJWT(payload)
			.setProtectedHeader({ alg: "RS256", kid })
			.sign(key ?? privateKey);
	}

	const server: Server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname === "/.well-known/jwks") {
			return void res.end(JSON.stringify({ keys: [jwk] }));
		}
		if (url.pathname === "/token") {
			// Every parameter is a claim, except `stranger`, which says how to sign.
			// An empty value drops the claim, which a query string cannot otherwise
			// say.
			const claims: Record<string, unknown> = {};
			for (const [name, raw] of url.searchParams) {
				if (name === "stranger") continue;
				claims[name] = raw === "" ? undefined : claimValue(raw);
			}
			const key = url.searchParams.has("stranger") ? stranger.privateKey : undefined;
			res.writeHead(200, { "content-type": "text/plain" });
			return void mint(claims, key).then((token) => res.end(token));
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((resolve) =>
		server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve),
	);
	// Not the host we bind: this goes into config.json and into every token's
	// iss claim, so it has to be a name the service resolves.
	issuer = `http://${opts.publicHost ?? "127.0.0.1"}:${(server.address() as AddressInfo).port}`;

	return {
		issuer,
		mint,
		/** A key the JWKS does not publish, for a token that must not verify. */
		strangerKey: stranger.privateKey,
		close(): void {
			server.close();
			server.closeAllConnections();
		},
	};
}
