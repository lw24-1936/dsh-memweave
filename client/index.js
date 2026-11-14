/**
 * 织忆 (Memweave) — Client half.
 *
 * This file is a classic browser script, not an ES module: the Harness client
 * module table executes it to register a factory, then materializes the
 * factory on first import. React comes from the module table; no second React
 * is installed and no external UI library is used.
 *
 * Three tabs are contributed to `settings.plugins.tab`. Each tab fetches from
 * the same-origin `/memweave/api` route on mount; the shell mounts a tab on
 * first selection and keeps it mounted while hidden.
 */
window.__ModuleLoader__.load({
  id: 'dsh-memweave',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    const NS = 'memweave';

    // Assigned by apply() so the tab components (declared once per factory)
    // read the active locale and the shared filter store at render time.
    let t = key => key;
    let clientStore = createUiStore();

    /** Simplified Chinese dictionary, the key source of truth. */
    const zh = {
      tabStorage: '存储与分类',
      tabMemories: '技能浏览',
      tabFusion: '融合',
      storageTitle: '存储与分类',
      storageIntro: '组织记忆落在绝对路径或当前 workspace 的 .memweave/ 目录。分类计数来自 Host 半的实时扫描。',
      currentRoot: '当前存储根',
      sourceConfigured: '已配置绝对路径',
      sourceSession: '会话 workspace',
      sourceLast: '最近会话 workspace',
      sourceHost: 'Host 启动目录',
      sourceInvalid: '配置无效',
      memoryCount: '记忆总数',
      pathLabel: '存储根目录（绝对路径；留空使用 workspace/.memweave）',
      pathPlaceholder: '例如 D:\\memory\\memweave',
      pathHint: '相对路径会被 Host 拒绝。清除后回退到当前 workspace 的 .memweave/。',
      save: '保存',
      saving: '保存中…',
      clear: '清除',
      refresh: '刷新',
      loadError: '读取失败',
      retry: '重试',
      categoryTitle: '分类概览',
      categoryHint: '点击分类：本页展开该分类明细，并为“技能浏览”预置筛选。',
      statusTitle: '状态分布',
      openMemories: '在技能浏览中查看',
      filterPresetHint: '筛选已预置；切换到“技能浏览”可查看完整结果。',
      drillBack: '返回概览',
      drillEmpty: '该分类当前没有记忆。',
      drillLoading: '正在读取…',
      memoriesTitle: '技能浏览',
      memoriesIntro: '浏览、检索并验证记忆。默认只显示已验证记忆；候选记忆需要显式切换状态。',
      filterStatus: '状态',
      filterTypes: '类型',
      searchPlaceholder: '搜索内容、理由或反模式',
      search: '搜索',
      prev: '上一页',
      next: '下一页',
      total: '共 {count} 条',
      empty: '没有匹配的记忆。',
      detailTitle: '详情',
      detailEmpty: '从左侧选择一条记忆查看详情。',
      content: '内容',
      rationale: '理由',
      antiPatterns: '反模式',
      scope: '适用范围',
      source: '来源',
      evidence: '证据',
      confidence: '置信度',
      status: '状态',
      lastVerified: '最近验证',
      verifyValid: '验证有效',
      verifyInvalid: '验证无效',
      verifyInconclusive: '结论未定',
      verifyNote: '验证依据（可选）',
      verify: '提交验证',
      verifying: '提交中…',
      close: '关闭',
      pageRange: '第 {from}-{to} 条',
      typeFact: '事实',
      typeProcedure: '程序',
      typeJudgment: '判断',
      typeAntiPattern: '反模式',
      typeRelation: '关系',
      statusVerified: '已验证',
      statusCandidate: '候选',
      statusDisputed: '有争议',
      statusSuperseded: '已取代',
      fusionTitle: '融合',
      fusionIntro: '只读探测兼容记忆插件；开关只决定织忆是否读取或写入自己的导出区，不修改其他插件。',
      fusionSummary: '检测到 {count} 个兼容插件，{enabled} 个已启用',
      detectedBy: '检测方式',
      byFile: '文件',
      byService: '服务',
      byTool: '工具',
      saved: '已保存',
      available: '已连接',
      unavailable: '不可用',
      enable: '启用',
      direction: '方向',
      directionRead: '读取',
      directionWrite: '写入',
      directionBoth: '双向',
      aggregateOn: '聚合包已启用',
      aggregateOff: '独立安装',
      compatibilityNote: '兼容性声明：Memweave 不修改其他插件的配置和运行时，融合是只读或显式调用的。禁用某项融合后，对应数据不会被读取或写入。',
      fusionError: '融合操作失败',
      noPlugins: '未检测到兼容插件。',
      apply: '应用',
      loading: '加载中…',
      error: '出错了',
      none: '无',
      yes: '是',
      no: '否',
      workspaceUnknown: '尚未确定 workspace',
    };

    /** English dictionary checked against the Chinese key set. */
    const en = {
      tabStorage: 'Storage & categories',
      tabMemories: 'Memories',
      tabFusion: 'Fusion',
      storageTitle: 'Storage & categories',
      storageIntro: 'Organizational memory lives under an absolute root or the current workspace .memweave/. Counts are scanned live by the Host half.',
      currentRoot: 'Current storage root',
      sourceConfigured: 'Configured absolute path',
      sourceSession: 'Session workspace',
      sourceLast: 'Most recent session workspace',
      sourceHost: 'Host launch directory',
      sourceInvalid: 'Invalid configuration',
      memoryCount: 'Total memories',
      pathLabel: 'Storage root (absolute path; leave empty for workspace/.memweave)',
      pathPlaceholder: 'e.g. D:\\memory\\memweave',
      pathHint: 'The Host rejects relative paths. Clearing falls back to the current workspace .memweave/.',
      save: 'Save',
      saving: 'Saving…',
      clear: 'Clear',
      refresh: 'Refresh',
      loadError: 'Could not read',
      retry: 'Retry',
      categoryTitle: 'Category overview',
      categoryHint: 'Click a category to expand its entries here and preset the Memories filter.',
      statusTitle: 'Status distribution',
      openMemories: 'Open in Memories',
      filterPresetHint: 'Filter preset; switch to Memories for the full result.',
      drillBack: 'Back to overview',
      drillEmpty: 'No memories in this category.',
      drillLoading: 'Reading…',
      memoriesTitle: 'Memories',
      memoriesIntro: 'Browse, search and verify memories. Verified is the default; candidates require an explicit status switch.',
      filterStatus: 'Status',
      filterTypes: 'Types',
      searchPlaceholder: 'Search content, rationale or anti-patterns',
      search: 'Search',
      prev: 'Previous',
      next: 'Next',
      total: '{count} total',
      empty: 'No matching memories.',
      detailTitle: 'Detail',
      detailEmpty: 'Select a memory to see its detail.',
      content: 'Content',
      rationale: 'Rationale',
      antiPatterns: 'Anti-patterns',
      scope: 'Scope',
      source: 'Source',
      evidence: 'Evidence',
      confidence: 'Confidence',
      status: 'Status',
      lastVerified: 'Last verified',
      verifyValid: 'Valid',
      verifyInvalid: 'Invalid',
      verifyInconclusive: 'Inconclusive',
      verifyNote: 'Verification note (optional)',
      verify: 'Verify',
      verifying: 'Verifying…',
      close: 'Close',
      pageRange: 'Rows {from}-{to}',
      typeFact: 'Fact',
      typeProcedure: 'Procedure',
      typeJudgment: 'Judgment',
      typeAntiPattern: 'Anti-pattern',
      typeRelation: 'Relation',
      statusVerified: 'Verified',
      statusCandidate: 'Candidate',
      statusDisputed: 'Disputed',
      statusSuperseded: 'Superseded',
      fusionTitle: 'Fusion',
      fusionIntro: 'Read-only probes over compatible memory plugins. Switches only decide whether Memweave reads or writes its own export area; other plugins are untouched.',
      fusionSummary: '{count} compatible plugins detected, {enabled} enabled',
      detectedBy: 'Detected by',
      byFile: 'File',
      byService: 'Service',
      byTool: 'Tool',
      saved: 'Saved',
      available: 'Connected',
      unavailable: 'Unavailable',
      enable: 'Enable',
      direction: 'Direction',
      directionRead: 'Read',
      directionWrite: 'Write',
      directionBoth: 'Both',
      aggregateOn: 'Aggregate bundle enabled',
      aggregateOff: 'Standalone install',
      compatibilityNote: 'Compatibility: Memweave does not modify another plugin’s configuration or runtime. Fusion is read-only or explicit. Disabling a fusion source stops all reads and writes for it.',
      fusionError: 'Fusion operation failed',
      noPlugins: 'No compatible plugins detected.',
      apply: 'Apply',
      loading: 'Loading…',
      error: 'Something went wrong',
      none: 'None',
      yes: 'Yes',
      no: 'No',
      workspaceUnknown: 'Workspace not known yet',
    };

    const TYPE_KEYS = ['fact', 'procedure', 'judgment', 'anti_pattern', 'relation'];
    const STATUS_KEYS = ['verified', 'candidate', 'disputed', 'superseded'];
    const TYPE_LABEL_KEY = {
      fact: 'typeFact',
      procedure: 'typeProcedure',
      judgment: 'typeJudgment',
      anti_pattern: 'typeAntiPattern',
      relation: 'typeRelation',
    };
    const STATUS_LABEL_KEY = {
      verified: 'statusVerified',
      candidate: 'statusCandidate',
      disputed: 'statusDisputed',
      superseded: 'statusSuperseded',
    };

    /** One client error with the Host's stable code. */
    function ApiError(code, message) {
      this.name = 'ApiError';
      this.code = code;
      this.message = message;
    }
    ApiError.prototype = Object.create(Error.prototype);

    /** Request one API route and unwrap the Host envelope. */
    async function request(path, options) {
      const init = { cache: 'no-store', ...options };
      if (init.body !== undefined) {
        init.method = 'POST';
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(init.body);
      }
      let response;
      try {
        response = await fetch(`/memweave/api${path}`, init);
      } catch (error) {
        throw new ApiError('NETWORK', error instanceof Error ? error.message : String(error));
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new ApiError('BAD_RESPONSE', `HTTP ${response.status}`);
      }
      if (!response.ok || payload?.ok !== true) {
        throw new ApiError(payload?.error?.code ?? `HTTP_${response.status}`, payload?.error?.message ?? `HTTP ${response.status}`);
      }
      return payload;
    }

    const api = {
      snapshot: async () => (await request('/snapshot')).snapshot,
      memories: async params => {
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
          if (value === undefined || value === null || value === '') continue;
          if (Array.isArray(value)) {
            if (value.length > 0) search.set(key, value.join(','));
          } else {
            search.set(key, String(value));
          }
        }
        return (await request(`/memories?${search.toString()}`)).result;
      },
      memory: async id => (await request(`/memory?id=${encodeURIComponent(id)}`)).result,
      verify: async body => (await request('/verify', { body })).result,
      settings: async storageRoot => (await request('/settings', { body: { storageRoot } })).result,
      fusion: async body => (await request('/fusion', { body })).result,
    };

    /** Confidence symbols mirrored from the Host renderer. */
    function symbol(confidence) {
      const value = Number(confidence);
      if (!Number.isFinite(value)) return '●○○○○';
      if (value >= 0.9) return '●●●●●';
      if (value >= 0.7) return '●●●●○';
      if (value >= 0.5) return '●●●○○';
      if (value >= 0.3) return '●●○○○';
      return '●○○○○';
    }

    /** Truncate by code points. */
    function truncate(text, max) {
      const characters = Array.from(String(text ?? ''));
      return characters.length <= max ? String(text ?? '') : `${characters.slice(0, max - 1).join('')}…`;
    }

    /** Minimal error text from an unknown thrown value. */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    /** Shared filter intent between the storage and memory tabs. */
    function createUiStore() {
      let state = { pendingType: null };
      const listeners = new Set();
      return {
        get: () => state,
        setPendingType(type) {
          state = { ...state, pendingType: type };
          for (const listener of listeners) listener();
        },
        consumePendingType() {
          const type = state.pendingType;
          if (type !== null) {
            state = { ...state, pendingType: null };
            for (const listener of listeners) listener();
          }
          return type;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    }

    const CSS = `
      .mw-root { container-type: inline-size; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.55; }
      .mw-stack { display: flex; flex-direction: column; gap: 14px; }
      .mw-title { margin: 0; font-size: 15px; font-weight: 600; }
      .mw-muted { color: var(--dsw-alias-label-tertiary); }
      .mw-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 12px; background: var(--dsw-alias-bg-layer-1, transparent); }
      .mw-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .mw-between { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
      .mw-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 8px; }
      .mw-cat { text-align: left; cursor: pointer; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 10px; background: var(--dsw-alias-bg-layer-1, transparent); color: inherit; font: inherit; }
      .mw-cat:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .mw-cat[aria-pressed="true"] { border-color: var(--dsw-alias-state-warn-primary); }
      .mw-cat-count { display: block; font-size: 22px; font-weight: 650; margin-top: 2px; }
      .mw-input { width: 100%; box-sizing: border-box; padding: 7px 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; font: inherit; }
      .mw-input:focus-visible, .mw-button:focus-visible, .mw-cat:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 1px; }
      .mw-button { cursor: pointer; padding: 6px 11px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: inherit; font: inherit; }
      .mw-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .mw-button:disabled { opacity: .55; cursor: default; }
      .mw-button-primary { background: var(--dsw-alias-button-primary-fill); border-color: transparent; color: var(--dsw-alias-bg-base); }
      .mw-button-danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-border-l2); }
      .mw-badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .mw-badge-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
      .mw-badge-ok { color: var(--dsw-alias-state-success-primary); }
      .mw-notice { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); }
      .mw-notice-error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .mw-notice-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
      .mw-list { display: flex; flex-direction: column; gap: 6px; }
      .mw-item { text-align: left; cursor: pointer; border: 1px solid transparent; border-bottom-color: var(--dsw-alias-border-l1); background: transparent; color: inherit; font: inherit; padding: 8px 6px; border-radius: 6px; }
      .mw-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .mw-item[aria-current="true"] { background: var(--dsw-alias-interactive-bg-active); }
      .mw-split { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 12px; align-items: start; }
      .mw-detail { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 12px; }
      .mw-detail h4 { margin: 10px 0 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .mw-detail p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
      .mw-chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .mw-chip { cursor: pointer; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: inherit; font: inherit; font-size: 12px; }
      .mw-chip[aria-pressed="true"] { border-color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); }
      .mw-source { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; overflow-wrap: anywhere; }
      .mw-hint { font-size: 11px; }
      .mw-divider { height: 1px; background: var(--dsw-alias-border-l1); }
      .mw-verify-bar { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
      .mw-fusion-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }
      .mw-fusion-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 3px; }
      .mw-select { padding: 5px 7px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; font: inherit; }
      .mw-switch { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
      .mw-check { width: 15px; height: 15px; accent-color: var(--dsw-alias-state-warn-primary); }
      .mw-empty { padding: 18px 8px; text-align: center; color: var(--dsw-alias-label-tertiary); }
      @container (max-width: 620px) {
        .mw-split { grid-template-columns: 1fr; }
        .mw-fusion-row { grid-template-columns: 1fr; }
      }
    `;

    /** Inject the component-local stylesheet. */
    function Styles() {
      return h('style', null, CSS);
    }

    /** Small common notice. */
    function Notice({ tone, children }) {
      return h('div', { className: `mw-notice${tone ? ` mw-notice-${tone}` : ''}`, role: tone === 'error' ? 'alert' : 'status' }, children);
    }

    /** The storage root and category overview. */
    function StorageTab() {
      const [state, setState] = useState({ status: 'loading' });
      const [draft, setDraft] = useState('');
      const [saving, setSaving] = useState(false);
      const [notice, setNotice] = useState(null);
      const [drillType, setDrillType] = useState(null);
      const [drill, setDrill] = useState({ status: 'idle' });

      const load = useCallback(async () => {
        setState({ status: 'loading' });
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const snapshot = await api.snapshot();
            setState({ status: 'ready', snapshot });
            setDraft(snapshot.storage.configuredRoot ?? '');
            return;
          } catch (error) {
            if (attempt === 1) {
              setState({ status: 'error', error: messageOf(error) });
              return;
            }
            // Saving a normal Config field restarts the Host half; the first
            // snapshot after the write can race that restart.
            await new Promise(resolve => setTimeout(resolve, 700));
          }
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      const sourceLabel = useMemo(() => {
        if (state.status !== 'ready') return '';
        const map = {
          configured: t('sourceConfigured'),
          session: t('sourceSession'),
          'last-workspace': t('sourceLast'),
          'host-cwd': t('sourceHost'),
          invalid: t('sourceInvalid'),
        };
        return map[state.snapshot.storage.source] ?? state.snapshot.storage.source;
      }, [state]);

      const total = state.status === 'ready' ? state.snapshot.storage.counts.types : null;

      async function save() {
        setSaving(true);
        setNotice(null);
        try {
          await api.settings(draft);
          setNotice({ tone: 'ok', text: t('saved') });
          await load();
        } catch (error) {
          setNotice({ tone: 'error', text: messageOf(error) });
        } finally {
          setSaving(false);
        }
      }

      async function clear() {
        setSaving(true);
        setNotice(null);
        try {
          await api.settings('');
          setDraft('');
          setNotice({ tone: 'ok', text: t('saved') });
          await load();
        } catch (error) {
          setNotice({ tone: 'error', text: messageOf(error) });
        } finally {
          setSaving(false);
        }
      }

      async function openCategory(type) {
        if (drillType === type) {
          clientStore.consumePendingType();
          setDrillType(null);
          setDrill({ status: 'idle' });
          return;
        }
        setDrillType(type);
        clientStore.setPendingType(type);
        setDrill({ status: 'loading' });
        try {
          const result = await api.memories({ types: [type], status: 'verified', limit: 50, offset: 0 });
          setDrill({ status: 'ready', result });
        } catch (error) {
          setDrill({ status: 'error', error: messageOf(error) });
        }
      }

      return h('div', { className: 'mw-root mw-stack' }, [
        h(Styles, { key: 'styles' }),
        h('h3', { className: 'mw-title', key: 'title' }, t('storageTitle')),
        h('p', { className: 'mw-muted', key: 'intro' }, t('storageIntro')),

        notice === null ? null : h(Notice, { key: 'notice', tone: notice.tone }, notice.text),

        state.status === 'loading' ? h('p', { className: 'mw-muted', key: 'loading' }, t('loading')) : null,
        state.status === 'error' ? h('div', { className: 'mw-card', key: 'error' }, [
          h(Notice, { key: 'n', tone: 'error' }, `${t('loadError')}：${state.error}`),
          h('div', { className: 'mw-row', style: { marginTop: 8 }, key: 'r' }, h('button', { className: 'mw-button', type: 'button', onClick: load }, t('retry'))),
        ]) : null,

        state.status === 'ready' ? h('div', { className: 'mw-card', key: 'root' }, [
          h('div', { className: 'mw-between', key: 'head' }, [
            h('span', { className: 'mw-muted', key: 'label' }, t('currentRoot')),
            h('span', { className: 'mw-badge', key: 'source' }, sourceLabel),
          ]),
          h('div', { className: 'mw-source', key: 'path', style: { marginTop: 4 } }, state.snapshot.storage.root ?? state.snapshot.storage.error ?? '—'),
          state.snapshot.storage.workspace === null ? null : h('div', { className: 'mw-muted mw-source', key: 'ws' }, `workspace: ${state.snapshot.storage.workspace}`),
          state.snapshot.storage.error === null ? null : h(Notice, { key: 'invalid', tone: 'error' }, state.snapshot.storage.error),
          h('div', { className: 'mw-row', key: 'total', style: { marginTop: 8 } }, [
            h('span', { className: 'mw-muted', key: 't' }, t('memoryCount')),
            h('strong', { key: 'v' }, String(state.snapshot.storage.total)),
            state.snapshot.storage.skipped > 0 ? h('span', { className: 'mw-badge mw-badge-warn', key: 'skip' }, `跳过损坏文件 ${state.snapshot.storage.skipped}`) : null,
          ]),
        ]) : null,

        h('div', { className: 'mw-card', key: 'editor' }, [
          h('label', { className: 'mw-muted', key: 'label', htmlFor: 'mw-storage-path' }, t('pathLabel')),
          h('div', { className: 'mw-row', key: 'row', style: { marginTop: 5 } }, [
            h('input', {
              id: 'mw-storage-path',
              key: 'input',
              className: 'mw-input',
              style: { flex: '1 1 260px' },
              type: 'text',
              value: draft,
              placeholder: t('pathPlaceholder'),
              spellCheck: false,
              onChange: event => setDraft(event.currentTarget.value),
            }),
            h('button', { key: 'save', className: 'mw-button mw-button-primary', type: 'button', disabled: saving, onClick: save }, saving ? t('saving') : t('save')),
            h('button', { key: 'clear', className: 'mw-button', type: 'button', disabled: saving || draft.length === 0, onClick: clear }, t('clear')),
            h('button', { key: 'refresh', className: 'mw-button', type: 'button', disabled: saving, onClick: load }, t('refresh')),
          ]),
          h('div', { className: 'mw-muted mw-hint', key: 'hint', style: { marginTop: 5 } }, t('pathHint')),
        ]),

        total === null ? null : h('div', { className: 'mw-card', key: 'categories' }, [
          h('div', { className: 'mw-between', key: 'head' }, [
            h('strong', { key: 't' }, t('categoryTitle')),
            h('span', { className: 'mw-muted mw-hint', key: 'h' }, t('categoryHint')),
          ]),
          h('div', { className: 'mw-grid', key: 'grid', style: { marginTop: 8 } }, TYPE_KEYS.map(type => h('button', {
            key: type,
            type: 'button',
            className: 'mw-cat',
            'aria-pressed': drillType === type ? 'true' : 'false',
            onClick: () => { openCategory(type); },
          }, [
            h('span', { key: 'label' }, t(TYPE_LABEL_KEY[type])),
            h('span', { className: 'mw-cat-count', key: 'count' }, String(total[type] ?? 0)),
          ]))),
          h('div', { className: 'mw-divider', key: 'div', style: { margin: '10px 0' } }),
          h('div', { className: 'mw-row', key: 'statuses' }, STATUS_KEYS.map(status => h('span', {
            key: status,
            className: `mw-badge${status === 'disputed' ? ' mw-badge-warn' : ''}`,
          }, `${t(STATUS_LABEL_KEY[status])} ${state.snapshot.storage.counts.statuses[status] ?? 0}`))),
          drillType === null ? null : h('div', { key: 'drill', style: { marginTop: 10 } }, [
            h('div', { className: 'mw-between', key: 'head' }, [
              h('strong', { key: 't' }, `${t(TYPE_LABEL_KEY[drillType])} · ${t('detailTitle')}`),
              h('button', { key: 'back', className: 'mw-button', type: 'button', onClick: () => { setDrillType(null); setDrill({ status: 'idle' }); } }, t('drillBack')),
            ]),
            drill.status === 'loading' ? h('p', { className: 'mw-muted', key: 'l' }, t('drillLoading')) : null,
            drill.status === 'error' ? h(Notice, { key: 'e', tone: 'error' }, drill.error) : null,
            drill.status === 'ready' && drill.result.items.length === 0 ? h('p', { className: 'mw-empty', key: 'empty' }, t('drillEmpty')) : null,
            drill.status === 'ready' && drill.result.items.length > 0 ? h('div', { className: 'mw-list', key: 'list' }, drill.result.items.map(memory => h('div', {
              key: memory.memoryId,
              className: 'mw-item',
              style: { cursor: 'default' },
            }, [
              h('div', { className: 'mw-row', key: 'top' }, [
                h('span', { className: 'mw-badge', key: 'type' }, t(TYPE_LABEL_KEY[memory.type])),
                h('span', { key: 'sym' }, symbol(memory.confidence)),
                h('span', { className: 'mw-muted', key: 'id' }, memory.memoryId),
              ]),
              h('div', { key: 'content' }, truncate(memory.content, 100)),
            ]))) : null,
            h('div', { className: 'mw-muted mw-hint', key: 'preset', style: { marginTop: 6 } }, t('filterPresetHint')),
          ]),
        ]),

        state.status === 'ready' ? h('div', { className: 'mw-muted mw-hint', key: 'version' }, `dsh-memweave ${state.snapshot.version}`) : null,
      ]);
    }

    /** Browse, inspect and verify memories. */
    function MemoriesTab() {
      const [status, setStatus] = useState('verified');
      const [types, setTypes] = useState([]);
      const [query, setQuery] = useState('');
      const [queryDraft, setQueryDraft] = useState('');
      const [offset, setOffset] = useState(0);
      const [state, setState] = useState({ status: 'loading' });
      const [detail, setDetail] = useState({ status: 'idle' });
      const [note, setNote] = useState('');
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(null);
      const pageSize = 50;

      const load = useCallback(async () => {
        setState({ status: 'loading' });
        try {
          const result = await api.memories({ status, types, query, limit: pageSize, offset });
          setState({ status: 'ready', result });
        } catch (error) {
          setState({ status: 'error', error: messageOf(error) });
        }
      }, [status, types, query, offset]);

      useEffect(() => { load(); }, [load]);

      useEffect(() => {
        const applyPending = () => {
          const pending = clientStore.get().pendingType;
          if (pending !== null) {
            clientStore.consumePendingType();
            setTypes([pending]);
            setStatus('verified');
            setOffset(0);
          }
        };
        applyPending();
        return clientStore.subscribe(applyPending);
      }, []);

      async function openDetail(memoryId) {
        setDetail({ status: 'loading', memoryId });
        setNote('');
        try {
          const result = await api.memory(memoryId);
          setDetail({ status: 'ready', memory: result.memory });
        } catch (error) {
          setDetail({ status: 'error', error: messageOf(error) });
        }
      }

      async function submitVerify(outcome) {
        if (detail.status !== 'ready') return;
        setBusy(true);
        setNotice(null);
        try {
          await api.verify({ memoryId: detail.memory.id, outcome, note });
          setNotice({ tone: 'ok', text: `${t('verify')}：${outcome === 'valid' ? t('verifyValid') : outcome === 'invalid' ? t('verifyInvalid') : t('verifyInconclusive')}` });
          setNote('');
          await load();
          await openDetail(detail.memory.id);
        } catch (error) {
          setNotice({ tone: 'error', text: messageOf(error) });
        } finally {
          setBusy(false);
        }
      }

      function toggleType(type) {
        setOffset(0);
        setTypes(current => current.includes(type) ? current.filter(item => item !== type) : [...current, type]);
      }

      const result = state.status === 'ready' ? state.result : null;
      const from = result !== null && result.items.length > 0 ? offset + 1 : 0;
      const to = result !== null ? offset + result.items.length : 0;

      return h('div', { className: 'mw-root mw-stack' }, [
        h(Styles, { key: 'styles' }),
        h('h3', { className: 'mw-title', key: 'title' }, t('memoriesTitle')),
        h('p', { className: 'mw-muted', key: 'intro' }, t('memoriesIntro')),

        notice === null ? null : h(Notice, { key: 'notice', tone: notice.tone }, notice.text),

        h('div', { className: 'mw-card mw-stack', key: 'filters' }, [
          h('div', { className: 'mw-row', key: 'status' }, [
            h('span', { className: 'mw-muted', key: 'label' }, t('filterStatus')),
            h('select', {
              key: 'select',
              className: 'mw-select',
              value: status,
              onChange: event => { setOffset(0); setStatus(event.currentTarget.value); },
            }, STATUS_KEYS.map(item => h('option', { key: item, value: item }, t(STATUS_LABEL_KEY[item])))),
            h('span', { className: 'mw-muted', key: 'total' }, result === null ? '' : t('total', { count: result.total })),
          ]),
          h('div', { className: 'mw-row', key: 'types' }, [
            h('span', { className: 'mw-muted', key: 'label' }, t('filterTypes')),
            ...TYPE_KEYS.map(type => h('button', {
              key: type,
              type: 'button',
              className: 'mw-chip',
              'aria-pressed': types.includes(type) ? 'true' : 'false',
              onClick: () => { toggleType(type); },
            }, t(TYPE_LABEL_KEY[type]))),
          ]),
          h('div', { className: 'mw-row', key: 'search' }, [
            h('input', {
              key: 'input',
              className: 'mw-input',
              style: { flex: '1 1 220px' },
              type: 'search',
              value: queryDraft,
              placeholder: t('searchPlaceholder'),
              onChange: event => setQueryDraft(event.currentTarget.value),
              onKeyDown: event => {
                if (event.key === 'Enter') {
                  setOffset(0);
                  setQuery(queryDraft.trim());
                }
              },
            }),
            h('button', {
              key: 'go',
              className: 'mw-button',
              type: 'button',
              onClick: () => { setOffset(0); setQuery(queryDraft.trim()); },
            }, t('search')),
            h('button', {
              key: 'clear',
              className: 'mw-button',
              type: 'button',
              onClick: () => { setQueryDraft(''); setQuery(''); setOffset(0); },
            }, t('clear')),
          ]),
        ]),

        state.status === 'loading' ? h('p', { className: 'mw-muted', key: 'loading' }, t('loading')) : null,
        state.status === 'error' ? h(Notice, { key: 'error', tone: 'error' }, `${t('loadError')}：${state.error}`) : null,

        result === null ? null : h('div', { className: 'mw-split', key: 'split' }, [
          h('div', { className: 'mw-card', key: 'list' }, [
            result.items.length === 0 ? h('p', { className: 'mw-empty', key: 'empty' }, t('empty')) : h('div', { className: 'mw-list' }, result.items.map(memory => h('button', {
              key: memory.memoryId,
              type: 'button',
              className: 'mw-item',
              'aria-current': detail.status === 'ready' && detail.memory.id === memory.memoryId ? 'true' : 'false',
              onClick: () => { openDetail(memory.memoryId); },
            }, [
              h('div', { className: 'mw-row', key: 'top' }, [
                h('span', { className: 'mw-badge', key: 'type' }, t(TYPE_LABEL_KEY[memory.type])),
                h('span', { key: 'sym' }, symbol(memory.confidence)),
                h('span', { className: 'mw-muted', key: 'id' }, memory.memoryId),
              ]),
              h('div', { key: 'content' }, truncate(memory.content, 90)),
              h('div', { className: 'mw-muted mw-hint', key: 'meta' }, `${memory.evidenceSummary} · ${memory.lastVerifiedAt ?? t('none')}`),
            ]))),
            h('div', { className: 'mw-row', key: 'pager', style: { marginTop: 8 } }, [
              h('button', { key: 'prev', className: 'mw-button', type: 'button', disabled: offset === 0, onClick: () => setOffset(Math.max(0, offset - pageSize)) }, t('prev')),
              h('span', { key: 'range', className: 'mw-muted' }, t('pageRange', { from, to })),
              h('button', { key: 'next', className: 'mw-button', type: 'button', disabled: result.total <= offset + result.items.length, onClick: () => setOffset(offset + pageSize) }, t('next')),
            ]),
          ]),
          h('div', { className: 'mw-detail', key: 'detail' }, detail.status === 'idle'
            ? h('p', { className: 'mw-muted' }, t('detailEmpty'))
            : detail.status === 'loading'
              ? h('p', { className: 'mw-muted' }, t('loading'))
              : detail.status === 'error'
                ? h(Notice, { tone: 'error' }, detail.error)
                : h('div', { className: 'mw-stack' }, [
                  h('div', { className: 'mw-between', key: 'head' }, [
                    h('strong', { key: 'title' }, t('detailTitle')),
                    h('span', { className: 'mw-badge', key: 'status' }, t(STATUS_LABEL_KEY[detail.memory.status])),
                  ]),
                  h('div', { className: 'mw-row', key: 'ids' }, [
                    h('span', { className: 'mw-badge', key: 'type' }, t(TYPE_LABEL_KEY[detail.memory.type])),
                    h('span', { key: 'sym' }, `${symbol(detail.memory.confidence)} ${Number(detail.memory.confidence).toFixed(2)}`),
                    h('span', { className: 'mw-source', key: 'id' }, detail.memory.id),
                  ]),
                  h('div', { key: 'content' }, [h('h4', { key: 'h' }, t('content')), h('p', { key: 'p' }, detail.memory.content)]),
                  h('div', { key: 'rationale' }, [h('h4', { key: 'h' }, t('rationale')), h('p', { key: 'p' }, detail.memory.rationale.length > 0 ? detail.memory.rationale : t('none'))]),
                  h('div', { key: 'anti' }, [
                    h('h4', { key: 'h' }, t('antiPatterns')),
                    detail.memory.antiPatterns.length === 0
                      ? h('p', { className: 'mw-muted', key: 'p' }, t('none'))
                      : h('ul', { key: 'ul', style: { margin: 0, paddingLeft: 18 } }, detail.memory.antiPatterns.map((item, index) => h('li', { key: String(index) }, item))),
                  ]),
                  h('div', { key: 'scope' }, [
                    h('h4', { key: 'h' }, t('scope')),
                    h('p', { key: 'p' }, detail.memory.scope.taskTypes.length === 0 ? t('none') : detail.memory.scope.taskTypes.join('、')),
                  ]),
                  h('div', { key: 'source' }, [
                    h('h4', { key: 'h' }, t('source')),
                    h('p', { className: 'mw-source', key: 'p' }, detail.memory.source.taskRef ?? t('none')),
                  ]),
                  h('div', { key: 'evidence' }, [
                    h('h4', { key: 'h' }, t('evidence')),
                    h('p', { key: 'p' }, detail.memory.evidenceSummary),
                    h('p', { className: 'mw-muted mw-hint', key: 'verified' }, `${t('lastVerified')}：${detail.memory.lastVerifiedAt ?? t('none')}`),
                  ]),
                  h('div', { className: 'mw-verify-bar', key: 'verify' }, [
                    h('label', { className: 'mw-muted', key: 'label', htmlFor: 'mw-verify-note' }, t('verifyNote')),
                    h('input', {
                      id: 'mw-verify-note',
                      key: 'note',
                      className: 'mw-input',
                      type: 'text',
                      value: note,
                      onChange: event => setNote(event.currentTarget.value),
                    }),
                    h('div', { className: 'mw-row', key: 'buttons' }, [
                      h('button', { key: 'valid', className: 'mw-button mw-button-primary', type: 'button', disabled: busy, onClick: () => { submitVerify('valid'); } }, busy ? t('verifying') : t('verifyValid')),
                      h('button', { key: 'invalid', className: 'mw-button mw-button-danger', type: 'button', disabled: busy, onClick: () => { submitVerify('invalid'); } }, t('verifyInvalid')),
                      h('button', { key: 'inconclusive', className: 'mw-button', type: 'button', disabled: busy, onClick: () => { submitVerify('inconclusive'); } }, t('verifyInconclusive')),
                    ]),
                  ]),
                ])),
        ]),
      ]);
    }

    /** Fusion switches and aggregate status. */
    function FusionTab() {
      const [state, setState] = useState({ status: 'loading' });
      const [notice, setNotice] = useState(null);
      const [busyKey, setBusyKey] = useState(null);

      const load = useCallback(async () => {
        setState({ status: 'loading' });
        try {
          const snapshot = await api.snapshot();
          setState({ status: 'ready', fusion: snapshot.fusion });
        } catch (error) {
          setState({ status: 'error', error: messageOf(error) });
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      async function update(plugin, patch) {
        setBusyKey(plugin.key);
        setNotice(null);
        try {
          await api.fusion({
            pluginKey: plugin.key,
            enabled: patch.enabled ?? plugin.enabled,
            direction: patch.direction ?? plugin.direction,
          });
          // A normal Config edit restarts the plugin; give the fiber a moment,
          // then reload. If the reload races, the user can press refresh.
          await new Promise(resolve => setTimeout(resolve, 600));
          await load();
        } catch (error) {
          setNotice({ tone: 'error', text: messageOf(error) });
        } finally {
          setBusyKey(null);
        }
      }

      const fusion = state.status === 'ready' ? state.fusion : null;
      const enabledCount = fusion === null ? 0 : fusion.plugins.filter(plugin => plugin.enabled).length;
      const directionOptions = [
        ['read', t('directionRead')],
        ['write', t('directionWrite')],
        ['both', t('directionBoth')],
      ];
      const detectionLabels = { file: t('byFile'), service: t('byService'), tool: t('byTool') };

      return h('div', { className: 'mw-root mw-stack' }, [
        h(Styles, { key: 'styles' }),
        h('h3', { className: 'mw-title', key: 'title' }, t('fusionTitle')),
        h('p', { className: 'mw-muted', key: 'intro' }, t('fusionIntro')),

        notice === null ? null : h(Notice, { key: 'notice', tone: notice.tone }, notice.text),

        state.status === 'loading' ? h('p', { className: 'mw-muted', key: 'loading' }, t('loading')) : null,
        state.status === 'error' ? h('div', { className: 'mw-card', key: 'error' }, [
          h(Notice, { key: 'n', tone: 'error' }, `${t('loadError')}：${state.error}`),
          h('div', { className: 'mw-row', key: 'r', style: { marginTop: 8 } }, h('button', { className: 'mw-button', type: 'button', onClick: load }, t('retry'))),
        ]) : null,

        fusion === null ? null : h('div', { className: 'mw-card', key: 'summary' }, [
          h('div', { className: 'mw-between', key: 'head' }, [
            h('strong', { key: 'summary' }, t('fusionSummary', { count: fusion.plugins.length, enabled: enabledCount })),
            h('span', { className: `mw-badge${fusion.aggregateBundle ? ' mw-badge-ok' : ''}`, key: 'aggregate' }, fusion.aggregateBundle ? t('aggregateOn') : t('aggregateOff')),
          ]),
          h('button', { className: 'mw-button', type: 'button', style: { marginTop: 8 }, onClick: load }, t('refresh')),
        ]),

        fusion === null ? null : h('div', { className: 'mw-stack', key: 'rows' }, fusion.plugins.map(plugin => h('div', {
          className: 'mw-card',
          key: plugin.key,
        }, [
          h('div', { className: 'mw-fusion-row', key: 'main' }, [
            h('div', { key: 'info' }, [
              h('strong', { key: 'label' }, plugin.label),
              h('div', { className: 'mw-fusion-meta', key: 'meta' }, [
                h('span', { className: 'mw-badge', key: 'by' }, `${t('detectedBy')}：${detectionLabels[plugin.detectedBy] ?? plugin.detectedBy}`),
                h('span', { className: `mw-badge${plugin.available ? ' mw-badge-ok' : ' mw-badge-warn'}`, key: 'avail' }, plugin.available ? t('available') : t('unavailable')),
                h('span', { className: 'mw-badge', key: 'dir' }, `${t('direction')}：${plugin.direction}`),
              ]),
              h('div', { className: 'mw-muted mw-hint', key: 'detail' }, plugin.detail),
            ]),
            h('div', { className: 'mw-row', key: 'controls' }, [
              h('label', { className: 'mw-switch', key: 'switch' }, [
                h('input', {
                  className: 'mw-check',
                  key: 'check',
                  type: 'checkbox',
                  checked: plugin.enabled,
                  disabled: busyKey === plugin.key,
                  onChange: event => { update(plugin, { enabled: event.currentTarget.checked }); },
                }),
                t('enable'),
              ]),
              h('select', {
                key: 'select',
                className: 'mw-select',
                value: plugin.direction,
                disabled: busyKey === plugin.key,
                onChange: event => { update(plugin, { direction: event.currentTarget.value }); },
              }, directionOptions.map(([value, label]) => h('option', { key: value, value }, label))),
            ]),
          ]),
        ]))),

        fusion === null ? null : h('p', { className: 'mw-muted mw-hint', key: 'statement' }, t('compatibilityNote')),
      ]);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'memweave: client dictionaries');
        t = ctx.locale.bind(NS);
        clientStore = createUiStore();

        // The tab components close over `t`, the API and the shared filter
        // store; they are stable for this activation.
        function Storage() { return h(StorageTab); }
        function Memories() { return h(MemoriesTab); }
        function Fusion() { return h(FusionTab); }

        const registerTab = (id, order, labelKey, component) => {
          ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
            name: 'settings.plugins.tab',
            id,
            order,
            label: () => t(labelKey),
            locale: NS,
          }, component));
        };

        registerTab('memweave-storage', 10, 'tabStorage', Storage);
        registerTab('memweave-memories', 20, 'tabMemories', Memories);
        registerTab('memweave-fusion', 30, 'tabFusion', Fusion);
      },
    };
  },
});
