import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '../../tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: { baseURL: 'http://127.0.0.1:5174', trace: 'retain-on-failure', screenshot: 'only-on-failure', channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' },
  projects: [
    { name: 'desktop', testMatch: ['**/auth.spec.ts', '**/workflow.spec.ts', '**/contacts.spec.ts', '**/history.spec.ts'], use: { ...devices['Desktop Chrome'] } },
    { name: 'narrow', testMatch: ['**/auth.spec.ts', '**/workflow.spec.ts', '**/contacts.spec.ts', '**/history.spec.ts'], use: { viewport: { width: 390, height: 844 }, isMobile: false } },
    { name: 'http-sse', testMatch: '**/reconnect.spec.ts', use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:5175' } },
  ],
  webServer: [{
    command: 'CALLMATE_DATA_DIR=/tmp/callmate-contacts-e2e NODE_ENV=test TELEPHONY_PROVIDER=fake CALLMATE_LOG_LEVEL=silent node ../server/dist/main.js',
    url: 'http://127.0.0.1:3000/health',
    reuseExistingServer: false,
    timeout: 30_000,
  }, {
    command: 'VITE_MOCK=true npm run dev -- --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
    timeout: 30_000,
  }, {
    command: 'VITE_MOCK=false npm run dev -- --port 5175 --strictPort',
    url: 'http://127.0.0.1:5175', reuseExistingServer: false, timeout: 30_000,
  }],
});
