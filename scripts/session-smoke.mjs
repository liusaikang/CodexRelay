import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const icons = await readFile(new URL('../node_modules/lucide/dist/umd/lucide.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
const sid = n => `sess_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tid = n => `task_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const task = (n, sessionId = sid(1)) => ({ taskId: tid(n), sessionId, status: 'succeeded',
  createdAt: new Date(Date.UTC(2026, 8, 24, 0, n)).toISOString(), startedAt: new Date(Date.UTC(2026, 8, 24, 0, n, 1)).toISOString(),
  finishedAt: new Date(Date.UTC(2026, 8, 24, 0, n, 3)).toISOString(), request: { question: `问题 ${n}`, context: { account: 'demo-user' } },
  result: { markdown: `回答 ${n}`, usage: { input_tokens: 100, output_tokens: 10 } }, progress: [] });
const rows = Array.from({ length: 25 }, (_, i) => task(i + 1));
rows.push(task(26, sid(2)));
rows[23] = { ...rows[23], status: 'failed', result: undefined, error: { code: 'CODEX_FAILED', message: '模型请求失败' } };
rows[24] = { ...rows[24], status: 'queued', result: undefined, startedAt: undefined, finishedAt: undefined,
  scheduling: { reason: 'previous_task_failed', blockedByTaskId: tid(24), queueExpiresAt: '2026-09-24T10:00:00.000Z' } };
const sessions = [1, 2].map(n => ({ sessionId: sid(n), createdAt: '2026-09-24T00:00:00Z', workingDirectory: '/workspace/example' }));
let failTask = false, delaySession = false, releaseSession;
let delayRetry = false, releaseRetry, failSessionList = false;
const retryRequests = [];
const errors = [];
const submissions = [];
const resumptions = [];
try {
  const page = await browser.newPage();
  await page.context().addCookies([{ name: 'codex_console', value: 'session-smoke-session', url: 'http://127.0.0.1:8787/' }]);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const json = data => route.fulfill({ json: data });
    if (path === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    if (path === '/assets/lucide.js') return route.fulfill({ contentType: 'application/javascript', body: icons });
    if (path === '/console/session') return json({ username: 'admin' });
    assert.ok(route.request().headers().cookie?.includes('codex_console=session-smoke-session'));
    if (path === '/v1/admin/account') return json({ available: true, authenticated: false });
    if (path === '/v1/info') return json({ runner: 'codex', maxConcurrent: 3, maxQueued: 100, defaultWorkingDirectory: '/workspace/example' });
    if (path === '/v1/health') return json({ ready: true, running: 1, queued: 1, receiving: 2, blocked: 1, runner: 'codex' });
    if (path === '/v1/sessions') {
      if (failSessionList) return route.fulfill({status:503,json:{error:{message:'session list unavailable'}}});
      return json({ items: sessions, total: sessions.length, offset: 0, limit: 6 });
    }
    if (path === '/v1/tasks' && route.request().method() === 'POST') {
      const input = route.request().postDataJSON(); submissions.push(input);
      const accepted = { ...task(52,input.sessionId || sid(1)), request: input };
      rows.push(accepted); return route.fulfill({ status: 202, json: accepted });
    }
    if (path === `/v1/sessions/${sid(1)}/resume`) {
      resumptions.push(route.request().postDataJSON());
      rows[24].scheduling = { reason: 'capacity' };
      return json({ sessionId: sid(1), resumed: 1 });
    }
    if (path.startsWith('/v1/sessions/')) {
      const id = path.split('/').at(-1), session = sessions.find(s => s.sessionId === id);
      if (!session) return route.fulfill({ status: 404, json: { error: { message: 'Session does not exist.' } } });
      if (delaySession && id === sid(1)) { delaySession = false; await new Promise(resolve => { releaseSession = resolve; }); }
      const tasks = rows.filter(t => t.sessionId === id), offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 20);
      return json({ ...session, tasks: { total: tasks.length, offset, limit, items: tasks.slice(offset, offset + limit).map(t => ({ taskId: t.taskId, status: t.status, question: t.request.question, createdAt: t.createdAt })) } });
    }
    if (path === `/v1/tasks/${tid(24)}/retry`) {
      retryRequests.push(route.request().postDataJSON());
      if (delayRetry) { delayRetry = false; await new Promise(resolve => { releaseRetry = resolve; }); }
      const id = sid(2+retryRequests.length), created = {...task(69+retryRequests.length,id),retryOfTaskId:tid(24)};
      rows.push(created); sessions.push({sessionId:id,createdAt:created.createdAt,workingDirectory:'/workspace/example'});
      return route.fulfill({status:202,json:created});
    }
    if (path.startsWith('/v1/tasks/')) {
      const item = rows.find(t => t.taskId === path.split('/').at(-1));
      if (!item) return route.fulfill({ status: 404, json: { error: { message: 'Task does not exist.' } } });
      if (failTask && item.taskId === tid(25)) return route.fulfill({ status: 503, json: { error: { message: 'temporary unavailable' } } });
      return json(item);
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  await page.goto('http://127.0.0.1:8787/');
  await page.getByRole('button', { name: 'Codex 调用', exact: true }).click();
  await page.locator('#sessions button').first().click();
  await expect(page.locator('#turns article')).toHaveCount(20);
  await expect(page.locator('#turns article').first()).toContainText('排队中');
  await expect(page.locator('#turns article').last()).toContainText('问题 6');
  await expect(page.locator('#health-running')).toContainText('1');
  await expect(page.locator('#health-queued')).toContainText('1');
  await expect(page.locator('#health-blocked')).toHaveText('1');
  await expect(page.locator('#health-receiving')).toHaveText('2');
  await expect(page.locator('#turns article').first()).toContainText('前序任务未成功，等待确认继续');
  await page.locator('#turns article').first().getByRole('button', { name: /折叠本轮对话/ }).click();
  await expect(page.locator('#turns article').first().locator('.turn-body')).toBeHidden();
  await page.locator('#turns article').first().getByRole('button', { name: /展开本轮对话/ }).click();
  await expect(page.locator('#turns article').first().locator('.turn-body')).toBeVisible();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '确认继续此会话', exact: true }).click();
  assert.equal(resumptions.length, 0);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '确认继续此会话', exact: true }).click();
  await expect(page.locator('#turns article').first()).toContainText('等待全局并发名额');
  assert.deepEqual(resumptions, [{ blockedByTaskId: tid(24) }]);
  await expect(page.locator(`article[data-task-id="${tid(24)}"]`)).toContainText('CODEX_FAILED');
  await page.getByRole('button', { name: '加载更早记录', exact: true }).click();
  await expect(page.locator('#turns article')).toHaveCount(25);
  await expect(page.locator('#turns article').first()).toContainText('问题 25');
  await expect(page.locator('#turns article').last()).toContainText('问题 1');
  await page.locator('#turns article').last().locator('summary').click();
  await expect(page.locator('#turns article').last()).toContainText('demo-user');
  await page.clock.install();
  await page.getByLabel('自动刷新', {exact:true}).uncheck();
  await page.getByLabel('自动刷新', {exact:true}).check();
  rows[24] = { ...task(25), status: 'running', finishedAt: undefined, result: undefined, progress: [{ at: new Date().toISOString(), kind: 'progress', detail: 'command_execution' }] };
  await page.clock.runFor(5100);
  await expect(page.locator('#turns article').first()).toContainText('执行中');
  rows[24] = { ...task(25), result: { markdown: '<script>danger()</script> 最新回答', usage: null } };
  await page.getByRole('button', { name: '刷新会话记录', exact: true }).click();
  await expect(page.locator('#turns article').first()).toContainText('最新回答');
  assert.equal(await page.locator('#turns script').count(), 0);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.ok((await page.screenshot({ fullPage: true })).length > 1000);
  }
  // A late response from a previous selection must never replace the current session.
  delaySession = true;
  await page.locator('#sessions button').first().click();
  await expect.poll(() => typeof releaseSession).toBe('function');
  await page.locator('#sessions button').nth(1).click();
  await expect(page.locator('#turns article')).toHaveCount(1);
  await expect(page.locator('#turns article')).toContainText('回答 26');
  releaseSession();
  await expect(page.locator('#active-session')).toHaveText(sid(2));
  await page.getByLabel('任务或会话 ID').fill(tid(25));
  await page.getByRole('button', { name: '定位记录', exact: true }).click();
  await expect(page.locator(`article[data-task-id="${tid(25)}"]`)).toContainText('最新回答');
  await expect(page.locator('#active-session')).toHaveText(sid(1));
  await page.getByLabel('任务或会话 ID').fill(tid(1));
  await page.getByRole('button', { name: '定位记录', exact: true }).click();
  await expect(page.locator(`article[data-task-id="${tid(1)}"]`)).toContainText('回答 1');
  await page.getByRole('button', { name: '加载更早记录', exact: true }).click();
  await expect(page.locator('#turns article')).toHaveCount(25);
  for (let n = 27; n <= 51; n++) rows.push(task(n));
  await page.getByRole('button', { name: '刷新会话记录', exact: true }).click();
  await expect(page.locator('#turns article')).toHaveCount(50);
  await expect(page.locator('#turns article').first()).toContainText('回答 51');
  rows.splice(26);
  await page.getByLabel('任务或会话 ID').fill(tid(999));
  await page.getByRole('button', { name: '定位记录', exact: true }).click();
  await expect(page.locator('#task-message')).toContainText('不能据此判断请求未到达');
  await expect(page.locator('#session')).toHaveValue('');
  failTask = true;
  await page.locator('#sessions button').first().click();
  await expect(page.locator(`article[data-task-id="${tid(25)}"]`)).toContainText('详情读取失败');
  failTask = false;
  await page.getByRole('button', { name: '刷新会话记录', exact: true }).click();
  await expect(page.locator(`article[data-task-id="${tid(25)}"]`)).toContainText('最新回答');
  await page.getByLabel('问题内容').fill('继续排查这个问题');
  await page.getByRole('button', { name: '提交任务', exact: true }).click();
  await expect(page.locator('#turns article')).toHaveCount(21);
  await expect(page.locator('#turns article').first()).toContainText('继续排查这个问题');
  assert.equal(submissions.length,1);
  assert.equal(submissions[0].sessionId,sid(1));
  await expect(page.getByLabel('问题内容')).toHaveValue('');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.locator('#turns article')).toHaveCount(0);
  await expect(page.locator('#session')).toHaveValue('');
  await page.locator('#sessions button').first().click();
  delayRetry = true;
  page.once('dialog',dialog => dialog.accept());
  await page.locator(`article[data-task-id="${tid(24)}"]`).getByRole('button',{name:'新会话重试',exact:true}).click();
  await expect.poll(() => !!releaseRetry).toBe(true);
  await page.locator('#sessions button').nth(1).click();
  await expect(page.locator('#session')).toHaveValue(sid(2));
  await page.getByLabel('问题内容').fill('这是第二个会话的草稿');
  releaseRetry();
  await expect(page.locator('#task-message')).toContainText('当前会话与草稿保持不变');
  await expect(page.locator('#session')).toHaveValue(sid(2));
  await expect(page.getByLabel('问题内容')).toHaveValue('这是第二个会话的草稿');
  await page.locator('#sessions button').first().click();
  failSessionList = true;
  page.once('dialog',dialog => dialog.accept());
  await page.locator(`article[data-task-id="${tid(24)}"]`).getByRole('button',{name:'新会话重试',exact:true}).click();
  await expect(page.locator('#task-message')).toContainText(`重试已接收：${tid(71)}，页面同步失败`);
  await expect(page.locator('#task-message')).not.toContainText('操作未确认完成');
  assert.deepEqual(errors, []);
  console.log('Session smoke passed: latest/older turns, queue/running/failure, diagnostics, lookup, stale responses, retry, layouts. No real tasks submitted.');
} finally { releaseSession?.(); releaseRetry?.(); await browser.close(); }
