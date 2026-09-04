# Rapid build action

A composite action that builds a commit and publishes it as a rapid tag. It
calls the `/build` endpoint of [rapid-builder](../rapid-builder/) (see
[API](../rapid-builder/docs/api.md)) with an OIDC token minted by the workflow.

```yaml
name: Rapid build
on:
  push:
    branches:
      - stable
# Builds of the same branch queue in called service so having multiple
# in parallel doesn't make sense
concurrency:
  group: rapid-build
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      # Needed to mint an OIDC token for the service
      id-token: write
    steps:
      - uses: beyond-all-reason/rapid-hosting/action@main
        with:
          url: https://rapid-build.example.com/build
          repo: byar
          branch: test
```

This publishes every push to `stable` as `byar:test`. All inputs are described
in [action.yml](action.yml). The action retries transient failures on its own
and only succeeds once the build was published.
