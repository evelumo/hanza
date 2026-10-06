import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

// Only pure helpers are tested here; the panel's end-to-end flows live in apps/e2e.
export default defineConfig({
  resolve: { alias: { '@': join(import.meta.dirname, 'src') } },
  test: { include: ['src/**/*.test.ts'] },
})
