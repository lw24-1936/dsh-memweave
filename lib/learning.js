/**
 * Safe, opt-in session learning.
 *
 * The learner observes user-authored session messages, extracts explicit
 * decisions/corrections, redacts secret-like values, and writes compact memory
 * candidates. It never stores raw conversations, tool results, or assistant
 * reasoning. Historical backfill is explicit and bounded.
 *
 * @module dsh-memweave/learning
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { invalidArgument } from './errors.js';
import { loadMemories } from './store.js';
import { precipitateMemory, verifyMemory } from './memory.js';

const MAX_LEARNED_PER_MESSAGE = 1;
const MAX_CONTENT = 200;
const MAX_HISTORY = 500;

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]{6,}/gi,
];

const CORRECTION = /(?:不要|别\s|禁止|不能|不应该|以后不要|避免|不是.{0,80}而是|改成|改为|纠正|正确做法|错了)/;
const DECISION = /(?:决定|确定|采用|选择|就按|按这个|以后都|必须|一定要|记住|优先|统一用)/;
const PROCEDURE = /(?:以后|必须|一定要|流程|先.{0,80}再|每次|统一)/;
const STRONG = /^(?:不要|别\s|禁止|不能|不应该|必须|一定要|记住|请记住|以后|决定|采用|就按|改成|改为|纠正|统一用)/;
const UNCERTAIN = /(?:可能|也许|大概|建议|可以考虑|或许|不一定|暂时|如果)/;
const CODEISH = /(?:\*\*|~~|`|```|\{|\}|\[|\]|https?:\/\/|=>|<\w+|^\s*[-*]\s|\||\\|[\u0000-\u001F\u007F])/;
const DURABLE_START = /^(?:以后|从今以后|今后|记住|请记住|请务必记住|始终|总是|永远|每次|长期)/;
const CONTEXT_SPECIFIC = /(?:git|commit|push|README|SQL|vite\.config|SystemPrompt|os|fs|child_process|另一代理|本次|这轮|当前|这个项目|该文件|文件|页面|代码|[\w.-]+\.(?:ts|js|jsx|tsx|json|md|vue|sql|css|html)|[\\/])/i;
const MOJIBAKE = /(?:\uFFFD|[\u00C0-\u00FF]{3,}|Ã|Â|锛|鈥)/;
const STREAM_EVENT = /stream|chunk|delta|heartbeat|telemetry/i;
const ARCHIVE_LINE_LIMIT = 30000;
const SYSTEMISH = /^(?:Current runtime context|This snapshot supersedes|You are an AI|Runtime context|AGENTS\.md)/i;

/** Remove secret-like values from one text fragment. */
export function redactSensitive(text) {
  let safe = String(text ?? '');
  for (const pattern of SECRET_PATTERNS) safe = safe.replace(pattern, '[REDACTED]');
  return safe;
}

/** Flatten a user-message content value into text. */
export function messageText(message) {
  if (typeof message === 'string') return message;
  if (message === null || typeof message !== 'object') return '';
  if (typeof message.text === 'string') return message.text;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

/** Normalize content for exact duplicate detection. */
export function normalizeLearningContent(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Stable content hash for dedupe. */
export function learningHash(text) {
  return createHash('sha256').update(normalizeLearningContent(text)).digest('hex');
}

/** Split one message into sentence-like candidates. */
function sentences(text) {
  return String(text ?? '')
    .split(/(?<=[。！？!?])\s*|\n+/)
    .map(part => part.trim().replace(/^[-*•]\s*/, ''))
    .filter(part => part.length >= 8);
}

/**
 * Extract compact, user-authored decision/correction memories.
 * @param {string} raw
 * @param {{ sessionId?: string, cwd?: string, time?: number }} [context]
 * @returns {Array<{type: string, content: string, rationale: string, scopeConditions: string[], sourceTaskRef: string, autoVerify: boolean}>}
 */
export function extractLearning(raw, { sessionId = 'unknown', cwd = '', time = Date.now() } = {}) {
  const source = redactSensitive(raw);
  if (source.length < 8 || source.length > 12000) return [];
  const project = typeof cwd === 'string' && cwd.length > 0 ? path.basename(cwd) : '';
  const when = new Date(Number.isFinite(time) ? time : Date.now()).toISOString();
  const found = [];
  const seen = new Set();
  for (const sentence of sentences(source)) {
    if (found.length >= MAX_LEARNED_PER_MESSAGE) break;
    if (sentence.length < 14 || sentence.length > MAX_CONTENT) continue;
    if (CODEISH.test(sentence)) continue;
    if (MOJIBAKE.test(sentence)) continue;
    if (/^[>{}\[\]]/.test(sentence)) continue;
    if (/[?？]\s*$/.test(sentence)) continue;
    if (/(?:[:：]|包括|如下|以下|\.{3}|…)\s*$/.test(sentence)) continue;
    if (!CORRECTION.test(sentence) && !DECISION.test(sentence)) continue;
    if (!DURABLE_START.test(sentence)) continue;
    if (CONTEXT_SPECIFIC.test(sentence)) continue;
    if (/^(?:好|可以|继续|谢谢|收到|ok|okay)[。！!]?$/i.test(sentence)) continue;
    const visible = sentence.replace(/[^\p{L}\p{N}]/gu, '').length;
    if (visible < 8 || visible / sentence.length < 0.55) continue;
    const content = sentence.slice(0, MAX_CONTENT).trim();
    if (content.length < 8 || normalizeLearningContent(content) === '[redacted]') continue;
    const hash = learningHash(content);
    if (seen.has(hash)) continue;
    seen.add(hash);
    found.push({
      type: PROCEDURE.test(content) ? 'procedure' : 'judgment',
      content,
      rationale: `自动学习：用户明确表达（来源会话 ${sessionId}${project.length > 0 ? `，项目 ${project}` : ''}，${when}）。`,
      scopeConditions: project.length > 0 ? [`项目：${project}`] : [],
      sourceTaskRef: `session:${sessionId}`,
      autoVerify: STRONG.test(content) && !UNCERTAIN.test(content) && content.length <= 180,
    });
  }
  return found;
}

/**
 * Create one opt-in learner. Live events are queued; backfill is explicit.
 * @param {{
 *   getSettings: () => { enabled?: boolean, scope?: string, autoVerify?: boolean, historyLimit?: number },
 *   getSessionQuery?: () => object | undefined,
 *   resolveRoot: (workspace: string|undefined) => Promise<string>,
 *   logger?: { warn?: (message: string) => void },
 * }} options
 */
export function createAutoLearner({ getSettings, getSessionQuery, resolveRoot, logger } = {}) {
  const state = {
    learned: 0,
    skipped: 0,
    errors: 0,
    sessionsSeen: 0,
    lastError: null,
    lastAt: null,
    backfilling: false,
    lastBackfill: null,
    archivedEvents: 0,
  };
  const seen = new Set();
  const seenArchive = new Set();
  const seededRoots = new Set();
  const seenSessions = new Set();
  const archivedSessionIds = new Set();
  const archiveDirs = new Set();
  let queue = Promise.resolve();

  const settings = () => {
    const value = getSettings?.() ?? {};
    return {
      enabled: value.enabled === true,
      scope: typeof value.scope === 'string' ? value.scope.trim() : '',
      autoVerify: value.autoVerify !== false,
      historyLimit: Math.min(MAX_HISTORY, Math.max(1, Number.isFinite(Number(value.historyLimit)) ? Number(value.historyLimit) : 50)),
    };
  };

  const matchesScope = (cwd, text) => {
    const scope = settings().scope;
    if (scope.length === 0) return true;
    return String(cwd ?? '').toLowerCase().includes(scope.toLowerCase()) || String(text ?? '').toLowerCase().includes(scope.toLowerCase());
  };

  const archiveBatch = async (sessionId, events, workspace, { skipExisting = false } = {}) => {
    if (!Array.isArray(events) || events.length === 0) return 0;
    const rootKey = await resolveRoot(workspace);
    const safeSession = String(sessionId).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'unknown';
    const directory = path.join(rootKey, 'sessions');
    const file = path.join(directory, `${safeSession}.jsonl`);
    if (skipExisting) {
      try {
        await fs.access(file);
        archivedSessionIds.add(safeSession);
        return 0;
      } catch {
        // No existing archive for this session.
      }
    }
    const lines = [];
    for (const event of events) {
      if (event === null || typeof event !== 'object') continue;
      const type = typeof event.type === 'string' ? event.type : '';
      if (type.length === 0 || STREAM_EVENT.test(type)) continue;
      const seq = event.seq ?? event.id ?? learningHash(JSON.stringify(event));
      const key = `${rootKey}:${safeSession}:${String(seq)}`;
      if (seenArchive.has(key)) continue;
      let payload;
      try {
        payload = JSON.stringify({ type, seq, at: event.at ?? event.time ?? null, data: event.data ?? null });
      } catch {
        continue;
      }
      if (payload.length > ARCHIVE_LINE_LIMIT) payload = `${payload.slice(0, ARCHIVE_LINE_LIMIT)}...[TRUNCATED]`;
      lines.push(redactSensitive(payload));
      seenArchive.add(key);
    }
    if (lines.length === 0) return 0;
    if (!archiveDirs.has(directory)) {
      await fs.mkdir(directory, { recursive: true });
      archiveDirs.add(directory);
    }
    await fs.appendFile(file, `${lines.join('\n')}\n`, 'utf8');
    archivedSessionIds.add(safeSession);
    state.archivedEvents += lines.length;
    return lines.length;
  };

  const archiveEvent = (sessionId, event, workspace) => archiveBatch(sessionId, [event], workspace);

  const summarizeSession = async (sessionId, cwd, events) => {
    const users = [];
    const tools = new Set();
    for (const event of events ?? []) {
      if (event?.type === 'user/message') {
        const text = redactSensitive(messageText(event.data)).replace(/<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/gi, '').replace(/\s+/g, ' ').trim();
        if (text.length > 0 && !SYSTEMISH.test(text) && !/runtime context/i.test(text)) users.push(text.slice(0, 180));
      }
      if (typeof event?.type === 'string' && /tool/i.test(event.type)) {
        const name = event.data?.name ?? event.data?.toolName ?? event.data?.call?.name;
        if (typeof name === 'string' && name.length > 0) tools.add(name);
      }
    }
    if (users.length === 0 && tools.size === 0) return false;
    const project = typeof cwd === 'string' && cwd.length > 0 ? path.basename(cwd) : '';
    const content = `会话 ${sessionId}${project.length > 0 ? `（${project}）` : ''}：用户要求 ${users.slice(0, 3).join('；')}${tools.size > 0 ? `；操作工具：${[...tools].slice(0, 8).join(', ')}` : ''}`.slice(0, MAX_CONTENT);
    return storeOne({
      type: 'procedure',
      content,
      rationale: `自动学习：会话摘要（来源 ${sessionId}${project.length > 0 ? `，项目 ${project}` : ''}）。`,
      scopeConditions: project.length > 0 ? [`项目：${project}`] : [],
      sourceTaskRef: `session:${sessionId}`,
      autoVerify: false,
    }, cwd, false);
  };

  const seedRoot = async root => {
    if (seededRoots.has(root)) return;
    try {
      const { memories } = await loadMemories(root);
      for (const memory of memories) seen.add(learningHash(memory.content));
    } catch {
      // A missing/empty store is normal.
    }
    seededRoots.add(root);
  };

  const storeOne = async (item, workspace, allowVerify = true) => {
    const hash = learningHash(item.content);
    if (seen.has(hash)) {
      state.skipped += 1;
      return false;
    }
    const root = await resolveRoot(workspace);
    await seedRoot(root);
    const created = await precipitateMemory(root, {
      type: item.type,
      content: item.content,
      rationale: item.rationale,
      scopeConditions: item.scopeConditions,
      sourceTaskRef: item.sourceTaskRef,
    });
    if (settings().autoVerify && allowVerify && item.autoVerify) {
      await verifyMemory(root, {
        memoryId: created.memoryId,
        outcome: 'valid',
        note: '自动学习：用户明确表达的决定或纠正。',
      });
    }
    seen.add(hash);
    state.learned += 1;
    state.lastAt = new Date().toISOString();
    return true;
  };

  const processText = async (text, { sessionId, cwd }, { allowVerify = true } = {}) => {
    if (!settings().enabled) return 0;
    if (!matchesScope(cwd, text)) return 0;
    const items = extractLearning(text, { sessionId, cwd });
    let count = 0;
    for (const item of items) {
      try {
        if (await storeOne(item, cwd, allowVerify)) count += 1;
      } catch (error) {
        state.errors += 1;
        state.lastError = error instanceof Error ? error.message : String(error);
        logger?.warn?.(`[dsh-memweave] auto-learn failed: ${state.lastError}`);
      }
    }
    return count;
  };

  const onSessionEvent = (session, event) => {
    if (!settings().enabled) return Promise.resolve(0);
    const sessionId = session?.id ?? session?.header?.id ?? 'unknown';
    const cwd = session?.header?.cwd;
    state.sessionsSeen += 1;
    queue = queue.then(async () => {
      await archiveEvent(sessionId, event, cwd);
      if (event?.type !== 'user/message') return 0;
      const text = messageText(event.data);
      if (text.length === 0) return 0;
      return processText(text, { sessionId, cwd });
    }).catch(error => {
      state.errors += 1;
      state.lastError = error instanceof Error ? error.message : String(error);
    });
    return queue;
  };

  const backfill = async ({ limit, dryRun = false } = {}) => {
    const current = settings();
    if (!current.enabled) throw invalidArgument('自动学习未启用。');
    const query = getSessionQuery?.();
    if (query === undefined || query === null || typeof query.listSessions !== 'function' || typeof query.readSession !== 'function') {
      throw invalidArgument('当前 Host 没有 sessionQuery，无法回填历史会话。');
    }
    if (state.backfilling) throw invalidArgument('历史回填正在进行中。');
    const bounded = Math.min(MAX_HISTORY, Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : current.historyLimit));
    state.backfilling = true;
    const result = { sessions: 0, learned: 0, skipped: 0, errors: 0, archived: 0 };
    const samples = [];
    try {
      const records = await query.listSessions();
      const ordered = [...records].sort((left, right) => Number(right.header?.createdAt ?? 0) - Number(left.header?.createdAt ?? 0));
      for (const record of ordered) {
        if (result.sessions >= bounded) break;
        const id = record.header?.id;
        if (typeof id !== 'string' || id.length === 0 || seenSessions.has(id)) {
          result.skipped += 1;
          continue;
        }
        let snapshot;
        try {
          snapshot = await query.readSession(id);
        } catch (error) {
          result.errors += 1;
          result.skipped += 1;
          seenSessions.add(id);
          logger?.warn?.(`[dsh-memweave] backfill skipped ${id}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        const cwd = snapshot.session?.cwd ?? record.header?.cwd;
        result.sessions += 1;
        if (!dryRun) result.archived += await archiveBatch(id, snapshot.events ?? [], cwd, { skipExisting: true });
        for (const event of snapshot.events ?? []) {
          if (event?.type !== 'user/message') continue;
          const text = messageText(event.data);
          if (!matchesScope(cwd, text)) continue;
          if (dryRun) {
            const items = extractLearning(text, { sessionId: id, cwd });
            result.learned += items.length;
            for (const item of items) {
              if (samples.length < 20) samples.push({ sessionId: id, content: item.content, autoVerify: item.autoVerify });
            }
          } else {
            const learned = await processText(text, { sessionId: id, cwd }, { allowVerify: false });
            result.learned += learned;
          }
        }
        if (!dryRun) {
          try {
            if (await summarizeSession(id, cwd, snapshot.events ?? [])) result.learned += 1;
          } catch (error) {
            result.errors += 1;
            logger?.warn?.(`[dsh-memweave] summary failed ${id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        seenSessions.add(id);
        if (dryRun) seenSessions.delete(id);
      }
      state.lastBackfill = { ...result, at: new Date().toISOString(), limit: bounded };
      return dryRun ? { ...result, samples } : result;
    } finally {
      state.backfilling = false;
    }
  };

  return {
    backfill,
    onSessionEvent,
    status: () => ({
      ...settings(),
      ...state,
      archivedSessions: archivedSessionIds.size,
      backfilling: state.backfilling,
      lastBackfill: state.lastBackfill,
    }),
  };
}
