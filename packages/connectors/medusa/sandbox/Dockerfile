# The sandbox's Medusa: the app in app/ with the plugin from the tarball `sandbox.sh pack` put in plugin/.
FROM node:22-alpine

WORKDIR /app

COPY app/package.json ./
COPY plugin/ ./plugin/
RUN set -e; \
    if ! ls plugin/medusa-plugin-hanza-*.tgz >/dev/null 2>&1; then \
      echo "No plugin/medusa-plugin-hanza-*.tgz: run sandbox.sh pack first (see README.md)." >&2; exit 1; \
    fi; \
    npm install --no-audit --no-fund; \
    npm install --no-audit --no-fund --no-save ./plugin/medusa-plugin-hanza-*.tgz

COPY app/ ./
COPY start.sh /usr/local/bin/start-sandbox
RUN chmod +x /usr/local/bin/start-sandbox

EXPOSE 9000
CMD ["start-sandbox"]
