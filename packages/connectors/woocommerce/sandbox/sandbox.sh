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

# The opt-in TLS front (`tls`): its certificate and access log, per instance like the keys file. A path without
# "..", because Docker mounts it.
export WOO_SANDBOX_TLS_PORT="${WOO_SANDBOX_TLS_PORT:-8443}"
if [ "$project" = "$default_project" ]; then
  export WOO_SANDBOX_TLS_DIR="$(dirname "$here")/.recording/tls"
else
  export WOO_SANDBOX_TLS_DIR="$(dirname "$here")/.recording/tls.$project"
fi
tls_host="${store_url#https://}"
if [ "$WOO_SANDBOX_TLS_PORT" = "443" ]; then tls_url="$store_url"; else tls_url="$store_url:$WOO_SANDBOX_TLS_PORT"; fi

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

# A throwaway certificate authority and a certificate for the shop's host name (and "www." of it), with openssl only.
# The authority may sign for those names alone and its key is deleted once it has, so trusting it
# (NODE_EXTRA_CA_CERTS) trusts nothing but this sandbox.
make_certificate() {
  local cert_dir="$WOO_SANDBOX_TLS_DIR/cert" work
  if [ -f "$cert_dir/server.crt" ] && [ -f "$cert_dir/server.key" ] && [ -f "$WOO_SANDBOX_TLS_DIR/ca.crt" ]; then return 0; fi
  command -v openssl >/dev/null || { echo "openssl is needed for the TLS front." >&2; return 1; }
  mkdir -p "$cert_dir"
  work="$(mktemp -d)"
  cat > "$work/ca.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = Hanza WooCommerce sandbox ($project), local and throwaway
[ext]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;DNS:$tls_host
CNF
  cat > "$work/server.cnf" <<CNF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = $tls_host
[ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:$tls_host, DNS:www.$tls_host
CNF
  if ! (
    umask 077
    openssl req -x509 -newkey rsa:2048 -nodes -days 30 -sha256 -config "$work/ca.cnf" \
      -keyout "$work/ca.key" -out "$work/ca.crt" 2>/dev/null &&
    openssl req -new -newkey rsa:2048 -nodes -sha256 -config "$work/server.cnf" \
      -keyout "$cert_dir/server.key" -out "$work/server.csr" 2>/dev/null &&
    openssl x509 -req -in "$work/server.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" -CAcreateserial \
      -days 30 -sha256 -extfile "$work/server.cnf" -extensions ext -out "$cert_dir/server.crt" 2>/dev/null
  ); then
    rm -rf "$work"
    echo "Could not create the certificate." >&2
    return 1
  fi
  cp "$work/ca.crt" "$WOO_SANDBOX_TLS_DIR/ca.crt"
  rm -rf "$work"
}

# curl through the TLS front: the shop's host name sent to this machine, trusting the sandbox's authority only.
tls_curl() {
  if [ ! -f "$WOO_SANDBOX_TLS_DIR/ca.crt" ]; then echo "No TLS front yet: run sandbox.sh tls" >&2; return 1; fi
  curl -sS --cacert "$WOO_SANDBOX_TLS_DIR/ca.crt" --resolve "$tls_host:$WOO_SANDBOX_TLS_PORT:127.0.0.1" \
    --resolve "www.$tls_host:$WOO_SANDBOX_TLS_PORT:127.0.0.1" "$@"
}

# What a locally running Hanza worker needs to reach the front (README.md, "A TLS front"), as shell to `eval`.
cmd_tls_env() {
  if [ ! -f "$WOO_SANDBOX_TLS_DIR/ca.crt" ]; then echo "No TLS front yet: run sandbox.sh tls" >&2; return 1; fi
  echo "# TLS front of sandbox \"$project\" on 127.0.0.1:$WOO_SANDBOX_TLS_PORT. Shop address for the Connection: $tls_url"
  echo "# Access log: $WOO_SANDBOX_TLS_DIR/log/access.log"
  printf 'export NODE_EXTRA_CA_CERTS=%q\n' "$WOO_SANDBOX_TLS_DIR/ca.crt"
  printf 'export WOO_SANDBOX_RESOLVE=%q\n' "$tls_host,www.$tls_host"
  printf 'export NODE_OPTIONS=%q\n' "--import=$here/resolve-shop.mjs"
}

cmd_tls() {
  if [ -z "$(compose ps -q wordpress 2>/dev/null)" ]; then
    echo "The shop is not up: run sandbox.sh up (or reset) first." >&2
    return 1
  fi
  make_certificate
  mkdir -p "$WOO_SANDBOX_TLS_DIR/log"
  compose --profile tls up -d tls
  for _ in $(seq 1 30); do
    if [ "$(tls_curl -o /dev/null -w '%{http_code}' --max-time 5 "$tls_url/wp-includes/images/blank.gif" 2>/dev/null || true)" = "200" ]; then
      cmd_tls_env
      return 0
    fi
    sleep 1
  done
  echo "The TLS front did not answer on $tls_url (127.0.0.1:$WOO_SANDBOX_TLS_PORT)." >&2
  return 1
}

cmd_down() {
  compose --profile tools --profile tls down --volumes --remove-orphans
  rm -f "$credentials"
  rm -rf "$WOO_SANDBOX_TLS_DIR"
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
  tls       Opt-in: put nginx with a throwaway certificate in front of the shop ($tls_url), print how to reach it.
  tls-env   Print the environment a local Hanza worker needs to reach the TLS front.
  tls-curl ...  curl through the TLS front, e.g. sandbox.sh tls-curl -i $tls_url/wp-json/

Environment: WOO_SANDBOX_PROJECT (default $default_project), WOO_SANDBOX_PORT (default 8089),
WOO_SANDBOX_TLS_PORT (default 8443, only used once "tls" has run).
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
  status) compose --profile tls ps ;;
  tls) cmd_tls ;;
  tls-env) cmd_tls_env ;;
  tls-curl) shift; tls_curl "$@" ;;
  *) usage; [ -n "${1:-}" ] && [ "${1:-}" != "help" ] && exit 1 || exit 0 ;;
esac
