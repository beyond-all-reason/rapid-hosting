# Configuration

The environment holds the secrets and the shape of the container. Everything
else, meaning what the service trusts and what it may build, is in
`config.json`.

## Environment

Every variable, its default and what it does is declared by the `env` schema in
[src/main.ts](../src/main.ts), except `LOG_LEVEL`, which is in
[src/log.ts](../src/log.ts).

The two Bunny keys are each given either literally in the variable or as the
path to a file holding it in the `_PATH` one, see `readSecret` in the same
file. [Deployment](deployment.md) has a compose file that uses the file form.

`BUNNY_MODE` says how much of a build reaches Bunny, see `BunnyMode` in
[src/build.ts](../src/build.ts).

## `config.json`

The fields are declared by the `Config` schema in
[src/config.ts](../src/config.ts).
[config.example.json](../config.example.json) is a filled in one.

Every object is strict: an unknown or misspelled key fails the load rather than
being silently ignored, which for an authorization config is the difference
between a typo and a hole.

`audience` and `oidcIssuer` are the whole trust anchor. Each repo's `policy`
decides who may publish what, see [Authorization](authorization.md).
