/**
 * Data model constants and pure formatting helpers.
 *
 * The stored shapes are deliberately small JSON documents; every read path
 * normalizes them so a file written by an older version (or by an importer)
 * cannot leak `undefined` into a canonical tool result.
 *
 * @module dsh-memweave/model
 */

import { randomBytes } from 'node:crypto';

/** The five memory categories. */
export const MEMORY_TYPES = Object.freeze(['fact', 'procedure', 'judgment', 'anti_pattern', 'relation']);

/** Lifecycle states. */
export const MEMORY_STATUSES = Object.freeze(['candidate', 'verified', 'disputed', 'superseded']);

/** Verification outcomes. */
export const VERIFY_OUTCOMES = Object.freeze(['valid', 'invalid', 'inconclusive']);

/** Loop cadences. */
export const LOOP_CADENCES = Object.freeze(['daily', 'weekly', 'on-demand']);

/** Chinese labels used by every renderer and by the settings UI. */
export const TYPE_LABELS = Object.freeze({
  fact: '事实',
  procedure: '程序',
  judgment: '判断',
  anti_pattern: '反模式',
  relation: '关系',
});

/** Chinese status labels. */
export const STATUS_LABELS = Object.freeze({
  candidate: '候选',
  verified: '已验证',
  disputed: '有争议',
  superseded: '已取代',
});

/** Chinese cadence labels. */
export const CADENCE_LABELS = Object.freeze({
  daily: '每日',
  weekly: '每周',
  'on-demand': '按需',
});

/** Chinese verification labels. */
export const OUTCOME_LABELS = Object.freeze({
  valid: '验证有效',
  invalid: '验证无效',
  inconclusive: '结论未定',
});

/** Confidence symbols, highest first. */
export function confidenceSymbol(confidence) {
  const value = Number(confidence);
  if (!Number.isFinite(value)) return '●○○○○';
  if (value >= 0.9) return '●●●●●';
  if (value >= 0.7) return '●●●●○';
  if (value >= 0.5) return '●●●○○';
  if (value >= 0.3) return '●●○○○';
  return '●○○○○';
}

/**
 * A short, stable id: `<prefix>_<base36 time>_<6 hex>`.
 * Random suffix keeps two writes in the same millisecond distinct.
 * @param {'mem'|'net'|'loop'} prefix
 * @returns {string}
 */
export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

/** ISO timestamp for "now". */
export function nowIso() {
  return new Date().toISOString();
}

/** Clamp a number into [min, max]; NaN falls back to min. */
export function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

/** Round to four decimals to keep stored confidences stable across JSON writes. */
export function round4(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

/** Truncate to a code-point count, appending an ellipsis when cut. */
export function truncate(text, max) {
  const value = String(text ?? '');
  const characters = Array.from(value);
  if (characters.length <= max) return value;
  return `${characters.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** Two-decimal confidence for rendered text. */
export function formatConfidence(value) {
  return Number(value).toFixed(2);
}

/** Normalize a JSON field that should be a string array. */
export function stringArray(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

/** Unique trimmed strings, preserving order. */
export function uniqueStrings(value) {
  return stringArray(value);
}

/** Short human summary of one memory's evidence arrays. */
export function evidenceSummary(evidence) {
  const loops = Array.isArray(evidence?.loopRecords) ? evidence.loopRecords.length : 0;
  const tasks = Array.isArray(evidence?.taskCompletions) ? evidence.taskCompletions.length : 0;
  if (loops === 0 && tasks === 0) return '暂无证据';
  return `Loop 记录 ${loops} 条 · 任务完成 ${tasks} 条`;
}

/**
 * Normalize one stored memory for read paths.
 * Unknown types are coerced to `fact`; unknown statuses to `candidate`.
 * @param {unknown} raw
 * @param {string} [fallbackId]
 * @returns {object|null}
 */
export function normalizeMemory(raw, fallbackId) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, any>} */ (raw);
  const content = typeof source.content === 'string' ? source.content : '';
  if (content.trim().length === 0) return null;
  const id = typeof source.id === 'string' && source.id.length > 0 ? source.id : fallbackId;
  if (typeof id !== 'string' || id.length === 0) return null;
  const type = MEMORY_TYPES.includes(source.type) ? source.type : 'fact';
  const status = MEMORY_STATUSES.includes(source.status) ? source.status : 'candidate';
  const createdAt = typeof source.createdAt === 'string' ? source.createdAt : nowIso();
  const lastVerifiedAt = typeof source.lastVerifiedAt === 'string' ? source.lastVerifiedAt : null;
  return {
    id,
    type,
    content,
    rationale: typeof source.rationale === 'string' ? source.rationale : '',
    antiPatterns: stringArray(source.antiPatterns),
    scope: {
      taskTypes: stringArray(source.scope?.taskTypes),
      conditions: stringArray(source.scope?.conditions),
    },
    source: {
      taskRef: typeof source.source?.taskRef === 'string' && source.source.taskRef.length > 0
        ? source.source.taskRef
        : null,
    },
    evidence: {
      loopRecords: Array.isArray(source.evidence?.loopRecords) ? source.evidence.loopRecords : [],
      taskCompletions: Array.isArray(source.evidence?.taskCompletions) ? source.evidence.taskCompletions : [],
    },
    confidence: round4(clamp(source.confidence ?? 0.5, 0, 1)),
    status,
    createdAt,
    lastVerifiedAt,
    supersededBy: typeof source.supersededBy === 'string' ? source.supersededBy : null,
    verificationLog: Array.isArray(source.verificationLog)
      ? source.verificationLog.filter(entry => entry !== null && typeof entry === 'object')
      : [],
  };
}

/** Normalize one stored task network. */
export function normalizeTasknet(raw, fallbackId) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, any>} */ (raw);
  const id = typeof source.id === 'string' && source.id.length > 0 ? source.id : fallbackId;
  if (typeof id !== 'string' || id.length === 0) return null;
  const nodes = Array.isArray(source.nodes)
    ? source.nodes.filter(node => node !== null && typeof node === 'object').map(node => ({
      id: String(node.id ?? ''),
      task: String(node.task ?? ''),
      dependsOn: stringArray(node.dependsOn),
      executor: ['human', 'agent', 'hybrid'].includes(node.executor) ? node.executor : 'agent',
    })).filter(node => node.id.length > 0 && node.task.length > 0)
    : [];
  return {
    id,
    goal: typeof source.goal === 'string' ? source.goal : '',
    nodes,
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : nowIso(),
  };
}

/** Normalize one stored Loop. */
export function normalizeLoop(raw, fallbackId) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, any>} */ (raw);
  const id = typeof source.id === 'string' && source.id.length > 0 ? source.id : fallbackId;
  if (typeof id !== 'string' || id.length === 0) return null;
  const metric = source.metric !== null && typeof source.metric === 'object' ? source.metric : {};
  const records = Array.isArray(source.records)
    ? source.records.filter(record => record !== null && typeof record === 'object').map((record, index) => ({
      round: Number.isInteger(record.round) ? record.round : index + 1,
      value: Number(record.value),
      recordedAt: typeof record.recordedAt === 'string' ? record.recordedAt : nowIso(),
      notes: typeof record.notes === 'string' ? record.notes : '',
    })).filter(record => Number.isFinite(record.value))
    : [];
  return {
    id,
    loopName: typeof source.loopName === 'string' ? source.loopName : '',
    taskRef: typeof source.taskRef === 'string' && source.taskRef.length > 0 ? source.taskRef : null,
    metric: {
      name: typeof metric.name === 'string' ? metric.name : '',
      target: Number(metric.target),
      unit: typeof metric.unit === 'string' ? metric.unit : '',
    },
    cadence: LOOP_CADENCES.includes(source.cadence) ? source.cadence : 'on-demand',
    records,
    basedOnMemoryId: typeof source.basedOnMemoryId === 'string' ? source.basedOnMemoryId : null,
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : nowIso(),
  };
}

/** The text a search indexes for one memory. */
export function memorySearchText(memory) {
  return [
    memory.content,
    memory.rationale,
    ...(memory.antiPatterns ?? []),
    ...(memory.scope?.taskTypes ?? []),
    ...(memory.scope?.conditions ?? []),
  ].join('\n');
}

/** Path display: default root stays `.memweave/...`; a custom root stays absolute. */
export function memoryPathLabel(root, id) {
  const normalized = String(root).replace(/\\/g, '/');
  const base = normalized.endsWith('/.memweave') ? '.memweave/' : `${normalized}/`;
  return `${base}memories/${id}.json`;
}
