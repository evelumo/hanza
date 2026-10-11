#!/usr/bin/env bash
# The recording sandbox of the Medusa connector: a throwaway Medusa store with medusa-plugin-hanza in Docker. See README.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project="${MEDUSA_SANDBOX_PROJECT:-hanza-medusa-sandbox}"
export MEDUSA_SANDBOX_PORT="${MEDUSA_SANDBOX_PORT:-9100}"
export MEDUSA_SANDBOX_POSTGRES_PORT="${MEDUSA_SANDBOX_POSTGRES_PORT:-5443}"
export MEDUSA_SANDBOX_REDIS_PORT="${MEDUSA_SANDBOX_REDIS_PORT:-6390}"
origin="http://127.0.0.1:${MEDUSA_SANDBOX_PORT}"

# The name the store has behind the opt-in TLS front (`tls`): the one the recordings are rewritten to as well
# (`../src/testing/recording.ts`), so a cassette and a live run name the same store.
store_url="https://medusa.example.test"
# The front's certificate and access log, per instance like the keys file. A path without "..", because Docker mounts it.
export MEDUSA_SANDBOX_TLS_PORT="${MEDUSA_SANDBOX_TLS_PORT:-9443}"
if [ "$project" = "hanza-medusa-sandbox" ]; then
  export MEDUSA_SANDBOX_TLS_DIR="$(dirname "$here")/.recording/tls"
else
  export MEDUSA_SANDBOX_TLS_DIR="$(dirname "$here")/.recording/tls.$project"
fi
tls_host="${store_url#https://}"
if [ "$MEDUSA_SANDBOX_TLS_PORT" = "443" ]; then tls_url="$store_url"; else tls_url="$store_url:$MEDUSA_SANDBOX_TLS_PORT"; fi

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

# Prunes the whole journal, then touches the newest order (an `order.updated` entry) so the journal has one entry
# to start from: a position before the prune answers 410 `journal_expired`, which the conformance kit's C18 records.
cmd_prune() {
  compose exec -T medusa npx medusa exec ./src/scripts/prune.ts
  local newest
  newest="$(cmd_curl 'orders?order=-created_at&limit=1&fields=id' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).orders[0]?.id ?? ""))')"
  if [ -z "$newest" ]; then echo "No order to touch: seed first." >&2; return 1; fi
  cmd_curl "orders/$newest" -X POST -H 'Content-Type: application/json' -d '{"metadata":{"hanza_sandbox_touch":"1"}}' >/dev/null
  echo "Journal pruned; order $newest touched. Wait 10 s before recording (the journal's hold-back)."
}

cmd_key() {
  mkdir -p "$recording_dir"
  node "$here/tools/key.mjs" "$origin" "$credentials" "$admin_email" "$admin_password"
}

# A throwaway certificate authority and a certificate for the store's host name, with openssl only. The authority may
# sign for that name alone and its key is deleted once it has, so trusting it (NODE_EXTRA_CA_CERTS) trusts nothing but
# this sandbox.
make_certificate() {
  local cert_dir="$MEDUSA_SANDBOX_TLS_DIR/cert" work
  if [ -f "$cert_dir/server.crt" ] && [ -f "$cert_dir/server.key" ] && [ -f "$MEDUSA_SANDBOX_TLS_DIR/ca.crt" ]; then return 0; fi
  command -v openssl >/dev/null || { echo "openssl is needed for the TLS front." >&2; return 1; }
  mkdir -p "$cert_dir"
  work="$(mktemp -d)"
  cat > "$work/ca.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = Hanza Medusa sandbox ($project), local and throwaway
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
subjectAltName = DNS:$tls_host
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
  cp "$work/ca.crt" "$MEDUSA_SANDBOX_TLS_DIR/ca.crt"
  rm -rf "$work"
}

# curl through the TLS front: the store's host name sent to this machine, trusting the sandbox's authority only.
tls_curl() {
  if [ ! -f "$MEDUSA_SANDBOX_TLS_DIR/ca.crt" ]; then echo "No TLS front yet: run sandbox.sh tls" >&2; return 1; fi
  curl -sS --cacert "$MEDUSA_SANDBOX_TLS_DIR/ca.crt" --resolve "$tls_host:$MEDUSA_SANDBOX_TLS_PORT:127.0.0.1" "$@"
}

# What a locally running Hanza worker needs to reach the front (README.md, "A TLS front"), as shell to `eval`.
cmd_tls_env() {
  if [ ! -f "$MEDUSA_SANDBOX_TLS_DIR/ca.crt" ]; then echo "No TLS front yet: run sandbox.sh tls" >&2; return 1; fi
  echo "# TLS front of sandbox \"$project\" on 127.0.0.1:$MEDUSA_SANDBOX_TLS_PORT. Store address for the Connection: $tls_url"
  echo "# Access log: $MEDUSA_SANDBOX_TLS_DIR/log/access.log"
  printf 'export NODE_EXTRA_CA_CERTS=%q\n' "$MEDUSA_SANDBOX_TLS_DIR/ca.crt"
  printf 'export MEDUSA_SANDBOX_RESOLVE=%q\n' "$tls_host"
  printf 'export NODE_OPTIONS=%q\n' "--import=$here/resolve-store.mjs"
}

cmd_tls() {
  if [ -z "$(compose ps -q medusa 2>/dev/null)" ]; then
    echo "The store is not up: run sandbox.sh up (or reset) first." >&2
    return 1
  fi
  make_certificate
  mkdir -p "$MEDUSA_SANDBOX_TLS_DIR/log"
  # --no-deps: the store is not recreated here, so `up` with MEDUSA_SANDBOX_DISABLE_ADMIN=false keeps its admin.
  compose --profile tls up -d --no-deps tls
  for _ in $(seq 1 30); do
    if [ "$(tls_curl -o /dev/null -w '%{http_code}' --max-time 5 "$tls_url/health" 2>/dev/null || true)" = "200" ]; then
      cmd_tls_env
      return 0
    fi
    sleep 1
  done
  echo "The TLS front did not answer on $tls_url (127.0.0.1:$MEDUSA_SANDBOX_TLS_PORT)." >&2
  return 1
}

cmd_down() {
  compose --profile tls down --volumes --remove-orphans
  rm -f "$credentials"
  rm -rf "$MEDUSA_SANDBOX_TLS_DIR"
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
  prune       Prune the whole journal and touch the newest order: what check C18 of the conformance kit needs (README).
  reset       down, up, seed and key: a fresh, seeded store.
  down        Remove the containers, the volumes and the keys file.
  curl ...    curl against the Admin API with the secret key, e.g. sandbox.sh curl 'hanza/status'
  status      Show the containers.
  exec ...    Run a command in the medusa container, e.g. sandbox.sh exec npx medusa db:migrate
  tls         Opt-in: put nginx with a throwaway certificate in front of the store ($tls_url), print how to reach it.
  tls-env     Print the environment a local Hanza worker needs to reach the TLS front.
  tls-curl ...  curl through the TLS front, e.g. sandbox.sh tls-curl -i $tls_url/health

Environment: MEDUSA_SANDBOX_PROJECT (default hanza-medusa-sandbox), MEDUSA_SANDBOX_PORT (9100),
MEDUSA_SANDBOX_POSTGRES_PORT (5443), MEDUSA_SANDBOX_REDIS_PORT (6390), MEDUSA_SANDBOX_DISABLE_ADMIN (true),
MEDUSA_SANDBOX_TLS_PORT (9443, only used once "tls" has run).
USAGE
}

case "${1:-}" in
  pack) shift; cmd_pack "$@" ;;
  up) cmd_up ;;
  seed) cmd_seed ;;
  key) cmd_key ;;
  prune) cmd_prune ;;
  reset) cmd_down; cmd_up; cmd_seed; cmd_key ;;
  down) cmd_down ;;
  curl) shift; cmd_curl "$@" ;;
  status) compose --profile tls ps ;;
  exec) shift; compose exec medusa "$@" ;;
  tls) cmd_tls ;;
  tls-env) cmd_tls_env ;;
  tls-curl) shift; tls_curl "$@" ;;
  *) usage; [ -n "${1:-}" ] && [ "${1:-}" != "help" ] && exit 1 || exit 0 ;;
esac
