#!/usr/bin/env bash
#
# Publish build/pages -- the whole static-host deployment, not just the
# guidebook: the packaged app as index.html, the service worker, the manifest
# and icons, podauth.html, and the guidebook with its assets.
#
#   mise exec -- python build.py --podium --pages   # build/pages
#   bash deploy-pages.sh                            # publish it
#
# The commit is assembled with git plumbing, so neither the working tree nor the
# current branch is touched: there is no checkout of gh-pages, and the feature
# branch you are working on stays checked out. gh-pages holds only the
# deployment, with no relation to the source tree, which is why the commit is
# built by hand rather than by adding files to the index.
#
# GitHub Pages then builds it, which takes a few minutes and occasionally
# stalls. To watch it, or to prod it:
#
#   gh api repos/<owner>/podium/pages/builds/latest --jq .status
#   gh api -X POST repos/<owner>/podium/pages/builds
#
set -euo pipefail

PAGES_DIR=build/pages
BRANCH=gh-pages
REMOTE=${REMOTE:-origin}

[ -f "$PAGES_DIR/index.html" ] ||
  { echo "error: $PAGES_DIR/index.html is missing; run build.py --pages" >&2; exit 1; }
[ -f "$PAGES_DIR/Guidebook.ja.html" ] ||
  echo "note: no guidebook in $PAGES_DIR; run build.py --doc --pages to deploy it" >&2

tree_of() {            # $1: directory -> sha of a tree recording its contents
  local entries="" path name
  for path in "$1"/*; do
    name=$(basename "$path")
    if [ -d "$path" ]; then
      entries="${entries}040000 tree $(tree_of "$path")	${name}
"
    else
      # --no-filters: the deployment is published byte for byte, so none of the
      # repository's text/eol attributes may rewrite it on the way in.
      entries="${entries}100644 blob $(git hash-object -w --no-filters "$path")	${name}
"
    fi
  done
  printf '%s' "$entries" | git mktree
}

# The remote branch is the parent, so a deployment made from another clone is
# not silently discarded.
git fetch --quiet "$REMOTE" "$BRANCH"
parent=$(git rev-parse "refs/remotes/$REMOTE/$BRANCH")
tree=$(tree_of "$PAGES_DIR")

if [ "$tree" = "$(git rev-parse "$parent^{tree}")" ]; then
  echo "$PAGES_DIR is already what $REMOTE/$BRANCH serves; nothing to deploy."
  exit 0
fi

source=$(git rev-parse --short HEAD)
dirty=$(git status --porcelain --untracked-files=no)
[ -z "$dirty" ] || source="$source+dirty"   # the build may not match any commit
message=${1:-"Deploy $source"}

commit=$(git commit-tree "$tree" -p "$parent" -m "$message")
git push "$REMOTE" "$commit:refs/heads/$BRANCH"
echo "deployed $commit ($message)"
