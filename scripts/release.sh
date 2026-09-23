#!/usr/bin/env bash
# Create the GitHub release for a version using its CHANGELOG.md section
# verbatim as the release notes, which triggers the npm publish workflow.
#
# Usage: npm run release -- 0.9.0     (tag v0.9.0 must already exist)
set -euo pipefail

version="${1:?usage: npm run release -- <version> (e.g. 0.9.0)}"
tag="v${version}"
cd "$(dirname "$0")/.."

notes_file=$(mktemp)
trap 'rm -f "$notes_file"' EXIT

# Extract the "## [x.y.z] ..." section: from its heading up to (excluding)
# the next "## [" heading.
awk -v ver="## [${version}]" '
  !found && index($0, ver) == 1 { found = 1; next }
  found && /^## \[/ { exit }
  found
' CHANGELOG.md > "$notes_file"

if [ ! -s "$notes_file" ]; then
  echo "error: no CHANGELOG.md section found for ${version}" >&2
  exit 1
fi

git rev-parse -q --verify "refs/tags/${tag}" >/dev/null \
  || { echo "error: tag ${tag} does not exist; create and push it first" >&2; exit 1; }

gh release create "$tag" --title "${version}" --notes-file "$notes_file"
