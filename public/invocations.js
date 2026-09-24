export function createInvocationPanel({ api, formatTime, labels }) {
  const $ = id => document.getElementById(id);
  const limit = 20;
  let offset = 0, total = 0, enabled = false, loading = false, generation = 0;
  let filters = new URLSearchParams();
  const duration = ms => ms === null ? '—' : (ms / 1000).toFixed(1) + ' s';
  const message = text => { $('logs-message').textContent = text; $('logs-message').classList.toggle('hidden', !text); };
  function controls() {
    $('logs-refresh').disabled = loading;
    $('logs-prev').disabled = loading || !enabled || offset === 0;
    $('logs-next').disabled = loading || !enabled || offset + limit >= total;
  }
  function resetDisplay() {
    $('logs-rows').replaceChildren();
    for (const id of ['total', 'rate', 'failed', 'duration', 'tokens']) $('logs-' + id).textContent = '—';
    $('logs-empty').classList.remove('hidden'); $('logs-empty').textContent = '正在读取…';
    $('logs-range').textContent = '—'; total = 0;
  }
  async function detail(id) {
    const current = ++generation;
    try {
      const row = await api('/v1/admin/invocations/' + encodeURIComponent(id));
      if (current !== generation) return;
      $('logs-detail-meta').replaceChildren();
      for (const [label, value] of [['任务 ID', row.taskId], ['会话 ID', row.sessionId], ['调用来源', row.transport], ['状态', labels[row.status]], ['提交时间', formatTime(row.receivedAt)], ['开始时间', formatTime(row.startedAt)], ['结束时间', formatTime(row.finishedAt)], ['执行耗时', duration(row.durationMs)]]) {
        const dt = document.createElement('dt'), dd = document.createElement('dd');
        dt.textContent = label; dd.textContent = value; $('logs-detail-meta').append(dt, dd);
      }
      $('logs-detail-question').textContent = row.question;
      $('logs-detail-context').textContent = row.context ? JSON.stringify(row.context, null, 2) : '未提供';
      $('logs-detail-result').textContent = row.resultMarkdown ?? '尚无返回结果';
      $('logs-detail-error').textContent = row.error ? `${row.error.code}\n${row.error.message}` : '无';
      $('logs-detail-usage').textContent = row.usage ? JSON.stringify(row.usage, null, 2) : '未报告';
      $('logs-detail').showModal();
    } catch (error) { if (current === generation) message(error.message || '读取详情失败'); }
  }
  async function load() {
    const current = ++generation;
    loading = true; controls(); message(''); resetDisplay(); $('logs-detail').close();
    const query = new URLSearchParams(filters); query.set('offset', String(offset)); query.set('limit', String(limit));
    try {
      const [list, summary] = await Promise.all([
        api('/v1/admin/invocations?' + query), api('/v1/admin/invocations/summary?' + filters),
      ]);
      if (current !== generation) return;
      enabled = list.enabled; total = list.total;
      if (!enabled) {
        $('logs-empty').textContent = '调用日志未启用';
        message('请在服务配置中设置 invocationLog.enabled: true，重启后开始记录。'); return;
      }
      if (!list.healthy || !summary.healthy) message('日志存储异常，记录可能不完整。请检查日志目录后重启服务。');
      if (offset >= total && offset > 0) { offset = Math.max(0, Math.floor((total - 1) / limit) * limit); return await load(); }
      $('logs-total').textContent = summary.total.toLocaleString();
      $('logs-rate').textContent = summary.successRate === null ? '—' : summary.successRate.toFixed(1) + '%';
      $('logs-failed').textContent = summary.failed.toLocaleString();
      $('logs-duration').textContent = duration(summary.averageDurationMs);
      $('logs-tokens').textContent = summary.usageKnownTasks ? summary.totalTokens.toLocaleString() : '—';
      $('logs-tokens').title = `${summary.usageKnownTasks} 个任务报告了用量`;
      $('logs-empty').classList.toggle('hidden', list.items.length > 0);
      $('logs-empty').textContent = '暂无符合条件的调用记录';
      $('logs-range').textContent = total ? `${offset + 1}–${Math.min(offset + limit, total)} / 共 ${total} 条` : '共 0 条';
      for (const row of list.items) {
        const tr = document.createElement('tr');
        for (const value of [formatTime(row.receivedAt), row.questionPreview, row.resultPreview || '—', `${labels[row.status]} / ${row.transport}`, duration(row.durationMs), row.totalTokens === null ? '—' : row.totalTokens.toLocaleString()]) {
          const td = document.createElement('td'); td.textContent = value; tr.append(td);
        }
        const td = document.createElement('td'), button = document.createElement('button');
        button.type = 'button'; button.className = 'icon'; button.title = '查看调用详情'; button.setAttribute('aria-label', '查看调用详情');
        const icon = document.createElement('i'); icon.dataset.lucide = 'file-text'; button.append(icon);
        button.onclick = () => { void detail(row.taskId); }; td.append(button); tr.append(td); $('logs-rows').append(tr);
      }
      window.lucide?.createIcons();
    } catch (error) {
      if (current !== generation) return;
      message(error.message || '读取调用日志失败'); $('logs-empty').textContent = '无法读取调用记录';
    } finally { if (current === generation) { loading = false; controls(); } }
  }
  $('logs-filters').onsubmit = event => {
    event.preventDefault();
    const next = new URLSearchParams();
    for (const key of ['from', 'to']) {
      const value = $('logs-' + key).value;
      if (value) { const date = new Date(value); if (Number.isNaN(date.getTime())) { message('请输入有效时间'); return; } next.set(key, date.toISOString()); }
    }
    if (next.has('from') && next.has('to') && next.get('from') > next.get('to')) { message('起始时间不能晚于截止时间'); return; }
    for (const key of ['status', 'keyword']) { const value = $('logs-' + key).value.trim(); if (value) next.set(key, value); }
    filters = next; offset = 0; void load();
  };
  $('logs-filters').onreset = () => { filters = new URLSearchParams(); offset = 0; void load(); };
  $('logs-refresh').onclick = () => { void load(); };
  $('logs-prev').onclick = () => { offset = Math.max(0, offset - limit); void load(); };
  $('logs-next').onclick = () => { offset += limit; void load(); };
  $('logs-close').onclick = () => $('logs-detail').close();
  return { load };
}
