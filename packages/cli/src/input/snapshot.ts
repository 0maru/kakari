import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Git, GitError, gitEnv } from './git.ts';

export interface SnapshotRequest {
  gitPath: string;
  /** リポジトリのミラーを置くディレクトリ */
  cacheDir: string;
  /** この実行の入力を書き出すディレクトリ（存在しないこと） */
  outputDir: string;
  host: string;
  repositoryFullName: string;
  prNumber: number;
  headSha: string;
  baseSha: string | null;
  /** 取得用URL。省略時は https://host/owner/repo.git */
  remoteUrl?: string;
  token?: string;
  maxInputBytes: number;
  metadata: Record<string, unknown>;
  parentEnv?: NodeJS.ProcessEnv;
}

export interface ManifestFile {
  path: string;
  bytes: number;
  blob: string;
}

export interface InputManifest {
  schema_version: 1;
  repository: string;
  pr_number: number;
  head_sha: string;
  base_sha: string | null;
  merge_base_sha: string | null;
  included: ManifestFile[];
  excluded: { path: string; reason: string }[];
  untrusted_config: { path: string; stored_as: string }[];
  diff: { bytes: number; sha256: string; truncated: boolean; changed_files: number };
  limitations: string[];
}

export interface Snapshot {
  dir: string;
  manifest: InputManifest;
  inputHash: string;
  mergeBaseSha: string | null;
  baseSha: string | null;
}

export class SnapshotError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
    this.name = 'SnapshotError';
  }
}

const MAX_FILE_BYTES = 512 * 1024;

/** PR由来のAI向け設定。自動設定として適用されないよう別名で渡す（14.1） */
export function isUntrustedConfigPath(path: string): boolean {
  return (
    /(^|\/)(CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md|AGENTS\.override\.md|\.mcp\.json|\.cursorrules)$/i.test(
      path,
    ) || /(^|\/)\.(claude|codex|cursor|gemini|github\/copilot-instructions)(\/|$)/i.test(path)
  );
}

/** Git上のパスをそのまま書き出してよいか。ディレクトリ外への書き込みを防ぐ */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\0') || path.includes('\\')) return false;
  return path
    .split('/')
    .every((seg) => seg !== '' && seg !== '.' && seg !== '..' && seg.toLowerCase() !== '.git');
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}

interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
  size: number | null;
  path: string;
}

function parseLsTree(output: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of output.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, type, sha, size] = record.slice(0, tab).trim().split(/\s+/);
    entries.push({
      mode: mode ?? '',
      type: type ?? '',
      sha: sha ?? '',
      size: size && size !== '-' ? Number(size) : null,
      path: record.slice(tab + 1),
    });
  }
  return entries;
}

async function makeReadOnly(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await makeReadOnly(p);
    else await chmod(p, 0o444);
  }
  await chmod(dir, 0o555);
}

/** 読み取り専用にした入力ディレクトリを削除する */
export async function removeSnapshot(dir: string): Promise<void> {
  const makeWritable = async (d: string) => {
    await chmod(d, 0o755).catch(() => undefined);
    for (const entry of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await makeWritable(join(d, entry.name));
    }
  };
  await makeWritable(dir);
  await rm(dir, { recursive: true, force: true });
}

/**
 * head/base を固定したレビュー入力を作る（7.3）。
 * 別の最新commitへ黙ってフォールバックしない。
 */
export async function prepareSnapshot(req: SnapshotRequest): Promise<Snapshot> {
  if (!/^[0-9a-f]{40,64}$/.test(req.headSha)) throw new SnapshotError('invalid head sha', false);
  const [owner, repo] = req.repositoryFullName.split('/');
  if (!owner || !repo || !isSafeRelativePath(`${owner}/${repo}`)) {
    throw new SnapshotError('invalid repository name', false);
  }
  const mirror = join(req.cacheDir, 'repos', req.host, owner, `${repo}.git`);
  const env = gitEnv({ token: req.token, host: req.host, parentEnv: req.parentEnv });
  const git = new Git(req.gitPath, mirror, env);

  try {
    await mkdir(mirror, { recursive: true, mode: 0o700 });
    if (!(await git.tryRun(['rev-parse', '--git-dir']))) {
      await git.run(['init', '--bare', '--quiet']);
    }
    const remoteUrl = req.remoteUrl ?? `https://${req.host}/${owner}/${repo}.git`;
    // 資格情報をリモートURLへ含めない
    if (await git.tryRun(['remote', 'get-url', 'origin'])) {
      await git.run(['remote', 'set-url', 'origin', remoteUrl]);
    } else {
      await git.run(['remote', 'add', 'origin', remoteUrl]);
    }
    const shas = [req.headSha, ...(req.baseSha ? [req.baseSha] : [])];
    const missing: string[] = [];
    for (const s of shas) {
      if (!(await git.tryRun(['cat-file', '-e', `${s}^{commit}`]))) missing.push(s);
    }
    if (missing.length > 0) {
      await git.run([
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        'origin',
        ...missing,
      ]);
    }
    if (!(await git.tryRun(['cat-file', '-e', `${req.headSha}^{commit}`]))) {
      throw new SnapshotError(`head ${req.headSha} を取得できません`, true);
    }
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    if (error instanceof GitError) {
      throw new SnapshotError(
        `リポジトリを取得できません: ${error.stderr.trim().slice(0, 300)}`,
        true,
      );
    }
    throw error;
  }

  const limitations: string[] = [];
  let baseSha = req.baseSha;
  if (baseSha && !(await git.tryRun(['cat-file', '-e', `${baseSha}^{commit}`]))) {
    limitations.push(`base ${baseSha} を取得できないため、差分の基点を特定できませんでした`);
    baseSha = null;
  }
  let mergeBase: string | null = null;
  if (baseSha) {
    mergeBase =
      (await git.text(['merge-base', baseSha, req.headSha]).catch(() => '')).trim() || null;
    if (!mergeBase) limitations.push('merge-base を特定できないため base との差分を使用しました');
  }
  const diffBase = mergeBase ?? baseSha;

  // 差分（外部diff・textconvを使わない）
  let diff: Buffer = Buffer.alloc(0);
  let changed: string[] = [];
  if (diffBase) {
    diff = await git.run(
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--find-renames',
        '--submodule=short',
        '-U5',
        diffBase,
        req.headSha,
      ],
      { maxOutputBytes: 256 * 1024 * 1024 },
    );
    const names = await git.run([
      'diff',
      '--no-ext-diff',
      '--name-only',
      '-z',
      diffBase,
      req.headSha,
    ]);
    changed = names.toString('utf8').split('\0').filter(Boolean);
  } else {
    limitations.push('差分の基点がないため、head時点のファイルだけを入力にしました');
  }
  const diffBudget = Math.floor(req.maxInputBytes / 2);
  const diffTruncated = diff.length > diffBudget;
  if (diffTruncated) {
    limitations.push(`差分が大きいため先頭 ${diffBudget} バイトだけを入力にしました`);
  }
  const diffOut = diffTruncated ? diff.subarray(0, diffBudget) : diff;

  // ファイル一覧
  const tree = parseLsTree(
    await git.run(['ls-tree', '-r', '-z', '--long', '--full-tree', req.headSha]),
  );
  const changedSet = new Set(changed);
  const changedDirs = new Set(changed.map((p) => dirname(p)));
  const priority = (e: TreeEntry) =>
    changedSet.has(e.path) ? 0 : changedDirs.has(dirname(e.path)) ? 1 : 2;
  tree.sort((a, b) => priority(a) - priority(b) || a.path.localeCompare(b.path));

  const root = resolve(req.outputDir);
  const repoDir = join(root, 'repo');
  const configDir = join(root, 'untrusted-config');
  await mkdir(repoDir, { recursive: true, mode: 0o700 });

  const manifest: InputManifest = {
    schema_version: 1,
    repository: req.repositoryFullName,
    pr_number: req.prNumber,
    head_sha: req.headSha,
    base_sha: baseSha,
    merge_base_sha: mergeBase,
    included: [],
    excluded: [],
    untrusted_config: [],
    diff: {
      bytes: diffOut.length,
      sha256: sha256(diffOut),
      truncated: diffTruncated,
      changed_files: changed.length,
    },
    limitations,
  };

  let budget = req.maxInputBytes - diffOut.length;
  const reader = git.batch();
  try {
    for (const entry of tree) {
      if (!isSafeRelativePath(entry.path)) {
        manifest.excluded.push({ path: entry.path, reason: 'unsafe_path' });
        continue;
      }
      if (entry.type === 'commit') {
        manifest.excluded.push({ path: entry.path, reason: 'submodule' });
        continue;
      }
      if (entry.mode === '120000') {
        manifest.excluded.push({ path: entry.path, reason: 'symlink' });
        continue;
      }
      if (entry.type !== 'blob') continue;
      if ((entry.size ?? 0) > MAX_FILE_BYTES) {
        manifest.excluded.push({ path: entry.path, reason: 'too_large' });
        continue;
      }
      if ((entry.size ?? 0) > budget) {
        manifest.excluded.push({ path: entry.path, reason: 'input_budget' });
        continue;
      }
      const blob = await reader.read(entry.sha);
      if (!blob) {
        manifest.excluded.push({ path: entry.path, reason: 'missing' });
        continue;
      }
      if (isBinary(blob.content)) {
        manifest.excluded.push({ path: entry.path, reason: 'binary' });
        continue;
      }
      const untrusted = isUntrustedConfigPath(entry.path);
      const target = untrusted ? join(configDir, `${entry.path}.txt`) : join(repoDir, entry.path);
      if (!target.startsWith(root + sep)) {
        manifest.excluded.push({ path: entry.path, reason: 'unsafe_path' });
        continue;
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, blob.content, { flag: 'wx', mode: 0o600 });
      budget -= blob.content.length;
      if (untrusted) {
        manifest.untrusted_config.push({ path: entry.path, stored_as: relative(root, target) });
      } else {
        manifest.included.push({ path: entry.path, bytes: blob.content.length, blob: entry.sha });
      }
    }
  } finally {
    reader.close();
  }
  if (manifest.excluded.some((e) => e.reason === 'input_budget')) {
    limitations.push(
      '入力サイズの上限により一部のファイルを含めていません（manifest.json の excluded を参照）',
    );
  }

  await writeFile(join(root, 'pr.diff'), diffOut, { mode: 0o600 });
  await writeFile(join(root, 'pr-metadata.json'), `${JSON.stringify(req.metadata, null, 2)}\n`, {
    mode: 0o600,
  });
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  await makeReadOnly(root);

  const inputHash = sha256(JSON.stringify(manifest) + sha256(JSON.stringify(req.metadata)));
  return { dir: root, manifest, inputHash, mergeBaseSha: mergeBase, baseSha };
}

/** 保持期限を過ぎたローカル入力を削除する（14.3） */
export async function pruneSnapshots(
  runsDir: string,
  maxAgeMs: number,
  now = Date.now(),
): Promise<number> {
  let removed = 0;
  for (const entry of await readdir(runsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const p = join(runsDir, entry.name);
    const info = await stat(p).catch(() => null);
    if (info && now - info.mtimeMs > maxAgeMs) {
      await removeSnapshot(p);
      removed++;
    }
  }
  return removed;
}
