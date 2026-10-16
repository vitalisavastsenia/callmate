import { test as base, expect } from '@playwright/test';
import type { Cookie } from '@playwright/test';
export { expect };
export type { Page } from '@playwright/test';

// A real isolated SQLite backend serves contacts even when calls use the browser simulator.
let ownerCookies: Cookie[] | undefined;
export const test = base.extend<{ contactIsolation: void }>({
  contactIsolation: [async ({ context }, use) => {
    const request = context.request;
    if (ownerCookies) await context.addCookies(ownerCookies);
    const state = await (await request.get('http://127.0.0.1:3000/api/auth/session')).json();
    if (!state.authenticated) {
      const login = await request.post(`http://127.0.0.1:3000/api/auth/${state.setupRequired ? 'setup' : 'login'}`, {
        data: { username: 'e2e-owner', password: 'isolated-browser-tests-only-password' },
      });
      expect(login.ok()).toBe(true);
      ownerCookies = (await request.storageState()).cookies;
    }
    const response = await request.get('http://127.0.0.1:3000/api/v1/contacts');
    expect(response.ok()).toBe(true);
    const { items } = await response.json();
    for (const contact of items) {
      expect((await request.delete(`http://127.0.0.1:3000/api/v1/contacts/${contact.id}`)).ok()).toBe(true);
    }
    await use();
  }, { auto: true }],
});
