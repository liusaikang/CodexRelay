import { chromium, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const capture = process.argv.includes('--screenshots');
const root = new URL('../',import.meta.url);
const html = await readFile(new URL('public/index.html',root),'utf8');
const script = await readFile(new URL('public/queue.js',root),'utf8');
const icons = await readFile(new URL('node_modules/lucide/dist/umd/lucide.js',root),'utf8');
const browser = await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL ? {channel:process.env.BROWSER_CHANNEL} : {})});
const tid = n => `task_00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sid = n => `sess_00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const received = '2026-01-12T08:00:00.000Z';
const make = (n,status,question) => ({version:2,taskId:tid(n),sessionId:sid(n),status,request:{question,context:{account:'demo-user'}},questionPreview:question,
  createdAt:received,startedAt:status === 'queued' ? undefined : received,finishedAt:['failed','succeeded'].includes(status) ? '2026-01-12T08:00:08.000Z' : undefined,
  progress:[],result:status === 'succeeded' ? {markdown:'结论：示例用户缺少当前工作区的订单读取角色。\n\n证据：\n1. 样例日志显示授权校验返回 ROLE_MISSING。\n2. 示例源码在查询前校验订单读取角色。\n\n建议：由管理员核对角色分配；本次分析未修改数据。',usage:{input_tokens:1200,output_tokens:180}} : undefined});
const rows = [make(1,'running','分析示例订单查询接口的超时原因'),make(2,'queued','检查示例账号 demo-user 的数据可见性'),make(3,'queued','继续核对订单查询的角色校验'),make(4,'queued','关联样例 error 与 info 日志'),make(5,'failed','检查样例数据源的连接状态'),make(6,'succeeded','为什么示例账号看不到订单？')];
rows[1].scheduling = {reason:'capacity',queueExpiresAt:'2026-01-12T09:00:00.000Z'};
rows[2].scheduling = {reason:'session_active',blockedByTaskId:tid(1)};
rows[2].sessionId = rows[0].sessionId;
rows[3].scheduling = {reason:'previous_task_failed',blockedByTaskId:tid(5)};
rows[3].sessionId = rows[4].sessionId;
rows[4].error = {code:'EXECUTION_FAILED',message:'Synthetic data source unavailable'};
for (let n=7;n<=26;n++) rows.push(make(n,'succeeded',`样例检查 ${n}`));
const actions = [], errors = [];
let failList = false, rejectRetryOnce = true;
try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  await page.clock.setFixedTime(new Date('2026-01-12T08:01:00.000Z'));
  page.on('pageerror',error => errors.push(error.message));
  await page.route('**/*',async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = data => route.fulfill({json:data});
    if (path === '/') return route.fulfill({contentType:'text/html; charset=utf-8',body:html});
    if (path === '/assets/lucide.js') return route.fulfill({contentType:'application/javascript',body:icons});
    if (path === '/assets/queue.js') return route.fulfill({contentType:'application/javascript',body:script});
    if (path === '/console/session') return json({username:'operator'});
    if (path === '/v1/admin/account') return json({available:true,authenticated:false});
    if (path === '/v1/info') return json({runner:'codex',maxConcurrent:3,maxQueued:100,defaultWorkingDirectory:'/workspace/example'});
    if (path === '/v1/health') return json({ready:true,running:1,queued:3,blocked:1,receiving:0});
    if (path === '/v1/tasks') {
      if (failList) return route.fulfill({status:503,json:{error:{message:'temporary unavailable'}}});
      const status = url.searchParams.get('status') || 'active', keyword = url.searchParams.get('keyword') || '',offset = Number(url.searchParams.get('offset') || 0);
      const items = rows.filter(t => (status === 'all' || (status === 'active' ? ['running','queued'].includes(t.status) : t.status === status)) && t.questionPreview.includes(keyword));
      const waiting = rows.filter(t => t.status === 'queued');
      return json({total:items.length,offset,limit:20,items:items.slice(offset,offset+20).map(t => ({...t,queuePosition:t.status === 'queued' ? waiting.indexOf(t)+1 : undefined}))});
    }
    if (path === '/v1/sessions') return json({total:rows.length,items:rows.slice(0,6).map(t => ({sessionId:t.sessionId,createdAt:received}))});
    if (path.startsWith('/v1/sessions/')) {
      const id = path.split('/')[3], task = rows.find(t => t.sessionId === id);
      if (path.endsWith('/resume')) { actions.push({action:'resume',body:request.postDataJSON()}); task.scheduling = {reason:'capacity'}; return json({resumed:1}); }
      return json({sessionId:id,workingDirectory:'/workspace/example',tasks:{total:1,items:[{...task,question:task.request.question}]}});
    }
    if (path.startsWith('/v1/tasks/')) {
      const id = path.split('/')[3], item = rows.find(t => t.taskId === id);
      if (path.endsWith('/cancel')) { actions.push({action:'cancel',id}); item.status='cancelled'; item.finishedAt=received; return json(item); }
      if (path.endsWith('/retry')) {
        actions.push({action:'retry',id,body:request.postDataJSON()});
        if (rejectRetryOnce) { rejectRetryOnce=false; return route.fulfill({status:503,json:{error:{message:'unknown result'}}}); }
        const retried = {...make(30,'queued',item.questionPreview),retryOfTaskId:id}; rows.push(retried); return route.fulfill({status:202,json:retried});
      }
      return json(item);
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  await page.goto('http://127.0.0.1:8787/');
  await page.getByRole('button',{name:'任务队列',exact:true}).click();
  await expect(page.locator('#queue-rows tr')).toHaveCount(4);
  await expect(page.locator('#queue-running')).toHaveText('1 / 3');
  await expect(page.locator('#queue-rows')).toContainText('前序任务未成功');
  await page.getByLabel('自动刷新队列').uncheck();
  if (capture) {
    await mkdir(new URL('docs/images/',root),{recursive:true});
    await page.screenshot({path:fileURLToPath(new URL('docs/images/console-queue.png',root)),fullPage:true});
  }
  const queued = page.locator(`tr[data-task-id="${tid(2)}"]`);
  page.once('dialog',dialog => dialog.dismiss()); await queued.getByRole('button',{name:'取消任务'}).click();
  assert.equal(actions.length,0);
  page.once('dialog',dialog => dialog.accept()); await queued.getByRole('button',{name:'取消任务'}).click();
  await expect(queued).toHaveCount(0); assert.equal(actions[0].action,'cancel');
  page.once('dialog',dialog => dialog.accept()); await page.getByRole('button',{name:'确认继续会话'}).click();
  await expect(page.locator('#queue-rows')).not.toContainText('前序任务未成功');
  await page.locator('#queue-status').selectOption('failed'); await page.getByRole('button',{name:'查询',exact:true}).click();
  await expect(page.locator('#queue-rows tr')).toHaveCount(1);
  for (let i=0;i<2;i++) {
    if (i === 1) {
      await page.reload();
      await page.getByRole('button',{name:'任务队列',exact:true}).click();
      await expect(page.locator('#queue-running')).toHaveText('1 / 3');
      await page.getByLabel('自动刷新队列').uncheck();
      await page.locator('#queue-status').selectOption('failed'); await page.getByRole('button',{name:'查询',exact:true}).click();
      await expect(page.locator('#queue-rows tr')).toHaveCount(1);
    }
    page.once('dialog',dialog => dialog.accept()); await page.getByRole('button',{name:'新会话重试',exact:true}).click();
    await expect(page.locator('#queue-message')).toContainText(i === 0 ? '操作结果未确认' : '已创建重试任务');
  }
  const retries = actions.filter(a => a.action==='retry'); assert.equal(retries.length,2); assert.equal(retries[0].body.idempotencyKey,retries[1].body.idempotencyKey);
  await page.locator('#queue-status').selectOption('all'); await page.getByRole('button',{name:'查询',exact:true}).click();
  await expect(page.locator('#queue-rows tr')).toHaveCount(20);
  await page.getByRole('button',{name:'队列下一页'}).click(); await expect(page.locator('#queue-rows tr')).toHaveCount(7);
  await page.getByRole('button',{name:'队列上一页'}).click();
  await expect(page.locator('#queue-rows tr')).toHaveCount(20);
  await page.locator('#queue-keyword').fill('为什么示例账号'); await page.getByRole('button',{name:'查询',exact:true}).click();
  await expect(page.locator('#queue-rows tr')).toHaveCount(1);
  for (const viewport of [{width:390,height:844},{width:1440,height:1000}]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
  }
  failList=true; await page.locator('#queue-refresh').click(); await expect(page.locator('#queue-updated')).toContainText('同步失败'); failList=false;
  await page.getByRole('button',{name:'查看会话',exact:true}).click();
  await expect(page.locator('#turns')).toContainText('示例用户缺少当前工作区');
  if (capture) await page.screenshot({path:fileURLToPath(new URL('docs/images/console-conversation.png',root)),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('Queue filtering, pagination, cancellation, retry idempotency, resume, inspection and responsive layout passed (synthetic fixtures).');
} finally { await browser.close(); }
