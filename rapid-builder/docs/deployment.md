# Deployment

The service needs `config.json`, the two Bunny keys, a volume for `DATA_DIR`
and a port reachable from GitHub Actions. The metrics port must stay internal.

To run it on your own machine instead, against the fakes or against a real
Bunny account, see [the local sandbox](sandbox.md). That is not how the service
is deployed in production, and is not meant to be.

## Config and secrets

```sh
cp config.example.json config.json  # then edit
```

Prefer `*_PATH` variables for passing secrets, see
[Configuration](configuration.md).

## Reverse proxy

A proxy in front of the service must speak HTTP/1.1 upstream and must not
buffer the response. Chunked framing is what signals a build's outcome (see
[Build API](api.md)), so a proxy that re-frames or holds the body back turns a
failed build into a successful looking one.

## Shutdown

On `SIGTERM` the service stops accepting requests and finishes the builds that
are already running. A second signal kills it.

## Bunny edge rule

The edge rule named `Redirect to fresh <repo> version` is created on the pull
zone by the repo's first build and repointed by every build after that. An
existing rule keeps all its other fields, so disabling it in the Bunny panel
turns the workaround off for that repo without breaking builds.
