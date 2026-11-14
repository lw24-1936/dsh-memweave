/**
 * Aggregate-layer marker only.
 *
 * The actual composition is the bundle patch next to this file: it inserts
 * Memweave plus the compatible plugins that were installed when the patch was
 * generated. This service exists solely so `memweave_fusion_status` can report
 * `aggregateBundle: true` without inspecting profile files.
 *
 * @module dsh-memweave-aggregate
 */

import { Service } from '@deepseek-ai/cordis';

/** Marker service provided by the optional aggregate bundle. */
export default class MemweaveAggregate extends Service {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   */
  constructor(ctx) {
    super(ctx, 'memweaveAggregate');
    /** Marker version. */
    this.version = '1.0.0';
  }
}
