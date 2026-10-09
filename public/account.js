export function createAccountPanel({api,formatTime,message,codexRunner}) {
  const $ = id => document.getElementById(id);
  let accountAuthenticated = false, loginState = {status:'idle'}, loginTimer;
  function setQuota(prefix, quota) {
    const remaining = typeof quota?.remainingPercent === 'number' ? Math.max(0,Math.min(100,quota.remainingPercent)) : null;
    const used = typeof quota?.usedPercent === 'number' ? quota.usedPercent : null;
    $(prefix + 'remaining').textContent = remaining === null ? '暂不可用' : remaining.toFixed(0) + '% 剩余';
    $(prefix + 'used').textContent = used === null ? '已使用 —' : '已使用 ' + used.toFixed(0) + '%';
    $(prefix + 'reset').textContent = quota?.resetsAt ? '重置于 ' + formatTime(quota.resetsAt) : '重置时间 —';
    const bar = $(prefix ? prefix + 'bar' : 'remaining-bar'); bar.style.width = (remaining ?? 0) + '%'; bar.parentElement.setAttribute('aria-valuenow',String(remaining ?? 0));
  }
  function renderAccount(account) {
    const authenticated = account?.available && account?.authenticated;
    accountAuthenticated = !!authenticated;
    $('account').textContent = authenticated ? account.email || 'ChatGPT 账号' : account?.available ? '未登录 Codex' : '账号状态暂不可用';
    $('plan').textContent = authenticated && account.plan ? account.plan : ''; $('plan').classList.toggle('hidden',!authenticated || !account.plan);
    $('login-method').textContent = authenticated ? (account.method === 'chatgpt' ? '通过 ChatGPT 账号登录' : '登录方式：' + account.method) : account?.available ? '请在服务端完成 Codex 登录' : '无法从 Codex App Server 读取账号';
    setQuota('',account?.quota?.primary); const secondary = account?.quota?.secondary; $('secondary').classList.toggle('hidden',!secondary); if (secondary) setQuota('secondary-',secondary);
    $('reset-credits').textContent = typeof account?.credits?.availableResetCount === 'number' ? account.credits.availableResetCount + ' 次' : '—'; $('checked-at').textContent = formatTime(account?.checkedAt);
    $('start-codex-login').classList.toggle('hidden',!codexRunner || authenticated || ['starting','pending'].includes(loginState.status));
    message('account-message',account?.error ? '暂时无法读取 Codex 账号状态，请确认服务端已安装并登录 Codex。' : '');
  }
  function renderLogin(state) {
    const previous = loginState.status;
    loginState = state;
    clearTimeout(loginTimer);
    const pending = state.status === 'pending';
    $('codex-login-flow').classList.toggle('hidden',!pending);
    $('start-codex-login').classList.toggle('hidden',!codexRunner || accountAuthenticated || pending || state.status === 'starting');
    if (pending) {
      $('codex-login-code').textContent = state.userCode || '';
      $('codex-login-link').href = state.verificationUrl;
    } else $('codex-login-link').removeAttribute('href');
    const feedback = $('codex-login-feedback');
    feedback.textContent = pending ? '等待浏览器完成授权…' : state.status === 'starting' ? '正在请求设备验证码…' :
      state.status === 'succeeded' ? '登录成功，正在刷新账号额度。' : state.status === 'failed' ? (state.message || '登录未完成，请重试。') : '';
    feedback.classList.toggle('hidden',!feedback.textContent);
    feedback.classList.toggle('error',state.status === 'failed');
    if (pending) loginTimer = setTimeout(() => { void loadLoginState(); },3000);
    if (state.status === 'succeeded' && previous !== 'succeeded') void loadAccount(true);
  }
  async function loadLoginState() {
    if (!codexRunner) return;
    try { renderLogin(await api('/console/codex-login')); }
    catch (error) {
      clearTimeout(loginTimer);
      $('codex-login-feedback').textContent = error.message || '无法读取登录状态';
      $('codex-login-feedback').classList.remove('hidden');
      $('codex-login-feedback').classList.add('error');
    }
  }
  async function startCodexLogin() {
    if (!codexRunner || ['starting','pending'].includes(loginState.status)) return;
    const loginWindow = window.open('about:blank','_blank');
    renderLogin({status:'starting'});
    try {
      const state = await api('/console/codex-login/start',{method:'POST'});
      renderLogin(state);
      if (loginWindow && state.status === 'pending') {
        loginWindow.opener = null;
        loginWindow.location.replace(state.verificationUrl);
      } else loginWindow?.close();
    } catch (error) {
      loginWindow?.close();
      renderLogin({status:'failed',message:error.message || '无法发起 Codex 登录'});
    }
  }
  async function loadAccount(force = false) {
    $('refresh-account').disabled = true; message('account-message');
    try { renderAccount(await api(force ? '/v1/admin/account/refresh' : '/v1/admin/account',force ? {method:'POST'} : {})); }
    catch (error) {
      renderAccount({available:false,authenticated:false});
      message('account-message',error.name === 'TimeoutError' ? '账号额度查询超时，请点击刷新重试。' : error.message || String(error));
    }
    finally { $('refresh-account').disabled = false; }
  }
  function bindAccountEvents() {
  $('refresh-account').onclick = () => { void loadAccount(true); void loadLoginState(); };
  $('start-codex-login').onclick = () => { void startCodexLogin(); };
  $('copy-codex-code').onclick = async () => {
    try { await navigator.clipboard.writeText(loginState.userCode || ''); $('codex-login-feedback').textContent = '验证码已复制，等待浏览器完成授权。'; }
    catch { $('codex-login-feedback').textContent = '复制失败，请手动选择验证码。'; }
  };
  $('cancel-codex-login').onclick = async () => {
    try { renderLogin(await api('/console/codex-login/cancel',{method:'POST'})); }
    catch (error) { renderLogin({status:'failed',message:error.message || '取消登录失败'}); }
  };
  }
  bindAccountEvents();
  return {load:async () => { await Promise.all([loadAccount(),loadLoginState()]); }};
}
