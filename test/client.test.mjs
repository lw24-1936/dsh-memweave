/** Client bundle registration and a static-render smoke test. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', 'client', 'index.js');

/** Stub React sufficient for registration and SSR (real React is used when available). */
const stubReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: value => [value, () => {}],
  useEffect: () => {},
  useMemo: factory => factory(),
  useCallback: factory => factory,
  useRef: value => ({ current: value }),
};

/** Evaluate the classic bundle and return its factory registration. */
function loadBundle() {
  const source = fs.readFileSync(bundlePath, 'utf8');
  let registration;
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { registration = value; } } },
    console,
    require: specifier => {
      if (specifier === 'react') return stubReact;
      throw new Error(`unexpected require: ${specifier}`);
    },
    fetch: () => { throw new Error('no fetch during registration'); },
    setTimeout,
    URLSearchParams,
  };
  vm.runInNewContext(source, sandbox, { filename: 'client/index.js' });
  return { registration, source };
}

test('bundle is a classic script that registers the package id', () => {
  const { registration, source } = loadBundle();
  assert.equal(registration.id, 'dsh-memweave');
  assert.equal(typeof registration.factory, 'function');
  assert.doesNotMatch(source.slice(0, 80), /^import\s/m);
  assert.match(source, /window\.__ModuleLoader__\.load/);
  assert.match(source, /require\('react'\)/);
});

test('factory contributes three settings tabs with the required ids and order', () => {
  const { registration } = loadBundle();
  const mod = registration.factory(specifier => {
    if (specifier === 'react') return stubReact;
    throw new Error(`unexpected require: ${specifier}`);
  });
  assert.deepEqual(Array.from(mod.inject), ['slots', 'locale']);

  const dictionaries = {};
  const registrations = [];
  const ctx = {
    effect(callback) { return callback(); },
    locale: {
      register(namespace, dictionariesValue) {
        dictionaries[namespace] = dictionariesValue;
        return () => {};
      },
      bind(namespace) {
        return (key, params) => {
          let text = dictionaries[namespace].zh[key] ?? key;
          for (const [name, value] of Object.entries(params ?? {})) {
            text = text.replace(`{${name}}`, String(value));
          }
          return text;
        };
      },
    },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'settings.plugins.tab');
        callback();
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  mod.apply(ctx);

  assert.equal(registrations.length, 3);
  const tabs = registrations.map(entry => ({
    id: entry.options.id,
    order: entry.options.order,
    label: entry.options.label(),
  }));
  assert.deepEqual(tabs, [
    { id: 'memweave-storage', order: 10, label: '存储与分类' },
    { id: 'memweave-memories', order: 20, label: '记忆浏览' },
    { id: 'memweave-fusion', order: 30, label: '融合' },
  ]);
  for (const entry of registrations) {
    assert.equal(typeof entry.component, 'function');
    assert.equal(entry.options.locale, 'memweave');
  }
  assert.deepEqual(Object.keys(dictionaries.memweave.zh).sort(), Object.keys(dictionaries.memweave.en).sort());
});

test('all three tabs render without a browser', async t => {
  let React;
  let renderToStaticMarkup;
  try {
    React = (await import('react')).default;
    ({ renderToStaticMarkup } = await import('react-dom/server'));
  } catch {
    t.skip('react/react-dom are not resolvable in this environment');
    return;
  }

  const source = fs.readFileSync(bundlePath, 'utf8');
  let registration;
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { registration = value; } } },
    console,
    require: specifier => {
      if (specifier === 'react') return React;
      throw new Error(`unexpected require: ${specifier}`);
    },
    fetch: () => { throw new Error('no fetch during render'); },
    setTimeout,
    URLSearchParams,
  }, { filename: 'client/index.js' });

  const mod = registration.factory(specifier => {
    if (specifier === 'react') return React;
    throw new Error(`unexpected require: ${specifier}`);
  });
  const dictionaries = {};
  const registrations = [];
  mod.apply({
    effect: callback => callback(),
    locale: {
      register(namespace, value) { dictionaries[namespace] = value; return () => {}; },
      bind(namespace) {
        return (key, params) => {
          let text = dictionaries[namespace].zh[key] ?? key;
          for (const [name, value] of Object.entries(params ?? {})) {
            text = text.replace(`{${name}}`, String(value));
          }
          return text;
        };
      },
    },
    slots: {
      inject(_name, callback) { callback(); },
      register(options, component) { registrations.push({ options, component }); return () => {}; },
    },
  });

  for (const { options, component } of registrations) {
    const html = renderToStaticMarkup(React.createElement(component));
    assert.ok(html.length > 1000, `${options.id} rendered too little`);
    assert.match(html, /mw-root/);
    assert.match(html, /@container/);
    assert.doesNotMatch(html, /height:\s*100%/);
    assert.doesNotMatch(html, /overflow-y:\s*auto/);
  }
});
