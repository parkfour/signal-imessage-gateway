#!/bin/sh
# Tests for scripts/publish-mirror.sh, using throwaway local repositories
# (no network). Source branch is master, mirror branch is main, as in CI.
# usage: tests/publish-mirror.sh
set -eu

script=$(cd "$(dirname "$0")/.." && pwd)/scripts/publish-mirror.sh
export GIT_AUTHOR_NAME=Dev GIT_AUTHOR_EMAIL=dev@example.com
export GIT_COMMITTER_NAME=Dev GIT_COMMITTER_EMAIL=dev@example.com
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
failures=0

fail() { echo "  FAIL: $*"; failures=$((failures + 1)); }
expect() { [ "$2" = "$3" ] || fail "$1: expected [$3], got [$2]"; }

setup() {
  rm -rf "$dir/source" "$dir/mirror.git"
  git init -q -b master "$dir/source"
  git init -q --bare -b main "$dir/mirror.git"
  src=$dir/source mirror=$dir/mirror.git
}
# usage: commit <message> <file>=<content>...
commit() {
  message=$1
  shift
  for pair in "$@"; do printf '%s' "${pair#*=}" >"$src/${pair%%=*}"; done
  git -C "$src" add -A
  git -C "$src" commit -q -m "$message"
}
publish() { (cd "$src" && sh "$script" "$@" "$mirror" main); }
mirror_files() { git -C "$mirror" ls-tree -r --name-only main | tr '\n' ' '; }
mirror_log() { git -C "$mirror" log --format=%s main | tr '\n' '|'; }

echo "publishes the current tree as one commit, without the private paths or the history"
setup
commit "wip 1" app.txt=v1 secret_parkfour.md=private ".gitdontforward=*_parkfour.md"
commit "wip 2" app.txt=v2
publish >/dev/null
expect log "$(mirror_log)" "Initial public release|"
expect files "$(mirror_files)" ".gitdontforward app.txt "
expect content "$(git -C "$mirror" show main:app.txt)" v2

echo "then publishes each new commit, skipping ones that only touch private paths"
setup
commit wip app.txt=v1 secret_parkfour.md=private ".gitdontforward=*_parkfour.md"
publish >/dev/null
commit "feat: two" app.txt=v2
commit "docs: private only" secret_parkfour.md="still private"
commit "feat: three" app.txt=v3 notes_parkfour.md="also private"
publish >/dev/null
expect log "$(mirror_log)" "feat: three|feat: two|Initial public release|"
expect files "$(mirror_files)" ".gitdontforward app.txt "
expect author "$(git -C "$mirror" log -1 --format='%an <%ae>' main)" "Dev <dev@example.com>"

echo "publishes version tags on the matching mirror commit, once that commit is published"
setup
commit wip app.txt=v1
publish >/dev/null
commit "feat: two" app.txt=v2
git -C "$src" tag v0.1.0 HEAD~1
git -C "$src" tag v0.2.0
publish --tags-only >/dev/null
expect "tags-only" "$(git -C "$mirror" tag -l | tr '\n' ' ')" "v0.1.0 "
expect "v0.1.0 target" "$(git -C "$mirror" rev-parse v0.1.0)" "$(git -C "$mirror" rev-parse main)"
publish >/dev/null
expect tags "$(git -C "$mirror" tag -l | tr '\n' ' ')" "v0.1.0 v0.2.0 "
expect "v0.2.0 content" "$(git -C "$mirror" show v0.2.0:app.txt)" v2
expect "v0.2.0 target" "$(git -C "$mirror" rev-parse v0.2.0)" "$(git -C "$mirror" rev-parse main)"

echo "renames only the listed authors when MIRROR_REPLACE_EMAILS is set (case-insensitively)"
setup
commit wip app.txt=v1
publish >/dev/null
commit "feat: mine" app.txt=v2
# Subshells: assignments before a function call can outlive it in sh.
(GIT_AUTHOR_NAME=Alice GIT_AUTHOR_EMAIL=alice@example.com GIT_COMMITTER_NAME=Alice GIT_COMMITTER_EMAIL=alice@example.com \
  commit "feat: contributor" contrib.txt="from alice")
(GIT_AUTHOR_NAME=Dev GIT_AUTHOR_EMAIL=Dev@Example.COM GIT_COMMITTER_NAME=Dev GIT_COMMITTER_EMAIL=Dev@Example.COM \
  commit "feat: mixed case" mixed.txt="from dev")
(MIRROR_AUTHOR_NAME="Public Name" MIRROR_AUTHOR_EMAIL=public@example.com MIRROR_REPLACE_EMAILS=other@example.com,DEV@example.com \
  publish >/dev/null)
expect authors "$(git -C "$mirror" log --format='%s|%an <%ae>' -3 main | tr '\n' ';')" \
  "feat: mixed case|Public Name <public@example.com>;feat: contributor|Alice <alice@example.com>;feat: mine|Public Name <public@example.com>;"

echo "does nothing when there's nothing new"
setup
commit wip app.txt=v1
publish >/dev/null
case $(publish) in *"already up to date"*) ;; *) fail "second run should report up to date" ;; esac
expect log "$(mirror_log)" "Initial public release|"

[ "$failures" -eq 0 ] && echo "all passed" || { echo "$failures failure(s)"; exit 1; }
