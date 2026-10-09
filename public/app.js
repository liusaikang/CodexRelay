'use strict';
const $ = id => document.getElementById(id);
window.lucide?.createIcons();
let codexRunner = false;
let accountPanel, taskPanel, accountLoaded = false;
const labels = {queued:'排队中',running:'执行中',succeeded:'已完成',failed:'失败',cancelled:'已取消',timed_out:'已超时',interrupted:'已中断'};
const waitingLabels = {capacity:'等待全局并发名额',session_active:'等待同会话正在执行的任务',session_predecessor:'等待同会话前序任务',previous_task_failed:'前序任务未成功，等待确认继续',service_stopping:'服务正在停止',storage_unavailable:'存储异常，调度已停止',ready:'等待调度'};
const formatTime = value => value ? new Date(value).toLocaleString('zh-CN', {hour12:false}) : '—';
function serviceStatus(label, state = '') { $('service-label').textContent = label; $('service-status').className = 'service-status' + (state ? ' ' + state : ''); }
function message(id, value = '') { $(id).textContent = value; $(id).classList.toggle('hidden', !value); }
let invocationPanelPromise;
async function loadInvocationPanel() {
  try {
    invocationPanelPromise ??= import('/assets/invocations.js').then(({createInvocationPanel}) => createInvocationPanel({api,formatTime,labels}));
    await (await invocationPanelPromise).load();
  } catch {
    invocationPanelPromise = undefined;
    message('logs-message','日志面板加载失败，请确认服务已重启到最新版本后刷新页面。');
  }
}
let settingsPanelPromise;
let queuePanelPromise;
let schedulesPanelPromise;
let skillsPanelPromise;
async function loadSkillsPanel() {
  try {
    skillsPanelPromise ??= import('/assets/skills.js').then(({createSkillsPanel}) => createSkillsPanel({api,formatTime}));
    const panel = await skillsPanelPromise;
    if (!$('skills-view').classList.contains('hidden')) panel.show();
  } catch { skillsPanelPromise = undefined; message('skills-message','项目 Skills 加载失败，请刷新页面后重试。'); }
}
async function loadSchedulesPanel() {
  try {
    schedulesPanelPromise ??= import('/assets/schedules.js').then(({createSchedulesPanel}) => createSchedulesPanel({api,formatTime,
      onInspect: async run => { if (await showView('task-view')) await taskPanel.inspect(run.sessionId,run.taskId); }}));
    const panel = await schedulesPanelPromise;
    if (!$('schedules-view').classList.contains('hidden')) panel.show();
  } catch { schedulesPanelPromise = undefined; message('schedules-message','定时任务面板加载失败，请刷新重试。'); }
}
async function loadQueuePanel() {
  try {
    queuePanelPromise ??= import('/assets/queue.js').then(({createQueuePanel}) => createQueuePanel({api,formatTime,labels,waitingLabels,
      onInspect: async item => { if (await showView('task-view')) await taskPanel.inspect(item.sessionId,item.taskId); },
      onAction: performTaskAction}));
    const panel = await queuePanelPromise;
    if (!$('queue-view').classList.contains('hidden')) panel.show();
  } catch { queuePanelPromise = undefined; message('queue-message','任务队列加载失败，请刷新重试。'); }
}
const taskActions = new Set();
async function performTaskAction(item, action) {
  const key = `${action}:${item.taskId}`;
  if (taskActions.has(key)) return;
  const prompts = {cancel:'确认取消这个任务？已经完成的文件或外部系统操作不会撤销。',
    retry:'确认在新会话中使用原问题和上下文重试？旧记录保留，执行可能重复外部操作。',
    resume:'前序任务未成功，确认继续原会话的后续任务？'};
  if (!confirm(prompts[action])) return;
  taskActions.add(key);
  try {
    let result;
    if (action === 'retry') {
      const storageKey = `codexrelay.pending-retry:${item.taskId}`;
      let retryKey;
      try {
        retryKey = sessionStorage.getItem(storageKey) || crypto.randomUUID();
        sessionStorage.setItem(storageKey,retryKey);
      } catch { throw new Error('无法保存重试幂等键，请允许当前页面使用会话存储后重试。'); }
      result = await api(`/v1/tasks/${item.taskId}/retry`,{method:'POST',body:JSON.stringify({idempotencyKey:retryKey})});
      try { sessionStorage.removeItem(storageKey); } catch { /* Keeping the key only deduplicates the next attempt. */ }
    } else if (action === 'resume') {
      result = await api(`/v1/sessions/${item.sessionId}/resume`,{method:'POST',body:JSON.stringify({blockedByTaskId:item.scheduling.blockedByTaskId})});
    } else result = await api(`/v1/tasks/${item.taskId}/cancel`,{method:'POST'});
    return result;
  } finally { taskActions.delete(key); }
}
async function loadSettingsPanel() {
  try {
    settingsPanelPromise ??= import('/assets/settings.js').then(({createSettingsPanel}) => createSettingsPanel({api,formatTime,refreshHealth:async () => taskPanel?.refreshHealth()}));
    await (await settingsPanelPromise).load();
  } catch {
    settingsPanelPromise = undefined;
    message('settings-message','运行配置加载失败，请刷新页面后重试。');
  }
}
async function api(path, options = {}) {
  const response = await fetch(path, {...options, headers:{...(options.body ? {'Content-Type':'application/json'} : {})},signal:AbortSignal.timeout(15000)});
  const body = await response.json();
  if (response.status === 401) { location.assign('/login'); throw new Error('登录已过期'); }
  if (!response.ok) { const error = new Error(body.error?.message || '请求失败'); error.status = response.status; throw error; }
  return body;
}
async function bootstrap() {
  const response = await fetch('/console/session', {signal:AbortSignal.timeout(15000)});
  const body = await response.json();
  if (response.status === 401) { location.assign('/login'); throw new Error('请先登录控制台'); }
  if (!response.ok || typeof body.username !== 'string') throw new Error('无法确认控制台登录状态');
  codexRunner = body.runner === 'codex';
  serviceStatus('已连接','online');
}
const viewNames = new Set(['account-view','task-view','queue-view','schedules-view','skills-view','logs-view','settings-view']);
const viewLoads = new Map();
let viewSwitch = 0;
async function ensureView(id) {
  if (!viewNames.has(id)) throw new Error('未知的控制台页面');
  if (!viewLoads.has(id)) {
    const name = id.slice(0,-5);
    const load = (async () => {
      let view = $(id);
      if (!view) {
        const response = await fetch(`/views/${name}.html`,{signal:AbortSignal.timeout(15000)});
        if (response.status === 401) { location.assign('/login'); throw new Error('登录已过期'); }
        if (!response.ok) throw new Error(`页面加载失败 (${response.status})`);
        const template = document.createElement('template');
        template.innerHTML = await response.text();
        view = template.content.firstElementChild;
        if (view?.id !== id || template.content.children.length !== 1) throw new Error('页面内容不完整');
        view.classList.add('hidden');
        $('view-root').append(view);
        window.lucide?.createIcons();
      }
      if (id === 'account-view' && !accountPanel) {
        const {createAccountPanel} = await import('/assets/account.js');
        accountPanel = createAccountPanel({api,formatTime,message,codexRunner});
      }
      if (id === 'task-view' && !taskPanel) {
        const {createTaskPanel} = await import('/assets/task.js');
        taskPanel = createTaskPanel({api,formatTime,message,serviceStatus,bootstrap,labels,waitingLabels,performTaskAction,taskActions});
      }
      return view;
    })();
    viewLoads.set(id,load);
    load.catch(() => viewLoads.delete(id));
  }
  return viewLoads.get(id);
}
async function showView(id) {
  const current = ++viewSwitch;
  try { await ensureView(id); }
  catch (error) {
    if (current === viewSwitch) message('view-error',error.message || '页面加载失败，请重试。');
    return false;
  }
  if (current !== viewSwitch) return false;
  message('view-error');
  for (const name of viewNames) $(name)?.classList.toggle('hidden',name !== id);
  for (const button of document.querySelectorAll('.quick-nav button')) button.setAttribute('aria-current',button.dataset.view === id ? 'page' : 'false');
  if (id === 'account-view' && !accountLoaded) { accountLoaded = true; void accountPanel.load(); }
  if (id === 'task-view') taskPanel.show();
  else taskPanel?.hide();
  if (id === 'logs-view') void loadInvocationPanel();
  if (id === 'settings-view') void loadSettingsPanel();
  if (id === 'queue-view') void loadQueuePanel();
  else if (queuePanelPromise) void queuePanelPromise.then(panel => panel.hide()).catch(() => {});
  if (id === 'schedules-view') void loadSchedulesPanel();
  else if (schedulesPanelPromise) void schedulesPanelPromise.then(panel => panel.hide()).catch(() => {});
  if (id === 'skills-view') void loadSkillsPanel();
  return true;
}
$('logout').onclick = async () => {
  $('logout').disabled = true;
  try { await fetch('/console/logout', {method:'POST'}); }
  finally { location.assign('/login'); }
};
const navButtons = [...document.querySelectorAll('.quick-nav button')];
for (const button of navButtons) { button.disabled = true; button.onclick = () => { void showView(button.dataset.view); }; }
void (async () => {
  try { await bootstrap(); await showView('account-view'); }
  catch (error) { serviceStatus('连接失败','error'); message('view-error',error.message || String(error)); }
  finally { for (const button of navButtons) button.disabled = false; }
})();
