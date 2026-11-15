/**
 * Same-origin settings API.
 *
 * The browser half cannot read the Host filesystem or call model tools, so the
 * three tabs talk to this prefix route. Every handler is supplied by the Host
 * half and reuses the exact core function behind the corresponding tool.
 *
 * Trust fence: loopback or an explicitly trusted web runtime host, no
 * cross-site fetch, and an Origin that matches the request host when present.
 * POST bodies are capped at 64 KiB.
 *
 * @module dsh-memweave/api
 */

import { HarnessError } from '@deepseek-ai/dsh-llm';
import { INVALID_ARGUMENT } from './errors.js';

/** Route prefix owned by Memweave. */
export const API_PREFIX = '/memweave/api';

/** Maximum accepted JSON body. */
const MAX_BODY_BYTES = 64 * 1024;

/** Parse a Host-header authority. */
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}

/** Whether a hostname names the local loopback authority. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Canonical `host[:port]` for one configured authority entry. */
function canonicalAuthority(entry) {
  const url = parseAuthority(entry);
  if (url === undefined) return undefined;
  return url.port === '' ? url.hostname : url.host;
}

/** Whether a request authority matches a trusted (non-loopback) entry. */
function isTrustedAuthority(hostUrl, trustedHosts) {
  const host = hostUrl.port === '' ? hostUrl.hostname : hostUrl.host;
  return trustedHosts.some(entry => {
    const canonical = canonicalAuthority(entry);
    return canonical !== undefined && (canonical === host || canonical === hostUrl.hostname);
  });
}

/**
 * Decide whether one request may use this API.
 * @param {import('node:http').IncomingMessage} req
 * @param {readonly string[]} trustedHosts
 * @returns {boolean}
 */
export function isTrustedRequest(req, trustedHosts) {
  const host = typeof req.headers.host === 'string' ? req.headers.host : undefined;
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts ?? [])) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/** Write one JSON response; never throws. */
function writeJson(res, status, value) {
  let body;
  try {
    body = JSON.stringify(value);
  } catch {
    status = 500;
    body = JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: '响应无法序列化' } });
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Map one failure to an HTTP body. */
function failureStatus(error) {
  return error instanceof HarnessError && error.code === INVALID_ARGUMENT ? 400 : 500;
}

/** Read one JSON body with a hard size cap. */
async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new HarnessError('请求体超过 64 KiB 上限。', INVALID_ARGUMENT);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new HarnessError('请求体必须是 JSON 对象。', INVALID_ARGUMENT);
    }
    return value;
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError('请求体不是合法 JSON。', INVALID_ARGUMENT);
  }
}

/** Parse a comma-separated `types` query value. */
function parseTypes(value) {
  if (value === null || value.length === 0) return undefined;
  return value.split(',').map(item => item.trim()).filter(item => item.length > 0);
}

/**
 * Mount the settings API.
 * @param {object} ctx - Host context with an optional `webServer`.
 * @param {{
 *   snapshot: () => Promise<object>,
 *   list: (query: URLSearchParams) => Promise<object>,
 *   detail: (id: string) => Promise<object>,
 *   verify: (body: object) => Promise<object>,
 *   saveStorageRoot: (storageRoot: string) => Promise<object>,
 *   saveFusion: (body: object) => Promise<object>,
 *   saveAutoLearn: (body: object) => Promise<object>,
 *   backfillLearning: (body: object) => Promise<object>,
 * }} handlers
 * @returns {() => void} disposer
 */
export function mountApi(ctx, handlers) {
  const webRuntime = typeof ctx.get === 'function' ? ctx.get('webRuntime') : undefined;
  const trustedHosts = Array.isArray(webRuntime?.trustedHosts) ? webRuntime.trustedHosts : [];

  return ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      if (!isTrustedRequest(req, trustedHosts)) {
        writeJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'forbidden' } });
        return;
      }
      let url;
      try {
        url = new URL(req.url ?? '/', 'http://localhost');
      } catch {
        writeJson(res, 400, { ok: false, error: { code: INVALID_ARGUMENT, message: 'bad request' } });
        return;
      }
      const route = url.pathname.slice(API_PREFIX.length) || '/';
      const method = req.method ?? 'GET';
      const isRead = method === 'GET';
      const isWrite = method === 'POST';
      if (!isRead && !isWrite) {
        writeJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' } });
        return;
      }

      try {
        if (isRead && (route === '/' || route === '/snapshot')) {
          writeJson(res, 200, { ok: true, snapshot: await handlers.snapshot() });
          return;
        }
        if (isRead && route === '/memories') {
          const result = await handlers.list(url.searchParams);
          writeJson(res, 200, { ok: true, result });
          return;
        }
        if (isRead && route === '/memory') {
          const id = url.searchParams.get('id') ?? '';
          const result = await handlers.detail(id);
          writeJson(res, 200, { ok: true, result });
          return;
        }
        if (isWrite && route === '/verify') {
          const body = await readJsonBody(req);
          const result = await handlers.verify(body);
          writeJson(res, 200, { ok: true, result });
          return;
        }
        if (isWrite && route === '/settings') {
          const body = await readJsonBody(req);
          if (typeof body.storageRoot !== 'string') {
            throw new HarnessError('storageRoot 必须是字符串。', INVALID_ARGUMENT);
          }
          const result = await handlers.saveStorageRoot(body.storageRoot);
          writeJson(res, 200, { ok: true, result });
          return;
        }
        if (isWrite && route === '/fusion') {
          const body = await readJsonBody(req);
          const result = await handlers.saveFusion(body);
          writeJson(res, 200, { ok: true, result });
          return;
        }
        if (isWrite && route === '/learning') {
          const body = await readJsonBody(req);
          const result = await handlers.saveAutoLearn(body);
          writeJson(res, 200, { ok: true, result });
          return;
        }
        if (isWrite && route === '/learning/backfill') {
          const body = await readJsonBody(req);
          const result = await handlers.backfillLearning(body);
          writeJson(res, 200, { ok: true, result });
          return;
        }
        writeJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'unknown route' } });
      } catch (error) {
        if (error instanceof HarnessError) {
          if (error.code !== INVALID_ARGUMENT) {
            try {
              ctx.logger?.error?.(error);
            } catch {
              // logging is best-effort
            }
          }
          writeJson(res, failureStatus(error), {
            ok: false,
            error: { code: error.code, message: error.message },
          });
          return;
        }
        try {
          ctx.logger?.error?.(error);
        } catch {
          // logging is best-effort
        }
        writeJson(res, 500, {
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) },
        });
      }
    },
  });
}

/** Re-export for the Host half's route parser tests. */
export { parseTypes };
