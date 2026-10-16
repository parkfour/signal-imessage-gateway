#!/bin/sh
# Publishes this repository's history to a public mirror, one commit at a
# time, without the paths listed in .gitdontforward (.gitignore syntax).
#
# The mirror's history starts at its first publish: one commit holding the
# whole tree. After that, every new first-parent commit on the current
# branch becomes one mirror commit, with the same message, author and
# author date. A note on each mirror commit (refs/notes/mirror) records
# the source commit it came from, so each run continues where the last one
# stopped. The mirror is never force-pushed; a push to it from anywhere
# else makes this fail rather than overwrite it.
#
# Version tags (v*) are published too, on the mirror commit made from the
# tagged commit, once that commit has been published.
#
# usage: scripts/publish-mirror.sh [--tags-only] <mirror URL> [branch]
# MIRROR_AUTHOR_NAME / MIRROR_AUTHOR_EMAIL, if set, replace the author of
# commits by the emails in MIRROR_REPLACE_EMAILS (comma-separated), or of
# every commit when that's unset. Other authors, such as contributors whose
# pull requests were imported, keep their own name.
set -eu

tags_only=
if [ "${1:-}" = "--tags-only" ]; then
  tags_only=1
  shift
fi
url=${1:?usage: publish-mirror.sh [--tags-only] <mirror URL> [branch]}
branch=${2:-main}
notes=refs/notes/mirror

git fetch -q "$url" "+refs/heads/$branch:refs/mirror/tip" 2>/dev/null || true
git fetch -q "$url" "+$notes:$notes" 2>/dev/null || true
tip=$(git rev-parse -q --verify refs/mirror/tip || true)

# The commit's tree minus .gitdontforward's paths (as of that commit).
filtered_tree() {
  index=$(mktemp)
  GIT_INDEX_FILE=$index git read-tree "$1"
  if git cat-file -e "$1:.gitdontforward" 2>/dev/null; then
    git show "$1:.gitdontforward" >"$index.exclude"
    GIT_INDEX_FILE=$index git ls-files -z --cached --ignored --exclude-from="$index.exclude" |
      GIT_INDEX_FILE=$index git update-index -z --force-remove --stdin
  fi
  GIT_INDEX_FILE=$index git write-tree
  rm -f "$index" "$index.exclude"
}

# usage: mirror_commit <source commit> <tree> <message> [-p parent]
mirror_commit() {
  source=$1 tree=$2 message=$3
  shift 3
  name=$(git log -1 --format=%an "$source")
  email=$(git log -1 --format=%ae "$source")
  email_lower=$(printf '%s' "$email" | tr '[:upper:]' '[:lower:]')
  replace_lower=$(printf '%s' "${MIRROR_REPLACE_EMAILS:-$email}" | tr '[:upper:]' '[:lower:]')
  case ",$replace_lower," in
    *",$email_lower,"*)
      name=${MIRROR_AUTHOR_NAME:-$name}
      email=${MIRROR_AUTHOR_EMAIL:-$email}
      ;;
  esac
  commit=$(printf '%s\n' "$message" |
    GIT_AUTHOR_NAME=$name GIT_AUTHOR_EMAIL=$email GIT_AUTHOR_DATE=$(git log -1 --format=%aI "$source") \
    GIT_COMMITTER_NAME=$name GIT_COMMITTER_EMAIL=$email \
    git commit-tree "$tree" "$@")
  GIT_COMMITTER_NAME=$name GIT_COMMITTER_EMAIL=$email GIT_AUTHOR_NAME=$name GIT_AUTHOR_EMAIL=$email \
    git notes --ref=mirror add -m "$source" "$commit"
  echo "$commit"
}

# Version tags whose commit is on the mirror but whose tag isn't yet.
publish_tags() {
  remote_tags=$(git ls-remote --tags "$url" 'v*' | sed 's#.*refs/tags/##')
  published=$(mktemp)
  git notes --ref=mirror list | while read -r note commit; do
    echo "$(git cat-file -p "$note") $commit"
  done >"$published"
  refspecs=
  for tag in $(git tag -l 'v*'); do
    echo "$remote_tags" | grep -qx "$tag" && continue
    source=$(git rev-parse "$tag^{commit}")
    mirrored=$(awk -v s="$source" '$1 == s { print $2 }' "$published")
    if [ -z "$mirrored" ]; then
      echo "not publishing tag $tag: its commit isn't on the mirror (yet)"
      continue
    fi
    echo "publishing tag $tag"
    refspecs="$refspecs $mirrored:refs/tags/$tag"
  done
  rm -f "$published"
  # shellcheck disable=SC2086
  [ -z "$refspecs" ] || git push -q "$url" $refspecs
}

if [ -n "$tags_only" ]; then
  publish_tags
  exit 0
fi

head=$(git rev-parse HEAD)
if [ -z "$tip" ]; then
  current=$(mirror_commit "$head" "$(filtered_tree "$head")" "Initial public release")
  echo "publishing the initial commit"
else
  last=$(git notes --ref=mirror show "$tip")
  current=$tip
  for source in $(git rev-list --reverse --first-parent "$last..$head"); do
    tree=$(filtered_tree "$source")
    # Nothing public changed (only .gitdontforward paths): nothing to publish.
    [ "$tree" = "$(git rev-parse "$current^{tree}")" ] && continue
    current=$(mirror_commit "$source" "$tree" "$(git log -1 --format=%B "$source")" -p "$current")
    echo "publishing $(git log -1 --format='%h %s' "$source")"
  done
fi

if [ "$current" = "$tip" ]; then
  echo "mirror already up to date"
else
  git push -q "$url" "$current:refs/heads/$branch" "$notes:$notes"
fi
publish_tags
