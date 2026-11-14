/**
 * Error taxonomy for the Memweave Host half.
 *
 * Every expected failure is a HarnessError with a stable code so tool results,
 * replay and the settings API can route on the code instead of the message.
 * Cancellation is never wrapped: the caller's abort reason is rethrown as-is.
 *
 * @module dsh-memweave/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-llm';

/** Argument rejected before touching the store. */
export const INVALID_ARGUMENT = 'INVALID_ARGUMENT';

/** Storage, configuration or unexpected runtime failure. */
export const INTERNAL_ERROR = 'INTERNAL_ERROR';

/**
 * Build an INVALID_ARGUMENT failure.
 * @param {string} message - user-facing, actionable explanation.
 * @param {ErrorOptions} [options] - optional cause.
 * @returns {HarnessError}
 */
export function invalidArgument(message, options) {
  return new HarnessError(message, INVALID_ARGUMENT, options);
}

/**
 * Build an INTERNAL_ERROR failure.
 * @param {string} action - what failed, e.g. `创建记忆目录`.
 * @param {unknown} [error] - underlying failure.
 * @returns {HarnessError}
 */
export function internalError(action, error) {
  const detail = error instanceof Error && error.message.length > 0 ? `：${error.message}` : '';
  return new HarnessError(`${action}失败${detail}`, INTERNAL_ERROR, error instanceof Error ? { cause: error } : undefined);
}

/**
 * Rethrow the caller's abort reason when the signal fired.
 *
 * `AbortSignal.throwIfAborted()` is the DSH-native path: it throws the exact
 * `signal.reason` the harness attached, so tool cancellation stays routable.
 * @param {AbortSignal | undefined} signal
 */
export function throwIfAborted(signal) {
  if (signal === undefined) return;
  if (typeof signal.throwIfAborted === 'function') {
    signal.throwIfAborted();
    return;
  }
  if (signal.aborted) {
    throw signal.reason ?? new Error('The operation was aborted');
  }
}

/**
 * Whether one thrown value is an abort, for catch blocks that must not wrap it.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAbortLike(error) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Wrap an unexpected failure, preserving HarnessErrors and aborts.
 * @param {string} action
 * @param {unknown} error
 * @param {AbortSignal} [signal]
 * @returns {never}
 */
export function rethrow(action, error, signal) {
  throwIfAborted(signal);
  if (error instanceof HarnessError) throw error;
  if (isAbortLike(error)) throw error;
  throw internalError(action, error);
}
