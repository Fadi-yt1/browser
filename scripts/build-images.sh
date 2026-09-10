#!/usr/bin/env bash
# Builds both images: the session browser and the all-in-one gateway.
set -euo pipefail
cd "$(dirname "$0")/.."

docker build -t browser-in-browser/session:latest ./browser-image
docker build -t browser-in-browser/gateway:latest .
echo "==> built browser-in-browser/session:latest and browser-in-browser/gateway:latest"
