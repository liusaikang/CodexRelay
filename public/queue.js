export function createQueuePanel({api,formatTime,labels,waitingLabels,onInspect,onAction}) {
  const $ = id => document.getElementById(id);
  let offset = 0, total = 0, visible = false, timer, loading = false, dirty = false;
  let filter = {status:'active',keyword:''};
  const pending = new Set();
  const el = (tag,text,className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const notice = text => { $('queue-message').textContent = text; $('queue-message').classList.toggle('hidden',!text); };
  const seconds = (start,end) => start ? Math.max(0,(Date.parse(end || new Date().toISOString())-Date.parse(start))/1000).toFixed(1)+' s' : '—';
  function schedule() {
    clearTimeout(timer);
    if (visible && !document.hidden && $('queue-auto').checked) timer = setTimeout(load,5000);
  }
  function button(icon,label,handler) {
    const node = el('button',undefined,'icon'); node.type = 'button'; node.title = label; node.setAttribute('aria-label',label);
    const symbol = el('i'); symbol.dataset.lucide = icon; node.append(symbol); node.onclick = handler; return node;
  }
  async function operate(item,action,node) {
    if (pending.has(item.taskId)) return;
    pending.add(item.taskId); node.disabled = true;
    try {
      const result = await onAction(item,action);
      if (result) notice(action === 'retry' ? `已创建重试任务：${result.taskId}` : action === 'cancel' ? '已请求取消；运行中的任务会等待进程退出。' : '已确认继续此会话。');
      pending.delete(item.taskId);
      await load();
    } catch (error) { notice(`操作结果未确认，请刷新核对。${error.message}`); }
    finally {
      pending.delete(item.taskId); node.disabled = false;
      const row = [...$('queue-rows').children].find(row => row.dataset.taskId === item.taskId);
      for (const control of row?.querySelectorAll('button') || []) control.disabled = false;
    }
  }
  function render(items) {
    $('queue-rows').replaceChildren();
    for (const item of items) {
      const row = el('tr'); row.dataset.taskId = item.taskId;
      const question = el('td'); question.append(el('div',item.questionPreview,'queue-question'),el('div',item.taskId,'queue-id mono'),el('div',item.sessionId,'queue-id mono'));
      const status = el('td'), badge = el('span',labels[item.status] || item.status,'task-status'); badge.dataset.state = item.status; status.append(badge);
      if (item.stopReason) status.append(el('div','停止原因：'+item.stopReason,'muted'));
      const wait = el('td'); wait.append(el('div',item.scheduling ? waitingLabels[item.scheduling.reason] || item.scheduling.reason : '—'));
      if (item.queuePosition) { const position = el('div',`入队序号 ${item.queuePosition}`,'muted'); position.title = '按接收顺序排列；同会话阻塞任务可被其他可运行会话跳过。'; wait.append(position); }
      if (item.scheduling?.queueExpiresAt) wait.append(el('div','截止 '+formatTime(item.scheduling.queueExpiresAt),'muted'));
      const times = el('td'); times.append(el('div',formatTime(item.createdAt)),el('div','等待 '+seconds(item.createdAt,item.startedAt || item.finishedAt),'muted'),el('div','执行 '+seconds(item.startedAt,item.finishedAt),'muted'));
      const actions = el('td'), group = el('div',undefined,'queue-actions');
      group.append(button('scan-search','查看会话',() => { void onInspect(item).catch(error => notice(error.message)); }));
      const addAction = (action,icon,label) => { const node = button(icon,label,() => { void operate(item,action,node); }); node.disabled = pending.has(item.taskId); group.append(node); };
      if (['running','queued'].includes(item.status) && !item.stopReason) addAction('cancel','square','取消任务');
      if (item.version !== 1 && ['failed','timed_out','interrupted','cancelled'].includes(item.status)) addAction('retry','rotate-cw','新会话重试');
      if (item.scheduling?.reason === 'previous_task_failed') addAction('resume','play','确认继续会话');
      actions.append(group); row.append(question,status,wait,times,actions); $('queue-rows').append(row);
    }
    if (!items.length) { const row = el('tr'), cell = el('td','当前筛选下没有任务','muted'); cell.colSpan = 5; row.append(cell); $('queue-rows').append(row); }
    $('queue-total').textContent = total ? `${offset+1}–${offset+items.length} / ${total}` : '共 0 条';
    $('queue-prev').disabled = offset === 0; $('queue-next').disabled = offset+20 >= total;
    window.lucide?.createIcons();
  }
  async function load() {
    if (loading) { dirty = true; return; }
    loading = true; clearTimeout(timer); $('queue-refresh').disabled = true;
    try {
      const query = new URLSearchParams({...filter,offset:String(offset),limit:'20'});
      const [list,health,info] = await Promise.all([api('/v1/tasks?'+query),api('/v1/health'),api('/v1/info')]);
      if (dirty || !visible) return;
      total = list.total;
      if (offset >= total && offset > 0) { offset = Math.max(0,Math.floor((total-1)/20)*20); dirty = true; return; }
      $('queue-running').textContent = `${health.running} / ${info.maxConcurrent}`;
      $('queue-waiting').textContent = `${health.queued} / ${info.maxQueued}`;
      $('queue-blocked').textContent = health.blocked; $('queue-receiving').textContent = health.receiving;
      for (const [id,value,max] of [['queue-running-bar',health.running,info.maxConcurrent],['queue-waiting-bar',health.queued,info.maxQueued]]) { $(id).max = Math.max(1,max); $(id).value = value; }
      render(list.items);
      $('queue-updated').textContent = `同步于 ${formatTime(new Date().toISOString())}${health.ready ? '' : ' · 服务未就绪'}`;
    } catch (error) {
      notice('队列读取失败：'+error.message);
      $('queue-updated').textContent = '同步失败，当前显示可能为旧数据';
    } finally {
      loading = false; $('queue-refresh').disabled = false;
      if (dirty && visible) { dirty = false; void load(); } else { dirty = false; schedule(); }
    }
  }
  $('queue-filter').onsubmit = event => { event.preventDefault(); filter = {status:$('queue-status').value,keyword:$('queue-keyword').value.trim()}; offset = 0; notice(''); void load(); };
  $('queue-refresh').onclick = () => { notice(''); void load(); };
  $('queue-prev').onclick = () => { offset = Math.max(0,offset-20); void load(); };
  $('queue-next').onclick = () => { offset += 20; void load(); };
  $('queue-auto').onchange = schedule;
  document.addEventListener('visibilitychange',schedule);
  return {show() {visible = true; void load();},hide() {visible = false; clearTimeout(timer);}};
}
