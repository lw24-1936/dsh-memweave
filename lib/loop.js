/**
 * Measurable Loop operations.
 *
 * A Loop is only created with a target, a unit and a cadence; trend needs at
 * least three rounds. "Smaller is better" is the v1 convention (cycle time,
 * defects, cost), matching the design's `gap = target - value`.
 *
 * @module dsh-memweave/loop
 */

import { invalidArgument, throwIfAborted } from './errors.js';
import {
  LOOP_CADENCES,
  newId,
  normalizeLoop,
  nowIso,
  truncate,
} from './model.js';
import { readLoop, readMemory, writeLoop } from './store.js';

/**
 * Compute the trend from the latest values.
 * @param {number[]} values - latest values in chronological order.
 * @returns {'improving'|'stable'|'worsening'|'insufficient_data'}
 */
export function computeTrend(values) {
  if (!Array.isArray(values) || values.length < 3) return 'insufficient_data';
  const latest = values.slice(-3);
  const mean = latest.reduce((sum, value) => sum + value, 0) / latest.length;
  const spread = Math.max(...latest) - Math.min(...latest);
  const scale = Math.abs(mean) > 1e-9 ? Math.abs(mean) : 1;
  if (spread / scale < 0.05) return 'stable';
  const [first, , last] = latest;
  if (last < first) return 'improving';
  if (last > first) return 'worsening';
  return 'stable';
}

/**
 * Create one Loop definition.
 * @param {string} root
 * @param {{
 *   loopName: string, taskRef?: string, metricName: string, metricTarget: number,
 *   metricUnit: string, cadence: string, basedOnMemoryId?: string,
 * }} input
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ loopId: string, definition: object }>}
 */
export async function startLoop(root, input, { signal } = {}) {
  throwIfAborted(signal);
  const loopName = String(input.loopName ?? '').trim();
  const metricName = String(input.metricName ?? '').trim();
  const metricUnit = String(input.metricUnit ?? '').trim();
  const metricTarget = Number(input.metricTarget);
  if (loopName.length === 0) throw invalidArgument('loopName 不能为空。');
  if (metricName.length === 0) throw invalidArgument('metricName 不能为空：没有指标的循环只是重复，不是进化。');
  if (metricUnit.length === 0) throw invalidArgument('metricUnit 不能为空。');
  if (!Number.isFinite(metricTarget)) throw invalidArgument('metricTarget 必须是有限数字。');
  if (!LOOP_CADENCES.includes(input.cadence)) {
    throw invalidArgument(`未知节奏：${String(input.cadence)}。允许：${LOOP_CADENCES.join(', ')}。`);
  }

  let basedOnMemoryId = null;
  if (typeof input.basedOnMemoryId === 'string' && input.basedOnMemoryId.trim().length > 0) {
    basedOnMemoryId = input.basedOnMemoryId.trim();
    await readMemory(root, basedOnMemoryId, { signal, missing: 'throw' });
  }

  const loop = normalizeLoop({
    id: newId('loop'),
    loopName,
    taskRef: typeof input.taskRef === 'string' && input.taskRef.trim().length > 0 ? input.taskRef.trim() : null,
    metric: { name: metricName, target: metricTarget, unit: metricUnit },
    cadence: input.cadence,
    records: [],
    basedOnMemoryId,
    createdAt: nowIso(),
  });
  await writeLoop(root, loop, { signal });
  return { loopId: loop.id, definition: loop };
}

/**
 * Append one round and derive the trend.
 * @param {string} root
 * @param {{ loopId: string, value: number, notes?: string }} input
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{
 *   loopId: string, rounds: number, latestValue: number,
 *   trend: 'improving'|'stable'|'worsening'|'insufficient_data',
 *   warning: string|null, metricTarget: number, metricUnit: string,
 * }>}
 */
export async function recordLoop(root, { loopId, value, notes }, { signal } = {}) {
  throwIfAborted(signal);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw invalidArgument('value 必须是有限数字。');
  const loop = await readLoop(root, loopId, { signal, missing: 'throw' });
  const round = loop.records.length + 1;
  loop.records.push({
    round,
    value: numeric,
    recordedAt: nowIso(),
    notes: typeof notes === 'string' ? truncate(notes, 500) : '',
  });
  const values = loop.records.map(record => record.value);
  const trend = computeTrend(values);
  let warning = null;
  if (trend === 'worsening' && typeof loop.basedOnMemoryId === 'string') {
    const basis = await readMemory(root, loop.basedOnMemoryId, { signal });
    warning = basis === null
      ? `该 Loop 引用的记忆 ${loop.basedOnMemoryId} 已不存在，建议重新确认设计依据。`
      : `该 Loop 基于记忆 ${loop.basedOnMemoryId} 设计，但指标正在恶化，建议复核该记忆是否仍成立。`;
  }
  throwIfAborted(signal);
  await writeLoop(root, loop, { signal });
  return {
    loopId: loop.id,
    rounds: loop.records.length,
    latestValue: numeric,
    trend,
    warning,
    metricTarget: loop.metric.target,
    metricUnit: loop.metric.unit,
  };
}
