/**
 * Memory lifecycle operations shared by the tools and the settings API.
 *
 * Keeping these functions free of Cordis/tool concerns is what lets the
 * settings-page "verify" button run exactly the same logic as
 * `memweave_memory_verify`.
 *
 * @module dsh-memweave/memory
 */

import { invalidArgument, throwIfAborted } from './errors.js';
import {
  MEMORY_STATUSES,
  MEMORY_TYPES,
  OUTCOME_LABELS,
  TYPE_LABELS,
  VERIFY_OUTCOMES,
  clamp,
  evidenceSummary,
  newId,
  normalizeMemory,
  nowIso,
  round4,
  truncate,
  uniqueStrings,
} from './model.js';
import { cleanupOrphanTmp } from './paths.js';
import { memorySearchText } from './model.js';
import { searchMemories, tokenize } from './search.js';
import { loadMemories, readMemory, writeMemory } from './store.js';
import path from 'node:path';

/**
 * Whether one type list is a non-empty subset of the five categories.
 * @param {unknown} types
 * @returns {string[]}
 */
export function normalizeTypeFilter(types) {
  if (types === undefined) return [];
  if (!Array.isArray(types)) throw invalidArgument('types 必须是字符串数组。');
  const result = [];
  for (const type of types) {
    if (!MEMORY_TYPES.includes(type)) {
      throw invalidArgument(`未知记忆类型：${String(type)}。允许：${MEMORY_TYPES.join(', ')}。`);
    }
    if (!result.includes(type)) result.push(type);
  }
  return result;
}

/**
 * Create one candidate memory.
 * @param {string} root
 * @param {{
 *   type: string, content: string, rationale: string, antiPatterns?: string[],
 *   scopeTaskTypes?: string[], scopeConditions?: string[], sourceTaskRef?: string,
 * }} input
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ memoryId: string, status: 'candidate', overlapHint: string|null }>}
 */
export async function precipitateMemory(root, input, { signal } = {}) {
  throwIfAborted(signal);
  const type = input.type;
  if (!MEMORY_TYPES.includes(type)) {
    throw invalidArgument(`未知记忆类型：${String(type)}。允许：${MEMORY_TYPES.join(', ')}。`);
  }
  const content = String(input.content ?? '').trim();
  if (content.length === 0) throw invalidArgument('content 不能为空。');
  const rationale = String(input.rationale ?? '').trim();
  const antiPatterns = uniqueStrings(input.antiPatterns);

  if (type === 'anti_pattern' && antiPatterns.length === 0) {
    throw invalidArgument('anti_pattern 记忆必须提供至少一条 antiPatterns：说明什么情况下这条经验无效。');
  }
  if (type === 'judgment' && rationale.length === 0) {
    throw invalidArgument('judgment 记忆必须提供 rationale：说明为什么有效。');
  }

  const { memories } = await loadMemories(root, { signal });
  throwIfAborted(signal);
  const memory = {
    id: newId('mem'),
    type,
    content,
    rationale,
    antiPatterns,
    scope: {
      taskTypes: uniqueStrings(input.scopeTaskTypes),
      conditions: uniqueStrings(input.scopeConditions),
    },
    source: {
      taskRef: typeof input.sourceTaskRef === 'string' && input.sourceTaskRef.trim().length > 0
        ? input.sourceTaskRef.trim()
        : null,
    },
    evidence: { loopRecords: [], taskCompletions: [] },
    confidence: 0.5,
    status: 'candidate',
    createdAt: nowIso(),
    lastVerifiedAt: null,
    supersededBy: null,
    verificationLog: [],
  };
  await writeMemory(root, memory, { signal });
  return {
    memoryId: memory.id,
    status: 'candidate',
    overlapHint: overlapHintFor(memories, memory),
  };
}

/**
 * Find a likely duplicate/overlapping memory before the user accumulates
 * contradictory judgments with the same scope.
 * @param {object[]} memories
 * @param {object} candidate
 * @returns {string|null}
 */
export function overlapHintFor(memories, candidate) {
  const candidateTypes = new Set(candidate.scope?.taskTypes ?? []);
  const candidateTokens = new Set(tokenize(candidate.content));
  let best = null;
  for (const memory of memories) {
    if (memory.status === 'superseded' || memory.id === candidate.id) continue;
    const sharedTypes = (memory.scope?.taskTypes ?? []).filter(type => candidateTypes.has(type));
    const memoryTokens = new Set(tokenize(memory.content));
    let intersection = 0;
    for (const token of candidateTokens) if (memoryTokens.has(token)) intersection += 1;
    const union = candidateTokens.size + memoryTokens.size - intersection;
    const similarity = union === 0 ? 0 : intersection / union;
    const weight = sharedTypes.length * 10 + similarity;
    if (sharedTypes.length === 0 && similarity < 0.5) continue;
    if (best === null || weight > best.weight) {
      best = { memory, sharedTypes, similarity, weight };
    }
  }
  if (best === null) return null;
  const scope = best.sharedTypes.length > 0 ? `（taskTypes：${best.sharedTypes.join('、')}）` : '';
  return `与 ${best.memory.id}（${TYPE_LABELS[best.memory.type]}）“${truncate(best.memory.content, 24)}”的适用范围重叠${scope}，建议合并，或将其标记为 superseded。`;
}

/**
 * Apply one verification outcome.
 * @param {string} root
 * @param {{ memoryId: string, outcome: string, note?: string }} input
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ memoryId: string, previousConfidence: number, newConfidence: number, newStatus: string }>}
 */
export async function verifyMemory(root, { memoryId, outcome, note }, { signal } = {}) {
  throwIfAborted(signal);
  if (!VERIFY_OUTCOMES.includes(outcome)) {
    throw invalidArgument(`未知验证结论：${String(outcome)}。允许：${VERIFY_OUTCOMES.join(', ')}。`);
  }
  const memory = await readMemory(root, memoryId, { signal, missing: 'throw' });
  if (memory.status === 'superseded') {
    throw invalidArgument(`记忆 ${memoryId} 已被 ${memory.supersededBy ?? '新版本'} 取代，不能再次验证。`);
  }

  const previousConfidence = memory.confidence;
  const previousStatus = memory.status;
  let newConfidence = previousConfidence;
  let newStatus = previousStatus;

  if (outcome === 'valid') {
    newConfidence = round4(clamp(previousConfidence + 0.15, 0, 1));
    newStatus = 'verified';
  } else if (outcome === 'invalid') {
    newConfidence = round4(clamp(previousConfidence - 0.25, 0, 1));
    if (newConfidence < 0.3) newStatus = 'disputed';
  }

  memory.confidence = newConfidence;
  memory.status = newStatus;
  memory.lastVerifiedAt = nowIso();
  memory.verificationLog = [
    ...(memory.verificationLog ?? []),
    {
      at: memory.lastVerifiedAt,
      outcome,
      note: typeof note === 'string' ? truncate(note, 500) : '',
    },
  ].slice(-50);

  throwIfAborted(signal);
  await writeMemory(root, memory, { signal });
  return { memoryId, previousConfidence, newConfidence, newStatus };
}

/** Public projection used by find/list results. */
export function toPublicMemory(memory) {
  return {
    memoryId: memory.id,
    type: memory.type,
    content: memory.content,
    rationale: memory.rationale,
    confidence: memory.confidence,
    status: memory.status,
    lastVerifiedAt: memory.lastVerifiedAt,
    evidenceSummary: evidenceSummary(memory.evidence),
  };
}

/**
 * Retrieve memories for a task/decision context.
 * @param {string} root
 * @param {{ query: string, types?: string[], limit?: number, includeCandidates?: boolean }} input
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ results: object[], antiPatternForced: boolean }>}
 */
export async function findMemories(root, input, { signal } = {}) {
  throwIfAborted(signal);
  const query = String(input.query ?? '').trim();
  if (query.length === 0) throw invalidArgument('query 不能为空。');
  const types = normalizeTypeFilter(input.types);
  const { memories } = await loadMemories(root, { signal });
  throwIfAborted(signal);
  const result = searchMemories(memories, {
    query,
    types,
    limit: input.limit,
    includeCandidates: input.includeCandidates === true,
  });
  return { results: result.results.map(toPublicMemory), antiPatternForced: result.antiPatternForced };
}

/** Count one memory set into the five fixed type keys + four status keys. */
export function countMemories(memories) {
  const types = Object.fromEntries(MEMORY_TYPES.map(type => [type, 0]));
  const statuses = Object.fromEntries(MEMORY_STATUSES.map(status => [status, 0]));
  for (const memory of memories) {
    types[memory.type] = (types[memory.type] ?? 0) + 1;
    statuses[memory.status] = (statuses[memory.status] ?? 0) + 1;
  }
  return { types, statuses };
}

/**
 * Browse memories with filters, sorting and pagination.
 * @param {string} root
 * @param {{
 *   types?: string[], status?: string, sort?: string, limit?: number, offset?: number, summary?: boolean,
 *   query?: string,
 * }} input
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ items: object[], total: number, summaryByType: Record<string, number>|null, skipped: number }>}
 */
export async function listMemories(root, input, { signal } = {}) {
  throwIfAborted(signal);
  const types = normalizeTypeFilter(input.types);
  const status = input.status ?? 'verified';
  if (!MEMORY_STATUSES.includes(status)) {
    throw invalidArgument(`未知状态：${String(status)}。允许：${MEMORY_STATUSES.join(', ')}。`);
  }
  const sort = input.sort ?? 'last_verified';
  if (!['last_verified', 'confidence', 'created'].includes(sort)) {
    throw invalidArgument(`未知排序：${String(sort)}。允许：last_verified, confidence, created。`);
  }
  const limit = clamp(Number.isFinite(input.limit) ? Math.floor(input.limit) : 20, 1, 100);
  const offset = Math.max(0, Number.isFinite(input.offset) ? Math.floor(input.offset) : 0);

  await cleanupOrphanTmp([path.join(root, 'memories')]);
  const { memories, skipped } = await loadMemories(root, { signal });
  throwIfAborted(signal);

  const typeSet = new Set(types);
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  const queryTokens = query.length > 0 ? tokenize(query) : [];
  const filtered = memories.filter(memory => {
    if (typeSet.size > 0 && !typeSet.has(memory.type)) return false;
    if (memory.status !== status) return false;
    if (query.length === 0) return true;
    const haystack = memorySearchText(memory).toLowerCase();
    if (haystack.includes(query.toLowerCase())) return true;
    return queryTokens.length > 0 && queryTokens.every(token => haystack.includes(token));
  });
  const summaryByType = Object.fromEntries(MEMORY_TYPES.map(type => [type, 0]));
  for (const memory of filtered) summaryByType[memory.type] += 1;

  if (input.summary === true) {
    return { items: [], total: filtered.length, summaryByType, skipped };
  }

  filtered.sort((left, right) => {
    if (sort === 'confidence') {
      return right.confidence - left.confidence
        || String(right.createdAt).localeCompare(String(left.createdAt));
    }
    if (sort === 'created') {
      return String(right.createdAt).localeCompare(String(left.createdAt));
    }
    const leftVerified = left.lastVerifiedAt === null ? 0 : Date.parse(left.lastVerifiedAt);
    const rightVerified = right.lastVerifiedAt === null ? 0 : Date.parse(right.lastVerifiedAt);
    return (rightVerified - leftVerified)
      || String(right.createdAt).localeCompare(String(left.createdAt));
  });

  const items = filtered.slice(offset, offset + limit).map(toPublicMemory);
  return { items, total: filtered.length, summaryByType: null, skipped };
}

/**
 * Full detail for the settings browser; includes fields the public tool
 * projection intentionally omits (scope, antiPatterns, verification log).
 * @param {string} root
 * @param {string} id
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function memoryDetail(root, id, { signal } = {}) {
  throwIfAborted(signal);
  const memory = await readMemory(root, id, { signal, missing: 'throw' });
  return {
    memory: {
      ...memory,
      typeLabel: TYPE_LABELS[memory.type],
      outcomeLabels: OUTCOME_LABELS,
    },
  };
}

/** All-memory overview counts for the storage tab. */
export async function memoryOverview(root, { signal } = {}) {
  throwIfAborted(signal);
  const { memories, skipped } = await loadMemories(root, { signal });
  return { counts: countMemories(memories), total: memories.length, skipped };
}

/** Re-export for normalization when a caller needs to inspect a raw object. */
export { normalizeMemory };
