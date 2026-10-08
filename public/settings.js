export function createSettingsPanel({ api, formatTime, refreshHealth }) {
  const $ = id => document.getElementById(id);
  const form = $('settings-form');
  const effortOptions = Array.from($('setting-effort').options);
  let snapshot;
  let busy = false;

  function values() {
    return {
      maxConcurrent: Number($('setting-max-concurrent').value),
      maxQueued: Number($('setting-max-queued').value),
      timeoutSeconds: Number($('setting-timeout').value),
      queueTimeoutSeconds: Number($('setting-queue-timeout').value),
      activeProvider: $('setting-provider').value,
      defaultModel: $('setting-model').value || null,
      defaultReasoningEffort: $('setting-effort').value,
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
    $('setting-provider').replaceChildren(...(snapshot?.providers ?? []).map(provider => {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.label;
      return option;
    }));
    $('setting-provider').value = settings.activeProvider;
    showProvider(settings.defaultModel);
    showEfforts(settings.defaultReasoningEffort ?? 'high');
    $('setting-log-enabled').checked = settings.invocationLog.enabled;
    $('setting-retention').value = settings.invocationLog.retentionDays;
    sync();
  }

  function showProvider(selectedModel = null) {
    const provider = snapshot?.providers?.find(item => item.id === $('setting-provider').value);
    $('setting-endpoint').textContent = provider?.baseUrl ?? 'Codex 内置 OpenAI 地址';
    $('setting-credential').textContent = provider?.credentialConfigured ? '认证配置已检测到，连通性以实际调用为准。'
      : '尚未检测到该供应商的认证配置，切换后任务可能失败。';
    const models = [...new Set([...(provider?.models ?? []), ...(provider?.defaultModel ? [provider.defaultModel] : []),
      ...(selectedModel ? [selectedModel] : [])])];
    $('setting-model').replaceChildren(...models.map(model => {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      return option;
    }));
    $('setting-model').value = selectedModel ?? provider?.defaultModel ?? models[0] ?? '';
    $('setting-model').disabled = models.length === 0;
  }

  function showEfforts(preferred = $('setting-effort').value) {
    const flash = $('setting-provider').value === 'model_studio' && $('setting-model').value === 'qwen3.7-flash';
    const choices = flash ? effortOptions.filter(option => option.value === 'low' || option.value === 'medium') : effortOptions;
    $('setting-effort').replaceChildren(...choices);
    $('setting-effort').value = choices.some(option => option.value === preferred) ? preferred : 'medium';
    $('setting-effort-help').classList.toggle('hidden', !flash);
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
  $('setting-provider').addEventListener('change', () => {
    const provider = snapshot?.providers?.find(item => item.id === $('setting-provider').value);
    showProvider(provider?.defaultModel ?? provider?.models?.[0] ?? null);
    showEfforts('high');
    sync();
  });
  $('setting-model').addEventListener('change', () => { showEfforts(); sync(); });
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
    if (settings.activeProvider !== snapshot.settings.activeProvider || settings.defaultModel !== snapshot.settings.defaultModel
      || settings.defaultReasoningEffort !== snapshot.settings.defaultReasoningEffort) {
      const jobs = snapshot.jobs ?? { running: 0, queued: 0 };
      const provider = snapshot.providers?.find(item => item.id === settings.activeProvider);
      const warning = provider?.credentialConfigured ? '' : '目标供应商尚未检测到认证配置，任务可能失败。\n';
      if (!window.confirm(`${warning}当前运行中 ${jobs.running} 个、排队中 ${jobs.queued} 个任务将继续使用原配置；此后提交的所有入口任务使用新配置。确定切换？`)) return;
    }
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
