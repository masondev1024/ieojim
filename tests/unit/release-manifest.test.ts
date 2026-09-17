import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareReleaseManifest } from '../../scripts/release-manifest';

const makeProject = async () => {
  const projectRoot = join(tmpdir(), `ieojim-release-${randomUUID()}`);
  await mkdir(join(projectRoot, 'dist', 'assets'), { recursive: true });
  await mkdir(join(projectRoot, 'artifacts', 'release-candidate', 'worker'), { recursive: true });
  await mkdir(join(projectRoot, 'migrations'), { recursive: true });
  await writeFile(join(projectRoot, 'dist', 'index.html'), '<div>app</div>');
  await writeFile(join(projectRoot, 'dist', 'assets', 'index.js'), 'console.log("compiled");');
  await writeFile(join(projectRoot, 'artifacts', 'release-candidate', 'worker', 'worker.js'), 'export default {};');
  await writeFile(join(projectRoot, 'artifacts', 'release-candidate', 'worker', 'worker.js.map'), '{"sourcesContent":["raw source"]}');
  await writeFile(join(projectRoot, 'migrations', '0001.sql'), 'CREATE TABLE test (id TEXT);');
  await writeFile(join(projectRoot, 'wrangler.jsonc'), '{ "name": "ieojim" }');
  await writeFile(join(projectRoot, 'package-lock.json'), '{ "lockfileVersion": 3 }');
  await writeFile(join(projectRoot, '.dev.vars'), 'GEMINI_API_KEY=secret');
  await writeFile(join(projectRoot, '.env.production'), 'GEMINI_API_KEY=secret');
  await writeFile(join(projectRoot, 'artifacts', 'release-candidate', 'worker', '.dev.vars'), 'SECRET=bad');
  await writeFile(join(projectRoot, 'artifacts', 'release-candidate', 'worker', '.env'), 'SECRET=bad');
  return {
    projectRoot,
    cleanup: () => rm(projectRoot, { recursive: true, force: true }),
  };
};

describe('release manifest', () => {
  it('copies the offline candidate bundle and hashes file bytes consistently', async () => {
    const project = await makeProject();
    try {
      const now = new Date('2026-09-09T00:00:00.000Z');
      const first = await prepareReleaseManifest({ projectRoot: project.projectRoot, now });
      const second = await prepareReleaseManifest({ projectRoot: project.projectRoot, now });
      expect(first).toEqual(second);
      expect(first).toMatchObject({
        schema: 'ieojim.release-manifest.v1',
        target: 'local-validation',
        buildTime: '2026-09-09T00:00:00.000Z',
        git: { commit: null, dirty: true },
      });
      expect(first.files.map((file) => file.path)).toEqual([
        'dist/assets/index.js',
        'dist/index.html',
        'migrations/0001.sql',
        'package-lock.json',
        'worker/worker.js',
        'wrangler.jsonc',
      ]);
      expect(first.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256) && file.bytes > 0)).toBe(true);
      const workerFile = first.files.find((file) => file.path === 'worker/worker.js');
      expect(workerFile?.sha256).toBe(createHash('sha256').update('export default {};').digest('hex'));
      const manifest = JSON.parse(await readFile(join(project.projectRoot, 'artifacts', 'release-candidate', 'manifest.json'), 'utf8'));
      expect(manifest).toEqual(first);
      expect(await readFile(join(project.projectRoot, 'artifacts', 'release-candidate', 'dist', 'index.html'), 'utf8')).toBe('<div>app</div>');
      await expect(stat(join(project.projectRoot, 'artifacts', 'release-candidate', 'worker', 'worker.js.map'))).rejects.toThrow();
    } finally {
      await project.cleanup();
    }
  });

  it('fails when required build or dry-run inputs are missing', async () => {
    const project = await makeProject();
    try {
      await rm(join(project.projectRoot, 'artifacts', 'release-candidate', 'worker'), { recursive: true, force: true });
      await expect(prepareReleaseManifest({ projectRoot: project.projectRoot }))
        .rejects.toThrow('Required release candidate input is missing: artifacts/release-candidate/worker');
    } finally {
      await project.cleanup();
    }
  });

  it('fails when dist, migrations or worker entrypoint are empty or incomplete', async () => {
    const project = await makeProject();
    try {
      await rm(join(project.projectRoot, 'dist', 'index.html'), { force: true });
      await expect(prepareReleaseManifest({ projectRoot: project.projectRoot }))
        .rejects.toThrow('Required release candidate input is missing: dist/index.html');
      await writeFile(join(project.projectRoot, 'dist', 'index.html'), '<div>app</div>');
      await rm(join(project.projectRoot, 'migrations', '0001.sql'), { force: true });
      await expect(prepareReleaseManifest({ projectRoot: project.projectRoot }))
        .rejects.toThrow('Required release candidate input has no migration SQL files: migrations');
      await writeFile(join(project.projectRoot, 'migrations', '0001.sql'), 'CREATE TABLE test (id TEXT);');
      await rm(join(project.projectRoot, 'artifacts', 'release-candidate', 'worker', 'worker.js'), { force: true });
      await expect(prepareReleaseManifest({ projectRoot: project.projectRoot }))
        .rejects.toThrow('Required release candidate input has no Worker entrypoint .js or .mjs file');
    } finally {
      await project.cleanup();
    }
  });

  it('excludes secrets, removes stale candidate files and rejects symlinks in allowlisted inputs', async () => {
    const project = await makeProject();
    try {
      await writeFile(join(project.projectRoot, 'artifacts', 'release-candidate', 'foo.txt'), 'stale arbitrary file');
      await writeFile(join(project.projectRoot, 'artifacts', 'release-candidate', 'worker', 'foo.txt'), 'stale worker file');
      await writeFile(join(project.projectRoot, 'migrations', 'README.md'), 'stale migration note');
      const manifest = await prepareReleaseManifest({ projectRoot: project.projectRoot });
      const serialized = JSON.stringify(manifest);
      expect(serialized).not.toContain('GEMINI_API_KEY');
      expect(serialized).not.toContain('SECRET=bad');
      expect(serialized).not.toContain('stale arbitrary file');
      expect(serialized).not.toContain('stale worker file');
      expect(serialized).not.toContain('stale migration note');
      expect(serialized).not.toContain('raw source');
      await expect(stat(join(project.projectRoot, 'artifacts', 'release-candidate', 'worker', '.dev.vars'))).rejects.toThrow();
      await expect(stat(join(project.projectRoot, 'artifacts', 'release-candidate', 'worker', '.env'))).rejects.toThrow();
      await expect(stat(join(project.projectRoot, 'artifacts', 'release-candidate', 'worker', 'foo.txt'))).rejects.toThrow();
      await expect(stat(join(project.projectRoot, 'artifacts', 'release-candidate', 'migrations', 'README.md'))).rejects.toThrow();
      expect(await readdir(join(project.projectRoot, 'artifacts', 'release-candidate'))).toEqual(expect.not.arrayContaining(['foo.txt']));
      await symlink('/tmp', join(project.projectRoot, 'dist', 'escape'));
      await expect(prepareReleaseManifest({ projectRoot: project.projectRoot }))
        .rejects.toThrow('Symlink is not allowed in release candidate inputs');
    } finally {
      await project.cleanup();
    }
  });

  it('rejects release candidate path component symlinks before deleting or copying files', async () => {
    const project = await makeProject();
    const externalRoot = join(tmpdir(), `ieojim-release-external-${randomUUID()}`);
    try {
      await mkdir(externalRoot, { recursive: true });
      await rm(join(project.projectRoot, 'artifacts', 'release-candidate'), { recursive: true, force: true });
      await symlink(externalRoot, join(project.projectRoot, 'artifacts', 'release-candidate'));
      await expect(prepareReleaseManifest({ projectRoot: project.projectRoot }))
        .rejects.toThrow('Symlink is not allowed in release candidate path components');
      await expect(stat(externalRoot)).resolves.toEqual(expect.any(Object));
    } finally {
      await project.cleanup();
      await rm(externalRoot, { recursive: true, force: true });
    }
  });
});
