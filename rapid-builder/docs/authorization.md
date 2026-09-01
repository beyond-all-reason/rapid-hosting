# Authorization

A build request is authorized in two steps, both in
[src/policy.ts](../src/policy.ts):

1. The token's `repository` claim must equal the repo's `githubRepository`,
   case-insensitively. No policy can widen this, so one repo's workflows can
   never publish another's packages, and a policy need not pin
   `claims.repository` itself.
2. The repo's `policy`, a [CEL](https://cel.dev) expression, must evaluate to
   the literal `true`. It is compiled and type checked when the config loads,
   so a broken policy stops the service at boot rather than at the first build.

Branch and version names are additionally capped by the request schema
(`BuildParams` in [src/server.ts](../src/server.ts)), so a too-permissive
policy still cannot produce a hostile name.

## What a policy can see

Two variables are in scope, declared by `environment` in
[src/policy.ts](../src/policy.ts). Naming anything else fails the load.

- `claims`: the verified OIDC token's claims. GitHub documents them in
  [Understanding the OIDC token](https://docs.github.com/en/actions/concepts/security/openid-connect#understanding-the-oidc-token)
  and [OIDC token claims](https://docs.github.com/en/actions/reference/security/oidc#oidc-token-claims).
- `request`: `request.branch`, `request.commit` and `request.version`, which is
  absent unless the request set one. This shape is declared, so a misspelled
  field like `request.brnch` fails the load rather than denying every build at
  runtime.

## Example

```json
"byar": {
  "githubRepository": "beyond-all-reason/Beyond-All-Reason",
  "policy": "claims.ref == 'refs/heads/stable' && !has(request.version) && request.branch == 'test'"
}
```

This one allows a build only when the run was triggered for the `stable`
branch, the request sets no version, and the rapid branch it publishes is
`test`. Everything else the workflow could ask for is denied.

## Pitfalls

[The CEL language definition](https://github.com/cel-expr/cel-spec/blob/master/doc/langdef.md)
covers the language. Three things bite here in particular:

- **Reading a value that is not there is an error, not `false`.**
  `claims.environment == 'prod'` *fails* for a token without that claim, and so
  does `request.version == '1.0'` for a request that set no version. Guard with
  `has(...) && ...` whenever the value is not always present.
- **`matches()` is unanchored.** `request.branch.matches('pr-[0-9]+')` also
  accepts `evil-pr-1`. Anchor the pattern yourself.
- **Only a literal `true` authorizes.** A denial is answered with 403 and
  logged at `warn` with the reason. The response body does not include it,
  because it quotes the configured policy.
