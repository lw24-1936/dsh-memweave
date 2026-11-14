/**
 * Durable store for memories, task networks, and Loops.
 *
 * One file per document keeps the write path atomic and the read path simple.
 * Corrupt memory files are skipped with a count rather than failing a whole
 * listing; a missing id is a caller error, not an internal one.
 *
 * @module dsh-memweave/store
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { internalError, invalidArgument, rethrow, throwIfAborted } from './errors.js';
import {
  normalizeLoop,
  normalizeMemory,
  normalizeTasknet,
} from './model.js';
import {
  listJsonNames,
  loopPath,
  memoryPath,
  readJsonSafe,
  tasknetPath,
  writeJsonAtomic,
} from './paths.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Reject ids that could escape the storage directory.
 * @param {string} id
 * @param {string} label
 * @returns {string}
 */
export function assertSafeId(id, label) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    throw invalidArgument(`${label} 不合法：${String(id)}`);
  }
  return id;
}

/**
 * Read one memory.
 * @param {string} root
 * @param {string} id
 * @param {{ signal?: AbortSignal, missing?: 'null'|'throw' }} [options]
 * @returns {Promise<object|null>}
 */
export async function readMemory(root, id, { signal, missing = 'null' } = {}) {
  assertSafeId(id, 'memoryId');
  throwIfAborted(signal);
  const filePath = memoryPath(root, id);
  const result = await readJsonSafe(filePath);
  throwIfAborted(signal);
  if (!result.ok) {
    if (result.missing) {
      if (missing === 'null') return null;
      throw invalidArgument(`未找到记忆：${id}`);
    }
    throw internalError(`读取记忆文件 ${filePath}`, result.error);
  }
  const memory = normalizeMemory(result.value, id);
  if (memory === null) {
    throw internalError(`记忆文件 ${filePath} 缺少必要字段（content/id）`);
  }
  return memory;
}

/**
 * Write one memory document.
 * @param {string} root
 * @param {object} memory
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function writeMemory(root, memory, { signal } = {}) {
  assertSafeId(memory.id, 'memoryId');
  throwIfAborted(signal);
  await writeJsonAtomic(memoryPath(root, memory.id), memory, { signal });
}

/**
 * Load every readable memory.
 * @param {string} root
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ memories: object[], skipped: number }>}
 */
export async function loadMemories(root, { signal } = {}) {
  const directory = path.join(root, 'memories');
  const names = await listJsonNames(directory);
  const memories = [];
  let skipped = 0;
  for (const name of names) {
    throwIfAborted(signal);
    const id = name.slice(0, -'.json'.length);
    const result = await readJsonSafe(path.join(directory, name));
    if (!result.ok) {
      skipped += 1;
      continue;
    }
    const memory = normalizeMemory(result.value, id);
    if (memory === null || memory.id !== id) {
      skipped += 1;
      continue;
    }
    memories.push(memory);
  }
  return { memories, skipped };
}

/** Read one task network, or null when missing. */
export async function readTasknet(root, id, { signal } = {}) {
  assertSafeId(id, 'netId');
  throwIfAborted(signal);
  const filePath = tasknetPath(root, id);
  const result = await readJsonSafe(filePath);
  if (!result.ok) {
    if (result.missing) return null;
    throw internalError(`读取任务网络 ${filePath}`, result.error);
  }
  const net = normalizeTasknet(result.value, id);
  if (net === null) throw internalError(`任务网络 ${filePath} 缺少必要字段`);
  return net;
}

/** Write one task network. */
export async function writeTasknet(root, net, { signal } = {}) {
  assertSafeId(net.id, 'netId');
  throwIfAborted(signal);
  await writeJsonAtomic(tasknetPath(root, net.id), net, { signal });
}

/** Read one Loop, or null when missing. */
export async function readLoop(root, id, { signal, missing = 'null' } = {}) {
  assertSafeId(id, 'loopId');
  throwIfAborted(signal);
  const filePath = loopPath(root, id);
  const result = await readJsonSafe(filePath);
  throwIfAborted(signal);
  if (!result.ok) {
    if (result.missing) {
      if (missing === 'null') return null;
      throw invalidArgument(`未找到 Loop：${id}`);
    }
    throw internalError(`读取 Loop ${filePath}`, result.error);
  }
  const loop = normalizeLoop(result.value, id);
  if (loop === null) throw internalError(`Loop 文件 ${filePath} 缺少必要字段`);
  return loop;
}

/** Write one Loop. */
export async function writeLoop(root, loop, { signal } = {}) {
  assertSafeId(loop.id, 'loopId');
  throwIfAborted(signal);
  await writeJsonAtomic(loopPath(root, loop.id), loop, { signal });
}

/** Whether a memory file exists (without parsing it). */
export async function memoryExists(root, id) {
  try {
    await fs.stat(memoryPath(root, id));
    return true;
  } catch {
    return false;
  }
}

/** Rethrow a Node filesystem failure as an INTERNAL_ERROR HarnessError. */
export function storageFailure(action, error, signal) {
  rethrow(action, error, signal);
}
