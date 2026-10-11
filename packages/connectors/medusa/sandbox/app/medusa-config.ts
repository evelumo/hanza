import { defineConfig, loadEnv } from "@medusajs/framework/utils"

loadEnv(process.env.NODE_ENV || "development", process.cwd())

// The sandbox store: Medusa 2.21.2 with medusa-plugin-hanza, Redis for events and workflows (the plugin's subscribers
// run on the event bus, as on a store in production). Every value comes from docker-compose.yml.
module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    databaseDriverOptions: { ssl: false, sslmode: "disable" },
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET!,
      cookieSecret: process.env.COOKIE_SECRET!,
    },
  },
  admin: {
    disable: process.env.MEDUSA_DISABLE_ADMIN === "true",
  },
  plugins: [{ resolve: "medusa-plugin-hanza", options: {} }],
  modules: [
    {
      resolve: "@medusajs/medusa/event-bus-redis",
      options: { redisUrl: process.env.REDIS_URL },
    },
    {
      resolve: "@medusajs/medusa/workflow-engine-redis",
      options: { redis: { redisUrl: process.env.REDIS_URL } },
    },
  ],
})
