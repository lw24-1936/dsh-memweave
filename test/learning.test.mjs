/** Safe session-learning extraction, dedupe, and explicit backfill. */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createAutoLearner, extractLearning, redactSensitive } from '../lib/learning.js';
import { loadMemories } from '../lib/store.js';
import { makeWorkspace, cleanup } from './helpers.mjs';

test('extracts explicit decisions, redacts secrets, and skips questions', () => {
  const text = '以后必须使用 pnpm，不要再用 npm。API key 是 sk-abcdefghijklmnopqrstuvwx，请记住。这个方案能用吗？';
  const items = extractLearning(text, { sessionId: 's-test', cwd: 'E:/project/demo', time: Date.now() });
  assert.ok(items.length >= 1);
  assert.equal(items[0].sourceTaskRef, 'session:s-test');
  assert.match(items[0].content, /pnpm/);
  assert.match(items[0].rationale, /自动学习/);
  assert.equal(items[0].autoVerify, true);
  assert.equal(items.some(item => item.content.includes('sk-abcdefghijklmnop')), false);
  assert.equal(redactSensitive('token=abcdef123456'), '[REDACTED]');
  assert.equal(extractLearning('这个方案能用吗？', {}).length, 0);
  assert.equal(extractLearning('必须修改 **M11** 的 `saveQuestion`；{ optionsJson }', {}).length, 0);
});

test('live learning writes verified memories and deduplicates content', async () => {
  const root = await makeWorkspace('memweave-learn-');
  try {
    const learner = createAutoLearner({
      getSettings: () => ({ enabled: true, scope: '', autoVerify: true, historyLimit: 50 }),
      resolveRoot: async () => root,
    });
    const session = { id: 's-live', header: { cwd: root } };
    const event = {
      type: 'user/message',
      data: { content: [{ type: 'text', text: '以后必须使用 pnpm 安装依赖，不要再用 npm。' }] },
    };
    await learner.onSessionEvent(session, event);
    const first = await loadMemories(root);
    assert.equal(first.memories.length, 1);
    assert.equal(first.memories[0].status, 'verified');
    assert.equal(first.memories[0].source.taskRef, 'session:s-live');
    assert.match(first.memories[0].content, /pnpm/);
    assert.equal(learner.status().learned, 1);
    const archived = await fs.readdir(path.join(root, 'sessions'));
    assert.equal(archived.length, 1);
    assert.match(await fs.readFile(path.join(root, 'sessions', archived[0]), 'utf8'), /以后必须使用 pnpm/);

    await learner.onSessionEvent(session, event);
    const second = await loadMemories(root);
    assert.equal(second.memories.length, 1);
    assert.equal(learner.status().skipped, 1);
  } finally {
    await cleanup(root);
  }
});

test('historical backfill is explicit, bounded, and idempotent', async () => {
  const root = await makeWorkspace('memweave-backfill-');
  try {
    const query = {
      listSessions: async () => [
        { header: { id: 's-new', createdAt: 2, cwd: root } },
        { header: { id: 's-old', createdAt: 1, cwd: root } },
      ],
      readSession: async id => ({
        session: { id, cwd: root },
        events: [{ type: 'user/message', data: { content: [{ type: 'text', text: id === 's-new' ? '以后都统一使用 pnpm 管理依赖。' : '以后都先写测试，再验证结果。' }] } }],
      }),
    };
    const learner = createAutoLearner({
      getSettings: () => ({ enabled: true, scope: '', autoVerify: true, historyLimit: 2 }),
      getSessionQuery: () => query,
      resolveRoot: async () => root,
    });
    const result = await learner.backfill({ limit: 2 });
    assert.equal(result.sessions, 2);
    assert.ok(result.learned >= 2);
    assert.ok(result.archived >= 2);
    const memories = await loadMemories(root);
    assert.ok(memories.memories.length >= 2);
    const again = await learner.backfill({ limit: 2 });
    assert.equal(again.sessions, 0);
    assert.equal(again.learned, 0);
  } finally {
    await cleanup(root);
  }
});
