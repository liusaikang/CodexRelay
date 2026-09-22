import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';

// Include both tracked and untracked non-ignored files so a first commit is checked too.
const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean))];
const forbiddenPath = /^(?:data\/|node_modules\/|dist\/|\.env(?:\.|$)(?!example$)|config\/(?:local|.*\.local)\.yaml$)|(?:^|\/)(?:auth\.json|id_rsa|id_ed25519)$/;
const rules = [
  ['private-key', /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/],
  ['model-api-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{30,}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['webhook-secret', /qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[a-f0-9-]{30,}/i],
];
const issues = [];
for (const file of files) {
  if (forbiddenPath.test(file)) { issues.push(`${file}: private/runtime file included`); continue; }
  try {
    if ((await stat(file)).size > 2 * 1024 * 1024) continue;
    const bytes = await readFile(file);
    if (bytes.includes(0)) continue;
    const content = bytes.toString('utf8');
    for (const [name, pattern] of rules) if (pattern.test(content)) issues.push(`${file}: ${name}`);
    for (const name of ['CODEX_MCP_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY']) {
      const secret = process.env[name];
      if (secret && secret.length >= 24 && content.includes(secret)) issues.push(`${file}: matches ${name}`);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (issues.length) {
  console.error(issues.join('\n'));
  process.exitCode = 1;
} else console.log(`Checked ${files.length} non-ignored source files; no matching private files or known secret patterns found.`);
