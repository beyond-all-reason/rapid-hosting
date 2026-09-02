# The local sandbox

`docker compose up` runs the service against local fakes, so you can commit to a
repository on your machine, ask for a build, and read what came out. It needs no
GitHub repository, no Bunny account and no credentials.

The used fakes are shared with the [end to end tests](../test/e2e.ts).

## Basic usage

```sh
dev/seed-origin.sh        # a small game repository in ./origin
mkdir -p sandbox
docker compose up --build
```

Compose keeps running and prints the logs, so trigger the build from another
terminal. The token comes from `dev/token.ts`, the commit from your repository,
and the rest is the API as GitHub Actions calls it:

```sh
curl -N -X POST -H "authorization: Bearer $(node dev/token.ts)" \
  "http://127.0.0.1:8080/build?repo=testrepo&branch=test&commit=$(git -C origin rev-parse HEAD)"
```

`dev/seed-origin.sh` writes the same repository the e2e test builds: a
`modinfo.lua` with `$VERSION`, a couple of unit files, and a second commit
reachable only from `refs/pull/7/head`. To build your own instead, point
`DEV_REPO` at it before starting compose:

```sh
DEV_REPO=/path/to/your/game docker compose up --build
```

## Directories layout

- `data/`: the service's own `DATA_DIR`: `git/testrepo`, `store/testrepo`
- `origin/`: the repository being built
- `sandbox/`: everything the fakes generate

Everything in `sandbox/` is written by the sandbox container:

| Path                    | What it is                                                                        |
| ----------------------- | --------------------------------------------------------------------------------- |
| `bunny/storage/zone1/…` | the storage zone: `pool/`, `packages/`, `versions.gz`, `fresh/`                   |
| `bunny/pullzones.json`  | the pull zone and its edge rules                                                  |
| `config.json`           | what the service loads, generated on every start from `BASE_CONFIG` and the fakes |
| `gitconfig`             | the git redirect to `/origin`, empty when no repo is named `testrepo`             |

`bunny/` is what Bunny would hold and nothing else; the rest is the service's
configuration, which the sandbox generates because it is the only thing that
knows the ports it just bound. The fake CDN serves straight out of storage.

> [!IMPORTANT]  
> The fake CDN **does not** emulate the edge rules behavior.

You can inspect the fake CDN contents:

```sh
find sandbox/bunny/storage -type f
cat sandbox/bunny/pullzones.json
curl -sL http://127.0.0.1:8081/cdn/testrepo/versions.gz | gunzip
```

## Generating a token

`dev/token.ts` prints a token the service accepts. Each argument is one
`<name>=<value>` claim.

```sh
node dev/token.ts                    # the default: the build runs
node dev/token.ts environment=prod   # set the environment to prod
node dev/token.ts repository=me/mine # 403, matched against githubRepository field
node dev/token.ts aud=wrong          # 401
node dev/token.ts exp=1              # 401, expired
node dev/token.ts stranger=1         # 401, special case, signed with a incorrect key
```

> [!TIP]
> Use https://www.jwt.io/ to inspect the content of token.

A claim's value is JSON when it parses and a string when it does not, so
`run_id=42` is a number and `actor=me` is a string. An empty value drops the
claim: `exp=` mints a token with no expiry at all, which is different from
`exp=null`. `stranger` is the one name that says how to sign rather than what
to claim.

The default sandbox repo's policy is `true`, so every token the service accepts
is a build that runs.

## Advanced usage

`BASE_CONFIG` names a partial `config.json` (See [Configuration](configuration.md)).
Whatever it sets is used as it is, so every block you write replaces one piece
of the sandbox:

| Block in `BASE_CONFIG` | What it replaces                                           |
| ---------------------- | ---------------------------------------------------------- |
| `repos`                | the single `testrepo` entry with the policy `true`         |
| `audience`             | the audience the service accepts and the sandbox mints for |
| `bunny`                | the fake storage zone and CDN: the service talks to Bunny  |
| `oidcIssuer`           | the fake issuer: the service stops accepting our tokens    |

The sandbox mints tokens for the config's `audience` and for the
`githubRepository` of its first repo, so `dev/token.ts` still needs no arguments
beyond the claims your own policy asks for. Both containers read the config on
start, so restart them after every change.

### A policy of your own

Name a `repos` block, see [Authorization](authorization.md) for what a policy
can say. Everything else stays faked:

```json
{
	"repos": {
		"testrepo": {
			"githubRepository": "test/repo",
			"policy": "claims.ref == 'refs/heads/stable'"
		}
	}
}
```

The token then has to carry the claims the policy asks for:

```sh
node dev/token.ts ref=refs/heads/stable
```

### A real Bunny account

Name a `bunny` block and pass the real keys. The service publishes to your
storage zone, and the tokens are still the ones we sign:

```sh
BASE_CONFIG=./config.json BUNNY_MODE=dry-run \
  BUNNY_API_KEY=... BUNNY_STORAGE_ACCESS_KEY=... \
  NODE_TLS_REJECT_UNAUTHORIZED=1 RCLONE_NO_CHECK_CERTIFICATE=false \
  docker compose up --build
```

The two certificate variables default to off in compose for the fake storage,
which serves a self-signed certificate.

> [!WARNING]
> Keep `BUNNY_MODE=dry-run` or `BUNNY_MODE=disabled` until you mean to publish.

### Another repository

The generated `sandbox/gitconfig` redirects a single clone URL: the one of the
repo named `testrepo`. A config that keeps that name still builds from
`./origin`, and `DEV_REPO` points that at any clone on disk. A config that names
the repo anything else leaves the URL as it is written, so the service clones it
from GitHub.
