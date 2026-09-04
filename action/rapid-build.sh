#!/usr/bin/env bash

set -euo pipefail

# Composite actions don't enforce required: true themselves.
for name in url repo branch; do
	var="INPUT_${name^^}"
	if [ -z "${!var}" ]; then
		echo "::error::$name is required"
		exit 1
	fi
done

audience="${INPUT_AUDIENCE:-$INPUT_URL}"
version_arg=()
if [ -n "$INPUT_VERSION" ]; then
	version_arg=(--data-urlencode "version=$INPUT_VERSION")
fi
headers="$RUNNER_TEMP/rapid-build-headers.txt"
log="$RUNNER_TEMP/rapid-build.log"

delay=60
waited=0
attempt=1
while :; do
	# A token expires in minutes and a build takes longer, so we mint one per
	# attempt.
	token="$(curl -fsSL -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
		"$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$audience" | jq -r .value)"

	echo "::group::Attempt $attempt: $INPUT_REPO:$INPUT_BRANCH at $INPUT_COMMIT"
	rc=0
	curl -sS --no-buffer --max-time 3600 -X POST \
		--get --data-urlencode "repo=$INPUT_REPO" --data-urlencode "branch=$INPUT_BRANCH" \
		--data-urlencode "commit=$INPUT_COMMIT" "${version_arg[@]}" --dump-header "$headers" \
		-H "Authorization: Bearer $token" "$INPUT_URL" \
		| tee "$log" || rc=$?
	echo "::endgroup::"

	status="$(awk 'NR == 1 { print $2 }' "$headers")"
	last="$(tail -n1 "$log")"

	# Only a build that published everything writes this line.
	case "$last" in
		"Build succeeded: "*) exit 0 ;;
	esac
	case "$status" in
		429) ;;
		4??)
			echo "::error::rapid-build refused the request ($status), retrying will not help"
			exit 1
			;;
	esac

	# We retry a failed build too, the service doesn't yet tell a transient
	# failure from a permanent one.
	reason="the build did not finish (HTTP $status, curl exit $rc)"
	if [ "$((waited + delay))" -gt "$INPUT_RETRY_BUDGET" ]; then
		echo "::error::$reason, giving up after $attempt attempts"
		exit 1
	fi
	echo "::warning::$reason, retrying in ${delay}s"
	sleep "$delay"
	waited=$((waited + delay))
	attempt=$((attempt + 1))
	delay=$((delay * 2))
done
