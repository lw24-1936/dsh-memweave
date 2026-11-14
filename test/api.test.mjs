/** Settings API: trust fence, routing, shared verify core, config writes. */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { cleanup, createHost, makeExec, makeRequest, makeResponse, makeWorkspace, parsed, runTool } from './helpers.mjs';

/** Build one active host with a captured web route and fake config editor. */
async function setup() {
  const workspace = await makeWorkspace();
  const edits = [];
  const editor = {
    async edit(entry, change) {
      edits.push({ entry, next: change({ storageRoot: '', fusion: {} }) });
    },
  };
  const entry = { id: 'memweave', options: { config: {} } };
  const host = createHost({
    withWebServer: true,
    entry,
    services: { configEditor: editor },
    config: { storageRoot: path.join(workspace, '.memweave') },
  });
  const route = host.routes[0];
  assert.ok(route, 'settings API route was not mounted');
  return { workspace, host, route, edits, entry };
}

/** Invoke the captured route. */
async function call(route, request) {
  const response = makeResponse();
  await route.handler(request, response);
  return response.state;
}

test('mounts exactly one prefix route', async () => {
  const { workspace, route, host } = await setup();
  try {
    assert.equal(route.kind, 'prefix');
    assert.equal(route.path, '/memweave/api');
    assert.equal(host.tools.size, 10);
  } finally {
    await cleanup(workspace);
  }
});

test('GET snapshot and memories return the shared core data', async () => {
  const { workspace, route, host } = await setup();
  try {
    const exec = makeExec(workspace);
    const created = await runTool(host.tools, 'memweave_precipitate', {
      type: 'fact',
      content: 'API 快照应返回存储根',
      rationale: '测试',
    }, exec);
    await runTool(host.tools, 'memweave_memory_verify', { memoryId: created.value.memoryId, outcome: 'valid' }, exec);

    const snapshot = await call(route, makeRequest({ url: '/memweave/api/snapshot' }));
    assert.equal(snapshot.status, 200);
    const snapshotBody = parsed(snapshot);
    assert.equal(snapshotBody.ok, true);
    assert.equal(snapshotBody.snapshot.storage.total, 1);
    assert.equal(snapshotBody.snapshot.fusion.plugins.length, 5);

    const list = await call(route, makeRequest({ url: '/memweave/api/memories?status=verified&limit=10' }));
    const listBody = parsed(list);
    assert.equal(listBody.ok, true);
    assert.equal(listBody.result.total, 1);
    assert.equal(listBody.result.items[0].memoryId, created.value.memoryId);

    const detail = await call(route, makeRequest({ url: `/memweave/api/memory?id=${created.value.memoryId}` }));
    assert.equal(parsed(detail).result.memory.content, 'API 快照应返回存储根');
  } finally {
    await cleanup(workspace);
  }
});

test('POST verify uses the same memory core as the tool', async () => {
  const { workspace, route, host } = await setup();
  try {
    const exec = makeExec(workspace);
    const created = await runTool(host.tools, 'memweave_precipitate', {
      type: 'judgment',
      content: '设置页验证按钮与工具共用 core',
      rationale: '避免两套写入逻辑',
    }, exec);

    const response = await call(route, makeRequest({
      method: 'POST',
      url: '/memweave/api/verify',
      headers: { 'content-type': 'application/json' },
      body: { memoryId: created.value.memoryId, outcome: 'valid', note: 'api' },
    }));
    const body = parsed(response);
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.result.newStatus, 'verified');
    assert.equal(body.result.previousStatus, 'candidate');
  } finally {
    await cleanup(workspace);
  }
});

test('POST settings and fusion persist through configEditor', async () => {
  const { workspace, route, edits, entry } = await setup();
  try {
    const settingsResponse = await call(route, makeRequest({
      method: 'POST',
      url: '/memweave/api/settings',
      headers: { 'content-type': 'application/json' },
      body: { storageRoot: path.join(workspace, 'custom-root') },
    }));
    assert.equal(settingsResponse.status, 200);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].entry, entry);
    assert.equal(edits[0].next.storageRoot, path.join(workspace, 'custom-root'));

    const fusionResponse = await call(route, makeRequest({
      method: 'POST',
      url: '/memweave/api/fusion',
      headers: { 'content-type': 'application/json' },
      body: { pluginKey: 'dsh-memory-xfy', enabled: true, direction: 'both' },
    }));
    assert.equal(fusionResponse.status, 200);
    assert.equal(edits.length, 2);
    assert.deepEqual(edits[1].next.fusion['dsh-memory-xfy'], { enabled: true, direction: 'both' });
  } finally {
    await cleanup(workspace);
  }
});

test('relative storageRoot is rejected by the API with 400', async () => {
  const { workspace, route } = await setup();
  try {
    const response = await call(route, makeRequest({
      method: 'POST',
      url: '/memweave/api/settings',
      headers: { 'content-type': 'application/json' },
      body: { storageRoot: 'relative/path' },
    }));
    assert.equal(response.status, 400);
    assert.equal(parsed(response).error.code, 'INVALID_ARGUMENT');
  } finally {
    await cleanup(workspace);
  }
});

test('trust fence rejects a non-loopback host and cross-site fetch', async () => {
  const { workspace, route } = await setup();
  try {
    const foreign = await call(route, makeRequest({
      headers: { host: 'evil.example', origin: 'https://evil.example' },
    }));
    assert.equal(foreign.status, 403);

    const crossSite = await call(route, makeRequest({
      headers: { 'sec-fetch-site': 'cross-site' },
    }));
    assert.equal(crossSite.status, 403);
  } finally {
    await cleanup(workspace);
  }
});

test('unsupported methods and unknown routes are explicit', async () => {
  const { workspace, route } = await setup();
  try {
    const method = await call(route, makeRequest({ method: 'DELETE' }));
    assert.equal(method.status, 405);
    const missing = await call(route, makeRequest({ url: '/memweave/api/nope' }));
    assert.equal(missing.status, 404);
  } finally {
    await cleanup(workspace);
  }
});
