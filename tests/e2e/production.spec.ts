import { expect, test } from './fixtures';

test('Zeus Llama serves the built UI, assets and authenticated API from one origin', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  const scripts: string[] = [];
  page.on('request', request => { if (request.resourceType() === 'script') scripts.push(request.url()); });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
  expect(scripts.some(url => new URL(url).origin === new URL(page.url()).origin && /^\/assets\/index-.*\.js$/.test(new URL(url).pathname))).toBe(true);
  expect(scripts.every(url => !url.includes('/@vite/') && !url.includes('/src/'))).toBe(true);
  expect((await page.request.get('/api/v1/history')).ok()).toBe(true);
  await page.getByRole('button', { name: 'Agreements', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Agreements', exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('zeus-llama-built-ui.png'), fullPage: true });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});

test('the technical console shares the app session and logout on the same port', async ({ page }) => {
  await page.goto('/console/');
  await expect(page.getByRole('button', { name: 'Start conversation', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  expect((await page.request.get('/api/v1/history')).status()).toBe(401);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Home', exact: true })).toHaveCount(0);
});
