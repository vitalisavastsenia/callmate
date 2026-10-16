import { test as base, expect } from '@playwright/test';
import type { Cookie } from '@playwright/test';
export { expect };
export type { Page } from '@playwright/test';

// A real isolated SQLite backend serves contacts even when calls use the browser simulator.
let ownerCookies: Cookie[] | undefined;
const apiOrigin = process.env.CALLMATE_E2E_APP_URL || 'http://127.0.0.1:3000';
export const test = base.extend<{ contactIsolation: void }>({
  contactIsolation: [async ({ context }, use) => {
    const request = context.request;
    if (ownerCookies) await context.addCookies(ownerCookies);
    const state = await (await request.get(apiOrigin + '/api/auth/session')).json();
    if (!state.authenticated) {
      const login = await request.post(`${apiOrigin}/api/auth/${state.setupRequired ? 'setup' : 'login'}`, {
        data: { username: 'e2e-owner', password: 'isolated-browser-tests-only-password' },
      });
      expect(login.ok()).toBe(true);
      ownerCookies = (await request.storageState()).cookies;
    }
    const response = await request.get(apiOrigin + '/api/v1/contacts');
    expect(response.ok()).toBe(true);
    const { items } = await response.json();
    for (const contact of items) {
      expect((await request.delete(`${apiOrigin}/api/v1/contacts/${contact.id}`)).ok()).toBe(true);
    }
    await use();
  }, { auto: true }],
});
