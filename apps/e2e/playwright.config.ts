import { defineConfig, devices } from '@playwright/test'
import { readRunEnv } from './src/run-env'

export default defineConfig({
  testDir: './flows',
  // The fake Channel is one in-memory instance in the worker, shared by every flow.
  workers: 1,
  fullyParallel: false,
  // A flaky flow must fail, not pass on a second try.
  retries: 0,
  forbidOnly: true,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: readRunEnv('baseUrl'),
    locale: 'en-GB',
    timezoneId: 'Europe/Warsaw',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
