/**
 * dsh-plugin-ai-super-search — 浏览器端客户端扩展
 *
 * 在 DSH 设置页侧栏注册「AI 超级搜索 (免 Token)」分区，提供图形化配置：
 *   1. TinyFish API Key（官方承诺 Search 永久免费）
 *   2. AnySearch API Key / 接口地址 / 区域（支持匿名免 Key 免费额度）
 *   3. Jina API Key（可选）
 *   4. 首选搜索引擎
 *
 * 架构要点（照抄官方 dsh-web-search-anysearch 的成熟契约）：
 *   - `ctx.remote` 只在 `apply(ctx)` 闭包里可用，**不能**从组件 props 里取；
 *   - 状态用「store + hooks 注入」：`inject: () => ({ hooks: { xxx: store } })`
 *     会被 slots 框架转成组件里的 `props.useXxx(selector)` 钩子；
 *   - section 是容器，用 `renderSlot(childId)` 渲染带 inject 的表单项；
 *   - 密钥全部经 `remote.credentials.set` 存入 DSH 凭据服务，绝不落配置文件。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-ai-super-search',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const { useState, useEffect, useCallback } = React;
    const h = React.createElement;

    // ───────────────────────────── 样式 ─────────────────────────────
    const C = {
      primary: 'var(--dsw-alias-label-primary, #0f172a)',
      secondary: 'var(--dsw-alias-label-secondary, #475569)',
      tertiary: 'var(--dsw-alias-label-tertiary, #94a3b8)',
      border: 'var(--dsw-alias-border-l2, #cbd5e1)',
      field: 'var(--dsw-alias-field-fill, #ffffff)',
      btn: 'var(--dsw-alias-button-primary-fill, #2563eb)',
      ok: 'var(--dsw-alias-state-success-primary, #16a34a)',
      warn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
      err: 'var(--dsw-alias-state-error-primary, #dc2626)',
    };

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 760, fontSize: 13 },
      card: { border: '1px solid ' + C.border, borderRadius: 10, padding: '16px 18px', marginTop: 12 },
      title: { fontSize: 14.5, fontWeight: 600, color: C.primary, marginBottom: 6 },
      desc: { fontSize: 12, color: C.tertiary, lineHeight: 1.7, marginBottom: 4 },
      block: { borderTop: '1px solid ' + C.border, paddingTop: 14, marginTop: 16 },
      head: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 },
      name: { fontWeight: 600, fontSize: 13, color: C.primary },
      row: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 },
      label: { fontSize: 12.5, color: C.secondary },
      input: { height: 34, padding: '0 10px', fontSize: 13, borderRadius: 8, border: '1px solid ' + C.border, background: C.field, color: C.primary, font: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box' },
      select: { height: 34, padding: '0 10px', fontSize: 13, borderRadius: 8, border: '1px solid ' + C.border, background: C.field, color: C.primary, font: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box' },
      hint: { fontSize: 11.5, color: C.tertiary, lineHeight: 1.6 },
      footRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 8 },
      btnRow: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 18 },
      btn: { height: 34, padding: '0 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, background: C.btn, color: '#fff', font: 'inherit' },
      btnGhost: { height: 34, padding: '0 14px', borderRadius: 8, border: '1px solid ' + C.border, background: 'transparent', color: C.secondary, cursor: 'pointer', fontSize: 13, font: 'inherit' },
      getKey: { display: 'inline-flex', alignItems: 'center', height: 28, padding: '0 12px', borderRadius: 6, border: '1px solid ' + C.btn, background: 'transparent', color: C.btn, fontSize: 12, fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap', cursor: 'pointer' },
      tagOk: { display: 'inline-block', fontSize: 11, padding: '2px 8px', borderRadius: 4, background: 'rgba(22,163,74,0.12)', color: C.ok, fontWeight: 600 },
      tagWarn: { display: 'inline-block', fontSize: 11, padding: '2px 8px', borderRadius: 4, background: 'rgba(245,158,11,0.14)', color: C.warn, fontWeight: 600 },
      tagFree: { display: 'inline-block', fontSize: 11, padding: '2px 8px', borderRadius: 4, background: 'rgba(22,163,74,0.12)', color: C.ok, fontWeight: 600 },
    };

    // ─────────────────── 官方取 Key / 注册入口（已核对） ───────────────────
    const SIGNUP = {
      tinyfish: 'https://agent.tinyfish.ai/api-keys',
      anysearch: 'https://anysearch.com/console/api-keys',
      jina: 'https://jina.ai/',
    };

    // ─────────────────── 凭据引用（host 侧按同名读取） ───────────────────
    const REFS = {
      tinyfishKey: 'TINYFISH_API_KEY',
      tinyfishBaseUrl: 'TINYFISH_SEARCH_BASE_URL',
      anysearchKey: 'ANYSEARCH_API_KEY',
      anysearchBaseUrl: 'ANYSEARCH_BASE_URL',
      anysearchZone: 'ANYSEARCH_ZONE',
      jinaKey: 'DSH_JINA_API_KEY',
      engine: 'DSH_SEARCH_ENGINE',
    };

    /** 「前往获取 Key」直达按钮。 */
    function GetKeyLink({ href, label }) {
      return h('a', { href, target: '_blank', rel: 'noreferrer', style: S.getKey, title: href }, label);
    }

    /** 状态徽标。 */
    function KeyBadge({ configured }) {
      return h('span', { style: configured ? S.tagOk : S.tagWarn }, configured ? '● 已配置' : '未配置');
    }

    // ─────────────────────────── 容器 section ───────────────────────────
    function SuperSearchSection({ renderSlot }) {
      return h('div', { style: S.wrap }, renderSlot('settings.ai-super-search.item'));
    }

    // ──────────────────────────── 表单 ────────────────────────────
    function SuperSearchForm(props) {
      const snapshot = props.useSuperSearchCard((s) => s);
      const save = props.save;
      const reset = props.reset;

      const [fields, setFields] = useState({
        tinyfishKey: '', tinyfishBaseUrl: '',
        anysearchKey: '', anysearchBaseUrl: '', anysearchZone: 'cn',
        jinaKey: '', engine: '',
      });

      const set = (k, v) => setFields((prev) => ({ ...prev, [k]: v }));

      const onSave = () => {
        const payload = {};
        for (const [k, ref] of Object.entries(REFS)) {
          const value = String(fields[k] || '').trim();
          if (value.length > 0) payload[ref] = value;
        }
        void save(payload);
        // 保存后立即清空密钥输入，避免明文停留在界面上
        setFields((prev) => ({ ...prev, tinyfishKey: '', anysearchKey: '', jinaKey: '' }));
      };

      const noteStyle = {
        marginTop: 12, fontSize: 12.5, lineHeight: 1.6,
        color: String(snapshot.note).startsWith('✅') ? C.ok
          : String(snapshot.note).startsWith('❌') ? C.err : C.warn,
      };

      return h('div', { style: S.wrap },
        h('div', { style: S.card },
          h('div', { style: S.title }, '🌐 AI 超级搜索与免费通道'),
          h('div', { style: S.desc },
            '接管 DSH 原生 web_search，绕开官方 DeepSeek 的付费搜索通道（每次搜索 = 一次完整模型调用，独立扣费且面板不可见）。'),
          h('div', { style: S.desc },
            '降级链：TinyFish → AnySearch → Bing 爬虫 → Jina → DuckDuckGo，全程零 Token 消耗。'),

          // 首选引擎
          h('div', { style: S.row },
            h('span', { style: S.label }, '首选检索引擎'),
            h('select', { style: S.select, value: fields.engine, onChange: (e) => set('engine', e.target.value) },
              h('option', { value: '' }, '智能自动降级（推荐：有 Key 优先，无 Key 走爬虫）'),
              h('option', { value: 'tinyfish' }, 'TinyFish（官方免费结构化 API）'),
              h('option', { value: 'anysearch' }, 'AnySearch（支持匿名免费额度）'),
              h('option', { value: 'bing' }, 'Bing 结果页解析（免 Key）'),
              h('option', { value: 'jina' }, 'Jina Search'),
              h('option', { value: 'ddg' }, 'DuckDuckGo Lite（免 Key）')),
            h('div', { style: S.hint }, '留空即智能路由：配了 Key 优先走免费结构化通道，没配则自动用免 Key 爬虫，永远不会没结果。')),

          // TinyFish
          h('div', { style: S.block },
            h('div', { style: S.head },
              h('span', { style: S.name }, 'TinyFish'),
              h('span', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('span', { style: S.tagFree }, 'Search 永久免费'),
                h(KeyBadge, { configured: snapshot.tinyfishConfigured }))),
            h('input', {
              style: S.input, type: 'password',
              placeholder: snapshot.tinyfishConfigured ? '已保存（留空保持不变，输入新值覆盖）' : '粘贴 TinyFish API Key…',
              value: fields.tinyfishKey, onChange: (e) => set('tinyfishKey', e.target.value),
            }),
            h('div', { style: S.footRow },
              h('div', { style: S.hint }, '官方明文承诺：Search 不消耗钱包余额，$0 余额也可用。'),
              h(GetKeyLink, { href: SIGNUP.tinyfish, label: '前往获取 TinyFish Key →' }))),

          // AnySearch
          h('div', { style: S.block },
            h('div', { style: S.head },
              h('span', { style: S.name }, 'AnySearch'),
              h('span', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('span', { style: S.tagFree }, '支持匿名免费'),
                h(KeyBadge, { configured: snapshot.anysearchConfigured }))),
            h('input', {
              style: S.input, type: 'password',
              placeholder: snapshot.anysearchConfigured ? '已保存（留空保持不变，输入新值覆盖）' : '粘贴 AnySearch API Key（可留空走匿名额度）…',
              value: fields.anysearchKey, onChange: (e) => set('anysearchKey', e.target.value),
            }),
            h('div', { style: S.footRow },
              h('div', { style: S.hint }, '不填 Key 也能用：按 IP 享受每日免费额度。'),
              h(GetKeyLink, { href: SIGNUP.anysearch, label: '前往获取 AnySearch Key →' })),
            h('div', { style: S.row },
              h('span', { style: S.label }, '接口地址（可选）'),
              h('input', {
                style: S.input, placeholder: '留空默认 https://api.anysearch.com',
                value: fields.anysearchBaseUrl, onChange: (e) => set('anysearchBaseUrl', e.target.value),
              })),
            h('div', { style: S.row },
              h('span', { style: S.label }, '区域'),
              h('select', { style: S.select, value: fields.anysearchZone, onChange: (e) => set('anysearchZone', e.target.value) },
                h('option', { value: 'cn' }, 'cn — 国内优先'),
                h('option', { value: 'intl' }, 'intl — 国际优先')))),

          // Jina
          h('div', { style: S.block },
            h('div', { style: S.head },
              h('span', { style: S.name }, 'Jina（可选）'),
              h('span', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('span', { style: S.tagFree }, '免 Key 可用'),
                h(KeyBadge, { configured: snapshot.jinaConfigured }))),
            h('input', {
              style: S.input, type: 'password',
              placeholder: 'jina_...（留空走免费速率限制）',
              value: fields.jinaKey, onChange: (e) => set('jinaKey', e.target.value),
            }),
            h('div', { style: S.footRow },
              h('div', { style: S.hint }, '用于网页正文提取与搜索的备用通道。'),
              h(GetKeyLink, { href: SIGNUP.jina, label: '前往 Jina 官网 →' }))),

          // 操作
          h('div', { style: S.btnRow },
            h('button', { style: { ...S.btn, opacity: snapshot.saving ? 0.6 : 1 }, disabled: snapshot.saving, onClick: onSave },
              snapshot.saving ? '保存中…' : '保存搜索配置'),
            h('button', { style: S.btnGhost, onClick: () => { void reset(); setFields({ tinyfishKey: '', tinyfishBaseUrl: '', anysearchKey: '', anysearchBaseUrl: '', anysearchZone: 'cn', jinaKey: '', engine: '' }); } },
              '清除已保存配置')),

          snapshot.note ? h('div', { style: noteStyle }, snapshot.note) : null
        )
      );
    }

    // ───────────────────────────── 插件主体 ─────────────────────────────
    const name = 'dsh-plugin-ai-super-search';

    // cordis 的 ctx 是代理：读取未在 inject 中声明的服务会直接抛
    // `cannot get property "remote" without inject`，fiber 因此进入 failed 状态，
    // 前端表现为「web boot: 1 entry did not activate」。
    // 本文件用了 ctx.slots 与 ctx.remote（含 credentials 子域），三者都必须声明。
    const inject = ['slots', 'remote', 'remote.credentials'];

    function apply(ctx) {
      // remote 只在 apply 闭包里可用 —— 这正是上一版取不到凭据服务的原因
      const remote = ctx.remote;

      let snapshot = {
        tinyfishConfigured: false,
        anysearchConfigured: false,
        jinaConfigured: false,
        saving: false,
        note: '',
      };
      const listeners = new Set();
      const notify = () => { for (const listener of listeners) listener(); };
      const setSnapshot = (next) => { snapshot = next; notify(); };
      const store = {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      };

      /** 询问凭据服务：三个 Key 各自的配置状态。 */
      const refresh = async () => {
        if (typeof remote?.credentials?.describe !== 'function') {
          setSnapshot({ ...snapshot, note: '⚠ 凭据服务不可用（该部署可能未挂载 credentials）。' });
          return;
        }
        try {
          const result = await remote.credentials.describe([REFS.tinyfishKey, REFS.anysearchKey, REFS.jinaKey]);
          if (!result?.ok) return;
          const view = result.value || {};
          setSnapshot({
            ...snapshot,
            tinyfishConfigured: view[REFS.tinyfishKey]?.configured === true,
            anysearchConfigured: view[REFS.anysearchKey]?.configured === true,
            jinaConfigured: view[REFS.jinaKey]?.configured === true,
          });
        } catch { /* 读取失败不打扰用户 */ }
      };

      /** 把非空字段写入凭据服务（密钥永不进设置文档）。 */
      const save = async (payload) => {
        if (typeof remote?.credentials?.set !== 'function') {
          setSnapshot({ ...snapshot, saving: false, note: '❌ 凭据服务不可用，无法保存。可改用环境变量配置。' });
          return;
        }
        setSnapshot({ ...snapshot, saving: true, note: '' });
        try {
          for (const [ref, value] of Object.entries(payload)) {
            const result = await remote.credentials.set(ref, value);
            if (!result?.ok) throw new Error(result?.error?.message ?? `写入 ${ref} 失败`);
          }
          setSnapshot({ ...snapshot, saving: false, note: '✅ 已加密保存，下次联网搜索立即生效。' });
        } catch (error) {
          setSnapshot({ ...snapshot, saving: false, note: '❌ 保存失败：' + (error?.message || String(error)) });
        }
        await refresh();
      };

      /** 清空所有引用，回退到免 Key 爬取模式。 */
      const reset = async () => {
        if (typeof window !== 'undefined' && !window.confirm('确定清除已保存的搜索凭据吗？将回退到免 Key 自动爬取模式。')) return;
        if (typeof remote?.credentials?.unset !== 'function') return;
        setSnapshot({ ...snapshot, saving: true, note: '' });
        let failed = false;
        for (const ref of Object.values(REFS)) {
          try {
            const result = await remote.credentials.unset(ref);
            if (!result?.ok) failed = true;
          } catch { failed = true; }
        }
        setSnapshot({ ...snapshot, saving: false, note: failed ? '⚠ 部分字段未能清除。' : '✅ 已清除，回退默认配置。' });
        await refresh();
      };

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'ai-super-search',
            order: 125,
            label: () => 'AI 超级搜索 (免 Token)',
            children: { 'settings.ai-super-search.item': { kind: 'list', scope: 'root' } },
          },
          SuperSearchSection,
        ));

      ctx.slots.inject('settings.ai-super-search.item', () =>
        ctx.slots.register(
          {
            name: 'settings.ai-super-search.item',
            id: 'ai-super-search-form',
            order: 0,
            inject: () => ({ hooks: { superSearchCard: store }, save, reset }),
          },
          SuperSearchForm,
        ));

      ctx.effect(
        () => [
          ctx.remote?.$on?.('credentials/reference-updated', () => { void refresh(); }),
          ctx.on?.('connection/reset', () => { void refresh(); }),
        ],
        'ai-super-search: credential invalidations',
      );

      void refresh();
    }

    module.exports = { name, inject, apply };
    return module.exports;
  }
});