#!/bin/sh
# Runs in the medusa container: migrations (Medusa's and the plugin's), the admin user, then the server.
set -e
cd /app
npx medusa db:migrate
# Fails when the user exists already, which is fine on a restart.
npx medusa user -e "$MEDUSA_SANDBOX_ADMIN_EMAIL" -p "$MEDUSA_SANDBOX_ADMIN_PASSWORD" >/dev/null 2>&1 || echo "The sandbox admin exists already."
exec npx medusa develop
