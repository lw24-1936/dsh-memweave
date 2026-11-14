/**
 * Storage path resolution, atomic writes, and small filesystem helpers.
 *
 * A memory file is a single JSON document. Writes use an exclusive temporary
 * sibling plus `rename` so a reader never observes a half-written document and
 * a crash leaves at most one orphan `.tmp.*` file (cleaned by list operations).
 *
 * @module dsh-memweave/paths
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { internalError, invalidArgument, rethrow, throwIfAborted } from './errors.js';

/** The storage subdirectories owned by Memweave. */
export const LAYOUT = Object.freeze(['memories', 'tasknets', 'loops']);

/**
 * The calling agent's session workspace, when this call has one.
 * @param {{ agent?: { session?: { header?: { cwd?: string } } } } | undefined} exec
 * @returns {string|undefined}
 */
export function workspaceOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
}

/**
 * Whether a string is absolute in any spelling the Host accepts: POSIX, a
 * Windows drive, or a UNC share. `path.isAbsolute` alone rejects Windows
 * spellings on POSIX and vice versa, so the portable rule is explicit.
 * @param {string} value
 * @returns {boolean}
 */
export function isAbsoluteStoragePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.startsWith('/')) return true;
  if (value.startsWith('\\\\')) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  return path.isAbsolute(value);
}

/**
 * Create the storage layout under one root.
 * @param {string} root
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export async function ensureLayout(root, signal) {
  throwIfAborted(signal);
  try {
    await fs.mkdir(root, { recursive: true });
    for (const directory of LAYOUT) {
      throwIfAborted(signal);
      await fs.mkdir(path.join(root, directory), { recursive: true });
    }
  } catch (error) {
    rethrow(`创建存储目录 ${root}`, error, signal);
  }
}

/**
 * Resolve the storage root for one call.
 *
 * Precedence:
 * 1. a configured absolute `storageRoot`;
 * 2. the calling session's workspace + `.memweave`;
 * 3. the most recent session workspace this process observed + `.memweave`;
 * 4. the Host launch directory + `.memweave`.
 *
 * Source is returned so the UI can say where the path came from instead of
 * presenting a fallback as if the user configured it.
 *
 * @param {{
 *   settings?: { storageRoot?: string },
 *   exec?: object,
 *   fallbackWorkspace?: string,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<{ root: string, source: 'configured'|'session'|'last-workspace'|'host-cwd', workspace: string|null }>}
 */
export async function resolveStorageRoot({ settings, exec, fallbackWorkspace, signal } = {}) {
  throwIfAborted(signal);
  const configured = typeof settings?.storageRoot === 'string' ? settings.storageRoot.trim() : '';
  if (configured.length > 0) {
    if (!isAbsoluteStoragePath(configured)) {
      throw invalidArgument(`storageRoot 必须是绝对路径，收到相对路径：${configured}`);
    }
    const root = path.normalize(configured);
    await ensureLayout(root, signal);
    return { root, source: 'configured', workspace: null };
  }

  const sessionWorkspace = workspaceOf(exec);
  const remembered = typeof fallbackWorkspace === 'string' && fallbackWorkspace.trim().length > 0
    ? fallbackWorkspace.trim()
    : undefined;
  const base = sessionWorkspace ?? remembered ?? process.cwd();
  const source = sessionWorkspace !== undefined
    ? 'session'
    : remembered !== undefined
      ? 'last-workspace'
      : 'host-cwd';
  const root = path.join(base, '.memweave');
  await ensureLayout(root, signal);
  return { root, source, workspace: base };
}

/** The memory file path for one id. */
export function memoryPath(root, id) {
  return path.join(root, 'memories', `${id}.json`);
}

/** The task network file path for one id. */
export function tasknetPath(root, id) {
  return path.join(root, 'tasknets', `${id}.json`);
}

/** The Loop file path for one id. */
export function loopPath(root, id) {
  return path.join(root, 'loops', `${id}.json`);
}

/**
 * Write one UTF-8 file atomically.
 *
 * The temp file is created with `wx` in the target directory; the suffix is
 * random so two concurrent writers cannot pick the same name. The rename is
 * the commit point.
 *
 * @param {string} targetPath
 * @param {string} content
 * @param {{ signal?: AbortSignal, mode?: number }} [options]
 * @returns {Promise<void>}
 */
export async function writeAtomic(targetPath, content, { signal, mode = 0o600 } = {}) {
  throwIfAborted(signal);
  const directory = path.dirname(targetPath);
  const name = path.basename(targetPath);
  try {
    await fs.mkdir(directory, { recursive: true });
  } catch (error) {
    rethrow(`创建文件目录 ${directory}`, error, signal);
  }

  let handle;
  let tmpPath;
  for (let attempt = 0; attempt < 3 && handle === undefined; attempt += 1) {
    tmpPath = path.join(directory, `${name}.tmp.${randomBytes(6).toString('hex')}`);
    try {
      handle = await fs.open(tmpPath, 'wx', mode);
    } catch (error) {
      if (error?.code !== 'EEXIST') rethrow(`创建临时文件 ${tmpPath}`, error, signal);
    }
  }
  if (handle === undefined || tmpPath === undefined) {
    throw internalError(`创建临时文件 ${targetPath}`);
  }

  try {
    await handle.writeFile(content, 'utf8');
    await handle.close();
    handle = undefined;
    throwIfAborted(signal);
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
    await fs.unlink(tmpPath).catch(() => {});
    rethrow(`写入文件 ${targetPath}`, error, signal);
  }
}

/**
 * Write one JSON document atomically.
 * @param {string} targetPath
 * @param {unknown} value
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<void>}
 */
export async function writeJsonAtomic(targetPath, value, { signal } = {}) {
  throwIfAborted(signal);
  let text;
  try {
    text = `${JSON.stringify(value, null, 2)}\n`;
  } catch (error) {
    throw internalError('序列化 JSON', error);
  }
  await writeAtomic(targetPath, text, { signal });
}

/**
 * Read and parse one JSON file.
 * @param {string} filePath
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, missing: boolean, error?: unknown }>}
 */
export async function readJsonSafe(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, missing: true };
    return { ok: false, missing: false, error };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, missing: false, error };
  }
}

/**
 * List `.json` file names in one directory, ignoring temp files.
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
export async function listJsonNames(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw internalError(`读取目录 ${directory}`, error);
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json') && !entry.name.includes('.tmp.'))
    .map(entry => entry.name);
}

/**
 * Remove orphan `.tmp.*` files older than `maxAgeMs`.
 * Best-effort: cleanup never fails the caller.
 * @param {string[]} directories
 * @param {{ maxAgeMs?: number, now?: number }} [options]
 * @returns {Promise<number>}
 */
export async function cleanupOrphanTmp(directories, { maxAgeMs = 60 * 60 * 1000, now = Date.now() } = {}) {
  let removed = 0;
  for (const directory of directories) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.includes('.tmp.')) continue;
      const filePath = path.join(directory, entry.name);
      try {
        const stat = await fs.stat(filePath);
        if (now - stat.mtimeMs <= maxAgeMs) continue;
        await fs.unlink(filePath);
        removed += 1;
      } catch {
        // A concurrent writer may have renamed or removed it already.
      }
    }
  }
  return removed;
}

/** Whether a path exists as a directory. */
export async function isDirectory(targetPath) {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/** Whether a path exists as any file. */
export async function exists(targetPath) {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

/** Filesystem-friendly timestamp for export names. */
export function timestampSlug(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-`
    + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}
