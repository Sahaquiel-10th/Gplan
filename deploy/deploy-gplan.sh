#!/usr/bin/env bash
set -euo pipefail

readonly commit_sha="${1:-}"
readonly app_dir="/opt/gplan"
[[ "$commit_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid commit SHA" >&2; exit 64; }
readonly work_dir="/tmp/gplan-deploy-${commit_sha}"
readonly archive="/tmp/gplan-${commit_sha}.tar"
readonly credential_file="${CLIENT_API_CREDENTIAL_FILE:-/root/winona-trial-20261015.json}"
readonly backup_dir="/opt/gplan-release-backups/$(date +%Y%m%d-%H%M%S)-${commit_sha}"

exec 9>/var/lock/gplan-deploy.lock
flock -n 9 || { echo "Another deployment is running" >&2; exit 75; }
cleanup() { rm -rf "$work_dir" "$archive"; }
trap cleanup EXIT
mkdir -p "$work_dir"
cat > "$archive"
[[ -s "$archive" ]] || { echo "Empty deployment archive" >&2; exit 65; }
if tar -tf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "Unsafe archive path" >&2; exit 66
fi
tar -xf "$archive" -C "$work_dir"
cd "$work_dir"
[[ -f scripts/check-release-contract.mjs && -f package-lock.json ]] || {
  echo "Release lacks formal API checks; refusing replacement" >&2; exit 67;
}
node scripts/check-release-contract.mjs "$archive"
[[ -r "$credential_file" ]] || { echo "Client API smoke-test credential missing" >&2; exit 68; }
npm ci --ignore-scripts --prefer-offline --no-audit --no-fund
npm run test:client-api
npm run test:enterprise-data
npm run build

# Keep recoverable code, build and dependency snapshots outside the rsync target.
mkdir -p "$backup_dir"
rsync -a --exclude '.env*' --exclude '.git/' --exclude 'data/' "$app_dir"/ "$backup_dir"/
rollback() {
  echo "Release validation failed; restoring $backup_dir" >&2
  rsync -a --delete --exclude '.env*' --exclude '.git/' --exclude 'data/' "$backup_dir"/ "$app_dir"/
  cd "$app_dir"
  pm2 startOrRestart deploy/ecosystem.config.cjs --update-env
  pm2 save
}
rsync -a --delete --exclude '.env*' --exclude '.git/' --exclude 'data/' "$work_dir"/ "$app_dir"/
cd "$app_dir"
if ! pm2 startOrRestart deploy/ecosystem.config.cjs --update-env; then rollback; exit 1; fi
ready=false
for attempt in {1..15}; do
  if curl --fail --silent http://127.0.0.1:3001/api/health >/dev/null; then ready=true; break; fi
  sleep 2
done
if [[ "$ready" != true ]] || ! CLIENT_API_BASE_URL=http://127.0.0.1:3001/api/open/v1 \
  CLIENT_API_CREDENTIAL_FILE="$credential_file" node scripts/check-client-api.mjs; then
  rollback; exit 1
fi
printf '%s\n' "$commit_sha" > "$app_dir/REVISION"
pm2 save
# Subsequent automated deployments use the same versioned checks.
install -m 755 deploy/deploy-gplan.sh /usr/local/sbin/deploy-gplan
echo "Deployment complete with authenticated API validation: $commit_sha"
