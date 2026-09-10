#!/usr/bin/env bash
# Publishes the front-end to GitHub Pages when Pages is set to a *branch* source
# (the legacy mode), by building the client and placing it at the repository root
# where GitHub's branch builder looks for it.
#
# If you switch Settings -> Pages -> Source to "GitHub Actions", stop using this:
# .github/workflows/pages.yml does the same job without committing build output.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO_NAME="${REPO_NAME:-$(basename "$(git rev-parse --show-toplevel)")}"
# Project pages are served from /<repo>/, so assets must be requested from there.
BASE_PATH="${BASE_PATH:-/$REPO_NAME/}"

echo "==> building the client for $BASE_PATH"
(cd web && npm install --no-audit --no-fund >/dev/null && BASE_PATH="$BASE_PATH" npm run build)

echo "==> staging the built site at the repository root"
rm -rf assets index.html
cp -r web/dist/assets ./assets
cp web/dist/index.html ./index.html
# Tell GitHub to serve the files as they are instead of running Jekyll over them.
touch .nojekyll

echo "==> done. Commit and push these to the branch Pages builds from:"
echo "    index.html  assets/  .nojekyll"
