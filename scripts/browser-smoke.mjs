import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const icons = await readFile(new URL('../node_modules/lucide/dist/umd/lucide.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
const errors = [];
const id = (prefix, n) => `${prefix}_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const createdAt = '2026-09-22T01:00:00.000Z';

async function checkLayout(page) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.ok((await page.screenshot({ fullPage: true })).length > 1000);
  }
}

async function connect(page) {
  await page.getByRole('button', { name: '连接服务', exact: true }).click();
  await expect(page.locator('#connection-label')).toHaveText('已连接');
  await expect(page.getByLabel('访问令牌')).toHaveValue('由服务环境变量 CODEX_MCP_TOKEN 自动提供');
  assert.equal(await page.locator('#project, #capability').count(), 0);
}

try {
  // An explicitly supplied live service is checked with GET requests only.
  if (process.env.CODEX_MCP_URL) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      if (route.request().method() !== 'GET') {
        errors.push('Unexpected live write: ' + route.request().url());
        await route.abort();
      } else await route.continue();
    });
    await page.goto(process.env.CODEX_MCP_URL);
    await connect(page);
    await expect(page.getByLabel('附加上下文 JSON')).toBeEnabled();
    assert.equal(await page.locator('#working-directory, #model, #reasoning').count(), 0);
    await checkLayout(page);
    await context.close();
  }

  // All task submissions are intercepted fixtures; no task reaches a real service.
  for (const runner of ['codex']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const info = { defaultWorkingDirectory: 'D:/workspace/default', maxConcurrent: 2, maxQueued: 8,
      accessMode: 'danger-full-access', readOnly: false, networkAccess: true, webSearch: 'live', runner };
    const resolvedDefaults = { workingDirectory: 'D:/workspace/resolved-default', model: info.defaultModel || 'resolved-model', modelReasoningEffort: info.defaultReasoningEffort || 'medium' };
    const sessions = [
      { sessionId: id('sess', 1), workingDirectory: 'D:/workspace/first', model: 'first-model', modelReasoningEffort: 'medium', createdAt },
      { sessionId: id('sess', 2), workingDirectory: '/workspace/second', model: 'second-model', modelReasoningEffort: 'low', createdAt },
      { sessionId: id('sess', 3), projectKey: 'old-project', capability: 'old-capability', createdAt },
      { sessionId: id('sess', 4), createdAt },
    ];
    const tasks = new Map(), submissions = [], requests = [];
    const makeTask = (n, sessionId, request, markdown) => ({
      taskId: id('task', n), sessionId, request, status: 'succeeded', createdAt,
      startedAt: createdAt, finishedAt: createdAt, progress: [], result: { markdown, usage: null },
    });
    const legacyTask = makeTask(3, id('sess', 3), { question: '历史问题', projectKey: 'old-project', capability: 'old-capability' }, '旧版历史结果');
    tasks.set(legacyTask.taskId, legacyTask);
    const firstTask = makeTask(1, id('sess', 1), { question: '历史目录', workingDirectory: 'D:/workspace/first' }, '目录历史结果');
    tasks.set(firstTask.taskId, firstTask);
    let sequence = 10;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      requests.push(request.method() + ' ' + path);
      const json = body => route.fulfill({ json: body });
      if (path === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      if (path === '/assets/lucide.js') return route.fulfill({ contentType: 'application/javascript', body: icons });
      if (path === '/console/session') return json({ token: 'browser-smoke-fixture-token-only' });
      if (request.headers().authorization !== 'Bearer browser-smoke-fixture-token-only') {
        errors.push('Missing fixture authorization: ' + path);
        return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED' } } });
      }
      if (path === '/v1/info') return json(info);
      if (path === '/v1/health') return json({ ready: true, running: 0, queued: 0, runner });
      if (path === '/v1/sessions') {
        const offset = Number(url.searchParams.get('offset') || 0);
        return json({ items: sessions.slice(offset, offset + 6), total: sessions.length });
      }
      if (path.startsWith('/v1/sessions/')) {
        const session = sessions.find(item => item.sessionId === path.split('/').at(-1));
        if (!session) return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } });
        const items = [...tasks.values()].filter(task => task.sessionId === session.sessionId);
        const offset = Number(url.searchParams.get('offset') || 0);
        return json({ ...session, tasks: { total: items.length, items: items.slice(offset, offset + 1) } });
      }
      if (path === '/v1/tasks' && request.method() === 'POST') {
        const body = request.postDataJSON();
        submissions.push(body);
        const n = sequence++;
        let session = sessions.find(item => item.sessionId === body.sessionId);
        if (!session) {
          session = { sessionId: id('sess', n), ...resolvedDefaults, createdAt };
          sessions.unshift(session);
        }
        const task = makeTask(n, session.sessionId, body, '拦截测试结果 · 未调用 Codex ' + n);
        tasks.set(task.taskId, task);
        return json({ ...task, status: 'queued', result: undefined, finishedAt: undefined });
      }
      if (path.startsWith('/v1/tasks/') && request.method() === 'GET') {
        const task = tasks.get(path.split('/').at(-1));
        if (task) return json(task);
      }
      errors.push('Unexpected fixture request: ' + request.method() + ' ' + path);
      return route.abort();
    });
    await page.goto('http://127.0.0.1:8787/');
    await connect(page);
    assert.equal(await page.locator('#working-directory, #model, #reasoning').count(), 0);
    assert.equal(await page.locator('input[name=stage], #stage-help, #mode').count(), 0);
    assert.equal(await page.getByText('演示阶段', { exact: true }).count(), 0);
    await expect(page.getByLabel('附加上下文 JSON')).toHaveValue('');
    await expect(page.getByLabel('问题内容')).toHaveValue('');
    await expect(page.getByLabel('问题内容')).toHaveAttribute('placeholder', '请描述需要 Codex 分析或处理的问题。');

    const submit = page.getByRole('button', { name: '提交任务', exact: true });
    await page.getByLabel('问题内容').fill(' \n\t  ');
    await expect(submit).toBeDisabled();
    await page.locator('#task-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(submissions.length, 0);
    const rawQuestion = '  \n$log-evidence 浏览器拦截测试\n\t保留缩进及末尾空白  \n';
    await page.getByLabel('问题内容').fill(rawQuestion);
    const platformContext = { subject: { account: 'demo-user', tenantId: 'tenant-demo-001' }, request: { module: 'orders' } };
    await page.getByLabel('附加上下文 JSON').fill(JSON.stringify(platformContext));
    await submit.click();
    await expect(page.locator('#task-status')).toHaveText('已完成');
    await expect(submit).toBeEnabled();
    assert.deepEqual(Object.keys(submissions[0]).sort(), ['context', 'idempotencyKey', 'question']);
    assert.equal(submissions[0].question, rawQuestion);
    assert.deepEqual(submissions[0].context, platformContext);
    const newId = await page.locator('#session').inputValue();
    assert.ok(requests.includes('GET /v1/sessions/' + newId));
    await expect(page.locator('#active-directory')).toHaveText(resolvedDefaults.workingDirectory);
    assert.equal(JSON.parse(await page.locator('#request-json').textContent()).question, rawQuestion);
    await expect(page.getByLabel('附加上下文 JSON')).toHaveValue('');
    await page.getByLabel('问题内容').fill('继续分析');
    await submit.click();
    await expect(page.locator('#result')).toHaveText(/未调用 Codex 11/);
    await expect(submit).toBeEnabled();
    assert.equal(submissions[1].sessionId, newId);
    assert.deepEqual(Object.keys(submissions[1]).sort(), ['idempotencyKey', 'question', 'sessionId']);
    await page.getByRole('tab', { name: '请求 / 响应' }).click();
    await expect(page.locator('#request-json')).toHaveText(/idempotencyKey/);
    await page.getByRole('tab', { name: '分析结果' }).click();

    const open = async n => {
      await page.locator('#sessions button[title="' + id('sess', n) + '"]').click();
      await expect(page.locator('#session')).toHaveValue(id('sess', n));
      await expect(page.locator('#session-notice')).not.toHaveText('会话尚未载入');
    };
    await open(1);
    await expect(page.locator('#active-directory')).toHaveText('D:/workspace/first');
    await open(2);
    await expect(page.locator('#task-id')).toHaveValue('');
    await submit.click();
    await expect(page.locator('#result')).toHaveText(/未调用 Codex 12/);
    await expect(submit).toBeEnabled();
    assert.deepEqual(Object.keys(submissions[2]).sort(), ['idempotencyKey', 'question', 'sessionId']);

    await open(3);
    await expect(page.locator('#session-notice')).toHaveText(/旧版会话/);
    await expect(page.locator('#result')).toHaveText('旧版历史结果');
    await expect(submit).toBeDisabled();
    await expect(page.getByLabel('附加上下文 JSON')).toBeDisabled();
    const beforeLegacy = submissions.length;
    await page.locator('#task-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(submissions.length, beforeLegacy);
    await expect(page.locator('#alert')).toHaveText(/不可续接/);
    await open(4);
    await expect(submit).toBeEnabled();
    await expect(page.getByLabel('附加上下文 JSON')).toHaveValue('');

    await page.locator('#session').fill(id('sess', 1));
    await expect(submit).toBeDisabled();
    await page.getByLabel('问题内容').click();
    await page.locator('#session').fill(id('sess', 3));
    await page.getByLabel('问题内容').click();
    await expect(page.locator('#session-notice')).toHaveText(/旧版会话/);
    await expect(submit).toBeDisabled();

    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    for (const selector of ['#session', '#task-id', '#context']) await expect(page.locator(selector)).toHaveValue('');
    await page.getByLabel('附加上下文 JSON').fill('{invalid json');
    await page.getByLabel('问题内容').fill('无效上下文');
    await submit.click();
    await expect(page.locator('#alert')).toHaveText(/上下文必须是有效的 JSON 对象/);
    assert.equal(submissions.length, 3);
    await page.getByLabel('附加上下文 JSON').fill('');
    await page.getByLabel('问题内容').fill('固定工作区任务');
    await submit.click();
    await expect(page.locator('#result')).toHaveText(/未调用 Codex 13/);
    await expect(submit).toBeEnabled();
    assert.deepEqual(Object.keys(submissions[3]).sort(), ['idempotencyKey', 'question']);
    await expect(page.locator('#active-directory')).toHaveText(resolvedDefaults.workingDirectory);
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    for (const selector of ['#session', '#task-id', '#context']) await expect(page.locator(selector)).toHaveValue('');
    await page.getByLabel('任务 ID', { exact: true }).fill(legacyTask.taskId);
    await page.getByRole('button', { name: '查询任务', exact: true }).click();
    await expect(page.locator('#result')).toHaveText('旧版历史结果');
    await expect(page.locator('#active-directory')).toHaveText(/旧版会话/);
    await checkLayout(page);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.ok(requests.includes('GET /v1/info'));
    assert.equal(requests.some(value => value.includes('/v1/capabilities')), false);
    assert.ok(submissions.every(body => !('projectKey' in body) && !('capability' in body) && !('workingDirectory' in body) && !('model' in body) && !('modelReasoningEffort' in body)));
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('Browser smoke passed: four-field submit contract, structured context validation, fixed execution settings, session switching, legacy history, intercepted submit/poll/follow-up, task lookup, desktop/mobile. No real tasks submitted.');
} finally { await browser.close(); }
