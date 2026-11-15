/** End-to-end Host behavior: tool contracts, lifecycle, loops, fusion. */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { detectFusion } from '../lib/fusion.js';
import { cleanup, createHost, makeExec, makeWorkspace, runTool } from './helpers.mjs';

const TOOL_NAMES = [
  'memweave_decompose',
  'memweave_precipitate',
  'memweave_memory_find',
  'memweave_memory_verify',
  'memweave_loop_start',
  'memweave_loop_record',
  'memweave_memory_list',
  'memweave_fusion_status',
  'memweave_import',
  'memweave_export',
];

test('registers ten tools whose descriptions start with "Use when"', async () => {
  const workspace = await makeWorkspace();
  try {
    const { tools } = createHost({ cwd: workspace });
    assert.deepEqual([...tools.keys()].sort(), [...TOOL_NAMES].sort());
    for (const name of TOOL_NAMES) {
      assert.match(tools.get(name).description, /^Use when /);
    }
  } finally {
    await cleanup(workspace);
  }
});

test('decompose creates a six-node task network with anti-pattern warnings', async () => {
  const workspace = await makeWorkspace();
  try {
    const { tools } = createHost({ cwd: workspace });
    const exec = makeExec(workspace);

    const anti = await runTool(tools, 'memweave_precipitate', {
      type: 'anti_pattern',
      content: '插件验证只跑 happy path、不写验收标准，会误判已经完成',
      rationale: '验收标准是任务网络的闭环条件',
      antiPatterns: ['目标仍然模糊时'],
      scopeTaskTypes: ['任务拆解'],
    }, exec);
    await runTool(tools, 'memweave_memory_verify', { memoryId: anti.value.memoryId, outcome: 'valid' }, exec);

    const result = await runTool(tools, 'memweave_decompose', {
      goal: '实现一个 DSH 插件并验证安装',
      context: '已有 agent-experience 技能',
    }, exec);
    assert.deepEqual(result.violations, []);
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].type, 'text');
    assert.equal(result.value.nodes.length, 6);
    assert.deepEqual(result.value.nodes[0].dependsOn, []);
    assert.equal(result.value.warnings.length, 1);
    assert.match(result.blocks[0].text, /避坑提醒/);
    assert.match(result.blocks[0].text, /网络 ID/);

    const netFile = path.join(workspace, '.memweave', 'tasknets', `${result.value.netId}.json`);
    const stored = JSON.parse(await fs.readFile(netFile, 'utf8'));
    assert.equal(stored.nodes.length, 6);
  } finally {
    await cleanup(workspace);
  }
});

test('precipitate enforces anti-pattern and judgment contracts', async () => {
  const workspace = await makeWorkspace();
  try {
    const { tools } = createHost({ cwd: workspace });
    const exec = makeExec(workspace);

    await assert.rejects(
      runTool(tools, 'memweave_precipitate', {
        type: 'anti_pattern',
        content: '没有反模式说明',
        rationale: 'x',
      }, exec),
      error => error instanceof HarnessError && error.code === 'INVALID_ARGUMENT',
    );

    await assert.rejects(
      runTool(tools, 'memweave_precipitate', {
        type: 'judgment',
        content: '没有理由的判断',
        rationale: '   ',
      }, exec),
      error => error instanceof HarnessError && error.code === 'INVALID_ARGUMENT',
    );

    const result = await runTool(tools, 'memweave_precipitate', {
      type: 'judgment',
      content: '先注册工具再写 UI，能更早发现契约错误',
      rationale: '注册阶段会立即校验 schema',
      scopeTaskTypes: ['插件开发'],
    }, exec);
    assert.equal(result.value.status, 'candidate');
    assert.deepEqual(result.violations, []);

    const overlap = await runTool(tools, 'memweave_precipitate', {
      type: 'judgment',
      content: '先注册工具再写界面，能在早期发现契约问题',
      rationale: 'schema 校验发生在注册阶段',
      scopeTaskTypes: ['插件开发'],
    }, exec);
    assert.notEqual(overlap.value.overlapHint, null);
    assert.match(overlap.value.overlapHint, /重叠/);
  } finally {
    await cleanup(workspace);
  }
});

test('memory lifecycle: candidate hidden, valid promotes, invalid demotes', async () => {
  const workspace = await makeWorkspace();
  try {
    const { tools } = createHost({ cwd: workspace });
    const exec = makeExec(workspace);

    const created = await runTool(tools, 'memweave_precipitate', {
      type: 'judgment',
      content: '发布前必须跑注册测试，才能发现 schema 契约错误',
      rationale: '注册阶段会立即校验参数与输出 schema',
      scopeTaskTypes: ['发布流程'],
    }, exec);
    const memoryId = created.value.memoryId;

    const hidden = await runTool(tools, 'memweave_memory_find', { query: '发布 注册测试 schema' }, exec);
    assert.equal(hidden.value.results.length, 0);

    const candidate = await runTool(tools, 'memweave_memory_find', { query: '发布 注册测试 schema', includeCandidates: true }, exec);
    assert.equal(candidate.value.results.length, 1);

    const verified = await runTool(tools, 'memweave_memory_verify', {
      memoryId,
      outcome: 'valid',
      note: '在发布任务 42 复现',
    }, exec);
    assert.equal(verified.value.newStatus, 'verified');
    assert.equal(verified.value.previousConfidence, 0.5);
    assert.equal(verified.value.newConfidence, 0.65);
    assert.match(verified.blocks[0].text, /候选 → 已验证/);

    const found = await runTool(tools, 'memweave_memory_find', { query: '发布 注册测试 schema' }, exec);
    assert.equal(found.value.results.length, 1);
    assert.equal(found.value.results[0].memoryId, memoryId);

    const invalid = await runTool(tools, 'memweave_memory_verify', { memoryId, outcome: 'invalid' }, exec);
    assert.equal(invalid.value.newConfidence, 0.4);
    assert.equal(invalid.value.newStatus, 'verified');
    const invalidAgain = await runTool(tools, 'memweave_memory_verify', { memoryId, outcome: 'invalid' }, exec);
    assert.equal(invalidAgain.value.newConfidence, 0.15);
    assert.equal(invalidAgain.value.newStatus, 'disputed');

    const afterDispute = await runTool(tools, 'memweave_memory_find', { query: '发布 注册测试 schema', includeCandidates: true }, exec);
    assert.equal(afterDispute.value.results.length, 0);
  } finally {
    await cleanup(workspace);
  }
});

test('anti-pattern forced recall replaces the lowest-scoring result', async () => {
  const workspace = await makeWorkspace();
  try {
    const { tools } = createHost({ cwd: workspace });
    const exec = makeExec(workspace);

    const judgment = await runTool(tools, 'memweave_precipitate', {
      type: 'judgment',
      content: '发布前必须跑注册测试以发现 schema 契约错误',
      rationale: '注册阶段会立即校验 schema',
    }, exec);
    const anti = await runTool(tools, 'memweave_precipitate', {
      type: 'anti_pattern',
      content: '只跑注册测试而不核对参数，会漏掉 schema 错误',
      rationale: '测试覆盖不等于契约覆盖',
      antiPatterns: ['只验证了 happy path'],
    }, exec);

    await runTool(tools, 'memweave_memory_verify', { memoryId: anti.value.memoryId, outcome: 'valid' }, exec);
    for (let index = 0; index < 3; index += 1) {
      await runTool(tools, 'memweave_memory_verify', { memoryId: judgment.value.memoryId, outcome: 'valid' }, exec);
    }

    const result = await runTool(tools, 'memweave_memory_find', {
      query: '发布前注册测试 schema',
      limit: 1,
    }, exec);
    assert.equal(result.value.antiPatternForced, true);
    assert.equal(result.value.results.length, 1);
    assert.equal(result.value.results[0].type, 'anti_pattern');
    assert.match(result.blocks[0].text, /强制召回/);
  } finally {
    await cleanup(workspace);
  }
});

test('Loop trends: insufficient, improving, worsening with basis warning, stable', async () => {
  const workspace = await makeWorkspace();
  try {
    const { tools } = createHost({ cwd: workspace });
    const exec = makeExec(workspace);

    const basis = await runTool(tools, 'memweave_precipitate', {
      type: 'judgment',
      content: '缩短交付周期应优先减少等待时间',
      rationale: '等待是周期里最大的浪费',
    }, exec);
    await runTool(tools, 'memweave_memory_verify', { memoryId: basis.value.memoryId, outcome: 'valid' }, exec);

    const loop = await runTool(tools, 'memweave_loop_start', {
      loopName: '发布周期',
      metricName: '交付时长',
      metricTarget: 3,
      metricUnit: '天',
      cadence: 'weekly',
      basedOnMemoryId: basis.value.memoryId,
    }, exec);
    assert.deepEqual(loop.value.definition.records, []);
    assert.match(loop.blocks[0].text, /Loop ID/);

    const first = await runTool(tools, 'memweave_loop_record', { loopId: loop.value.loopId, value: 5 }, exec);
    assert.equal(first.value.trend, 'insufficient_data');
    const second = await runTool(tools, 'memweave_loop_record', { loopId: loop.value.loopId, value: 4 }, exec);
    assert.equal(second.value.trend, 'insufficient_data');
    const third = await runTool(tools, 'memweave_loop_record', { loopId: loop.value.loopId, value: 3 }, exec);
    assert.equal(third.value.trend, 'improving');
    assert.equal(third.value.warning, null);
    assert.match(third.blocks[0].text, /改善/);

    const worsening = await runTool(tools, 'memweave_loop_start', {
      loopName: '缺陷数',
      metricName: '线上缺陷',
      metricTarget: 1,
      metricUnit: '个',
      cadence: 'daily',
      basedOnMemoryId: basis.value.memoryId,
    }, exec);
    await runTool(tools, 'memweave_loop_record', { loopId: worsening.value.loopId, value: 1 }, exec);
    await runTool(tools, 'memweave_loop_record', { loopId: worsening.value.loopId, value: 2 }, exec);
    const bad = await runTool(tools, 'memweave_loop_record', { loopId: worsening.value.loopId, value: 3 }, exec);
    assert.equal(bad.value.trend, 'worsening');
    assert.match(bad.value.warning, /复核/);

    const stable = await runTool(tools, 'memweave_loop_start', {
      loopName: '稳定指标',
      metricName: '响应时间',
      metricTarget: 100,
      metricUnit: 'ms',
      cadence: 'on-demand',
    }, exec);
    for (const value of [100, 101, 100]) {
      await runTool(tools, 'memweave_loop_record', { loopId: stable.value.loopId, value }, exec);
    }
    const stableResult = await runTool(tools, 'memweave_loop_record', { loopId: stable.value.loopId, value: 100 }, exec);
    assert.equal(stableResult.value.trend, 'stable');
  } finally {
    await cleanup(workspace);
  }
});

test('list supports summary, pagination and orphan tmp cleanup', async () => {
  const workspace = await makeWorkspace();
  try {
    const { tools } = createHost({ cwd: workspace });
    const exec = makeExec(workspace);
    for (const content of ['事实一', '事实二', '事实三']) {
      const created = await runTool(tools, 'memweave_precipitate', {
        type: 'fact',
        content,
        rationale: '测试数据',
      }, exec);
      await runTool(tools, 'memweave_memory_verify', { memoryId: created.value.memoryId, outcome: 'valid' }, exec);
    }

    const summary = await runTool(tools, 'memweave_memory_list', { status: 'verified', summary: true }, exec);
    assert.deepEqual(summary.value.items, []);
    assert.equal(summary.value.total, 3);
    assert.deepEqual(Object.keys(summary.value.summaryByType).sort(), ['anti_pattern', 'fact', 'judgment', 'procedure', 'relation']);
    assert.match(summary.blocks[0].text, /事实 3/);

    const page = await runTool(tools, 'memweave_memory_list', { status: 'verified', limit: 2, offset: 0 }, exec);
    assert.equal(page.value.items.length, 2);
    assert.equal(page.value.total, 3);
    assert.match(page.blocks[0].text, /第 1-2 条/);
    assert.match(page.blocks[0].text, new RegExp(page.value.items[0].memoryId));

    const directory = path.join(workspace, '.memweave', 'memories');
    const orphan = path.join(directory, 'mem_x.json.tmp.abcdef');
    await fs.writeFile(orphan, 'x');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(orphan, old, old);
    await runTool(tools, 'memweave_memory_list', { status: 'verified' }, exec);
    await assert.rejects(fs.stat(orphan));
  } finally {
    await cleanup(workspace);
  }
});

test('relative storageRoot fails at the tool boundary', async () => {
  const workspace = await makeWorkspace();
  try {
    const { tools } = createHost({ cwd: workspace, config: { storageRoot: 'relative/root' } });
    const exec = makeExec(workspace);
    await assert.rejects(
      runTool(tools, 'memweave_memory_list', { status: 'verified' }, exec),
      error => error instanceof HarnessError && error.code === 'INVALID_ARGUMENT',
    );
  } finally {
    await cleanup(workspace);
  }
});

test('unknown memory and loop ids are INVALID_ARGUMENT with 未找到', async () => {
  const workspace = await makeWorkspace();
  try {
    const { tools } = createHost({ cwd: workspace });
    const exec = makeExec(workspace);
    await assert.rejects(
      runTool(tools, 'memweave_memory_verify', { memoryId: 'mem_missing', outcome: 'valid' }, exec),
      error => error instanceof HarnessError && error.code === 'INVALID_ARGUMENT' && /未找到/.test(error.message),
    );
    await assert.rejects(
      runTool(tools, 'memweave_loop_record', { loopId: 'loop_missing', value: 1 }, exec),
      error => error instanceof HarnessError && error.code === 'INVALID_ARGUMENT' && /未找到/.test(error.message),
    );
  } finally {
    await cleanup(workspace);
  }
});

test('fusion exposes five fixed adapters; import dry-run writes nothing; export stays in its own area', async () => {
  const workspace = await makeWorkspace();
  try {
    const memoryDir = path.join(workspace, '.dsh-memory');
    const taskMemoryDir = path.join(workspace, '.dsh-task-memory');
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.mkdir(taskMemoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, 'a.md'), '---\ntype: judgment\n---\n部署前先跑注册测试，能提前发现 schema 契约错误。\n', 'utf8');
    await fs.writeFile(path.join(memoryDir, 'b.json'), JSON.stringify({ memories: [{ type: 'fact', content: '记忆条目必须经过验证才进入默认检索池' }] }), 'utf8');
    await fs.writeFile(path.join(taskMemoryDir, 'task.md'), '# 任务记忆\n任务结束后先沉淀判断，再关闭 Loop。\n', 'utf8');

    const config = {
      fusion: {
        'dsh-memory-xfy': { enabled: true, direction: 'both' },
        'dsh-memory-plus': { enabled: true, direction: 'both' },
      },
    };
    const { tools } = createHost({ cwd: workspace, config });
    const exec = makeExec(workspace);

    const status = await runTool(tools, 'memweave_fusion_status', {}, exec);
    assert.equal(status.value.aggregateBundle, false);
    assert.equal(status.value.plugins.length, 5);
    const xfy = status.value.plugins.find(plugin => plugin.key === 'dsh-memory-xfy');
    assert.equal(xfy.detectedBy, 'builtin');
    assert.equal(xfy.available, true);
    assert.equal(xfy.enabled, true);
    const taskMemory = status.value.plugins.find(plugin => plugin.key === 'dsh-task-memory');
    assert.equal(taskMemory.detectedBy, 'builtin');
    assert.equal(taskMemory.available, true);

    const memoryStore = path.join(workspace, '.memweave', 'memories');
    const before = await fs.readdir(memoryStore).catch(() => []);
    const dry = await runTool(tools, 'memweave_import', { pluginKey: 'dsh-memory-xfy', dryRun: true }, exec);
    assert.equal(dry.value.dryRun, true);
    assert.ok(dry.value.imported >= 1);
    const afterDry = await fs.readdir(memoryStore).catch(() => []);
    assert.deepEqual(afterDry, before);

    const imported = await runTool(tools, 'memweave_import', { pluginKey: 'dsh-memory-xfy' }, exec);
    assert.ok(imported.value.imported >= 1);
    const afterImport = await fs.readdir(memoryStore);
    assert.ok(afterImport.length >= imported.value.imported);

    const exported = await runTool(tools, 'memweave_export', {
      pluginKey: 'dsh-memory-xfy',
      statusFilter: 'candidate',
    }, exec);
    assert.ok(exported.value.exported >= 1);
    assert.ok(exported.value.path.startsWith(path.join(workspace, '.memweave-exports')));
    await fs.stat(exported.value.path);

    const foreignBefore = (await fs.readdir(memoryDir)).sort();
    assert.deepEqual(foreignBefore, ['a.md', 'b.json']);
  } finally {
    await cleanup(workspace);
  }
});

test('import downgrades an anti-pattern record that lacks its invalidation notes', async () => {
  const workspace = await makeWorkspace();
  try {
    const directory = path.join(workspace, '.dsh-memory');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'anti.json'), JSON.stringify({
      memories: [{ type: 'anti_pattern', content: '导入的反模式没有说明什么情况下无效' }],
    }), 'utf8');
    const { tools } = createHost({
      cwd: workspace,
      config: { fusion: { 'dsh-memory-plus': { enabled: true, direction: 'read' } } },
    });
    const exec = makeExec(workspace);
    const imported = await runTool(tools, 'memweave_import', { pluginKey: 'dsh-memory-plus' }, exec);
    assert.equal(imported.value.imported, 1);
    assert.equal(imported.value.samples[0].type, 'fact');

    const files = await fs.readdir(path.join(workspace, '.memweave', 'memories'));
    const stored = JSON.parse(await fs.readFile(path.join(workspace, '.memweave', 'memories', files[0]), 'utf8'));
    assert.equal(stored.type, 'fact');
    assert.equal(stored.confidence, 0.4);
    assert.equal(stored.status, 'candidate');
  } finally {
    await cleanup(workspace);
  }
});

test('fusion exposes five available built-in adapters', async () => {
  const status = await detectFusion({ settings: {} });
  assert.equal(status.plugins.length, 5);
  for (const plugin of status.plugins) {
    assert.equal(plugin.available, true);
    assert.equal(plugin.detectedBy, 'builtin');
  }
  const plus = status.plugins.find(plugin => plugin.key === 'dsh-memory-plus');
  assert.match(plus.detail, /内置适配器/);
  assert.equal(plus.detail.includes('未找到'), false);
});

test('import/export require the matching fusion direction', async () => {
  const workspace = await makeWorkspace();
  try {
    const { tools } = createHost({
      cwd: workspace,
      config: { fusion: { 'dsh-memory-xfy': { enabled: true, direction: 'write' } } },
    });
    const exec = makeExec(workspace);
    await assert.rejects(
      runTool(tools, 'memweave_import', { pluginKey: 'dsh-memory-xfy', dryRun: true }, exec),
      error => error instanceof HarnessError && error.code === 'INVALID_ARGUMENT' && /读取/.test(error.message),
    );
  } finally {
    await cleanup(workspace);
  }
});
