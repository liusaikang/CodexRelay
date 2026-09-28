export function createSettingsPanel({ api, formatTime, refreshHealth }) {
  const $ = id => document.getElementById(id);
  const form = $('settings-form');
  let snapshot;
  let busy = false;

  function values() {
    return {
      maxConcurrent: Number($('setting-max-concurrent').value),
      maxQueued: Number($('setting-max-queued').value),
      timeoutSeconds: Number($('setting-timeout').value),
      queueTimeoutSeconds: Number($('setting-queue-timeout').value),
      defaultModel: $('setting-model').value.trim() || null,
      defaultReasoningEffort: $('setting-effort').value || null,
      invocationLog: {
        enabled: $('setting-log-enabled').checked,
        retentionDays: Number($('setting-retention').value),
      },
    };
  }

  function fill(settings) {
    $('setting-max-concurrent').value = settings.maxConcurrent;
    $('setting-max-queued').value = settings.maxQueued;
    $('setting-timeout').value = settings.timeoutSeconds;
    $('setting-queue-timeout').value = settings.queueTimeoutSeconds;
    $('setting-model').value = settings.defaultModel ?? '';
    $('setting-effort').value = settings.defaultReasoningEffort ?? '';
    $('setting-log-enabled').checked = settings.invocationLog.enabled;
    $('setting-retention').value = settings.invocationLog.retentionDays;
    sync();
  }

  function dirty() {
    return !!snapshot && JSON.stringify(values()) !== JSON.stringify(snapshot.settings);
  }

  function feedback(text = '', error = false) {
    $('settings-feedback').textContent = text;
    $('settings-feedback').classList.toggle('error', error);
  }

  function sync() {
    const changed = dirty();
    $('settings-save').disabled = busy || !changed;
    $('settings-cancel').disabled = busy || !changed;
    $('settings-defaults').disabled = busy || !snapshot;
    $('settings-refresh').disabled = busy;
    $('settings-summary').textContent = changed ? '有未保存的修改' : '仅显示可在线调整的运行参数';
  }

  function render(data) {
    snapshot = data;
    $('settings-revision').textContent = `版本 ${data.revision}`;
    $('settings-updated').textContent = data.updatedAt
      ? `${formatTime(data.updatedAt)} · ${data.updatedBy ?? '未知用户'}` : '使用基础配置';
    $('settings-log-health').textContent = !data.settings.invocationLog.enabled
      ? '日志已关闭；已有文件保留。'
      : data.logging?.healthy === false ? '日志存储异常，记录可能不完整。' : '日志正在记录。';
    fill(data.settings);
  }

  async function load(force = false) {
    if (busy || (snapshot && !force)) return;
    busy = true; sync();
    try {
      const data = await api('/console/settings');
      render(data);
      $('settings-message').classList.add('hidden');
      feedback();
    } catch (error) {
      $('settings-message').textContent = error.message || '无法读取运行配置';
      $('settings-message').classList.remove('hidden');
    } finally { busy = false; sync(); }
  }

  form.addEventListener('input', () => { feedback(); sync(); });
  form.addEventListener('change', () => { feedback(); sync(); });
  $('settings-refresh').addEventListener('click', () => {
    if (dirty() && !window.confirm('放弃未保存的修改并重新读取配置？')) return;
    void load(true);
  });
  $('settings-defaults').addEventListener('click', () => { if (snapshot) { fill(snapshot.defaults); feedback('基础值已载入，保存后才会生效。'); } });
  $('settings-cancel').addEventListener('click', () => { if (snapshot) { fill(snapshot.settings); feedback('已撤销未保存的修改。'); } });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!snapshot || busy || !dirty() || !form.reportValidity()) return;
    const settings = values();
    if (snapshot.settings.invocationLog.enabled && !settings.invocationLog.enabled
      && !window.confirm('关闭后不再记录新调用，已有日志文件仍会保留。确定继续？')) return;
    if (settings.invocationLog.retentionDays < snapshot.settings.invocationLog.retentionDays
      && !window.confirm('缩短保留期将清理超期调用日志，确定继续？')) return;
    busy = true; sync(); feedback('正在保存…');
    try {
      const data = await api('/console/settings', { method: 'PUT', body: JSON.stringify({ revision: snapshot.revision, settings }) });
      render(data);
      feedback('已保存并应用。');
      void refreshHealth();
    } catch (error) {
      feedback(error.status === 409 ? '配置已由其他页面更改。请先刷新再保存。' : (error.message || '保存失败'), true);
    } finally { busy = false; sync(); }
  });

  return { load };
}
