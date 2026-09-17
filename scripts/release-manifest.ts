import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

type ManifestFile = {
  path: string;
  bytes: number;
  sha256: string;
};

export type ReleaseManifest = {
  schema: 'ieojim.release-manifest.v1';
  buildTime: string;
  target: 'local-validation';
  git: {
    commit: string | null;
    dirty: boolean;
  };
  warnings: string[];
  files: ManifestFile[];
};

type PrepareOptions = {
  projectRoot?: string;
  now?: Date;
};

const execFileAsync = promisify(execFile);
const schema = 'ieojim.release-manifest.v1' as const;
const defaultCandidateDir = 'artifacts/release-candidate';
const copiedEntries = ['dist', 'migrations', 'wrangler.jsonc', 'package-lock.json'] as const;
const hashedEntries = ['dist', 'worker', 'migrations', 'wrangler.jsonc', 'package-lock.json'] as const;
const allowedTopLevelEntries = new Set<string>([...hashedEntries, 'manifest.json']);
const excludedPathParts = new Set(['.wrangler', 'manifest.json']);
const distAssetExtensions = new Set(['.css', '.gif', '.html', '.ico', '.jpg', '.jpeg', '.js', '.json', '.png', '.svg', '.txt', '.webp', '.woff', '.woff2']);

export const prepareReleaseManifest = async (options: PrepareOptions = {}): Promise<ReleaseManifest> => {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const candidateDir = resolve(projectRoot, defaultCandidateDir);
  const workerDir = resolve(projectRoot, defaultCandidateDir, 'worker');
  assertInside(projectRoot, candidateDir, 'candidate directory');
  assertInside(projectRoot, workerDir, 'worker directory');
  await assertNoSymlinkComponents(projectRoot, candidateDir);
  await assertNoSymlinkComponents(projectRoot, workerDir);

  await assertRequiredInputs(projectRoot, workerDir);
  await assertRunnableBundleInputs(projectRoot, workerDir);
  await mkdir(candidateDir, { recursive: true });
  await refreshCandidateCopies(projectRoot, candidateDir);
  await pruneExcludedCandidateFiles(candidateDir);

  const files = (await collectManifestFiles(candidateDir, hashedEntries))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0) throw new Error('Release candidate has no files to hash.');

  const manifest: ReleaseManifest = {
    schema,
    buildTime: (options.now ?? new Date()).toISOString(),
    target: 'local-validation',
    git: await gitState(projectRoot),
    warnings: [
      'Local validation bundle only; Cloudflare account, remote D1, Queue, cron and alert delivery are not provisioned or verified by this manifest.',
      'Worker dry-run output is reviewable build output, not proof of production deployment.',
    ],
    files,
  };
  await writeFile(join(candidateDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  return manifest;
};

const assertRequiredInputs = async (projectRoot: string, workerDir: string): Promise<void> => {
  for (const entry of copiedEntries) await assertExists(resolve(projectRoot, entry), entry);
  await assertExists(workerDir, relative(projectRoot, workerDir));
};

const assertRunnableBundleInputs = async (projectRoot: string, workerDir: string): Promise<void> => {
  await assertRegularFile(resolve(projectRoot, 'dist/index.html'), 'dist/index.html');
  if ((await collectFiles(resolve(projectRoot, 'migrations'))).filter((file) => file.endsWith('.sql')).length === 0) {
    throw new Error('Required release candidate input has no migration SQL files: migrations');
  }
  const workerFiles = await collectFiles(workerDir);
  if (!workerFiles.some((file) => file.endsWith('.js') || file.endsWith('.mjs'))) {
    throw new Error('Required release candidate input has no Worker entrypoint .js or .mjs file: artifacts/release-candidate/worker');
  }
};

const refreshCandidateCopies = async (projectRoot: string, candidateDir: string): Promise<void> => {
  await removeStaleCandidateEntries(candidateDir);
  for (const entry of copiedEntries) {
    const destination = join(candidateDir, entry);
    await rm(destination, { recursive: true, force: true });
    await copyAllowlisted(resolve(projectRoot, entry), destination, projectRoot);
  }
  await rm(join(candidateDir, 'manifest.json'), { force: true });
};

const removeStaleCandidateEntries = async (candidateDir: string): Promise<void> => {
  await mkdir(candidateDir, { recursive: true });
  const names = await readdir(candidateDir);
  await Promise.all(names
    .filter((name) => !allowedTopLevelEntries.has(name))
    .map((name) => rm(join(candidateDir, name), { recursive: true, force: true })));
};

const collectManifestFiles = async (candidateDir: string, entries: readonly string[]): Promise<ManifestFile[]> => {
  const files = await Promise.all(entries.map((entry) => collectPath(join(candidateDir, entry), candidateDir)));
  return files.flat();
};

const pruneExcludedCandidateFiles = async (candidateDir: string): Promise<void> => {
  await prunePath(candidateDir, candidateDir);
};

const prunePath = async (path: string, candidateDir: string): Promise<void> => {
  const stats = await lstat(path);
  rejectSymlink(stats, path);
  if (path !== candidateDir && isExcluded(relative(candidateDir, path))) {
    await rm(path, { recursive: true, force: true });
    return;
  }
  if (!stats.isDirectory()) {
    if (path !== candidateDir && !isAllowedCandidateFile(relative(candidateDir, path))) await rm(path, { force: true });
    return;
  }
  const names = await readdir(path);
  await Promise.all(names.map((name) => prunePath(join(path, name), candidateDir)));
};

const collectPath = async (path: string, candidateDir: string): Promise<ManifestFile[]> => {
  const stats = await lstat(path);
  rejectSymlink(stats, path);
  if (stats.isDirectory()) {
    const names = await readdir(path);
    const files = await Promise.all(names
      .filter((name) => !excludedPathParts.has(name))
      .map((name) => collectPath(join(path, name), candidateDir)));
    return files.flat();
  }
  if (!stats.isFile()) return [];
  const content = await readFile(path);
  const relativePath = toPosix(relative(candidateDir, path));
  if (isExcluded(relativePath) || !isAllowedCandidateFile(relativePath)) return [];
  return [{ path: relativePath, bytes: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') }];
};

const copyAllowlisted = async (source: string, destination: string, projectRoot: string): Promise<void> => {
  assertInside(projectRoot, source, 'source path');
  const stats = await lstat(source);
  rejectSymlink(stats, source);
  if (stats.isDirectory()) {
    await mkdir(destination, { recursive: true });
    const names = await readdir(source);
    await Promise.all(names
      .filter((name) => !isExcluded(name))
      .map((name) => copyAllowlisted(join(source, name), join(destination, name), projectRoot)));
    return;
  }
  if (!stats.isFile()) throw new Error(`Required bundle input is not a regular file: ${source}`);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
};

const gitState = async (projectRoot: string): Promise<ReleaseManifest['git']> => {
  try {
    const [{ stdout: commitStdout }, { stdout: statusStdout }] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: projectRoot }),
      execFileAsync('git', ['status', '--porcelain'], { cwd: projectRoot }),
    ]);
    return {
      commit: commitStdout.trim() || null,
      dirty: statusStdout.trim().length > 0,
    };
  } catch {
    return { commit: null, dirty: true };
  }
};

const assertExists = async (path: string, label: string): Promise<void> => {
  try {
    await access(path, fsConstants.F_OK);
  } catch {
    throw new Error(`Required release candidate input is missing: ${label}`);
  }
};

const assertRegularFile = async (path: string, label: string): Promise<void> => {
  const stats = await lstat(path).catch(() => null);
  if (!stats) throw new Error(`Required release candidate input is missing: ${label}`);
  rejectSymlink(stats, path);
  if (!stats.isFile()) throw new Error(`Required release candidate input is not a regular file: ${label}`);
};

const rejectSymlink = (stats: Awaited<ReturnType<typeof lstat>>, path: string): void => {
  if (stats.isSymbolicLink()) throw new Error(`Symlink is not allowed in release candidate inputs: ${path}`);
};

const collectFiles = async (path: string): Promise<string[]> => {
  const stats = await lstat(path).catch(() => null);
  if (!stats) return [];
  rejectSymlink(stats, path);
  if (stats.isFile()) return [path];
  if (!stats.isDirectory()) return [];
  const names = await readdir(path);
  const nested = await Promise.all(names
    .filter((name) => !isExcluded(name))
    .map((name) => collectFiles(join(path, name))));
  return nested.flat();
};

const assertInside = (root: string, path: string, label: string): void => {
  const relativePath = relative(resolve(root), resolve(path));
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`${label} escapes project root: ${path}`);
  }
};

const assertNoSymlinkComponents = async (root: string, target: string): Promise<void> => {
  const rootPath = resolve(root);
  const relativePath = relative(rootPath, resolve(target));
  if (relativePath.startsWith('..')) throw new Error(`Path escapes project root: ${target}`);
  let current = rootPath;
  for (const part of relativePath.split(sep).filter(Boolean)) {
    current = join(current, part);
    const stats = await lstat(current).catch(() => null);
    if (!stats) continue;
    if (stats.isSymbolicLink()) throw new Error(`Symlink is not allowed in release candidate path components: ${current}`);
  }
};

const isExcluded = (relativePath: string): boolean => {
  const parts = toPosix(relativePath).split('/');
  return parts.some((part) => excludedPathParts.has(part) || isSecretLikeName(part) || part.endsWith('.map'));
};

const isSecretLikeName = (name: string): boolean => name === '.env' || name.startsWith('.env.') || name.startsWith('.dev.vars');

const isAllowedCandidateFile = (relativePath: string): boolean => {
  const path = toPosix(relativePath);
  const parts = path.split('/');
  if (!allowedTopLevelEntries.has(parts[0])) return false;
  if (parts.length === 1) return ['wrangler.jsonc', 'package-lock.json', 'manifest.json'].includes(path);
  if (parts[0] === 'migrations') return path.endsWith('.sql');
  if (parts[0] === 'worker') return path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.wasm') || path === 'worker/README.md';
  if (parts[0] === 'dist') return path === 'dist/_headers' || [...distAssetExtensions].some((extension) => path.endsWith(extension));
  return false;
};

const toPosix = (path: string): string => path.split(sep).join('/');

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  prepareReleaseManifest().then((manifest) => {
    console.log(JSON.stringify({
      manifest: join(defaultCandidateDir, 'manifest.json'),
      target: manifest.target,
      files: manifest.files.length,
      git: manifest.git,
      warnings: manifest.warnings,
    }, null, 2));
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Failed to prepare release manifest.');
    process.exitCode = 1;
  });
}
