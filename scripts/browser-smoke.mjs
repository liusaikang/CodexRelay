import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const icons = await readFile(new URL('../node_modules/lucide/dist/umd/lucide.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
const errors = [];
const account = {
  available: true,
  authenticated: true,
  method: 'chatgpt',
  email: 'o******r@example.com',
  plan: 'pro',
  checkedAt: '2026-09-24T06:00:00.000Z',
  quota: {
    ordinaryUsageAllowed: true,
    primary: { usedPercent: 37, remainingPercent: 63, windowDurationMins: 10080, resetsAt: '2026-09-29T23:24:23.000Z' },
    secondary: { usedPercent: 12, remainingPercent: 88, windowDurationMins: 300, resetsAt: '2026-09-24T08:00:00.000Z' },
  },
  credits: { hasCredits: false, unlimited: false, balance: '0', availableResetCount: 2 },
};

async function checkLayout(page) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.ok((await page.screenshot({ fullPage: true })).length > 1000);
  }
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const requests = [], submissions = [];
  const taskId = 'task_00000000-0000-4000-8000-000000000001';
  const sessionId = 'sess_00000000-0000-4000-8000-000000000001';
  await context.route('**/*', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push(request.method() + ' ' + path);
    if (path === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    if (path === '/assets/lucide.js') return route.fulfill({ contentType: 'application/javascript', body: icons });
    if (path === '/console/session') return route.fulfill({ json: { token: 'browser-smoke-fixture-token-only' } });
    if (request.headers().authorization !== 'Bearer browser-smoke-fixture-token-only') {
      errors.push('Missing fixture authorization: ' + path);
      return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED' } } });
    }
    if (path === '/v1/admin/account' && request.method() === 'GET') {
      return route.fulfill({ json: account });
    }
    if (path === '/v1/admin/account/refresh' && request.method() === 'POST') {
      return route.fulfill({ json: { ...account, quota: { ...account.quota, primary: { ...account.quota.primary, remainingPercent: 62, usedPercent: 38 } } } });
    }
    if (path === '/v1/info') return route.fulfill({ json: { runner: 'codex', defaultWorkingDirectory: 'D:/workspace/default' } });
    if (path === '/v1/sessions') return route.fulfill({ json: { items: [], total: 0 } });
    if (path === '/v1/tasks' && request.method() === 'POST') {
      const body = request.postDataJSON();
      submissions.push(body);
      return route.fulfill({ json: { taskId, sessionId, request: body, status: 'queued', createdAt: '2026-09-24T06:00:00.000Z', progress: [] } });
    }
    if (path === '/v1/tasks/' + taskId && request.method() === 'GET') {
      return route.fulfill({ json: { taskId, sessionId, request: submissions[0], status: 'succeeded', createdAt: '2026-09-24T06:00:00.000Z', startedAt: '2026-09-24T06:00:01.000Z', finishedAt: '2026-09-24T06:00:02.000Z', progress: [], result: { markdown: '模拟 Codex 分析结果', usage: { input_tokens: 100, output_tokens: 20 } } } });
    }
    errors.push('Unexpected fixture request: ' + request.method() + ' ' + path);
    return route.abort();
  });

  await page.goto('http://127.0.0.1:8787/');
  await expect(page.locator('#service-label')).toHaveText('已连接');
  await expect(page.locator('#account')).toHaveText('o******r@example.com');
  await expect(page.locator('#plan')).toHaveText('pro');
  await expect(page.locator('#remaining')).toHaveText('63% 剩余');
  await expect(page.locator('#secondary-remaining')).toHaveText('88% 剩余');
  await expect(page.locator('#reset-credits')).toHaveText('2 次');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.locator('#remaining')).toHaveText('62% 剩余');
  await page.getByRole('button', { name: 'Codex 调用', exact: true }).click();
  await expect(page.getByLabel('服务地址')).toHaveValue('http://127.0.0.1:8787');
  await expect(page.getByLabel('认证来源')).toHaveValue('由服务环境变量 CODEX_MCP_TOKEN 自动提供');
  await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeEnabled();
  await expect(page.getByLabel('问题内容')).toBeVisible();
  const submit = page.getByRole('button', { name: '提交任务', exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.locator('#task-message')).toHaveText('请先填写问题内容。');
  assert.equal(submissions.length, 0);
  await page.getByLabel('问题内容').fill('分析这个测试问题');
  await page.getByLabel('附加上下文 JSON').fill('{"source":"browser-smoke"}');
  await submit.click();
  await expect(page.locator('#task-status')).toHaveText('已完成');
  await expect(page.locator('#result')).toHaveText('模拟 Codex 分析结果');
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].question, '分析这个测试问题');
  assert.deepEqual(submissions[0].context, { source: 'browser-smoke' });
  await checkLayout(page);
  await page.getByRole('button', { name: '账号额度', exact: true }).click();
  await expect(page.locator('#remaining')).toHaveText('62% 剩余');
  await checkLayout(page);
  assert.ok(requests.includes('POST /v1/tasks'));
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  await context.close();
  assert.deepEqual(errors, []);
  console.log('Browser smoke passed: top navigation, account quota, intercepted Codex submit/result flow, and desktop/mobile layouts. No real tasks submitted.');
} finally {
  await browser.close();
}
