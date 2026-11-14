/** Shared test helpers: temp workspace, fake Host context, tool runner. */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { apply } from '../lib/index.js';

/** Create a disposable workspace directory. */
export async function makeWorkspace(prefix = 'memweave-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** A tool execution context bound to one session workspace. */
export function makeExec(cwd) {
  return {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd } } },
  };
}

/**
 * Build and activate one fake Host context.
 * @param {{ config?: object, cwd?: string, withWebServer?: boolean, services?: object, entry?: object }} [options]
 */
export function createHost(options = {}) {
  const tools = new Map();
  const routes = [];
  const disposers = [];
  const ctx = {
    effect(callback) {
      const disposer = callback();
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    },
    on() {
      return () => {};
    },
    inject(deps, callback) {
      if (options.withWebServer === true && deps.includes('webServer')) callback(ctx);
    },
    get(name) {
      return options.services?.[name];
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    fiber: { entry: options.entry },
    logger: { warn() {}, error() {} },
  };
  apply(ctx, options.config ?? {});
  return { ctx, tools, routes, disposers };
}

/** Execute one registered tool and validate its canonical value + render. */
export async function runTool(tools, name, args, exec) {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`tool not registered: ${name}`);
  const value = await tool.execute(args, exec);
  const violations = validateJsonSchemaValue(tool.output.schema, value, '');
  const blocks = tool.output.render(args, value, exec);
  return { tool, value, violations, blocks };
}

/** Fake HTTP request with an optional JSON body. */
export function makeRequest({ method = 'GET', url = '/memweave/api/snapshot', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  return {
    method,
    url,
    headers: { host: '127.0.0.1:52693', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** Fake HTTP response capturing status/headers/body. */
export function makeResponse() {
  const state = { status: 0, headers: {}, body: '' };
  return {
    state,
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers;
    },
    end(body) {
      state.body = typeof body === 'string' ? body : String(body ?? '');
    },
  };
}

/** Parse a captured JSON response body. */
export function parsed(state) {
  return JSON.parse(state.body);
}

/** Remove a temp workspace. */
export async function cleanup(root) {
  await fs.rm(root, { recursive: true, force: true });
}
