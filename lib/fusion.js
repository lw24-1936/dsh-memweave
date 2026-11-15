/**
 * Compatibility/fusion layer.
 *
 * Memweave never imports another plugin's runtime values, never edits another
 * plugin's configuration, and never hijacks another plugin's tools. Fusion is a
 * read-only probe over three public surfaces — `ctx.get(serviceName)`, the
 * tool registry, and files under the workspace — plus explicit, user-initiated
 * import/export that stays inside Memweave's own directories.
 *
 * @module dsh-memweave/fusion
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { internalError, invalidArgument, throwIfAborted } from './errors.js';
import {
  MEMORY_TYPES,
  newId,
  nowIso,
  truncate,
  uniqueStrings,
} from './model.js';
import { writeAtomic } from './paths.js';
import { loadMemories, writeMemory } from './store.js';

/**
 * Known-compatible plugins. `serviceName` stays null while a plugin exposes no
 * service; `marker`/`extensions` are the file-adaptation view of `filePattern`.
 */
export const COMPATIBILITY_REGISTRY = Object.freeze([
  Object.freeze({
    key: 'dsh-memory-xfy',
    label: '内置适配器 · xfy',
    type: 'memory',
    serviceName: null,
    filePattern: '**/.dsh-memory/**/*.md',
    marker: '.dsh-memory',
    extensions: ['.md'],
    toolNames: ['mem_search', 'mem_pack'],
    direction: ['read'],
    exportFormat: 'markdown',
    builtin: true,
  }),
  Object.freeze({
    key: 'dsh-memory-plus',
    label: '内置适配器 · memory-plus',
    type: 'memory',
    serviceName: null,
    filePattern: '**/.dsh-memory/**/*.json',
    marker: '.dsh-memory',
    extensions: ['.json'],
    toolNames: [],
    direction: ['read'],
    exportFormat: 'json',
    builtin: true,
  }),
  Object.freeze({
    key: 'dsh-cue-bank',
    label: '内置适配器 · cue-bank',
    type: 'memory',
    serviceName: null,
    filePattern: '**/.dsh-cue-bank/**/*.json',
    marker: '.dsh-cue-bank',
    extensions: ['.json'],
    toolNames: [],
    direction: ['read'],
    exportFormat: 'json',
    builtin: true,
  }),
  Object.freeze({
    key: 'dsh-task-memory',
    label: '内置适配器 · task-memory',
    type: 'memory',
    serviceName: null,
    filePattern: '**/.dsh-task-memory/**/*.md',
    marker: '.dsh-task-memory',
    extensions: ['.md'],
    toolNames: ['memory_bind_task', 'memory_current_task', 'memory_remember', 'memory_recall', 'memory_list_tasks'],
    direction: ['read'],
    exportFormat: 'markdown',
    builtin: true,
  }),
  Object.freeze({
    key: 'dsh-graphmemory',
    label: '内置适配器 · graphmemory',
    type: 'memory',
    serviceName: null,
    filePattern: '**/.dsh-graphmemory/**/*.json',
    marker: '.dsh-graphmemory',
    extensions: ['.json'],
    toolNames: [],
    direction: ['read'],
    exportFormat: 'json',
    builtin: true,
  }),
]);

/** Directories a memory scan never enters. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'coverage',
  '.memweave', '.memweave-exports', '.cache', '.next', 'target', 'out',
]);

/** Directions a config entry may request. */
export const FUSION_DIRECTIONS = Object.freeze(['read', 'write', 'both']);

/** Find one registry entry. */
export function compatibilityEntry(key) {
  return COMPATIBILITY_REGISTRY.find(entry => entry.key === key) ?? null;
}

/**
 * Normalize the `fusion` settings object into known keys only.
 * @param {{ fusion?: Record<string, { enabled?: boolean, direction?: string }> }} settings
 * @returns {Map<string, { enabled: boolean, direction: string }>}
 */
export function normalizeFusionSettings(settings) {
  const configured = settings?.fusion;
  const result = new Map();
  for (const entry of COMPATIBILITY_REGISTRY) {
    const raw = configured !== null && typeof configured === 'object' ? configured[entry.key] : undefined;
    if (raw === null || typeof raw !== 'object') continue;
    const direction = FUSION_DIRECTIONS.includes(raw.direction) ? raw.direction : entry.direction[0];
    result.set(entry.key, { enabled: raw.enabled === true, direction });
  }
  return result;
}

/** Whether the configured direction allows one operation. */
export function directionAllows(direction, operation) {
  if (operation === 'read') return direction === 'read' || direction === 'both';
  return direction === 'write' || direction === 'both';
}

/** Tool names currently registered on this Host. */
export function knownToolNames(ctx) {
  const names = new Set();
  try {
    const schemas = ctx?.tools?.schemas?.();
    if (Array.isArray(schemas)) {
      for (const schema of schemas) {
        if (typeof schema?.name === 'string') names.add(schema.name);
      }
    }
  } catch {
    // A registry without a public schema projection is treated as "no names".
  }
  return names;
}

/** Whether a known tool name is registered. */
function hasTool(ctx, name) {
  try {
    if (typeof ctx?.tools?.get === 'function' && ctx.tools.get(name) !== undefined) return true;
  } catch {
    // fall through to schema projection
  }
  return knownToolNames(ctx).has(name);
}

/**
 * Find directories named `marker` under the workspace.
 * @param {string} workspace
 * @param {string} marker
 * @param {{ signal?: AbortSignal, maxDepth?: number, maxDirs?: number }} [options]
 * @returns {Promise<string[]>}
 */
async function findMarkerDirs(workspace, marker, { signal, maxDepth = 5, maxDirs = 2000 } = {}) {
  const found = [];
  const queue = [{ dir: workspace, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < maxDirs) {
    throwIfAborted(signal);
    const current = queue.shift();
    if (current === undefined) break;
    visited += 1;
    let entries;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === marker) {
        found.push(path.join(current.dir, entry.name));
        continue;
      }
      if (current.depth >= maxDepth || SKIP_DIRS.has(entry.name)) continue;
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }
  return found;
}

/**
 * Collect matching files under one directory.
 * @param {string} directory
 * @param {readonly string[]} extensions
 * @param {{ signal?: AbortSignal, maxFiles?: number, maxDepth?: number }} [options]
 * @returns {Promise<{ files: string[], truncated: boolean }>}
 */
async function collectFiles(directory, extensions, { signal, maxFiles = 500, maxDepth = 6 } = {}) {
  const files = [];
  const queue = [{ dir: directory, depth: 0 }];
  let truncated = false;
  while (queue.length > 0) {
    throwIfAborted(signal);
    const current = queue.shift();
    if (current === undefined) break;
    let entries;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < maxDepth && !SKIP_DIRS.has(entry.name)) {
          queue.push({ dir: full, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (!extensions.some(extension => lower.endsWith(extension))) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      files.push(full);
    }
    if (truncated) break;
  }
  files.sort((left, right) => left.localeCompare(right));
  return { files, truncated };
}

/**
 * Discover the files one registry entry describes under a workspace.
 * @param {string|undefined} workspace
 * @param {object} entry
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ files: string[], roots: string[], truncated: boolean }>}
 */
export async function findCompatibleFiles(workspace, entry, { signal } = {}) {
  if (typeof workspace !== 'string' || workspace.length === 0) {
    return { files: [], roots: [], truncated: false };
  }
  const roots = await findMarkerDirs(workspace, entry.marker, { signal });
  const files = [];
  let truncated = false;
  for (const root of roots) {
    throwIfAborted(signal);
    const collected = await collectFiles(root, entry.extensions, { signal });
    files.push(...collected.files);
    truncated = truncated || collected.truncated;
    if (files.length >= 500) {
      truncated = true;
      break;
    }
  }
  const unique = [...new Set(files)].slice(0, 500);
  return { files: unique, roots, truncated };
}

/**
 * Whether a compatible plugin package is installed in the active profile.
 * Installation alone is enough to make the target "available": the user still
 * decides whether to enable it, and the detail explains that no data/tool was
 * found yet.
 * @param {string} key
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<boolean>}
 */
async function isInstalledPackage(key, { signal } = {}) {
  throwIfAborted(signal);
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profile = process.env.DSH_PROFILE;
  const candidates = [];
  if (profile) candidates.push(path.join(home, 'profiles', profile, 'node_modules', key, 'package.json'));
  candidates.push(path.join(home, 'node_modules', key, 'package.json'));
  candidates.push(path.join(process.cwd(), 'node_modules', key, 'package.json'));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return true;
    } catch {
      // Try the next known package location.
    }
  }
  return false;
}

/**
 * Probe one registry entry.
 * @returns {Promise<{ detectedBy: 'service'|'tool'|'file'|'installed', available: boolean, detail: string, files: string[] }>}
 */
async function probeEntry(ctx, workspace, entry, { signal } = {}) {
  if (entry.serviceName !== null) {
    let service;
    try {
      service = ctx?.get?.(entry.serviceName);
    } catch {
      service = undefined;
    }
    if (service !== undefined && service !== null) {
      return { detectedBy: 'service', available: true, detail: `服务 ${entry.serviceName} 可用`, files: [] };
    }
  }

  const tools = (entry.toolNames ?? []).filter(name => hasTool(ctx, name));
  const fileScan = await findCompatibleFiles(workspace, entry, { signal });
  if (tools.length > 0) {
    return {
      detectedBy: 'tool',
      available: true,
      detail: `工具 ${tools.join(', ')} 可用`,
      files: fileScan.files,
    };
  }
  if (fileScan.files.length > 0) {
    return {
      detectedBy: 'file',
      available: true,
      detail: `文件 ${fileScan.files.length} 个（${fileScan.roots.length} 个 ${entry.marker} 目录）${fileScan.truncated ? '，已截断' : ''}`,
      files: fileScan.files,
    };
  }
  if (await isInstalledPackage(entry.key, { signal })) {
    return {
      detectedBy: 'installed',
      available: true,
      detail: '插件已安装；启用后可导入或导出',
      files: [],
    };
  }
  if (entry.builtin === true) {
    return {
      detectedBy: 'builtin',
      available: true,
      detail: '内置适配器就绪；启用后可导入或导出',
      files: [],
    };
  }
  return {
    detectedBy: 'file',
    available: false,
    detail: '适配器不可用；请检查安装或数据',
    files: [],
  };
}

/**
 * Detect every compatible plugin and merge the user's fusion switches.
 * @param {{ ctx: object, workspace?: string, settings?: object, signal?: AbortSignal }} input
 * @returns {Promise<{ plugins: object[], aggregateBundle: boolean }>}
 */
export async function detectFusion({ ctx, workspace, settings, signal } = {}) {
  const configured = normalizeFusionSettings(settings);
  const plugins = [];
  for (const entry of COMPATIBILITY_REGISTRY) {
    throwIfAborted(signal);
    const probed = await probeEntry(ctx, workspace, entry, { signal });
    const toggle = configured.get(entry.key);
    plugins.push({
      key: entry.key,
      label: entry.label,
      type: entry.type,
      detectedBy: probed.detectedBy,
      available: probed.available,
      enabled: toggle?.enabled === true,
      direction: toggle?.direction ?? entry.direction[0],
      detail: probed.detail,
    });
  }
  let aggregateBundle = false;
  try {
    aggregateBundle = ctx?.get?.('memweaveAggregate') !== undefined;
  } catch {
    aggregateBundle = false;
  }
  return { plugins, aggregateBundle };
}

/**
 * The files a status probe reports back, used by import without re-scanning.
 * @param {string} workspace
 * @param {string} key
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function filesForImport(workspace, key, { signal } = {}) {
  const entry = compatibilityEntry(key);
  if (entry === null) throw invalidArgument(`未知兼容插件：${key}`);
  return findCompatibleFiles(workspace, entry, { signal });
}

/** Strip a YAML frontmatter block and read its type, if present. */
function parseMarkdown(text) {
  const source = text.replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (match === null) return { body: source.trim(), type: null };
  const typeMatch = /^type:\s*([a-z_]+)/m.exec(match[1]);
  return {
    body: source.slice(match[0].length).trim(),
    type: typeMatch !== null && MEMORY_TYPES.includes(typeMatch[1]) ? typeMatch[1] : null,
  };
}

/** Extract importable records from one parsed JSON value. */
function recordsFromJson(value) {
  const records = [];
  const push = candidate => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    let content = '';
    for (const key of ['content', 'text', 'memory', 'body', 'value', 'title']) {
      const field = candidate[key];
      if (typeof field === 'string' && field.trim().length > 0) {
        content = field;
        break;
      }
      if (field !== undefined && typeof field === 'object' && field !== null && content.length === 0) {
        try {
          content = JSON.stringify(field);
        } catch {
          content = '';
        }
      }
    }
    if (content.trim().length === 0) return;
    const type = MEMORY_TYPES.includes(candidate.type) ? candidate.type : 'fact';
    const antiPatterns = Array.isArray(candidate.antiPatterns)
      ? candidate.antiPatterns.filter(item => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()).slice(0, 20)
      : [];
    records.push({ content, type, antiPatterns });
  };

  if (Array.isArray(value)) {
    for (const item of value) push(item);
    return records;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of ['memories', 'entries', 'items', 'records']) {
      if (Array.isArray(value[key])) {
        for (const item of value[key]) push(item);
        return records;
      }
    }
    push(value);
  }
  return records;
}

/** Content key used to de-duplicate imports. */
function contentKey(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 400);
}

/**
 * Import memories from one compatible plugin.
 * @param {{
 *   ctx?: object, workspace?: string, root: string, settings?: object,
 *   pluginKey: string, dryRun?: boolean, signal?: AbortSignal,
 * }} input
 * @returns {Promise<{ pluginKey: string, imported: number, skipped: number, dryRun: boolean, samples: { content: string, type: string }[] }>}
 */
export async function importFromPlugin({ ctx: _ctx, workspace, root, settings, pluginKey, dryRun = false, signal } = {}) {
  const entry = compatibilityEntry(pluginKey);
  if (entry === null) throw invalidArgument(`未知兼容插件：${pluginKey}。允许：${COMPATIBILITY_REGISTRY.map(item => item.key).join(', ')}。`);
  const configured = normalizeFusionSettings(settings);
  const toggle = configured.get(pluginKey);
  if (toggle?.enabled !== true) {
    throw invalidArgument(`融合未启用：请先在“融合”标签页启用 ${pluginKey}。`);
  }
  if (!directionAllows(toggle.direction, 'read')) {
    throw invalidArgument(`方向不允许读取：${pluginKey} 当前方向为 ${toggle.direction}。`);
  }
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw invalidArgument('无法确定 workspace，不能导入其他插件的记忆。');
  }

  const scan = await findCompatibleFiles(workspace, entry, { signal });
  const { memories: existing } = await loadMemories(root, { signal });
  const seen = new Set(existing.map(memory => contentKey(memory.content)));
  const candidates = [];
  let skipped = 0;

  for (const file of scan.files) {
    throwIfAborted(signal);
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      skipped += 1;
      continue;
    }
    let records = [];
    try {
      if (file.toLowerCase().endsWith('.json')) {
        records = recordsFromJson(JSON.parse(text.replace(/^\uFEFF/, '')));
      } else {
        const parsed = parseMarkdown(text);
        if (parsed.body.length > 0) records = [{ content: parsed.body, type: parsed.type ?? 'fact', antiPatterns: [] }];
      }
    } catch {
      skipped += 1;
      continue;
    }
    for (const record of records) {
      const content = truncate(record.content.replace(/\s+/g, ' ').trim(), 200);
      if (content.length < 2) {
        skipped += 1;
        continue;
      }
      const key = contentKey(content);
      if (seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      const requestedType = MEMORY_TYPES.includes(record.type) ? record.type : 'fact';
      // Preserve the memory invariant: an imported anti-pattern without its
      // "when this is invalid" notes becomes a plain fact, not a contract
      // violation. Import never promotes; everything stays candidate.
      const type = requestedType === 'anti_pattern' && record.antiPatterns.length === 0 ? 'fact' : requestedType;
      candidates.push({ content, type, antiPatterns: record.antiPatterns });
      if (candidates.length >= 500) break;
    }
    if (candidates.length >= 500) break;
  }

  const samples = candidates.slice(0, 3).map(candidate => ({
    content: truncate(candidate.content, 120),
    type: candidate.type,
  }));

  if (dryRun) {
    return { pluginKey, imported: candidates.length, skipped, dryRun: true, samples };
  }

  let imported = 0;
  for (const candidate of candidates) {
    throwIfAborted(signal);
    const memory = {
      id: newId('mem'),
      type: candidate.type,
      content: candidate.content,
      rationale: `从 ${pluginKey} 导入`,
      antiPatterns: candidate.antiPatterns,
      scope: { taskTypes: [], conditions: [] },
      source: { taskRef: null },
      evidence: { loopRecords: [], taskCompletions: [] },
      confidence: 0.4,
      status: 'candidate',
      createdAt: nowIso(),
      lastVerifiedAt: null,
      supersededBy: null,
      verificationLog: [],
    };
    try {
      await writeMemory(root, memory, { signal });
      imported += 1;
    } catch (error) {
      throw internalError(`导入 ${pluginKey} 第 ${imported + 1} 条记忆`, error);
    }
  }
  return { pluginKey, imported, skipped, dryRun: false, samples };
}

/** Render markdown for one export. */
function exportMarkdown(pluginKey, memories) {
  const lines = [
    `# Memweave 导出 · ${pluginKey}`,
    '',
    `导出时间：${nowIso()}`,
    `条目数：${memories.length}`,
    '',
  ];
  for (const memory of memories) {
    lines.push(`## [${memory.type}] ${memory.id}`, '', memory.content, '');
    if (memory.rationale.length > 0) lines.push(`- 理由：${memory.rationale}`);
    if (memory.antiPatterns.length > 0) lines.push(`- 反模式：${memory.antiPatterns.join('；')}`);
    if (memory.scope.taskTypes.length > 0) lines.push(`- 适用任务：${memory.scope.taskTypes.join('、')}`);
    lines.push(`- 置信度：${memory.confidence.toFixed(2)} · 状态：${memory.status}`, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Render JSON for one export. */
function exportJson(pluginKey, memories) {
  return `${JSON.stringify({
    pluginKey,
    exportedAt: nowIso(),
    count: memories.length,
    memories: memories.map(memory => ({
      id: memory.id,
      type: memory.type,
      content: memory.content,
      rationale: memory.rationale,
      antiPatterns: memory.antiPatterns,
      scope: memory.scope,
      confidence: memory.confidence,
      status: memory.status,
      lastVerifiedAt: memory.lastVerifiedAt,
    })),
  }, null, 2)}\n`;
}

/**
 * Export memories to Memweave's own export area. Never writes another plugin's
 * private directory.
 * @param {{
 *   workspace?: string, root: string, settings?: object, pluginKey: string,
 *   statusFilter?: string, limit?: number, signal?: AbortSignal,
 * }} input
 * @returns {Promise<{ pluginKey: string, exported: number, format: string, path: string }>}
 */
export async function exportToPlugin({ workspace, root, settings, pluginKey, statusFilter = 'verified', limit = 50, signal } = {}) {
  const entry = compatibilityEntry(pluginKey);
  if (entry === null) throw invalidArgument(`未知兼容插件：${pluginKey}。允许：${COMPATIBILITY_REGISTRY.map(item => item.key).join(', ')}。`);
  const configured = normalizeFusionSettings(settings);
  const toggle = configured.get(pluginKey);
  if (toggle?.enabled !== true) {
    throw invalidArgument(`融合未启用：请先在“融合”标签页启用 ${pluginKey}。`);
  }
  if (!directionAllows(toggle.direction, 'write')) {
    throw invalidArgument(`方向不允许写入：${pluginKey} 当前方向为 ${toggle.direction}。`);
  }
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw invalidArgument('无法确定 workspace，不能导出。');
  }
  if (!['verified', 'candidate', 'disputed'].includes(statusFilter)) {
    throw invalidArgument(`未知 statusFilter：${String(statusFilter)}。允许：verified, candidate, disputed。`);
  }
  const capped = Math.min(200, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50));

  const { memories } = await loadMemories(root, { signal });
  const selected = memories
    .filter(memory => memory.status === statusFilter)
    .sort((left, right) => String(right.lastVerifiedAt ?? right.createdAt).localeCompare(String(left.lastVerifiedAt ?? left.createdAt)))
    .slice(0, capped);

  const format = entry.exportFormat;
  const extension = format === 'markdown' ? 'md' : 'json';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const directory = path.join(workspace, '.memweave-exports');
  const target = path.join(directory, `${pluginKey}-${stamp}.${extension}`);
  const body = format === 'markdown' ? exportMarkdown(pluginKey, selected) : exportJson(pluginKey, selected);
  try {
    await writeAtomic(target, body, { signal });
  } catch (error) {
    throw internalError(`写入导出文件 ${target}`, error);
  }
  return { pluginKey, exported: selected.length, format, path: target };
}
