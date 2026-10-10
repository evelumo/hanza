#!/usr/bin/env bash
# The recording sandbox of the WooCommerce connector: a throwaway shop in Docker. See README.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
default_project="hanza-woo-sandbox"
project="${WOO_SANDBOX_PROJECT:-$default_project}"
export WOO_SANDBOX_PORT="${WOO_SANDBOX_PORT:-8089}"
origin="http://127.0.0.1:${WOO_SANDBOX_PORT}"

# What the shop believes its address is, so nothing of this machine (host, port) reaches a recorded response.
store_url="https://shop.example.test"
woocommerce_version="11.2.1"

recording_dir="$here/../.recording"
if [ "$project" = "$default_project" ]; then
  credentials="$recording_dir/credentials.json"
else
  credentials="$recording_dir/credentials.$project.json"
fi

compose() { docker compose --progress quiet -p "$project" -f "$here/docker-compose.yml" "$@"; }
# -T: no terminal, so output can be piped and a command works from a script or an agent.
wp() { compose run --rm -T cli wp "$@"; }

wait_for_files() {
  # The image copies WordPress into its volume on first start; wp-cli needs the files.
  for _ in $(seq 1 90); do
    if curl -s -o /dev/null --max-time 2 "$origin/wp-includes/images/blank.gif"; then return 0; fi
    sleep 1
  done
  echo "WordPress did not answer on $origin" >&2
  return 1
}

cmd_up() {
  compose up -d --wait db wordpress
  wait_for_files
  if ! wp core is-installed 2>/dev/null; then
    wp core install --url="$store_url" --title="Hanza WooCommerce sandbox" \
      --admin_user=admin --admin_email=admin@example.test --skip-email >/dev/null
  fi
  if ! wp plugin is-active woocommerce 2>/dev/null; then
    wp plugin install woocommerce --version="$woocommerce_version" --activate
  fi
  # Installed through wp-cli, WooCommerce keeps orders in posts: turn HPOS on, as it is on every shop created
  # since WooCommerce 8.2 (it also creates the order tables).
  if [ "$(wp option get woocommerce_custom_orders_table_enabled 2>/dev/null || true)" != "yes" ]; then
    wp wc hpos enable >/dev/null
  fi
  wp rewrite structure '/%postname%/' >/dev/null
  wp eval-file /sandbox/setup.php
  echo "Sandbox \"$project\" is up on $origin (the shop calls itself $store_url)."
}

cmd_seed() { wp eval-file /sandbox/seed.php; }

cmd_key() {
  mkdir -p "$recording_dir"
  local json
  json="$(wp eval-file /sandbox/key.php "$origin" | tail -n 1)"
  case "$json" in
    '{'*'}') ;;
    *) echo "Could not create the API keys." >&2; return 1 ;;
  esac
  (umask 077 && printf '%s\n' "$json" > "$credentials")
  echo "API keys written to ${credentials#"$here/../"} (ignored by git)."
}

cmd_down() {
  compose --profile tools down --volumes --remove-orphans
  rm -f "$credentials"
}

usage() {
  cat <<EOF
Usage: sandbox.sh <command>

  up        Start the shop and set it up (WordPress, WooCommerce $woocommerce_version, settings). Safe to repeat.
  seed      Create the seed products and orders. Once per shop; "reset" gives a fresh one.
  key       Create the REST API keys and write them to .recording/ (replaces earlier ones).
  reset     down, up, seed and key: a fresh, seeded shop.
  down      Remove the containers, the volumes and the keys file.
  wp ...    Run a wp-cli command in the shop, e.g. sandbox.sh wp wc shop_order list --user=1
  curl ...  curl against the shop's REST API with the read-write key (passed on curl's stdin), e.g. sandbox.sh curl 'orders?per_page=1'
  status    Show the containers.

Environment: WOO_SANDBOX_PROJECT (default $default_project), WOO_SANDBOX_PORT (default 8089).
EOF
}

cmd_curl() {
  if [ ! -f "$credentials" ]; then echo "No keys yet: run sandbox.sh key" >&2; return 1; fi
  local path="$1"; shift
  # The key goes to curl on its standard input (`-K -`), never on its command line, where `ps` would show it. The
  # script reads the file by path and prints only the config line, so the key is not in node's arguments either.
  # It means curl's own standard input is taken: no `-d @-` or `-T -`.
  node -e '
    const k = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    const escaped = (k.consumerKey + ":" + k.consumerSecret).replace(/[\\"]/g, "\\$&")
    process.stdout.write("user = \"" + escaped + "\"\n")
  ' "$credentials" | curl -sS -K - -H 'X-Forwarded-Proto: https' -H 'Accept: application/json' "$@" "$origin/wp-json/wc/v3/$path"
}

case "${1:-}" in
  up) cmd_up ;;
  seed) cmd_seed ;;
  key) cmd_key ;;
  reset) cmd_down; cmd_up; cmd_seed; cmd_key ;;
  down) cmd_down ;;
  wp) shift; wp "$@" ;;
  curl) shift; cmd_curl "$@" ;;
  status) compose ps ;;
  *) usage; [ -n "${1:-}" ] && [ "${1:-}" != "help" ] && exit 1 || exit 0 ;;
esac
