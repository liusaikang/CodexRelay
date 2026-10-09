export function createTaskPanel({api,formatTime,message,serviceStatus,bootstrap,labels,waitingLabels,performTaskAction,taskActions}) {
  const $ = id => document.getElementById(id);
  let serviceInfo = null, submitting = false, taskReady = false;
  let selectedSession = '', viewEpoch = 0, historyOffset = 0, totalTurns = 0, refreshEpoch = null, monitorTimer;
  let sessionsOffset = 0, sessionsTotal = 0, sessionListEpoch = 0;
  const turnRows = new Map(), collapsedTurns = new Set(), resumingSessions = new Set(), deletingSessions = new Set();
  const terminal = item => !['queued','running'].includes(item.status);
  function syncTaskControls() {
    if (!$('task-view')) return;
    const enabled = taskReady && !submitting && !deletingSessions.size;
    for (const id of ['question','system-prompt','context','sandbox-mode','session','new-session','refresh-sessions']) $(id).disabled = !enabled;
    $('submit').disabled = !enabled;
    $('submit-label').textContent = submitting ? '提交中…' : '提交任务';
    for (const button of $('sessions').querySelectorAll('button')) button.disabled = !enabled;
    $('session-prev').disabled = !enabled || sessionsOffset === 0;
    $('session-next').disabled = !enabled || sessionsOffset + 6 >= sessionsTotal;
  }
  function resetTask() {
    viewEpoch++; refreshEpoch = null; selectedSession = ''; turnRows.clear(); historyOffset = 0; totalTurns = 0;
    collapsedTurns.clear();
    $('session').value = '';
    $('turns').replaceChildren(); $('active-session').textContent = '—'; $('active-directory').textContent = '—'; $('active-model').textContent = '—'; $('active-effort').textContent = '—';
    $('conversation-count').textContent = '尚未选择'; $('conversation-empty').textContent = '请选择会话或查询任务 ID'; $('conversation-empty').classList.remove('hidden');
    $('load-older').classList.add('hidden'); $('refresh-conversation').disabled = true;
    markSession();
  }
  function markSession() {
    for (const button of $('sessions').querySelectorAll('.session-open')) button.setAttribute('aria-current',String(button.dataset.sessionId === selectedSession));
  }
  const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const elapsed = (start, end) => start ? Math.max(0,(Date.parse(end || new Date().toISOString()) - Date.parse(start)) / 1000).toFixed(1) + ' s' : '—';
  function renderConversation({older = false, latest = false, focusId} = {}) {
    const scroller = $('conversation-scroll'), top = scroller.scrollTop;
    const pageTop = window.scrollY, nestedScroll = new Map();
    for (const article of $('turns').children) {
      const panes = [...article.querySelectorAll('details pre.json')];
      if (panes.length) nestedScroll.set(article.dataset.taskId,panes.map(node => ({top:node.scrollTop,left:node.scrollLeft})));
    }
    const atTop = top < 50;
    const expanded = new Set([...$('turns').querySelectorAll('details[open]')].map(node => node.dataset.taskId));
    $('turns').replaceChildren();
    for (const row of [...turnRows.values()].sort((a,b) => (b.ordinal || Number.MAX_SAFE_INTEGER) - (a.ordinal || Number.MAX_SAFE_INTEGER))) {
      const item = row.data || row.summary;
      const article = element('article','turn'); article.dataset.taskId = item.taskId;
      if (item.taskId === focusId) article.classList.add('focused');
      const header = element('div','turn-header'), state = element('span','task-status',labels[item.status] || item.status); state.dataset.state = item.status;
      const body = element('div','turn-body');
      const toggle = element('button','turn-toggle'); toggle.type = 'button';
      const title = row.ordinal ? `第 ${row.ordinal} 轮` : '定位任务';
      const setCollapsed = collapsed => {
        article.dataset.collapsed = String(collapsed);
        body.hidden = collapsed;
        toggle.textContent = collapsed ? '展开' : '折叠';
        toggle.title = collapsed ? '展开本轮对话' : '折叠本轮对话';
        toggle.setAttribute('aria-label',`${toggle.title}：${title}`);
        toggle.setAttribute('aria-expanded',String(!collapsed));
      };
      toggle.onclick = () => {
        const collapsed = !body.hidden;
        if (collapsed) collapsedTurns.add(item.taskId); else collapsedTurns.delete(item.taskId);
        setCollapsed(collapsed);
      };
      header.append(element('h3','',title),state,element('span','turn-id mono',item.taskId),toggle); article.append(header);
      body.append(element('h4','','问题'),element('p','turn-question',item.request?.question ?? row.summary.question));
      if (row.error) {
        body.append(element('p','turn-note error',`详情读取失败：${row.error}。这不是任务执行失败，可刷新重试。`));
      } else {
        const usage = item.result?.usage, progress = item.progress || [], lastEvent = progress.at(-1);
        const times = element('dl','turn-times');
        for (const [label,value] of [['接收时间',formatTime(item.createdAt)],['开始时间',formatTime(item.startedAt)],['结束时间',formatTime(item.finishedAt)],['排队耗时',elapsed(item.createdAt,item.startedAt || item.finishedAt)],['执行耗时',elapsed(item.startedAt,item.finishedAt)],['执行上限',item.timeoutSeconds ? item.timeoutSeconds + ' s' : '未记录'],['Token 用量',usage ? ((usage.input_tokens ?? 0)+(usage.output_tokens ?? 0)).toLocaleString() : '未报告'],['最近执行事件',lastEvent ? formatTime(lastEvent.at) : '无事件记录'],['距最近事件',lastEvent ? elapsed(lastEvent.at,item.finishedAt) : '—']]) {
          const pair = element('div'); pair.append(element('dt','',label),element('dd','',value)); times.append(pair);
        }
        body.append(times);
        if (item.stopReason && !terminal(item)) body.append(element('p','turn-note',`已请求停止：${item.stopReason}，等待执行进程退出。`));
        if (item.scheduling) {
          const schedule = item.scheduling;
          body.append(element('p','turn-note',`${waitingLabels[schedule.reason] || schedule.reason}${schedule.blockedByTaskId ? '\n前序任务：' + schedule.blockedByTaskId : ''}${schedule.queueExpiresAt ? '\n排队截止：' + formatTime(schedule.queueExpiresAt) : ''}`));
          if (schedule.reason === 'previous_task_failed' && schedule.blockedByTaskId) {
            const resume = element('button','','确认继续此会话'); resume.type = 'button'; resume.disabled = resumingSessions.has(item.sessionId);
            resume.onclick = async () => {
              if (resumingSessions.has(item.sessionId) || !confirm('前序任务未成功，继续执行可能缺少完整上下文。确认让此会话的后续任务继续排队？不会重新执行失败任务。')) return;
              const epoch = viewEpoch;
              resumingSessions.add(item.sessionId); resume.disabled = true;
              try {
                await api('/v1/sessions/' + encodeURIComponent(item.sessionId) + '/resume',{method:'POST',body:JSON.stringify({blockedByTaskId:schedule.blockedByTaskId})});
                if (epoch === viewEpoch) { message('task-message'); await refreshConversation({force:true}); }
                await refreshHealth();
              } catch (error) { if (epoch === viewEpoch) message('task-message','继续排队失败：' + error.message); }
              finally { resumingSessions.delete(item.sessionId); if (epoch === viewEpoch) renderConversation(); }
            };
            body.append(resume);
          }
        }
        if (item.error) body.append(element('p','turn-note error',`${item.error.code}: ${item.error.message}`));
        if ((!terminal(item) && !item.stopReason) || (item.version !== 1 && ['failed','timed_out','interrupted','cancelled'].includes(item.status))) {
          const action = terminal(item) ? 'retry' : 'cancel';
          const controls = element('div','turn-actions'), button = element('button','',action === 'retry' ? '新会话重试' : '取消任务');
          button.type = 'button'; button.disabled = taskActions.has(`${action}:${item.taskId}`);
          button.onclick = async () => {
            button.disabled = true;
            const epoch = viewEpoch, draft = ['question','context','session'].map(id => $(id).value);
            let result;
            try {
              result = await performTaskAction(item,action);
              if (result && action === 'retry') {
                const unchanged = epoch === viewEpoch && !$('task-view').classList.contains('hidden') && ['question','context','session'].every((id,i) => $(id).value === draft[i]);
                if (unchanged) await selectSession(result.sessionId,result.taskId,result);
                else message('task-message',`重试已接收：${result.taskId}。当前会话与草稿保持不变。`);
                await refreshSessions();
              } else if (epoch === viewEpoch) await refreshConversation({force:true});
              await refreshHealth();
            } catch (error) {
              message('task-message',result && action === 'retry' ? `重试已接收：${result.taskId}，页面同步失败，请按任务 ID 查询。${error.message}` : '操作未确认完成，请刷新核对；重试按钮会复用本次幂等键。' + error.message);
            }
            finally { button.disabled = false; }
          };
          controls.append(button); body.append(controls);
        }
        if (item.retryOfTaskId) body.append(element('p','turn-note',`重试来源：${item.retryOfTaskId}`));
        const answer = item.result?.markdown;
        body.append(element('h4','','Codex 返回结果'));
        if (typeof answer === 'string' && answer.trim()) body.append(element('pre','turn-answer',answer));
        else {
          const missing = item.status === 'queued' ? '已接收，尚未开始执行。' : item.status === 'running' ? '正在执行，尚未产生最终结果。没有新事件不等于任务卡死。' : item.status === 'succeeded' ? '任务标记为成功，但未保存非空结果，需要检查服务端执行记录。' : '任务已结束，未保存最终结果。';
          body.append(element('p','turn-note' + (item.status === 'succeeded' ? ' error' : ''),missing));
        }
        const details = element('details'); details.dataset.taskId = item.taskId;
        details.append(element('summary','','请求 / 响应与执行事件'));
        let populated = false;
        const populate = () => { if (!details.open || populated) return; populated = true;
          for (const [label,value] of [['原始请求',item.request],['任务响应',item],['最近执行事件（最多 100 条）',progress]]) details.append(element('h4','',label),element('pre','json',JSON.stringify(value ?? null,null,2)));
        };
        details.addEventListener('toggle',populate);
        if (expanded.has(item.taskId)) { details.open = true; populate(); }
        body.append(details);
      }
      setCollapsed(collapsedTurns.has(item.taskId));
      article.append(body);
      $('turns').append(article);
    }
    for (const article of $('turns').children) {
      const positions = nestedScroll.get(article.dataset.taskId);
      if (positions) [...article.querySelectorAll('details pre.json')].forEach((node,index) => {
        if (positions[index]) { node.scrollTop = positions[index].top; node.scrollLeft = positions[index].left; }
      });
    }
    $('conversation-count').textContent = `已加载 ${turnRows.size} / 共 ${totalTurns} 轮`;
    $('conversation-empty').classList.toggle('hidden',turnRows.size > 0);
    $('conversation-empty').textContent = '该会话暂无任务记录';
    $('load-older').classList.toggle('hidden',historyOffset === 0);
    if (focusId) {
      const target = [...$('turns').children].find(node => node.dataset.taskId === focusId);
      if (target) scroller.scrollTop = Math.max(0,target.offsetTop - scroller.offsetTop);
    } else if (older) scroller.scrollTop = top;
    else if (latest || atTop) scroller.scrollTop = 0;
    else scroller.scrollTop = top;
    if (!focusId && !latest) window.scrollTo(window.scrollX,pageTop);
    $('last-updated').textContent = '最近同步 ' + new Date().toLocaleTimeString('zh-CN',{hour12:false});
  }
  async function readTurnDetails(entries, epoch, force = false) {
    let index = 0;
    // Bound detail reads so opening a long session cannot flood the service.
    await Promise.all(Array.from({length:Math.min(4,entries.length)}, async () => {
      while (index < entries.length && epoch === viewEpoch) {
        const entry = entries[index++], old = turnRows.get(entry.summary.taskId);
        if (!force && old?.data && !old.error && terminal(old.data) && old.data.status === entry.summary.status) { old.ordinal = entry.ordinal; continue; }
        try {
          const data = await api('/v1/tasks/' + encodeURIComponent(entry.summary.taskId));
          if (epoch === viewEpoch) turnRows.set(data.taskId,{...entry,data});
        } catch (error) { if (epoch === viewEpoch) turnRows.set(entry.summary.taskId,{...entry,error:error.message}); }
      }
    }));
  }
  async function refreshConversation({initial = false, older = false, focusId, force = false} = {}) {
    const epoch = viewEpoch, id = selectedSession;
    if (!id || refreshEpoch === epoch) return;
    refreshEpoch = epoch; $('refresh-conversation').disabled = true; $('load-older').disabled = true;
    try {
      const url = '/v1/sessions/' + encodeURIComponent(id);
      const peek = await api(url + '?offset=0&limit=1');
      if (epoch !== viewEpoch) return;
      const total = peek.tasks.total;
      const offset = older ? Math.max(0,historyOffset - 20) : initial ? Math.max(0,total - 20) : Math.min(totalTurns,Math.max(0,total - 20));
      const end = older ? historyOffset : total;
      const entries = [];
      for (let start = offset; start < end; start += 100) {
        const detail = total <= 1 ? peek : await api(`${url}?offset=${start}&limit=${Math.min(100,end-start)}`);
        if (epoch !== viewEpoch) return;
        entries.push(...detail.tasks.items.map((summary,i) => ({summary,ordinal:start+i+1})));
      }
      totalTurns = total;
      $('active-directory').textContent = peek.workingDirectory || '—';
      $('active-model').textContent = peek.model || '—'; $('active-effort').textContent = peek.modelReasoningEffort || '—';
      if (!initial && !older) for (const old of turnRows.values()) {
        if ((old.error || !terminal(old.data || old.summary)) && !entries.some(row => row.summary.taskId === old.summary.taskId)) entries.push({summary:old.summary,ordinal:old.ordinal});
      }
      await readTurnDetails(entries,epoch,force);
      if (epoch !== viewEpoch) return;
      historyOffset = initial ? offset : Math.min(historyOffset,offset);
      renderConversation({older,latest:initial,focusId});
    } catch (error) {
      if (epoch === viewEpoch) {
        message('task-message',error.status === 404 ? '当前实例未找到此会话。不能据此判断请求未到达，请核对服务地址、会话 ID 和调用方记录。' : '会话读取失败：' + error.message);
        if (!turnRows.size) { $('conversation-empty').textContent = '会话记录读取失败，请重试'; $('conversation-empty').classList.remove('hidden'); }
      }
    } finally { if (epoch === viewEpoch) { refreshEpoch = null; $('refresh-conversation').disabled = false; $('load-older').disabled = false; } }
  }
  async function selectSession(id, focusId, focusData) {
    resetTask(); selectedSession = id; $('session').value = id; $('active-session').textContent = id;
    $('conversation-empty').textContent = '正在读取会话记录…'; markSession(); message('task-message');
    const epoch = viewEpoch;
    await refreshConversation({initial:true,focusId});
    if (epoch === viewEpoch && focusData && !turnRows.has(focusId)) {
      turnRows.set(focusId,{summary:{...focusData,question:focusData.request?.question},data:focusData,ordinal:0});
      renderConversation({focusId});
    }
  }
  async function refreshHealth() {
    if (!$('task-view')) return;
    try {
      const health = await api('/v1/health');
      $('health-running').textContent = health.running; $('health-queued').textContent = health.queued;
      $('health-receiving').textContent = health.receiving ?? '—'; $('health-blocked').textContent = health.blocked ?? '—';
      $('health-capacity').textContent = `并发上限 ${serviceInfo?.maxConcurrent ?? '—'} · 队列上限 ${serviceInfo?.maxQueued ?? '—'}`;
      $('health-updated').textContent = '检查于 ' + new Date().toLocaleTimeString('zh-CN',{hour12:false});
      message('health-error',health.ready ? '' : '服务当前未就绪');
    } catch { for (const id of ['health-running','health-queued','health-receiving','health-blocked']) $(id).textContent = '—'; message('health-error','服务状态读取失败，当前调度情况未知'); }
  }
  function startMonitor() {
    clearTimeout(monitorTimer);
    if (!taskReady || $('task-view').classList.contains('hidden') || document.hidden || !$('auto-refresh').checked) return;
    monitorTimer = setTimeout(async () => {
      await refreshHealth(); await refreshConversation(); startMonitor();
    },5000);
  }
  async function refreshSessions() {
    const epoch = ++sessionListEpoch;
    const data = await api(`/v1/sessions?offset=${sessionsOffset}&limit=6`);
    if (epoch !== sessionListEpoch) return;
    sessionsTotal = data.total; $('sessions').replaceChildren();
    $('sessions-page').textContent = data.total ? `${sessionsOffset+1}–${sessionsOffset+data.items.length} / ${data.total}` : '共 0 个';
    syncTaskControls();
    if (!data.items.length) { const li = document.createElement('li'); li.className = 'muted'; li.textContent = '暂无会话'; $('sessions').append(li); return; }
    for (const session of data.items) {
      const li = document.createElement('li'), button = document.createElement('button'), remove = document.createElement('button');
      const text = document.createElement('span'), time = document.createElement('span');
      li.className = 'history-entry'; button.className = 'session-open'; button.type = 'button';
      button.dataset.sessionId = session.sessionId; button.disabled = !taskReady || submitting || !!deletingSessions.size;
      text.className = 'history-title mono'; text.textContent = session.sessionId; time.className = 'history-time'; time.textContent = formatTime(session.createdAt); button.append(text,time);
      remove.className = 'session-delete'; remove.type = 'button'; remove.textContent = '删除';
      remove.setAttribute('aria-label',`删除会话 ${session.sessionId}`);
      remove.disabled = button.disabled;
      li.append(button,remove); $('sessions').append(li);
      button.onclick = async () => {
        if (!submitting) await selectSession(session.sessionId);
      };
      remove.onclick = async () => {
        if (submitting || deletingSessions.size || !confirm(`确定删除会话 ${session.sessionId} 及其全部任务对话记录吗？调用审计日志和 Codex 原生历史仍会保留。此操作无法撤销。`)) return;
        deletingSessions.add(session.sessionId); syncTaskControls(); message('task-message');
        try {
          await api(`/console/sessions/${encodeURIComponent(session.sessionId)}`,{method:'DELETE'});
          if (selectedSession === session.sessionId) resetTask();
          else if ($('session').value.trim() === session.sessionId) $('session').value = '';
          if (sessionsOffset > 0 && sessionsOffset >= sessionsTotal - 1) sessionsOffset = Math.max(0,sessionsOffset - 6);
          await refreshSessions();
        } catch (error) { message('task-message',`删除会话失败：${error.message}`); }
        finally { deletingSessions.delete(session.sessionId); syncTaskControls(); }
      };
    }
    markSession();
  }
  async function ensureTaskConsole() {
    if (taskReady) return;
    message('task-message');
    try { serviceInfo = await api('/v1/info'); if (serviceInfo.runner !== 'codex') throw new Error('当前服务未启用真实 Codex 执行器'); applyServiceDefaults(); taskReady = true; await refreshSessions(); await refreshHealth(); startMonitor(); }
    catch (error) { message('task-message',error.message || String(error)); }
    finally { syncTaskControls(); }
  }
  function applyServiceDefaults() {
    const mode = serviceInfo?.accessMode || serviceInfo?.sandboxMode;
    if (['read-only','workspace-write','danger-full-access'].includes(mode)) $('sandbox-mode').value = mode;
    else $('sandbox-mode').value = 'danger-full-access';
  }
  async function reconnectTaskConsole() {
    $('reconnect').disabled = true; taskReady = false; syncTaskControls(); message('task-message'); serviceStatus('正在连接');
    try {
      await bootstrap();
      serviceInfo = await api('/v1/info');
      if (serviceInfo.runner !== 'codex') throw new Error('当前服务未启用真实 Codex 执行器');
      applyServiceDefaults();
      taskReady = true; await refreshSessions(); await refreshHealth(); startMonitor();
    } catch (error) {
      serviceStatus('连接失败','error'); message('task-message',error.message || String(error));
    } finally { $('reconnect').disabled = false; syncTaskControls(); }
  }
  function bindTaskEvents() {
  $('task-form').onsubmit = async event => {
    event.preventDefault(); if (!taskReady || submitting) return;
    if (!$('question').value.trim()) { message('task-message','请先填写问题内容。'); $('question').focus(); return; }
    message('task-message'); const request = {question:$('question').value,idempotencyKey:crypto.randomUUID()}; const rawContext = $('context').value.trim();
    const systemPrompt = $('system-prompt').value.trim();
    if (new TextEncoder().encode(systemPrompt).length > 16 * 1024) { message('task-message','系统提示词不能超过 16 KiB。'); $('system-prompt').focus(); return; }
    if (systemPrompt) request.systemPrompt = systemPrompt;
    if (rawContext) { try { const value = JSON.parse(rawContext); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); request.context = value; } catch { message('task-message','附加上下文必须是有效的 JSON 对象。'); return; } }
    request.sandboxMode = $('sandbox-mode').value;
    if ($('session').value.trim()) request.sessionId = $('session').value.trim();
    submitting = true; syncTaskControls();
    let accepted;
    try {
      accepted = await api('/v1/tasks',{method:'POST',body:JSON.stringify(request)});
      $('session').value = accepted.sessionId; $('question').value = ''; $('system-prompt').value = ''; $('context').value = '';
      if (selectedSession !== accepted.sessionId) await selectSession(accepted.sessionId,accepted.taskId,accepted);
      else { await refreshConversation({focusId:accepted.taskId}); }
      sessionsOffset = 0; await refreshSessions(); await refreshHealth(); startMonitor();
    }
    catch (error) {
      message('task-message',accepted ? `任务已接收：${accepted.taskId}，但页面同步失败，请按任务 ID 查询。` : error.status && error.status < 500 ? `服务拒绝提交：${error.message}` : `提交结果未知：${error.message}。请核对调用方记录，勿直接重复提交。幂等键：${request.idempotencyKey}`);
    }
    finally { submitting = false; syncTaskControls(); }
  };
  $('question').oninput = syncTaskControls;
  $('new-session').onclick = () => { $('session').value = ''; $('question').value = ''; $('system-prompt').value = ''; $('context').value = ''; resetTask(); syncTaskControls(); $('question').focus(); };
  $('refresh-sessions').onclick = () => { void refreshSessions().catch(error => message('task-message',error.message)); };
  for (const [id,step] of [['session-prev',-6],['session-next',6]]) $(id).onclick = () => { sessionsOffset = Math.max(0,sessionsOffset+step); void refreshSessions().catch(error => message('task-message',error.message)); };
  $('load-older').onclick = () => { void refreshConversation({older:true}); };
  $('refresh-conversation').onclick = () => { message('task-message'); void refreshConversation({force:true}); void refreshHealth(); };
  $('auto-refresh').onchange = startMonitor;
  document.addEventListener('visibilitychange',startMonitor);
  $('task-lookup').onsubmit = async event => {
    event.preventDefault(); if (submitting || !taskReady) return;
    const id = $('lookup-id').value.trim();
    if (!/^(task|sess)_[0-9a-f-]{36}$/.test(id)) { message('task-message','请输入完整的 task_ 或 sess_ ID'); return; }
    if (id.startsWith('sess_')) { await selectSession(id); return; }
    resetTask(); const epoch = viewEpoch; message('task-message');
    try { const item = await api('/v1/tasks/' + encodeURIComponent(id)); if (epoch === viewEpoch) await selectSession(item.sessionId,item.taskId,item); }
    catch (error) { if (epoch === viewEpoch) message('task-message',error.status === 404 ? '当前实例未找到此任务。不能据此判断请求未到达，请核对服务地址、任务 ID、鉴权和调用方记录。' : '任务读取失败：' + error.message); }
  };
    $('reconnect').onclick = () => { void reconnectTaskConsole(); };
  }
  bindTaskEvents();
  $('endpoint').value = location.origin;
  syncTaskControls();
  return {show:() => { void ensureTaskConsole(); startMonitor(); },hide:() => clearTimeout(monitorTimer),inspect:selectSession,refreshHealth};
}
