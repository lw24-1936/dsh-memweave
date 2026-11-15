/**
 * 织忆 (Memweave) — Host half.
 *
 * Registers ten model-facing tools and one same-origin settings API over a
 * small JSON store. The required dependency is only `tools`; `webServer`,
 * `configEditor`, and every compatible plugin are optional probes, so a
 * profile without them still gets working memory/task/Loop tools.
 *
 * @module dsh-memweave
 */

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { mountApi, parseTypes } from './api.js';
import { invalidArgument, internalError, throwIfAborted } from './errors.js';
import {
  CADENCE_LABELS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  OUTCOME_LABELS,
  STATUS_LABELS,
  TYPE_LABELS,
  VERIFY_OUTCOMES,
  confidenceSymbol,
  formatConfidence,
  truncate,
} from './model.js';
import {
  memoryDetail,
  memoryOverview,
  findMemories,
  listMemories,
  precipitateMemory,
  verifyMemory,
} from './memory.js';
import { decomposeGoal } from './network.js';
import { recordLoop, startLoop } from './loop.js';
import { detectFusion, importFromPlugin, exportToPlugin, compatibilityEntry, FUSION_DIRECTIONS } from './fusion.js';
import { isAbsoluteStoragePath, resolveStorageRoot, workspaceOf } from './paths.js';

/** Loader entry name. */
export const name = 'memweave';

/** The only required service: the tool registry. */
export const inject = ['tools'];

/** Persisted plugin configuration (Settings renders this form natively).
 * DSH 0.2.x exposes plugin settings through a Config schema plus
 * `configEditor`, not through a `ctx.settings.register` method; the three
 * custom tabs write this same schema through `/memweave/api`. */
export const Config = z.object({
  storageRoot: z.string().default('').description('组织记忆存储根目录的绝对路径。留空则使用当前 workspace 的 .memweave/ 目录。'),
  fusion: z.dict(z.object({
    enabled: z.boolean().default(false),
    direction: z.union(['read', 'write', 'both']).default('read'),
  })).default({}).description('融合开关：{ "<pluginKey>": { enabled: boolean, direction: "read"|"write"|"both" } }'),
});

/** One text block is the complete V1 render contract. */
function textBlock(text) {
  return [{ type: 'text', text }];
}

/** Chinese or fallback type label. */
function typeLabel(type) {
  return TYPE_LABELS[type] ?? type;
}

/** Chinese status label. */
function statusLabel(status) {
  return STATUS_LABELS[status] ?? status;
}

/** Confidence symbol from a numeric value. */
function symbol(confidence) {
  return confidenceSymbol(confidence);
}

/** Trend render map. */
const TREND_RENDER = Object.freeze({
  improving: '✓ 改善',
  stable: '→ 持平',
  worsening: '⚠ 恶化',
  insufficient_data: '数据不足，继续记录',
});

/** The schemas shared by several tools. */
const MEMORY_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    memoryId: { type: 'string', required: true },
    type: { type: 'string', required: true, enum: MEMORY_TYPES },
    content: { type: 'string', required: true },
    rationale: { type: 'string', required: true },
    confidence: { type: 'number', required: true },
    status: { type: 'string', required: true, enum: MEMORY_STATUSES },
    lastVerifiedAt: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    evidenceSummary: { type: 'string', required: true },
  },
};

const TASK_NODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    task: { type: 'string', required: true },
    dependsOn: { type: 'array', required: true, items: { type: 'string' } },
    executor: { type: 'string', required: true, enum: ['human', 'agent', 'hybrid'] },
  },
};

const LOOP_RECORD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    round: { type: 'integer', required: true },
    value: { type: 'number', required: true },
    recordedAt: { type: 'string', required: true },
    notes: { type: 'string', required: true },
  },
};

const LOOP_DEFINITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    loopName: { type: 'string', required: true },
    taskRef: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    metric: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        name: { type: 'string', required: true },
        target: { type: 'number', required: true },
        unit: { type: 'string', required: true },
      },
    },
    cadence: { type: 'string', required: true, enum: ['daily', 'weekly', 'on-demand'] },
    records: { type: 'array', required: true, items: LOOP_RECORD_SCHEMA },
    basedOnMemoryId: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    createdAt: { type: 'string', required: true },
  },
};

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: Object.fromEntries(MEMORY_TYPES.map(type => [type, { type: 'integer', required: true }])),
};

/**
 * Build a task line for decompose rendering.
 * @param {object} node
 * @param {number} depth
 */
function taskLine(node, depth) {
  const prefix = depth === 0 ? '' : `${'  '.repeat(depth)}↳ `;
  const depends = node.dependsOn.length > 0 ? ` ← ${node.dependsOn.join(', ')}` : '';
  return `${prefix}[${node.id}] ${node.task} (${node.executor})${depends}`;
}

/** Depth of one node in the dependency DAG (0 for roots). */
function nodeDepth(node, byId, seen = new Set()) {
  if (node.dependsOn.length === 0 || seen.has(node.id)) return 0;
  seen.add(node.id);
  let max = 0;
  for (const dependency of node.dependsOn) {
    const parent = byId.get(dependency);
    if (parent !== undefined) max = Math.max(max, nodeDepth(parent, byId, seen) + 1);
  }
  return Math.max(0, Math.min(6, max));
}

/** Render decompose output. */
function renderDecompose(_args, value) {
  const byId = new Map(value.nodes.map(node => [node.id, node]));
  const lines = value.nodes.map(node => taskLine(node, nodeDepth(node, byId)));
  lines.push('', `网络 ID：${value.netId}`);
  if (value.warnings.length > 0) {
    lines.push('', '⚠ 避坑提醒：', ...value.warnings.map(warning => `- ${warning.content}`));
  }
  return textBlock(lines.join('\n'));
}

/** Render precipitate output. */
function renderPrecipitate(args, value) {
  let body = `已沉淀 [${typeLabel(args.type)}] 记忆 ${value.memoryId}。内容：${truncate(args.content, 60)}。路径：.memweave/memories/${value.memoryId}.json`;
  if (value.overlapHint !== null) body += ` ⚠ 重叠提示：${value.overlapHint}`;
  return textBlock(body);
}

/** Render find output. */
function renderFind(_args, value) {
  const lines = [];
  if (value.antiPatternForced) lines.push('⚠ 以下结果中包含强制召回的反模式记忆');
  if (value.results.length === 0) {
    lines.push('未找到相关记忆。');
  } else {
    for (const memory of value.results) {
      const rationale = memory.rationale.length > 0 ? truncate(memory.rationale, 40) : '（未填写理由）';
      lines.push(`[${typeLabel(memory.type)}] ${symbol(memory.confidence)} ${memory.memoryId} ${truncate(memory.content, 50)} — ${rationale}`);
    }
  }
  return textBlock(lines.join('\n'));
}

/** Render verify output. */
function renderVerify(args, value) {
  const outcome = OUTCOME_LABELS[args.outcome] ?? args.outcome;
  const statusPart = value.previousStatus === value.newStatus
    ? `状态保持 ${statusLabel(value.newStatus)}`
    : `状态：${statusLabel(value.previousStatus)} → ${statusLabel(value.newStatus)}`;
  return textBlock(`${value.memoryId} ${outcome}。置信度：${formatConfidence(value.previousConfidence)} → ${formatConfidence(value.newConfidence)}。${statusPart}`);
}

/** Render loop_start output. */
function renderLoopStart(_args, value) {
  const definition = value.definition;
  const parts = [
    `已定义 Loop ${definition.loopName}（${CADENCE_LABELS[definition.cadence] ?? definition.cadence}）。`,
    `Loop ID：${definition.id}。`,
    `指标：${definition.metric.name} 目标 ${definition.metric.target} ${definition.metric.unit}`,
  ];
  if (definition.taskRef !== null) parts.push(`，关联任务：${definition.taskRef}`);
  if (definition.basedOnMemoryId !== null) parts.push(`，基于记忆：${definition.basedOnMemoryId}`);
  parts.push('。调用 memweave_loop_record 记录每轮值。');
  return textBlock(parts.join(''));
}

/** Render loop_record output. */
function renderLoopRecord(_args, value) {
  const gap = value.metricTarget - value.latestValue;
  let body = `第 ${value.rounds} 轮记录：${value.latestValue}。距目标 ${gap} ${value.metricUnit}。趋势：${TREND_RENDER[value.trend] ?? value.trend}`;
  if (value.warning !== null) body += ` ⚠ ${value.warning}`;
  return textBlock(body);
}

/** Render list output. */
function renderList(args, value) {
  if (args.summary === true) {
    const summary = value.summaryByType ?? {};
    return textBlock(MEMORY_TYPES.map(type => `${typeLabel(type)} ${summary[type] ?? 0}`).join(' / '));
  }
  if (value.items.length === 0) {
    return textBlock(`共 ${value.total} 条，当前显示第 0-0 条`);
  }
  const offset = Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
  const lines = value.items.map(memory => [
    typeLabel(memory.type),
    memory.memoryId,
    truncate(memory.content, 30),
    symbol(memory.confidence),
    memory.status,
  ].join(' | '));
  lines.push(`共 ${value.total} 条，当前显示第 ${offset + 1}-${offset + value.items.length} 条`);
  return textBlock(lines.join('\n'));
}

/** Render fusion status output. */
function renderFusionStatus(_args, value) {
  const enabled = value.plugins.filter(plugin => plugin.enabled).length;
  const lines = [`${value.plugins.length} 个固定内置记忆适配器，${enabled} 个已启用`];
  for (const plugin of value.plugins) {
    lines.push(`${plugin.label} [来源: 内置] 方向: ${plugin.direction}`);
  }
  lines.push(value.aggregateBundle ? '聚合包已启用' : '独立安装');
  return textBlock(lines.join('\n'));
}

/** Render import output. */
function renderImport(_args, value) {
  if (value.dryRun) {
    const sample = value.samples.length > 0 ? truncate(value.samples[0].content, 60) : '无可用条目';
    return textBlock(`将导入 ${value.imported} 条（跳过 ${value.skipped} 条），示例：${sample}`);
  }
  return textBlock(`已导入 ${value.imported} 条，跳过 ${value.skipped} 条`);
}

/** Render export output. */
function renderExport(_args, value) {
  return textBlock(`已导出 ${value.exported} 条为 ${value.format}，路径：${value.path}`);
}

/**
 * Host plugin activation.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ storageRoot?: string, fusion?: Record<string, { enabled?: boolean, direction?: string }> }} [config]
 */
export function apply(ctx, config = {}) {
  const settings = {
    storageRoot: typeof config.storageRoot === 'string' ? config.storageRoot : '',
    fusion: config.fusion !== null && typeof config.fusion === 'object' ? config.fusion : {},
  };

  /** Most recent session workspace observed; used only when no exec is available. */
  const runtime = { lastWorkspace: undefined };

  // A settings API call has no agent/session. Seed the fallback from the
  // workspace registry so a restart does not fall back to the Host's launch
  // directory while a real workspace is known. This is an optional probe.
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
    const known = typeof registry?.list === 'function' ? registry.list() : undefined;
    if (Array.isArray(known) && known.length > 0) {
      const latest = [...known].sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))[0];
      if (typeof latest?.path === 'string' && latest.path.length > 0) runtime.lastWorkspace = latest.path;
    }
  } catch {
    // Workspace registry is optional; the session event below still fills it.
  }

  /** Current resolved configuration snapshot. */
  const currentSettings = () => ({ storageRoot: settings.storageRoot, fusion: settings.fusion });

  /** The workspace for API calls and export/import; undefined until one is known. */
  const workspaceFor = exec => {
    const cwd = workspaceOf(exec);
    if (cwd !== undefined) {
      runtime.lastWorkspace = cwd;
      return cwd;
    }
    return runtime.lastWorkspace;
  };

  /** Resolve the storage root for one call. */
  const resolveFor = async (exec, signal) => {
    const cwd = workspaceOf(exec);
    if (cwd !== undefined) runtime.lastWorkspace = cwd;
    return resolveStorageRoot({
      settings: currentSettings(),
      exec,
      fallbackWorkspace: runtime.lastWorkspace,
      signal,
    });
  };

  /** Persist one config patch through the profile config editor. */
  const editConfig = async patch => {
    const entry = ctx.fiber?.entry;
    const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined;
    if (entry === undefined) {
      throw internalError('保存设置', new Error('当前插件不是由 profile 条目加载的，无法定位配置行'));
    }
    if (editor === undefined || typeof editor.edit !== 'function') {
      throw internalError('保存设置', new Error('当前 profile 未提供配置编辑器'));
    }
    try {
      await editor.edit(entry, current => ({ ...current, ...patch }));
    } catch (error) {
      throw internalError('保存设置', error);
    }
  };

  /** Save `storageRoot` from the settings tab. */
  const saveStorageRoot = async value => {
    const next = typeof value === 'string' ? value.trim() : '';
    if (next.length > 0 && !isAbsoluteStoragePath(next)) {
      throw invalidArgument(`storageRoot 必须是绝对路径，收到相对路径：${next}`);
    }
    await editConfig({ storageRoot: next });
    return { storageRoot: next };
  };

  /** Save one fusion switch/direction. */
  const saveFusion = async body => {
    const pluginKey = typeof body.pluginKey === 'string' ? body.pluginKey : '';
    const entry = compatibilityEntry(pluginKey);
    if (entry === null) throw invalidArgument(`未知适配器：${pluginKey}`);
    if (typeof body.enabled !== 'boolean') throw invalidArgument('enabled 必须是布尔值。');
    const direction = FUSION_DIRECTIONS.includes(body.direction) ? body.direction : null;
    if (direction === null) throw invalidArgument(`direction 必须是 ${FUSION_DIRECTIONS.join('/')} 之一。`);
    const nextFusion = {
      ...settings.fusion,
      [pluginKey]: { enabled: body.enabled, direction },
    };
    await editConfig({ fusion: nextFusion });
    return { pluginKey, enabled: body.enabled, direction };
  };

  /** Snapshot consumed by all three tabs. */
  const snapshot = async () => {
    let storage;
    try {
      const resolved = await resolveFor(undefined);
      const overview = await memoryOverview(resolved.root);
      storage = {
        configuredRoot: settings.storageRoot,
        root: resolved.root,
        source: resolved.source,
        workspace: resolved.workspace,
        counts: overview.counts,
        total: overview.total,
        skipped: overview.skipped,
        error: null,
      };
    } catch (error) {
      storage = {
        configuredRoot: settings.storageRoot,
        root: null,
        source: 'invalid',
        workspace: null,
        counts: { types: Object.fromEntries(MEMORY_TYPES.map(type => [type, 0])), statuses: Object.fromEntries(MEMORY_STATUSES.map(status => [status, 0])) },
        total: 0,
        skipped: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const fusion = await detectFusion({
      ctx,
      settings: currentSettings(),
    });
    return { version: '1.0.0', storage, fusion };
  };

  /** Paged list for the skills tab. */
  const listFromQuery = async searchParams => {
    const resolved = await resolveFor(undefined);
    const result = await listMemories(resolved.root, {
      types: parseTypes(searchParams.get('types')),
      status: searchParams.get('status') ?? 'verified',
      sort: searchParams.get('sort') ?? 'last_verified',
      limit: Number(searchParams.get('limit') ?? 50),
      offset: Number(searchParams.get('offset') ?? 0),
      summary: searchParams.get('summary') === 'true',
      query: searchParams.get('query') ?? '',
    });
    return result;
  };

  /** Full detail for one memory. */
  const detailFromId = async id => {
    if (typeof id !== 'string' || id.length === 0) throw invalidArgument('缺少 memoryId 参数。');
    const resolved = await resolveFor(undefined);
    return memoryDetail(resolved.root, id);
  };

  /** Shared verification core. */
  const verifyFromBody = async body => {
    if (typeof body.memoryId !== 'string' || body.memoryId.length === 0) {
      throw invalidArgument('缺少 memoryId 参数。');
    }
    if (!VERIFY_OUTCOMES.includes(body.outcome)) {
      throw invalidArgument(`未知验证结论：${String(body.outcome)}。`);
    }
    const resolved = await resolveFor(undefined);
    const before = await memoryDetail(resolved.root, body.memoryId);
    const result = await verifyMemory(resolved.root, {
      memoryId: body.memoryId,
      outcome: body.outcome,
      note: typeof body.note === 'string' ? body.note : '',
    });
    return { ...result, previousStatus: before.memory.status };
  };

  // ── tools ───────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memweave_decompose',
    description: 'Use when starting a new task or decomposing a vague goal. 将模糊目标拆解为任务网络，并注入相关反模式记忆作为警告。',
    parameters: {
      goal: { type: 'string', required: true, description: '要拆解的目标。' },
      context: { type: 'string', description: '已知上下文；为空时骨架会要求先澄清。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          netId: { type: 'string', required: true },
          nodes: { type: 'array', required: true, items: TASK_NODE_SCHEMA },
          warnings: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                memoryId: { type: 'string', required: true },
                content: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: renderDecompose,
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      const { root } = await resolveFor(exec, exec.signal);
      return decomposeGoal(root, args, { signal: exec.signal });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memweave_precipitate',
    description: 'Use when a task completes, a valid judgment is discovered, or a pitfall is encountered. 将经验沉淀为结构化记忆条目。',
    parameters: {
      type: { type: 'string', required: true, enum: MEMORY_TYPES, description: '记忆类型。anti_pattern 必须说明什么情况下无效。' },
      content: { type: 'string', required: true, description: '判断或反模式本身，不写操作手册。' },
      rationale: { type: 'string', required: true, description: '为什么有效；judgment 必填。' },
      antiPatterns: { type: 'array', items: { type: 'string' }, description: '什么情况下这条经验无效。' },
      scopeTaskTypes: { type: 'array', items: { type: 'string' }, description: '适用任务类型。' },
      scopeConditions: { type: 'array', items: { type: 'string' }, description: '适用条件。' },
      sourceTaskRef: { type: 'string', description: '来源任务引用。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memoryId: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['candidate'] },
          overlapHint: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
      render: renderPrecipitate,
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      const { root } = await resolveFor(exec, exec.signal);
      return precipitateMemory(root, args, { signal: exec.signal });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memweave_memory_find',
    description: 'Use when decomposing a task, designing a Loop, or needing to reference past judgments. 检索与当前任务相关的组织记忆。',
    parameters: {
      query: { type: 'string', required: true, description: '任务或判断的自然语言描述。' },
      types: { type: 'array', items: { type: 'string', enum: MEMORY_TYPES }, description: '限定记忆类型。' },
      limit: { type: 'number', description: '返回条数，默认 5，最大 50。' },
      includeCandidates: { type: 'boolean', description: '是否同时检索 candidate；默认 false。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: { type: 'array', required: true, items: MEMORY_ITEM_SCHEMA },
          antiPatternForced: { type: 'boolean', required: true },
        },
      },
      render: renderFind,
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      const { root } = await resolveFor(exec, exec.signal);
      return findMemories(root, args, { signal: exec.signal });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memweave_memory_verify',
    description: 'Use when a memory has been used and its validity is known. 标记记忆有效或无效，更新置信度和状态。',
    parameters: {
      memoryId: { type: 'string', required: true, description: '要验证的记忆 id。' },
      outcome: { type: 'string', required: true, enum: VERIFY_OUTCOMES, description: '验证结论。' },
      note: { type: 'string', description: '验证依据或复现说明。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memoryId: { type: 'string', required: true },
          previousConfidence: { type: 'number', required: true },
          newConfidence: { type: 'number', required: true },
          previousStatus: { type: 'string', required: true, enum: MEMORY_STATUSES },
          newStatus: { type: 'string', required: true, enum: MEMORY_STATUSES },
        },
      },
      render: renderVerify,
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      const { root } = await resolveFor(exec, exec.signal);
      const before = await memoryDetail(root, args.memoryId, { signal: exec.signal });
      const result = await verifyMemory(root, args, { signal: exec.signal });
      return { ...result, previousStatus: before.memory.status };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memweave_loop_start',
    description: 'Use when defining a measurable iterative process. 定义可衡量的 Loop。',
    parameters: {
      loopName: { type: 'string', required: true, description: 'Loop 名称。' },
      taskRef: { type: 'string', description: '关联任务引用。' },
      metricName: { type: 'string', required: true, description: '指标名。' },
      metricTarget: { type: 'number', required: true, description: '目标值；v1 约定越小越好。' },
      metricUnit: { type: 'string', required: true, description: '指标单位。' },
      cadence: { type: 'string', required: true, enum: ['daily', 'weekly', 'on-demand'], description: '复盘节奏。' },
      basedOnMemoryId: { type: 'string', description: '该 Loop 基于哪条记忆设计。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          loopId: { type: 'string', required: true },
          definition: { ...LOOP_DEFINITION_SCHEMA, required: true },
        },
      },
      render: renderLoopStart,
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      const { root } = await resolveFor(exec, exec.signal);
      return startLoop(root, args, { signal: exec.signal });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memweave_loop_record',
    description: 'Use when an iteration of a defined Loop completes. 记录一轮指标值，三轮以上返回趋势。',
    parameters: {
      loopId: { type: 'string', required: true, description: 'Loop id。' },
      value: { type: 'number', required: true, description: '本轮指标值。' },
      notes: { type: 'string', description: '本轮说明。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          loopId: { type: 'string', required: true },
          rounds: { type: 'integer', required: true },
          latestValue: { type: 'number', required: true },
          trend: { type: 'string', required: true, enum: ['improving', 'stable', 'worsening', 'insufficient_data'] },
          warning: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          metricTarget: { type: 'number', required: true },
          metricUnit: { type: 'string', required: true },
        },
      },
      render: renderLoopRecord,
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      const { root } = await resolveFor(exec, exec.signal);
      return recordLoop(root, args, { signal: exec.signal });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memweave_memory_list',
    description: 'Use when browsing the memory store, needing to show memory categories, or requesting a list of a specific type. 列出记忆条目。',
    parameters: {
      types: { type: 'array', items: { type: 'string', enum: MEMORY_TYPES }, description: '限定类型。' },
      status: { type: 'string', enum: MEMORY_STATUSES, description: '状态，默认 verified。' },
      sort: { type: 'string', enum: ['last_verified', 'confidence', 'created'], description: '排序，默认 last_verified。' },
      limit: { type: 'number', description: '每页条数，默认 20，最大 100。' },
      offset: { type: 'number', description: '偏移，默认 0。' },
      summary: { type: 'boolean', description: '只返回五类计数。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: { type: 'array', required: true, items: MEMORY_ITEM_SCHEMA },
          total: { type: 'integer', required: true },
          summaryByType: { required: true, oneOf: [SUMMARY_SCHEMA, { type: 'null' }] },
        },
      },
      render: renderList,
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      const { root } = await resolveFor(exec, exec.signal);
      const result = await listMemories(root, args, { signal: exec.signal });
      return { items: result.items, total: result.total, summaryByType: result.summaryByType };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memweave_fusion_status',
    description: 'Use when the user asks about the fixed memory adapters, or before importing/exporting data. 返回五个固定内置适配器及其开关状态；不做自动探测。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plugins: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                label: { type: 'string', required: true },
                type: { type: 'string', required: true },
                detectedBy: { type: 'string', required: true, enum: ['builtin'] },
                available: { type: 'boolean', required: true },
                enabled: { type: 'boolean', required: true },
                direction: { type: 'string', required: true },
                detail: { type: 'string', required: true },
              },
            },
          },
          aggregateBundle: { type: 'boolean', required: true },
        },
      },
      render: renderFusionStatus,
    },
    async execute(_args, exec) {
      throwIfAborted(exec.signal);
      return detectFusion({
        ctx,
        settings: currentSettings(),
        signal: exec.signal,
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memweave_import',
    description: 'Use when the user explicitly asks to import memories from a compatible file format. 从内置适配器的兼容文件导入记忆条目到 Memweave。',
    parameters: {
      pluginKey: {
        type: 'string',
        required: true,
        description: '内置适配器 key：dsh-memory-xfy / dsh-memory-plus / dsh-cue-bank / dsh-task-memory / dsh-graphmemory。',
      },
      dryRun: { type: 'boolean', description: '为 true 时只返回将导入的摘要，不写入。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pluginKey: { type: 'string', required: true },
          imported: { type: 'integer', required: true },
          skipped: { type: 'integer', required: true },
          dryRun: { type: 'boolean', required: true },
          samples: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: { type: 'string', required: true },
                type: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: renderImport,
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      const { root } = await resolveFor(exec, exec.signal);
      const result = await importFromPlugin({
        ctx,
        workspace: workspaceFor(exec),
        root,
        settings: currentSettings(),
        pluginKey: args.pluginKey,
        dryRun: args.dryRun === true,
        signal: exec.signal,
      });
      return { ...result, samples: result.samples ?? [] };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memweave_export',
    description: 'Use when the user explicitly asks to export Memweave memories to a compatible format. 将 Memweave 记忆导出为内置适配器格式。',
    parameters: {
      pluginKey: {
        type: 'string',
        required: true,
        description: '内置适配器 key：dsh-memory-xfy / dsh-memory-plus / dsh-cue-bank / dsh-task-memory / dsh-graphmemory。',
      },
      statusFilter: { type: 'string', enum: ['verified', 'candidate', 'disputed'], description: '导出状态，默认 verified。' },
      limit: { type: 'number', description: '最多导出条数，默认 50，最大 200。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pluginKey: { type: 'string', required: true },
          exported: { type: 'integer', required: true },
          format: { type: 'string', required: true },
          path: { type: 'string', required: true },
        },
      },
      render: renderExport,
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      const { root } = await resolveFor(exec, exec.signal);
      return exportToPlugin({
        workspace: workspaceFor(exec),
        root,
        settings: currentSettings(),
        pluginKey: args.pluginKey,
        statusFilter: args.statusFilter ?? 'verified',
        limit: args.limit ?? 50,
        signal: exec.signal,
      });
    },
  }));

  // ── workspace observation ──────────────────────────────────────────────
  // Not an agent/turn-stopping hook: this only remembers the session workspace
  // so the settings tabs can probe compatible memory files before the first
  // tool call. `session/event` is an emit event; nothing is short-circuited.
  ctx.effect(
    () => ctx.on('session/event', session => {
      const cwd = session?.header?.cwd;
      if (typeof cwd === 'string' && cwd.length > 0) runtime.lastWorkspace = cwd;
    }),
    'memweave: remember session workspace',
  );

  // ── settings API (optional carrier) ────────────────────────────────────
  ctx.inject(['webServer'], webCtx => {
    try {
      webCtx.effect(() => mountApi(webCtx, {
        snapshot,
        list: listFromQuery,
        detail: detailFromId,
        verify: verifyFromBody,
        saveStorageRoot,
        saveFusion,
      }), 'memweave: settings API');
    } catch (error) {
      webCtx.logger?.warn?.(`[dsh-memweave] settings API unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // v1.0 deliberately installs no agent/turn-stopping hooks. Reserved seam:
  // ctx.effect(() => { ... }, 'memweave: future agent hooks')
}
