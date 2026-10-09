import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillExplorer } from '../src/skills.js';

const cleanup: string[] = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'relay-skills-'));
  cleanup.push(workspace);
  const root = join(workspace, '.agents', 'skills');
  await mkdir(join(root, 'sample', 'scripts'), { recursive: true });
  await writeFile(join(root, 'sample', 'SKILL.md'), '---\nname: sample\n---\n# Sample\n', 'utf8');
  await writeFile(join(root, 'sample', 'scripts', 'audit.py'), 'print("中文")\n', 'utf8');
  await writeFile(join(root, 'sample', 'scripts', 'credentials.json'), '{"secret":"hidden"}', 'utf8');
  await writeFile(join(root, 'sample', 'scripts', 'large.md'), 'a'.repeat(512 * 1024 + 1), 'utf8');
  await writeFile(join(root, 'sample', 'scripts', 'binary.md'), Buffer.from([0,1,2]));
  return { workspace, root, explorer: new SkillExplorer(workspace) };
}

it('lists Skill folders and reads bounded UTF-8 files without exposing sensitive names', async () => {
  const { explorer } = await fixture();
  const tree = await explorer.tree();
  expect(tree.root).toBe('.agents/skills');
  expect(tree.entries).toHaveLength(1);
  const sample = tree.entries[0]!;
  expect(sample.name).toBe('sample');
  expect(sample.children?.find(child => child.name === 'SKILL.md')?.previewable).toBe(true);
  const scripts = sample.children?.find(child => child.name === 'scripts');
  expect(scripts?.children?.map(file => file.name)).not.toContain('credentials.json');
  expect(scripts?.children?.find(file => file.name === 'large.md')?.previewable).toBe(false);
  expect((await explorer.file('sample/SKILL.md')).content).toContain('# Sample');
  expect((await explorer.file('sample/scripts/audit.py')).content).toContain('中文');
  await expect(explorer.file('sample/scripts/binary.md')).rejects.toMatchObject({ code: 'SKILL_FILE_UNSUPPORTED' });
  await expect(explorer.file('sample/scripts/credentials.json')).rejects.toMatchObject({ code: 'INVALID_SKILL_PATH' });
});

it('rejects traversal and linked content outside the configured Skill root', async () => {
  const { workspace, root, explorer } = await fixture();
  await writeFile(join(workspace, 'outside.md'), 'PRIVATE');
  for (const path of ['../outside.md', 'sample/../SKILL.md', 'sample\\SKILL.md', 'C:/outside.md']) {
    await expect(explorer.file(path)).rejects.toMatchObject({ code: 'INVALID_SKILL_PATH' });
  }
  try {
    await symlink(join(workspace, 'outside.md'), join(root, 'sample', 'linked.md'));
    expect((await explorer.tree()).entries[0]?.children?.some(entry => entry.name === 'linked.md')).toBe(false);
    await expect(explorer.file('sample/linked.md')).rejects.toMatchObject({ code: 'SKILL_LINK_DENIED' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  }
});

it('returns an empty tree when the project has no Skill directory', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'relay-skills-empty-'));
  cleanup.push(workspace);
  expect((await new SkillExplorer(workspace).tree()).entries).toEqual([]);
});
