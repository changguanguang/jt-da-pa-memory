/**
 * jt-da-pa-memory —— 浏览器半（Web Client）。
 *
 * 在 dsh 的 Web UI 里加一个「记忆」面板：侧边栏一个图标 + 点开后的主区页面。
 * 数据来自宿主半的 HTTP 接口（/jt-da-pa-memory/api/*）。
 *
 * 纯 JS、无编译；由 dsh 的客户端模块系统加载（window.__ModuleLoader__.load）。
 * 插槽用法对齐 dsh 自带的 ui-schedule。
 *
 * 诊断：控制台会打印 [jt-da-pa-memory] 开头的几行，用于定位加载到哪一步。
 */
window.__ModuleLoader__.load({
  id: 'jt-da-pa-memory',
  factory(require) {
    var log = function () { try { console.log.apply(console, ['[jt-da-pa-memory]'].concat([].slice.call(arguments))); } catch (e) {} };
    log('client bundle loaded');

    let React;
    try {
      React = require('react');
    } catch (e) {
      log('require("react") FAILED:', e && e.message);
      throw e;
    }
    const h = React.createElement;
    const PANEL_ID = 'jt-da-pa-memory';
    const NS = 'jt-da-pa-memory';
    const API = '/jt-da-pa-memory/api/';

    function api(path, body) {
      return fetch(API + path, body
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : undefined).then((r) => r.json());
    }

    /** 侧边栏图标（大脑轮廓）。渲染器会传入 { size, active }。 */
    function MemoryIcon({ size }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size || 18, height: size || 18,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, h('path', { d: 'M12 5a3 3 0 0 0-6 0v9a3 3 0 0 0 6 0V5Zm0 0v9m0-9a3 3 0 0 1 6 0v9a3 3 0 0 1-6 0' }));
    }

    function useMemories() {
      const [state, set] = React.useState({ loading: true, memories: [], error: null });
      const load = React.useCallback(() => {
        api('list')
          .then((d) => set({ loading: false, memories: (d && d.memories) || [], error: null }))
          .catch((e) => set({ loading: false, memories: [], error: String(e) }));
      }, []);
      React.useEffect(() => { load(); }, [load]);
      return [state, load];
    }

    /** 主区页面：记忆列表 + 手动添加 + 删除。 */
    function MemoryPanel() {
      const [state, load] = useMemories();
      const [draft, setDraft] = React.useState('');
      const del = (id) => { api('forget', { id }).then(load); };
      const add = () => {
        const v = draft.trim();
        if (!v) return;
        api('add', { text: v }).then(() => { setDraft(''); load(); });
      };
      const row = (m) => h('li', {
        key: m.id,
        style: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid rgba(128,128,128,.18)' },
      },
        h('span', { style: { flex: 1, opacity: m.archived ? 0.45 : 1 } }, m.text),
        m.expiresAt ? h('span', { style: { fontSize: 11, color: '#c47f00' } }, '至 ' + new Date(m.expiresAt).toISOString().slice(0, 10)) : null,
        m.category && m.category !== 'other' ? h('span', { style: { fontSize: 11, opacity: 0.5 } }, m.category) : null,
        h('button', { type: 'button', onClick: () => del(m.id), style: { cursor: 'pointer' } }, '删除'));

      return h('div', { style: { maxWidth: 760, margin: '0 auto', padding: '28px 20px 80px' } },
        h('h1', { style: { fontSize: 22, margin: '0 0 4px' } }, 'jt-da-pa 记忆'),
        h('div', { style: { opacity: 0.6, fontSize: 13, marginBottom: 16 } },
          state.loading ? '加载中…' : '共 ' + state.memories.length + ' 条'),
        h('div', { style: { display: 'flex', gap: 8, marginBottom: 20 } },
          h('input', {
            type: 'text', value: draft, placeholder: '手动记一条…',
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') add(); },
            style: { flex: 1, padding: '6px 10px' },
          }),
          h('button', { type: 'button', onClick: add }, '记住')),
        state.error ? h('div', { style: { color: '#d23b3b' } }, '读取失败：' + state.error) : null,
        h('ul', { style: { listStyle: 'none', padding: 0, margin: 0 } }, state.memories.map(row)));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        log('apply() called. slots=' + !!ctx.slots + ' locale=' + !!ctx.locale);
        // 语言表（可缺省，仅让侧边栏标签本地化）
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            ctx.effect(() => ctx.locale.register(NS, { zh: { panel: '记忆' }, en: { panel: 'Memory' } }), 'jt-da-pa-memory: i18n');
          }
        } catch (e) { log('locale.register failed', e && e.message); }

        // 主区页面（由侧边栏图标激活）
        try {
          ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, MemoryPanel));
          log('injected main');
        } catch (e) { log('main inject failed', e && e.message); }

        // 侧边栏图标
        try {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist', id: PANEL_ID, order: 30, locale: NS, label: () => '记忆',
          }, MemoryIcon));
          log('injected sidebar.panellist');
        } catch (e) { log('sidebar.panellist inject failed', e && e.message); }
      },
    };
  },
});