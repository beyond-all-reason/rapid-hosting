import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";

/** Verifies a bearer token and resolves to its claims. */
export type TokenVerifier = (token: string, audience: string) => Promise<JWTPayload>;

/** Builds a verifier for GitHub Actions OIDC tokens from one issuer. */
export function createOidcVerifier(issuer: string): TokenVerifier {
	const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`));
	return async (token, audience) => {
		const { payload } = await jwtVerify(token, jwks, { issuer, audience });
		return payload;
	};
}
