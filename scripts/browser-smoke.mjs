import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const invocationScript = await readFile(new URL('../public/invocations.js', import.meta.url), 'utf8');
const settingsScript = await readFile(new URL('../public/settings.js', import.meta.url), 'utf8');
const icons = await readFile(new URL('../node_modules/lucide/dist/umd/lucide.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
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
  await context.addCookies([{ name: 'codex_console', value: 'browser-smoke-session', url: 'http://127.0.0.1:8787/' }]);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const requests = [], submissions = [];
  const taskId = 'task_00000000-0000-4000-8000-000000000001';
  const sessionId = 'sess_00000000-0000-4000-8000-000000000001';
  let logsEnabled = true, logsFail = false, scriptFail = false, accountFail = false;
  let settingsRevision = 0;
  const baseSettings = { maxConcurrent: 3, maxQueued: 100, timeoutSeconds: 600, queueTimeoutSeconds: 1800,
    defaultModel: null, defaultReasoningEffort: null, invocationLog: { enabled: true, retentionDays: 30 } };
  let liveSettings = structuredClone(baseSettings);
  const logDetail = { taskId, sessionId, transport: 'mcp', question: '<script>window.__injected = true</script> 日志测试', context: { account: 'demo-user' }, status: 'succeeded', receivedAt: '2026-09-24T06:00:00.000Z', startedAt: '2026-09-24T06:00:01.000Z', finishedAt: '2026-09-24T06:00:03.000Z', durationMs: 2000, usage: { input_tokens: 100, output_tokens: 20 }, resultMarkdown: '<img src=x onerror=alert(1)> 完整回答', error: null };
  await context.route('**/*', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push(request.method() + ' ' + path);
    if (path === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    if (path === '/assets/lucide.js') return route.fulfill({ contentType: 'application/javascript', body: icons });
    if (path === '/assets/invocations.js') return scriptFail
      ? route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED' } } })
      : route.fulfill({ contentType: 'application/javascript', body: invocationScript });
    if (path === '/assets/settings.js') return route.fulfill({ contentType: 'application/javascript', body: settingsScript });
    if (path === '/console/session') return route.fulfill({ json: { username: 'admin' } });
    if (!request.headers().cookie?.includes('codex_console=browser-smoke-session')) {
      errors.push('Missing fixture console session: ' + path);
      return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED' } } });
    }
    if (path === '/v1/admin/account' && request.method() === 'GET') {
      if (accountFail) return route.fulfill({ status: 503, json: { error: { message: '账号查询暂不可用' } } });
      return route.fulfill({ json: account });
    }
    if (path === '/v1/admin/account/refresh' && request.method() === 'POST') {
      return route.fulfill({ json: { ...account, quota: { ...account.quota, primary: { ...account.quota.primary, remainingPercent: 62, usedPercent: 38 } } } });
    }
    if (path === '/v1/info') return route.fulfill({ json: { runner: 'codex', defaultWorkingDirectory: 'D:/workspace/default' } });
    if (path === '/v1/health') return route.fulfill({ json: { ready: true, running: 0, queued: 0 } });
    if (path === '/console/settings') {
      if (request.method() === 'PUT') {
        const body = request.postDataJSON();
        assert.equal(body.revision, settingsRevision);
        liveSettings = body.settings;
        settingsRevision++;
      }
      return route.fulfill({ json: { revision: settingsRevision, settings: liveSettings, defaults: baseSettings,
        updatedAt: settingsRevision ? '2026-09-28T09:00:00.000Z' : null,
        updatedBy: settingsRevision ? 'admin' : null, logging: { healthy: true } } });
    }
    if (path.startsWith('/v1/admin/invocations')) {
      if (logsFail) return route.fulfill({ status: 503, json: { error: { message: '日志请求失败' } } });
      const query = new URL(request.url()).searchParams;
      const count = !logsEnabled || query.get('keyword') === 'nothing' ? 0 : 21;
      if (path.endsWith('/summary')) return route.fulfill({ json: { enabled: logsEnabled, healthy: true, total: count, failed: 0, succeeded: count, successRate: count ? 100 : null, averageDurationMs: count ? 2000 : null, totalTokens: count * 120, usageKnownTasks: count } });
      if (path === '/v1/admin/invocations') {
        const offset = Number(query.get('offset') || 0);
        return route.fulfill({ json: { enabled: logsEnabled, healthy: true, total: count, offset, limit: 20, items: Array.from({ length: Math.max(0, Math.min(20, count - offset)) }, () => ({ ...logDetail, questionPreview: logDetail.question, resultPreview: '结果摘要', totalTokens: 120 })) } });
      }
      return route.fulfill({ json: logDetail });
    }
    if (path === '/v1/sessions') return route.fulfill({ json: { items: [], total: 0 } });
    if (path === '/v1/sessions/' + sessionId) return route.fulfill({ json: { sessionId, workingDirectory: '/workspace/example', tasks: { items: [{ taskId, status: 'succeeded', question: submissions[0]?.question, createdAt: '2026-09-24T06:00:00.000Z' }], total: 1 } } });
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
  await expect(page.getByLabel('认证来源')).toHaveValue('控制台登录会话');
  await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeEnabled();
  await expect(page.getByLabel('问题内容')).toBeVisible();
  const submit = page.getByRole('button', { name: '提交任务', exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.locator('#task-message')).toHaveText('请先填写问题内容。');
  assert.equal(submissions.length, 0);
  await expect(page.getByLabel('执行权限')).toHaveValue('danger-full-access');
  await page.getByLabel('执行权限').selectOption('read-only');
  await page.getByLabel('问题内容').fill('分析这个测试问题');
  await page.getByLabel('附加上下文 JSON').fill('{"source":"browser-smoke"}');
  await submit.click();
  await expect(page.locator('#turns .task-status')).toHaveText('已完成');
  await expect(page.locator('#turns .turn-answer')).toHaveText('模拟 Codex 分析结果');
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].question, '分析这个测试问题');
  assert.deepEqual(submissions[0].context, { source: 'browser-smoke' });
  assert.equal(submissions[0].sandboxMode, 'read-only');
  await checkLayout(page);
  await page.getByRole('button', { name: '调用日志', exact: true }).click();
  await expect(page.locator('#logs-total')).toHaveText('21');
  await expect(page.locator('#logs-rows tr')).toHaveCount(20);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('#logs-rows tr')).toHaveCount(1);
  await page.getByRole('button', { name: '查看调用详情', exact: true }).click();
  await expect(page.locator('#logs-detail')).toBeVisible();
  await expect(page.locator('#logs-detail-question')).toHaveText(logDetail.question);
  await expect(page.locator('#logs-detail-result')).toHaveText(logDetail.resultMarkdown);
  assert.equal(await page.locator('#logs-detail script, #logs-detail img').count(), 0);
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.getByLabel('提示词关键字').fill('nothing');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect(page.locator('#logs-empty')).toHaveText('暂无符合条件的调用记录');
  await page.getByRole('button', { name: '重置筛选', exact: true }).click();
  await expect(page.locator('#logs-total')).toHaveText('21');
  await checkLayout(page);
  await page.getByRole('button', { name: '运行配置', exact: true }).click();
  await expect(page.getByLabel('并发任务数')).toHaveValue('3');
  await expect(page.locator('#settings-save')).toBeDisabled();
  await page.getByLabel('并发任务数').fill('4');
  await expect(page.locator('#settings-save')).toBeEnabled();
  await page.locator('#settings-save').click();
  await expect(page.locator('#settings-feedback')).toHaveText('已保存并应用。');
  assert.equal(liveSettings.maxConcurrent, 4);
  await page.locator('#settings-defaults').click();
  await expect(page.getByLabel('并发任务数')).toHaveValue('3');
  await page.locator('#settings-cancel').click();
  await expect(page.getByLabel('并发任务数')).toHaveValue('4');
  await checkLayout(page);
  logsEnabled = false;
  await page.getByRole('button', { name: '调用日志', exact: true }).click();
  await page.getByRole('button', { name: '刷新日志', exact: true }).click();
  await expect(page.locator('#logs-empty')).toHaveText('调用日志未启用');
  logsFail = true;
  await page.getByRole('button', { name: '刷新日志', exact: true }).click();
  await expect(page.locator('#logs-message')).toHaveText('日志请求失败');
  await page.getByRole('button', { name: '账号额度', exact: true }).click();
  await expect(page.locator('#remaining')).toHaveText('62% 剩余');
  await checkLayout(page);
  assert.ok(requests.includes('POST /v1/tasks'));
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  scriptFail = true;
  await page.reload();
  await expect(page.locator('#account')).toHaveText('o******r@example.com');
  await page.getByRole('button', { name: '调用日志', exact: true }).click();
  await expect(page.locator('#logs-message')).toContainText('日志面板加载失败');
  await page.getByRole('button', { name: 'Codex 调用', exact: true }).click();
  await expect(submit).toBeEnabled();
  accountFail = true;
  await page.reload();
  await expect(page.locator('#account')).toHaveText('账号状态暂不可用');
  await expect(page.locator('#account-message')).toHaveText('账号查询暂不可用');
  await expect(page.locator('#refresh-account')).toBeEnabled();
  await context.close();
  assert.deepEqual(errors, []);
  console.log('Browser smoke passed: account, task, logs, live settings, and desktop/mobile layouts. No real tasks submitted.');
} finally {
  await browser.close();
}
