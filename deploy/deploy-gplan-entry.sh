#!/usr/bin/env bash
set -euo pipefail
exec /usr/local/sbin/deploy-gplan "${1:-}"
