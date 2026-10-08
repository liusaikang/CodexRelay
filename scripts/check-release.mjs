import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { parseEnv } from 'node:util';

// Include both tracked and untracked non-ignored files so a first commit is checked too.
const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean))];
const forbiddenPath = /^(?:data\/|node_modules\/|dist\/|\.env(?:\.|$)(?!example$)|config\/(?:local|.*\.local)\.yaml$)|(?:^|\/)(?:\.ssh\/|\.codex\/|auth\.json$|id_rsa$|id_ed25519$)|\.(?:pem|p12|pfx|key)$/i;
const rules = [
  ['private-key', /-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['model-api-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{30,}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['webhook-secret', /qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[a-f0-9-]{30,}/i],
];
// Check known local values without printing or including them in source control.
let localEnv = {};
try { localEnv = parseEnv(await readFile('.env', 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const knownSecrets = ['CODEX_MCP_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'DASHSCOPE_API_KEY', 'CODEX_CONSOLE_PASSWORD']
  .flatMap(name => [process.env[name], localEnv[name]].filter(value => value && value.length >= 16).map(value => ({name,value})));
const issues = [];
for (const file of files) {
  if (forbiddenPath.test(file)) { issues.push(`${file}: private/runtime file included`); continue; }
  try {
    if ((await stat(file)).size > 2 * 1024 * 1024) continue;
    const bytes = await readFile(file);
    if (bytes.includes(0)) continue;
    const content = bytes.toString('utf8');
    for (const [name, pattern] of rules) if (pattern.test(content)) issues.push(`${file}: ${name}`);
    for (const {name,value} of knownSecrets) if (content.includes(value)) issues.push(`${file}: matches ${name}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (issues.length) {
  console.error(issues.join('\n'));
  process.exitCode = 1;
} else console.log(`Checked ${files.length} non-ignored source files; no matching private files or known secret patterns found.`);
