import { defineConfig } from 'vitest/config'

// Unit tests of the runner only; the browser flows (`flows/*.spec.ts`) run through `pnpm test:e2e`.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
})
