#!/bin/sh
# Creates a small valid for RapidTools repository for local testing and e2e.
set -eu

dir=${1:-./origin}
git="git -c user.name=rapid-build -c user.email=dev@rapid-build.invalid -c commit.gpgsign=false"

if [ -e "$dir/.git" ]; then
	echo "$dir is already a git repository, nothing to seed" >&2
	exit 1
fi

mkdir -p "$dir/units"
cd "$dir"
git init -q -b master .

printf 'return { name = "Test Game", version = "$VERSION" }\n' > modinfo.lua
printf 'return { hp = 100 }\n' > units/tank.lua
printf 'a game\n' > readme.md
$git add -A
$git commit -qm "the game"

# This second commit is reachable only from refs/pull/7/head and from no branch,
# which is the case fetching a bare sha.
printf 'return { hp = 200 }\n' > units/ship.lua
$git add -A
$git commit -qm "add a ship"
git update-ref refs/pull/7/head HEAD
git update-ref HEAD HEAD^
git reset -q --hard HEAD

echo "Seeded $dir"
echo "  master           $(git rev-parse HEAD)"
echo "  refs/pull/7/head $(git rev-parse refs/pull/7/head)"
