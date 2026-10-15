import { test as base, expect } from '@playwright/test';
export { expect };
export type { Page } from '@playwright/test';

// A real isolated SQLite backend serves contacts even when calls use the browser simulator.
export const test = base.extend<{ contactIsolation: void }>({
  contactIsolation: [async ({ request }, use) => {
    const response = await request.get('http://127.0.0.1:3000/api/v1/contacts');
    expect(response.ok()).toBe(true);
    const { items } = await response.json();
    for (const contact of items) {
      expect((await request.delete(`http://127.0.0.1:3000/api/v1/contacts/${contact.id}`)).ok()).toBe(true);
    }
    await use();
  }, { auto: true }],
});
