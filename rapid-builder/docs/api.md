# Build API

## `POST /build`

The whole request is in the URL, there is no body. The token is the GitHub
Actions OIDC token.

```
POST /build?repo=byar&branch=pr-1234&commit=6d3f9e0a1b2c3d4e5f60718293a4b5c6d7e8f900
Authorization: Bearer <GitHub Actions OIDC token>
```

The parameters are `BuildParams` in [src/server.ts](../src/server.ts), with the
values each one accepts. `version` is optional, the rest are required.

`repo` and `branch` together are the rapid tag clients fetch, so the build
above becomes `byar:pr-1234`. rapid-buildgit also publishes
`<repo>:git:<commit>`, so every build stays reachable by its commit. The repo's
[policy](authorization.md) decides whether this token may publish this branch,
and whether it may set a version at all.

## The streamed response

The response is `text/plain`. The 200 and the request's own log line go out as
soon as the request is accepted, before it has waited for the repo's lock, and
the rest arrives as the build writes it. Everything that answers with a status,
the rejections below included, is settled before that first byte.

A build that fails ten minutes in cannot take back the 200 it already sent, so
it reports failure with the framing instead. After a final `Build failed: ...`
line the connection is closed without finishing the chunked body, so every HTTP
client sees a truncated response rather than a complete one.

## Outcomes

| What the caller sees                                     | What happened                                                                                                           | Retry                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 200, complete transfer, last line `Build succeeded: ...` | built and published                                                                                                     | no need                                                    |
| 400                                                      | malformed or unknown parameter                                                                                          | no                                                         |
| 401                                                      | the token does not verify                                                                                               | no                                                         |
| 403                                                      | the policy does not allow this build (the reason is logged rather than returned, since it quotes the configured policy) | no                                                         |
| 405                                                      | the path is right and the method is not, `Allow` names the one it takes                                                 | no                                                         |
| 429                                                      | too many builds already queued for the repo                                                                             | yes, after a pause                                         |
| 505                                                      | the request came over HTTP/1.0, whose framing cannot signal an outcome                                                  | no                                                         |
| other 5xx                                                | the service broke before the build started                                                                              | yes                                                        |
| 200, truncated transfer, last line `Build failed: ...`   | the build ran and failed                                                                                                | it will fail the same way, so only if you expect flakiness |
| 200, truncated transfer, no `Build failed: ...` line     | the connection was lost mid-build, the build itself may well have finished                                              | yes                                                        |

Every 4xx except 429 plus the 505 is the request itself being wrong. Everything
else is the service or the transport rather than the request, and retrying it
is safe: builds of a repo are serialized, the rapid store is incremental, and
building the same commit onto the same branch again republishes what is already
there.

The last two rows are both a truncated transfer, so the last log line is what
separates them. `Build failed: ...` is written only by a build that ran and
failed, and `Build succeeded: ...` only once everything is published.

## `GET /healthz`

Returns 200 and `ok`.
