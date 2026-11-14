/** Aggregate manifest generation: parse, generated patch, installed-package skip. */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isInstalled,
  parseAggregateManifest,
  renderPatch,
} from '../scripts/prepare-aggregate.mjs';
import { cleanup, makeWorkspace } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

test('parses the declarative aggregate manifest', async () => {
  const text = await fs.readFile(path.join(projectRoot, 'patches', 'aggregate.yaml'), 'utf8');
  const rows = parseAggregateManifest(text);
  assert.deepEqual(rows, [
    { id: 'memweave', name: 'dsh-memweave', optional: false },
    { id: 'memweave-compat-memory-xfy', name: 'dsh-memory-xfy', optional: true },
    { id: 'memweave-compat-task-memory', name: 'dsh-task-memory', optional: true },
  ]);
});

test('rendered patch carries only included rows', () => {
  const text = renderPatch([{ id: 'memweave', name: 'dsh-memweave' }]);
  assert.match(text, /- id: memweave/);
  assert.match(text, /name: dsh-memweave/);
  assert.doesNotMatch(text, /dsh-memory-xfy/);
});

test('isInstalled distinguishes a present package from a missing one', async () => {
  const profile = await makeWorkspace('memweave-profile-');
  try {
    await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'profile', private: true }), 'utf8');
    const packageDir = path.join(profile, 'node_modules', 'fake-memory-plugin');
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'fake-memory-plugin', version: '1.0.0' }), 'utf8');
    assert.equal(isInstalled(profile, 'fake-memory-plugin'), true);
    assert.equal(isInstalled(profile, 'missing-memory-plugin'), false);
  } finally {
    await cleanup(profile);
  }
});

test('generated aggregate patch lists the marker and keeps optional rows explicit', async () => {
  const text = await fs.readFile(path.join(projectRoot, 'aggregate', 'cordis.patch.yml'), 'utf8');
  assert.match(text, /id: memweave/);
  assert.match(text, /id: memweave-aggregate/);
  assert.doesNotMatch(text, /optional:\s*true/);
});

test('aggregate marker exports a service class', async () => {
  const module = await import('../aggregate/index.js');
  assert.equal(typeof module.default, 'function');
  assert.equal(module.default.name, 'MemweaveAggregate');
});
