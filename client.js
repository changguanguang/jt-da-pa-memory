/**
 * jt-da-pa-memory —— 浏览器半（Web Client）。
 *
 * 侧边栏一个「记忆」图标 + 主区一个卡片网格：每条记忆是一张方形卡片，
 * 按类别分区展示（像商品列表那样）。顶部可手动加一条。
 *
 * 数据来自宿主半的 HTTP 接口（/jt-da-pa-memory/api/*）。
 * 纯 JS、无编译；由 dsh 的客户端模块系统加载（window.__ModuleLoader__.load）。
 */
window.__ModuleLoader__.load({
  id: 'jt-da-pa-memory',
  factory(require) {
    var log = function () { try { console.log.apply(console, ['[jt-da-pa-memory]'].concat([].slice.call(arguments))); } catch (e) {} };
    log('client bundle loaded');

    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'jt-da-pa-memory';
    const NS = 'jt-da-pa-memory';
    const API = '/jt-da-pa-memory/api/';

    /** 类别元数据（顺序即展示顺序；color 用作卡片左侧色条）。 */
    const CATS = [
      { id: 'identity', label: '身份', color: '#4D6BFE' },
      { id: 'preference', label: '偏好与习惯', color: '#1a9d63' },
      { id: 'goal', label: '目标', color: '#0a9396' },
      { id: 'lesson', label: '经验与避坑', color: '#c47f00' },
      { id: 'project', label: '项目', color: '#7c4dff' },
      { id: 'fact', label: '事实', color: '#5a6070' },
      { id: 'other', label: '其他', color: '#8b91a1' },
    ];
    const CAT = (id) => CATS.find((c) => c.id === id) || { id, label: id, color: '#8b91a1' };

    function api(path, body) {
      return fetch(API + path, body
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : undefined).then((r) => r.json());
    }

    function relTime(ts) {
      if (!ts) return '';
      const d = Math.floor((Date.now() - ts) / 86400000);
      if (d <= 0) return '今天';
      if (d === 1) return '昨天';
      if (d < 30) return d + ' 天前';
      return Math.floor(d / 30) + ' 个月前';
    }

    /** 一张记忆卡片。 */
    function MemoryCard({ m, onDelete }) {
      const c = CAT(m.category || 'other');
      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column',
          minHeight: 104,
          padding: '11px 13px',
          border: '1px solid rgba(127,127,127,.2)',
          borderLeft: '3px solid ' + c.color,
          borderRadius: 10,
          background: 'rgba(127,127,127,.045)',
          transition: 'border-color .15s, background .15s',
        },
        onMouseEnter: (e) => { e.currentTarget.style.borderColor = c.color; e.currentTarget.style.background = 'rgba(127,127,127,.09)'; },
        onMouseLeave: (e) => { e.currentTarget.style.borderColor = 'rgba(127,127,127,.2)'; e.currentTarget.style.borderLeftColor = c.color; e.currentTarget.style.background = 'rgba(127,127,127,.045)'; },
      },
        h('div', { style: { flex: 1, wordBreak: 'break-word', lineHeight: 1.5, opacity: m.archived ? 0.45 : 1 } }, m.text),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 9, fontSize: 11, opacity: 0.55 } },
          h('span', { style: { color: c.color, fontWeight: 600, opacity: 0.9 } }, c.label),
          h('span', null, relTime(m.updatedAt)),
          m.expiresAt ? h('span', { style: { color: '#c47f00' } }, '至 ' + new Date(m.expiresAt).toISOString().slice(0, 10)) : null,
          h('span', { style: { flex: 1 } }),
          h('button', {
            type: 'button', onClick: () => onDelete(m.id), title: '删除',
            style: { border: 'none', background: 'none', color: '#d23b3b', cursor: 'pointer', padding: 0 },
          }, '删除')));
    }

    function MemoryPanel() {
      const [state, setState] = React.useState({ loading: true, memories: [], error: null });
      const [draft, setDraft] = React.useState('');

      const load = React.useCallback(() => {
        api('list')
          .then((d) => setState({ loading: false, memories: (d && d.memories) || [], error: null }))
          .catch((e) => setState({ loading: false, memories: [], error: String(e) }));
      }, []);
      React.useEffect(() => { load(); }, [load]);

      const items = state.memories || [];
      const byCat = {};
      for (const m of items) { const c = m.category || 'other'; (byCat[c] = byCat[c] || []).push(m); }
      const order = CATS.map((c) => c.id).filter((c) => byCat[c] && byCat[c].length);
      for (const c of Object.keys(byCat)) if (!order.includes(c)) order.push(c);

      const del = (id) => { api('forget', { id }).then(load); };
      const add = () => {
        const v = draft.trim();
        if (!v) return;
        api('add', { text: v }).then(() => { setDraft(''); load(); });
      };

      const grid = {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
        gap: 10,
      };

      return h('div', { style: { maxWidth: 900, margin: '0 auto', padding: '28px 20px 80px', fontSize: 14, lineHeight: 1.6 } },
        h('h1', { style: { fontSize: 20, margin: '0 0 2px' } }, '记忆'),
        h('div', { style: { opacity: 0.55, fontSize: 13, marginBottom: 18 } },
          state.loading ? '加载中…' : '共 ' + items.length + ' 条'),

        // 手动加一条
        h('div', { style: { display: 'flex', gap: 8, marginBottom: 22 } },
          h('input', {
            type: 'text', value: draft, placeholder: '手动记一条…（回车）',
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') add(); },
            style: { flex: 1, padding: '7px 11px', border: '1px solid rgba(127,127,127,.3)', borderRadius: 8, background: 'transparent', color: 'inherit' },
          }),
          h('button', {
            type: 'button', onClick: add,
            style: { padding: '7px 14px', border: '1px solid rgba(127,127,127,.3)', borderRadius: 8, background: 'transparent', color: 'inherit', cursor: 'pointer' },
          }, '记住')),

        state.error ? h('div', { style: { color: '#d23b3b' } }, '读取失败：' + state.error) : null,

        !state.loading && items.length === 0
          ? h('div', { style: { opacity: 0.5, padding: '40px 0', textAlign: 'center' } }, '还没有记住任何东西。')
          : null,

        ...order.map((cat) => h('section', { key: cat, style: { marginTop: 24 } },
          h('h2', { style: { fontSize: 12, letterSpacing: '.08em', textTransform: 'uppercase', opacity: 0.55, margin: '0 0 10px', fontWeight: 600 } },
            CAT(cat).label + ' · ' + byCat[cat].length),
          h('div', { style: grid },
            ...byCat[cat]
              .slice()
              .sort((a, b) => (b.importance - a.importance) || (b.updatedAt - a.updatedAt))
              .map((m) => h(MemoryCard, { key: m.id, m, onDelete: del }))))) );
    }

    /** 侧边栏图标（大脑轮廓）。渲染器传入 { size, active }。 */
    function MemoryIcon({ size }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size || 18, height: size || 18,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, h('path', { d: 'M12 5a3 3 0 0 0-6 0v9a3 3 0 0 0 6 0V5Zm0 0v9m0-9a3 3 0 0 1 6 0v9a3 3 0 0 1-6 0' }));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        log('apply() called');
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            ctx.effect(() => ctx.locale.register(NS, { zh: { panel: '记忆' }, en: { panel: 'Memory' } }), 'jt-da-pa-memory: i18n');
          }
        } catch (e) { log('locale.register failed', e && e.message); }

        try {
          ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, MemoryPanel));
          log('injected main');
        } catch (e) { log('main inject failed', e && e.message); }

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