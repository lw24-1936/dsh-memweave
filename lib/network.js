/**
 * Deterministic task-network generation.
 *
 * A tool cannot call a language model without making its behavior
 * unpredictable and expensive; instead this creates a task-centered scaffold
 * that the model (or the user) refines in conversation. Every node names an
 * executor (`human`/`agent`/`hybrid`) and its dependencies — never a job title.
 *
 * @module dsh-memweave/network
 */

import { invalidArgument, throwIfAborted } from './errors.js';
import { newId, nowIso, truncate } from './model.js';
import { searchMemories } from './search.js';
import { loadMemories, writeTasknet } from './store.js';

/**
 * Shape one goal into the six-stage scaffold.
 * @param {string} goal
 * @param {string} context
 * @returns {object[]}
 */
export function buildNodes(goal, context) {
  const title = truncate(goal, 30);
  const hasContext = context.trim().length > 0;
  const approval = /审批|批准|签字|决策|合规|验收人|拍板/.test(goal);
  const writing = /文档|方案|报告|写作|演示|PPT|课程|素材/.test(goal);
  const building = /开发|实现|编码|修复|重构|部署|插件|系统|接口|功能/.test(goal);
  const research = /调研|分析|评估|对比|梳理|访谈|选型/.test(goal);

  const clarify = hasContext
    ? `澄清「${title}」的目标、边界与验收标准（已知上下文：${truncate(context, 60)}）`
    : `澄清「${title}」的目标、边界与验收标准；缺少信息时向用户提问`;
  const investigate = research
    ? `调研「${title}」的现状、依赖与约束`
    : `梳理「${title}」的现状、依赖与约束`;
  const design = `设计「${title}」的可验证方案与任务分解`;
  const execute = writing
    ? `撰写「${title}」的可检查产出（文档/方案）`
    : building
      ? `实现「${title}」并产出可运行的检查物`
      : `执行「${title}」并产出可检查物`;
  const verify = approval
    ? `人工评审「${title}」：按验收标准签字/决策`
    : `验证「${title}」的结果并复盘偏差`;
  const close = `沉淀「${title}」的记忆并关闭对应 Loop`;

  return [
    { id: 'n1', task: clarify, dependsOn: [], executor: 'hybrid' },
    { id: 'n2', task: investigate, dependsOn: ['n1'], executor: 'agent' },
    { id: 'n3', task: design, dependsOn: ['n1', 'n2'], executor: 'hybrid' },
    { id: 'n4', task: execute, dependsOn: ['n3'], executor: 'agent' },
    { id: 'n5', task: verify, dependsOn: ['n4'], executor: approval ? 'human' : 'hybrid' },
    { id: 'n6', task: close, dependsOn: ['n5'], executor: 'agent' },
  ];
}

/**
 * Create and persist one task network, with matching verified anti-patterns as
 * warnings.
 * @param {string} root
 * @param {{ goal: string, context?: string }} input
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ netId: string, nodes: object[], warnings: { memoryId: string, content: string }[] }>}
 */
export async function decomposeGoal(root, { goal, context }, { signal } = {}) {
  throwIfAborted(signal);
  const trimmedGoal = String(goal ?? '').trim();
  if (trimmedGoal.length === 0) throw invalidArgument('goal 不能为空。');
  const trimmedContext = String(context ?? '').trim();

  const { memories } = await loadMemories(root, { signal });
  throwIfAborted(signal);
  const relevant = searchMemories(memories, {
    query: `${trimmedGoal}\n${trimmedContext}`,
    types: ['anti_pattern'],
    limit: 3,
  });
  const warnings = relevant.results.map(memory => ({
    memoryId: memory.id,
    content: memory.content,
  }));

  const net = {
    id: newId('net'),
    goal: trimmedGoal,
    nodes: buildNodes(trimmedGoal, trimmedContext),
    createdAt: nowIso(),
  };
  await writeTasknet(root, net, { signal });
  return { netId: net.id, nodes: net.nodes, warnings };
}
