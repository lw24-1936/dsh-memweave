/** Path resolution, atomic write, and orphan cleanup. */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import {
  cleanupOrphanTmp,
  isAbsoluteStoragePath,
  resolveStorageRoot,
  writeAtomic,
  writeJsonAtomic,
} from '../lib/paths.js';
import { memoryPathLabel } from '../lib/model.js';
import { cleanup, makeWorkspace } from './helpers.mjs';

test('absolute path detection accepts POSIX, Windows drive and UNC', () => {
  assert.equal(isAbsoluteStoragePath('/tmp/a'), true);
  assert.equal(isAbsoluteStoragePath('C:\\temp\\a'), true);
  assert.equal(isAbsoluteStoragePath('C:/temp/a'), true);
  assert.equal(isAbsoluteStoragePath('\\\\server\\share'), true);
  assert.equal(isAbsoluteStoragePath('relative/path'), false);
  assert.equal(isAbsoluteStoragePath('./relative'), false);
  assert.equal(isAbsoluteStoragePath(''), false);
});

test('relative storageRoot is rejected with INVALID_ARGUMENT', async () => {
  const workspace = await makeWorkspace();
  try {
    await assert.rejects(
      resolveStorageRoot({ settings: { storageRoot: 'relative/root' }, exec: { agent: { session: { header: { cwd: workspace } } } } }),
      error => error instanceof HarnessError && error.code === 'INVALID_ARGUMENT',
    );
  } finally {
    await cleanup(workspace);
  }
});

test('empty storageRoot falls back to the session workspace', async () => {
  const workspace = await makeWorkspace();
  try {
    const resolved = await resolveStorageRoot({ settings: { storageRoot: '' }, exec: { agent: { session: { header: { cwd: workspace } } } } });
    assert.equal(resolved.source, 'session');
    assert.equal(resolved.root, path.join(workspace, '.memweave'));
    const stat = await fs.stat(path.join(workspace, '.memweave', 'memories'));
    assert.equal(stat.isDirectory(), true);
  } finally {
    await cleanup(workspace);
  }
});

test('atomic write leaves no temp files and replaces content', async () => {
  const workspace = await makeWorkspace();
  try {
    const target = path.join(workspace, 'memories', 'mem_1.json');
    await writeJsonAtomic(target, { id: 'mem_1', value: 1 });
    await writeJsonAtomic(target, { id: 'mem_1', value: 2 });
    const value = JSON.parse(await fs.readFile(target, 'utf8'));
    assert.equal(value.value, 2);
    const entries = await fs.readdir(path.dirname(target));
    assert.deepEqual(entries, ['mem_1.json']);
  } finally {
    await cleanup(workspace);
  }
});

test('writeAtomic respects an already-aborted signal', async () => {
  const workspace = await makeWorkspace();
  try {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await assert.rejects(
      writeAtomic(path.join(workspace, 'a.txt'), 'x', { signal: controller.signal }),
      /stop/,
    );
  } finally {
    await cleanup(workspace);
  }
});

test('orphan tmp cleanup removes only old temp files', async () => {
  const workspace = await makeWorkspace();
  try {
    const directory = path.join(workspace, 'memories');
    await fs.mkdir(directory, { recursive: true });
    const oldFile = path.join(directory, 'mem_old.json.tmp.abcdef');
    const newFile = path.join(directory, 'mem_new.json.tmp.abcdef');
    await fs.writeFile(oldFile, 'old');
    await fs.writeFile(newFile, 'new');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(oldFile, old, old);
    const removed = await cleanupOrphanTmp([directory], { maxAgeMs: 60 * 60 * 1000 });
    assert.equal(removed, 1);
    await assert.rejects(fs.stat(oldFile));
    await fs.stat(newFile);
  } finally {
    await cleanup(workspace);
  }
});

test('memory path labels keep .memweave relative only for the default root', () => {
  assert.equal(memoryPathLabel(path.join('/w', '.memweave'), 'mem_1'), '.memweave/memories/mem_1.json');
  assert.equal(memoryPathLabel(path.join('/custom', 'mem'), 'mem_1'), '/custom/mem/memories/mem_1.json');
});
