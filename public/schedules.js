export function createSchedulesPanel({api,formatTime,onInspect}) {
  const $ = id => document.getElementById(id);
  const node = (tag,value,className) => {
    const element = document.createElement(tag);
    if (value !== undefined) element.textContent = value;
    if (className) element.className = className;
    return element;
  };
  let visible = false, selectedId = '', timer, loading = false;
  const notice = value => { $('schedules-message').textContent = value; $('schedules-message').classList.toggle('hidden',!value); };
  const stateText = run => run.state === 'waiting' ? '等待工作位'
    : run.state === 'failed' ? '提交失败'
      : run.state === 'finished' ? ({succeeded:'成功',failed:'失败',timed_out:'超时',interrupted:'中断',cancelled:'取消'}[run.taskStatus] || run.taskStatus || '已结束')
        : run.taskStatus === 'queued' ? '任务排队中' : '执行中';
  function scheduleRefresh() {
    clearTimeout(timer);
    if (visible && !document.hidden) timer = setTimeout(() => { void load(); },5000);
  }
  async function operate(path,options,message) {
    try { await api(path,options); notice(message); await load(); }
    catch (error) { notice(`操作结果未确认，请刷新核对：${error.message}`); }
  }
  function renderRules(items) {
    $('schedule-list').replaceChildren();
    if (!items.length) $('schedule-list').append(node('p','暂无定时规则。','muted'));
    for (const rule of items) {
      const row = node('div',undefined,'schedule-row'); row.setAttribute('aria-current',String(selectedId === rule.id));
      const info = node('div');
      info.append(node('h3',rule.name),node('p',`每 ${rule.intervalMinutes} 分钟 · ${rule.enabled ? '已启用' : '已暂停'} · 执行 ${rule.running}/${rule.laneLimit} · 等待 ${rule.waiting}`),
        node('p',`下次触发：${rule.enabled ? formatTime(rule.nextRunAt) : '暂停'} · ${rule.question}`));
      const controls = node('div',undefined,'row');
      const inspect = node('button','查看轮次'); inspect.type = 'button'; inspect.onclick = () => { selectedId = rule.id; void load(); };
      const trigger = node('button','立即运行'); trigger.type = 'button'; trigger.onclick = () => {
        void operate(`/console/schedules/${rule.id}/run`,{method:'POST'},'已记录新的执行轮次。');
      };
      const toggle = node('button',rule.enabled ? '暂停' : '启用'); toggle.type = 'button'; toggle.onclick = () => {
        void operate(`/console/schedules/${rule.id}/enabled`,{method:'PUT',body:JSON.stringify({enabled:!rule.enabled})},
          rule.enabled ? '已暂停新的定时触发；已等待的轮次仍会继续。' : '已启用规则。');
      };
      controls.append(inspect,trigger,toggle); row.append(info,controls); $('schedule-list').append(row);
    }
  }
  async function renderRuns() {
    $('schedule-runs-body').replaceChildren();
    if (!selectedId) { $('schedule-runs-title').textContent = '选择规则查看执行轮次'; return; }
    const response = await api(`/console/schedules/${selectedId}/runs`);
    $('schedule-runs-title').textContent = `执行轮次 · 最近 ${Math.min(50,response.items.length)} 条`;
    for (const run of response.items.slice(-50).reverse()) {
      const row = node('tr'), status = node('td',stateText(run));
      if (run.error) status.append(node('div',run.error,'muted'));
      const task = node('td');
      if (run.taskId && run.sessionId) {
        const link = node('button',run.taskId,'mono'); link.type = 'button'; link.onclick = () => { void onInspect(run).catch(error => notice(error.message)); };
        task.append(link);
      } else task.textContent = '—';
      row.append(node('td',formatTime(run.scheduledAt)),status,node('td',run.laneIndex === undefined ? '—' : String(run.laneIndex+1)),task);
      $('schedule-runs-body').append(row);
    }
    if (!response.items.length) {
      const row = node('tr'), cell = node('td','尚无执行轮次','muted'); cell.colSpan = 4; row.append(cell); $('schedule-runs-body').append(row);
    }
  }
  async function load() {
    if (loading) return;
    loading = true; clearTimeout(timer); $('schedules-refresh').disabled = true;
    try {
      const response = await api('/console/schedules');
      if (selectedId && !response.items.some(item => item.id === selectedId)) selectedId = '';
      renderRules(response.items); await renderRuns();
    } catch (error) { notice(`定时任务读取失败：${error.message}`); }
    finally { loading = false; $('schedules-refresh').disabled = false; scheduleRefresh(); }
  }
  $('schedule-form').onsubmit = async event => {
    event.preventDefault();
    const form = $('schedule-form');
    if (!form.reportValidity()) return;
    const request = {name:$('schedule-name').value.trim(),question:$('schedule-question').value.trim(),
      intervalMinutes:Number($('schedule-interval').value),enabled:true};
    const submit = form.querySelector('[type=submit]'); submit.disabled = true;
    try {
      const rule = await api('/console/schedules',{method:'POST',body:JSON.stringify(request)});
      selectedId = rule.id; form.reset(); $('schedule-interval').value = '5'; notice('规则已创建，下次触发时间已写入持久化记录。'); await load();
    } catch (error) { notice(`创建结果未确认，请刷新检查规则是否已经存在：${error.message}`); }
    finally { submit.disabled = false; }
  };
  $('schedules-refresh').onclick = () => { notice(''); void load(); };
  document.addEventListener('visibilitychange',scheduleRefresh);
  return { show() { visible = true; void load(); }, hide() { visible = false; clearTimeout(timer); } };
}
