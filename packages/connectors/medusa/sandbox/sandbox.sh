#!/usr/bin/env bash
# The recording sandbox of the Medusa connector: a throwaway Medusa store with medusa-plugin-hanza in Docker. See README.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project="${MEDUSA_SANDBOX_PROJECT:-hanza-medusa-sandbox}"
export MEDUSA_SANDBOX_PORT="${MEDUSA_SANDBOX_PORT:-9100}"
export MEDUSA_SANDBOX_POSTGRES_PORT="${MEDUSA_SANDBOX_POSTGRES_PORT:-5443}"
export MEDUSA_SANDBOX_REDIS_PORT="${MEDUSA_SANDBOX_REDIS_PORT:-6390}"
origin="http://127.0.0.1:${MEDUSA_SANDBOX_PORT}"

# The plugin's repository, by default next to this repository's checkout (…/medusa-plugin-hanza beside …/open-linker).
default_plugin_dir="$(cd "$here/../../../../.." && pwd)/medusa-plugin-hanza"
# docker-compose.yml's sandbox admin (local and throwaway).
admin_email="hanza@example.com"
admin_password="hanza-sandbox-password"

recording_dir="$here/../.recording"
credentials="$recording_dir/credentials.json"

compose() { docker compose --progress quiet -p "$project" -f "$here/docker-compose.yml" "$@"; }

has_plugin_tarball() { ls "$here"/plugin/medusa-plugin-hanza-*.tgz >/dev/null 2>&1; }

cmd_pack() {
  local plugin_dir="${1:-$default_plugin_dir}"
  if [ ! -f "$plugin_dir/package.json" ]; then
    echo "No plugin at $plugin_dir: give its directory, sandbox.sh pack <dir>." >&2
    return 1
  fi
  rm -f "$here"/plugin/medusa-plugin-hanza-*.tgz
  (cd "$plugin_dir" && npm run build >/dev/null && npm pack --pack-destination "$here/plugin" >/dev/null)
  echo "Packed $(basename "$(ls "$here"/plugin/medusa-plugin-hanza-*.tgz)") into sandbox/plugin/ (ignored by git)."
}

cmd_up() {
  if ! has_plugin_tarball; then
    echo "No plugin tarball in sandbox/plugin/: run sandbox.sh pack [plugin-dir] first." >&2
    return 1
  fi
  compose up -d --build --wait
  echo "Sandbox \"$project\" is up on $origin (Admin API under $origin/admin)."
}

cmd_seed() { compose exec -T medusa npx medusa exec ./src/scripts/seed.ts; }

cmd_key() {
  mkdir -p "$recording_dir"
  node "$here/tools/key.mjs" "$origin" "$credentials" "$admin_email" "$admin_password"
}

cmd_down() {
  compose down --volumes --remove-orphans
  rm -f "$credentials"
}

cmd_curl() {
  if [ ! -f "$credentials" ]; then echo "No key yet: run sandbox.sh key" >&2; return 1; fi
  local path="$1"; shift
  # The key goes to curl on its standard input (`-K -`), never on its command line, where `ps` would show it.
  node -e '
    const k = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    process.stdout.write("header = \"Authorization: Basic " + k.apiKey.replace(/[\\"]/g, "\\$&") + "\"\n")
  ' "$credentials" | curl -sS -K - -H 'Accept: application/json' "$@" "$origin/admin/$path"
}

usage() {
  cat <<USAGE
Usage: sandbox.sh <command>

  pack [dir]  Build medusa-plugin-hanza and copy its tarball into sandbox/plugin/ (default dir: $default_plugin_dir).
  up          Build and start Medusa 2.21.2 with the plugin, Postgres and Redis; migrate; create the admin. Safe to repeat.
  seed        Create the seed: region, sales channel, stock location, products, five orders, the plugin's settings. Once per store.
  key         Create a secret API key and write it to ../.recording/credentials.json (ignored by git).
  reset       down, up, seed and key: a fresh, seeded store.
  down        Remove the containers, the volumes and the keys file.
  curl ...    curl against the Admin API with the secret key, e.g. sandbox.sh curl 'hanza/status'
  status      Show the containers.
  exec ...    Run a command in the medusa container, e.g. sandbox.sh exec npx medusa db:migrate

Environment: MEDUSA_SANDBOX_PROJECT (default hanza-medusa-sandbox), MEDUSA_SANDBOX_PORT (9100),
MEDUSA_SANDBOX_POSTGRES_PORT (5443), MEDUSA_SANDBOX_REDIS_PORT (6390), MEDUSA_SANDBOX_DISABLE_ADMIN (true).
USAGE
}

case "${1:-}" in
  pack) shift; cmd_pack "$@" ;;
  up) cmd_up ;;
  seed) cmd_seed ;;
  key) cmd_key ;;
  reset) cmd_down; cmd_up; cmd_seed; cmd_key ;;
  down) cmd_down ;;
  curl) shift; cmd_curl "$@" ;;
  status) compose ps ;;
  exec) shift; compose exec medusa "$@" ;;
  *) usage; [ -n "${1:-}" ] && [ "${1:-}" != "help" ] && exit 1 || exit 0 ;;
esac
