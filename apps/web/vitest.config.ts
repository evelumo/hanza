import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

// Only pure helpers are tested here; panel end-to-end tests are planned.
export default defineConfig({
  resolve: { alias: { '@': join(import.meta.dirname, 'src') } },
  test: { include: ['src/**/*.test.ts'] },
})
