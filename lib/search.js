/**
 * Explainable memory retrieval: TF-IDF relevance, trust decay, type boost, and
 * the anti-pattern forced-recall rule.
 *
 * The score is intentionally inspectable: every factor is a plain function of
 * stored fields, and no model call happens here.
 *
 * @module dsh-memweave/search
 */

import { MEMORY_TYPES, memorySearchText } from './model.js';

/** Type-specific relevance multipliers from the design. */
export const TYPE_BOOST = Object.freeze({
  anti_pattern: 1.3,
  judgment: 1.1,
  procedure: 1.0,
  fact: 0.9,
  relation: 0.8,
});

const LATIN = /^[a-z0-9_]+$/;
const SEGMENT = /[a-z0-9_]+|[\u3400-\u9fff]+/g;

/**
 * Tokenize Latin words and CJK bigrams.
 *
 * Chinese has no whitespace boundaries; bigrams are the smallest unit that
 * keeps phrase order meaningful without shipping a dictionary.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const value = String(text ?? '').normalize('NFKC').toLowerCase();
  const tokens = [];
  SEGMENT.lastIndex = 0;
  for (let match = SEGMENT.exec(value); match !== null; match = SEGMENT.exec(value)) {
    const segment = match[0];
    if (LATIN.test(segment)) {
      tokens.push(segment);
      continue;
    }
    if (segment.length === 1) {
      tokens.push(segment);
      continue;
    }
    for (let index = 0; index < segment.length - 1; index += 1) {
      tokens.push(segment.slice(index, index + 2));
    }
  }
  return tokens;
}

/** Term-frequency map with sublinear scaling. */
function termFrequencies(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  const frequencies = new Map();
  for (const [token, count] of counts) frequencies.set(token, 1 + Math.log(count));
  return frequencies;
}

/** Euclidean norm of a sparse vector. */
function norm(vector) {
  let sum = 0;
  for (const value of vector.values()) sum += value * value;
  return Math.sqrt(sum);
}

/**
 * Freshness in [0,1]: a 90-day linear decay from `lastVerifiedAt`.
 * @param {object} memory
 * @param {number} [now]
 * @returns {number}
 */
export function freshnessOf(memory, now = Date.now()) {
  const stamp = memory.lastVerifiedAt ?? memory.createdAt;
  const time = typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN;
  if (!Number.isFinite(time)) return 0;
  const ageDays = Math.max(0, (now - time) / (24 * 60 * 60 * 1000));
  return Math.min(1, Math.max(0, 1 - ageDays / 90));
}

/**
 * trust_factor = confidence × (1 + 0.6 × (freshness − 0.5)).
 * @param {object} memory
 * @param {number} [now]
 * @returns {number}
 */
export function trustFactorOf(memory, now = Date.now()) {
  const freshness = freshnessOf(memory, now);
  const confidence = Number.isFinite(memory.confidence) ? memory.confidence : 0;
  return confidence * (1 + 0.6 * (freshness - 0.5));
}

/** Whether one memory is in the default retrieval pool for these options. */
export function isSearchable(memory, includeCandidates) {
  if (memory.status === 'verified') return true;
  if (memory.status === 'candidate' && includeCandidates) return true;
  return false;
}

/**
 * Score one corpus against a query.
 * @param {object[]} memories - already filtered by type.
 * @param {string} query
 * @param {{ now?: number }} [options]
 * @returns {{ memory: object, score: number }[]} sorted descending; zero-score rows dropped.
 */
export function scoreCorpus(memories, query, { now = Date.now() } = {}) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || memories.length === 0) return [];

  const documents = memories.map(memory => {
    const tokens = tokenize(memorySearchText(memory));
    return { memory, frequencies: termFrequencies(tokens) };
  });

  const documentFrequency = new Map();
  for (const document of documents) {
    for (const token of document.frequencies.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const total = documents.length;
  const idf = token => Math.log((total + 1) / ((documentFrequency.get(token) ?? 0) + 1)) + 1;
  const queryFrequencies = termFrequencies(queryTokens);
  const queryVector = new Map();
  for (const [token, frequency] of queryFrequencies) queryVector.set(token, frequency * idf(token));
  const queryNorm = norm(queryVector);
  if (queryNorm === 0) return [];

  const scored = [];
  for (const document of documents) {
    let dot = 0;
    const vector = new Map();
    for (const [token, frequency] of document.frequencies) {
      const weight = frequency * idf(token);
      vector.set(token, weight);
      const queryWeight = queryVector.get(token);
      if (queryWeight !== undefined) dot += weight * queryWeight;
    }
    if (dot === 0) continue;
    const documentNorm = norm(vector);
    if (documentNorm === 0) continue;
    const similarity = dot / (queryNorm * documentNorm);
    if (similarity <= 0) continue;
    const boost = TYPE_BOOST[document.memory.type] ?? 1;
    const score = similarity * trustFactorOf(document.memory, now) * boost;
    if (score <= 0) continue;
    scored.push({ memory: document.memory, score });
  }

  scored.sort((left, right) => right.score - left.score
    || right.memory.confidence - left.memory.confidence
    || String(right.memory.createdAt).localeCompare(String(left.memory.createdAt)));
  return scored;
}

/**
 * Search the memory pool and apply forced anti-pattern recall.
 *
 * `types` is an allow-list; an empty or omitted list means all five types.
 * Disputed and superseded memories never enter this pool: their confidence is
 * already visible in browsing, but they must not silently advise a task.
 *
 * @param {object[]} memories
 * @param {{ query: string, types?: string[], limit?: number, includeCandidates?: boolean, now?: number }} input
 * @returns {{ results: object[], antiPatternForced: boolean }}
 */
export function searchMemories(memories, { query, types, limit = 5, includeCandidates = false, now = Date.now() } = {}) {
  const allowedTypes = Array.isArray(types) && types.length > 0
    ? new Set(types.filter(type => MEMORY_TYPES.includes(type)))
    : new Set(MEMORY_TYPES);
  const pool = memories.filter(memory => allowedTypes.has(memory.type) && isSearchable(memory, includeCandidates));
  const scored = scoreCorpus(pool, query, { now });
  const capped = Math.min(50, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 5));
  const results = scored.slice(0, capped).map(entry => entry.memory);

  let antiPatternForced = false;
  if (results.length > 0 && !results.some(memory => memory.type === 'anti_pattern')) {
    const already = new Set(results.map(memory => memory.id));
    const best = scored.find(entry => entry.memory.type === 'anti_pattern' && !already.has(entry.memory.id));
    if (best !== undefined) {
      if (results.length < capped) {
        results.push(best.memory);
      } else {
        results[results.length - 1] = best.memory;
      }
      antiPatternForced = true;
      const order = new Map(scored.map((entry, index) => [entry.memory.id, index]));
      results.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
    }
  }

  return { results, antiPatternForced };
}
