import { marked } from '/assets/marked.js';
import DOMPurify from '/assets/dompurify.js';

export function createSkillsPanel({api,formatTime}) {
  const $ = id => document.getElementById(id);
  const expanded = new Set(['workspace','.agents','.agents/skills']);
  let selected = '', content = '', mode = 'source', epoch = 0, loading = false, loaded = false;
  const el = (tag,text,className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const notice = value => { $('skills-message').textContent = value; $('skills-message').classList.toggle('hidden',!value); };
  const icon = name => { const symbol = el('i'); symbol.dataset.lucide = name; return symbol; };
  const size = bytes => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
  const allFiles = entries => entries.flatMap(entry => entry.kind === 'directory' ? allFiles(entry.children || []) : [entry]);
  function renderContent() {
    const markdown = selected.toLowerCase().endsWith('.md');
    const preview = markdown && mode === 'preview';
    $('skills-mode').classList.toggle('hidden', !markdown);
    for (const button of $('skills-mode').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    $('skills-wrap-control').classList.toggle('hidden', preview);
    $('skills-content').classList.toggle('hidden', preview);
    $('skills-rendered').classList.toggle('hidden', !preview);
    if (!preview) {
      $('skills-content').querySelector('code').textContent = content;
      return;
    }
    const safeHtml = DOMPurify.sanitize(marked.parse(content), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['img', 'video', 'audio', 'source', 'iframe', 'form', 'input', 'style'],
      FORBID_ATTR: ['style'],
    });
    $('skills-rendered').innerHTML = safeHtml;
    for (const link of $('skills-rendered').querySelectorAll('a[href]')) {
      const url = new URL(link.href, location.href);
      if (!['http:', 'https:'].includes(url.protocol)) link.removeAttribute('href');
      else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    }
  }
  function expandParents(path) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) expanded.add(parts.slice(0,i).join('/'));
  }
  function folder(name,key,children) {
    const details = el('details'); details.open = expanded.has(key);
    const summary = el('summary'); summary.title = name;
    summary.append(icon('folder'),el('span',name,'tree-label')); details.append(summary);
    details.addEventListener('toggle',() => { if (details.open) expanded.add(key); else expanded.delete(key); });
    for (const child of children) details.append(child);
    return details;
  }
  function renderEntry(entry) {
    if (entry.kind === 'directory') return folder(entry.name,entry.path,(entry.children || []).map(renderEntry));
    const button = el('button'); button.type = 'button'; button.title = entry.previewable ? entry.path : '不支持预览此文件';
    button.disabled = !entry.previewable; button.dataset.path = entry.path;
    button.setAttribute('aria-current',String(selected === entry.path));
    button.append(icon(entry.name.endsWith('.md') ? 'file-text' : 'file-code'),el('span',entry.name));
    button.onclick = () => { void openFile(entry.path); };
    return button;
  }
  function renderTree(tree) {
    $('skills-workspace').textContent = tree.workingDirectory;
    $('skills-tree').replaceChildren();
    const skills = folder('skills','.agents/skills',tree.entries.map(renderEntry));
    const agents = folder('.agents','.agents',[skills]);
    $('skills-tree').append(folder(tree.workingDirectory.split(/[\\/]/).filter(Boolean).at(-1) || '工作目录','workspace',[agents]));
    if (!tree.entries.length) $('skills-tree').append(el('p','当前工作目录中没有 Skill 文件','muted'));
    window.lucide?.createIcons();
  }
  async function openFile(path) {
    selected = path; const current = ++epoch;
    for (const button of $('skills-tree').querySelectorAll('button[data-path]')) button.setAttribute('aria-current',String(button.dataset.path === path));
    $('skills-file-name').textContent = path.split('/').at(-1);
    $('skills-file-path').textContent = `.agents/skills/${path}`;
    $('skills-meta').replaceChildren();
    $('skills-content').classList.add('hidden'); $('skills-rendered').classList.add('hidden'); $('skills-empty').classList.remove('hidden');
    $('skills-empty').textContent = '正在读取文件'; $('skills-copy').disabled = true; notice('');
    try {
      const file = await api('/console/skills/file?path='+encodeURIComponent(path));
      if (current !== epoch) return;
      content = file.content;
      mode = path.toLowerCase().endsWith('.md') ? 'preview' : 'source';
      renderContent();
      $('skills-meta').append(el('span',size(file.size)),el('span','修改于 '+formatTime(file.modifiedAt)),el('span','只读 · UTF-8'));
      $('skills-empty').classList.add('hidden');
      $('skills-copy').disabled = false;
    } catch (error) {
      if (current !== epoch) return;
      $('skills-empty').textContent = '文件暂时无法预览';
      notice('文件读取失败：'+error.message);
    }
  }
  async function load() {
    if (loading) return;
    loading = true; $('skills-refresh').disabled = true;
    try {
      const tree = await api('/console/skills');
      const files = allFiles(tree.entries).filter(file => file.previewable);
      if (!files.some(file => file.path === selected)) selected = files.find(file => file.name === 'SKILL.md')?.path || files[0]?.path || '';
      if (selected) expandParents(selected);
      renderTree(tree);
      loaded = true; notice('');
      if (selected) await openFile(selected);
      else { epoch++; content = ''; $('skills-file-name').textContent = '选择文件'; $('skills-file-path').textContent = '从左侧展开目录并选择文件';
        $('skills-meta').replaceChildren(); $('skills-content').classList.add('hidden'); $('skills-rendered').classList.add('hidden'); $('skills-mode').classList.add('hidden'); $('skills-empty').classList.remove('hidden');
        $('skills-empty').textContent = '当前没有可预览文件'; $('skills-copy').disabled = true; }
    } catch (error) { notice('目录读取失败：'+error.message); }
    finally { loading = false; $('skills-refresh').disabled = false; }
  }
  $('skills-refresh').onclick = () => { void load(); };
  for (const button of $('skills-mode').querySelectorAll('button')) button.onclick = () => { mode = button.dataset.mode; renderContent(); };
  $('skills-wrap').onchange = () => $('skills-content').classList.toggle('wrap',$('skills-wrap').checked);
  $('skills-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(content); notice('已复制文件内容。'); }
    catch { notice('复制失败，请手动选择内容。'); }
  };
  return { show() { if (!loaded) void load(); } };
}
