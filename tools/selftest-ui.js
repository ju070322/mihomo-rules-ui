'use strict';
/**
 * 前端联调测试：DOM 桩 + 真实后端。
 * GET 走真实的 127.0.0.1:3085（验证契约），PATCH/DELETE 用 mock（避免真的改线上配置）。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_DIR = process.env.RULES_UI_PUBLIC_DIR || path.resolve(__dirname, '..', 'public');
const BASE = process.env.RULES_UI_BASE || ('http://127.0.0.1:' + (process.env.PORT || '3085'));
const realFetch = globalThis.fetch;

let failures = 0;
let checks = 0;
function check(name, cond, extra) {
  checks += 1;
  if (!cond) failures += 1;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra && !cond ? '  → ' + extra : ''));
}

/* ---------------- DOM 桩 ---------------- */
class StubEl {
  constructor(tag, id) {
    this.tagName = (tag || 'div').toUpperCase();
    this.id = id || '';
    this.children = [];
    this.dataset = {};
    this.style = {};
    this._text = '';
    this._html = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.classKey = new Set();
    this._listeners = {};
    const self = this;
    this.classList = {
      add: (...c) => c.forEach((x) => self.classKey.add(x)),
      remove: (...c) => c.forEach((x) => self.classKey.delete(x)),
      contains: (c) => self.classKey.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !self.classKey.has(c) : !!force;
        if (on) self.classKey.add(c);
        else self.classKey.delete(c);
        return on;
      },
    };
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = String(v);
  }
  get innerHTML() {
    return this._html;
  }
  set innerHTML(v) {
    this._html = String(v);
  }
  setAttribute(k, v) {
    this['attr_' + k] = String(v);
  }
  getAttribute(k) {
    return this['attr_' + k] === undefined ? null : this['attr_' + k];
  }
  removeAttribute(k) {
    delete this['attr_' + k];
  }
  addEventListener(t, fn) {
    (this._listeners[t] = this._listeners[t] || []).push(fn);
  }
  removeEventListener() {}
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  insertBefore(c) {
    this.children.push(c);
    return c;
  }
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c);
  }
  remove() {}
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  closest(sel) {
    return this.matchesSel(sel) ? this : null;
  }
  matchesSel(sel) {
    if (!sel) return false;
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    if (sel.startsWith('.')) return this.classKey.has(sel.slice(1));
    if (sel.startsWith('[')) {
      const m = /\[([\w-]+)(?:="([^"]*)")?\]/.exec(sel);
      if (!m) return false;
      const key = m[1].startsWith('data-')
        ? m[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        : m[1];
      if (m[1].startsWith('data-')) {
        if (!(key in this.dataset)) return false;
        return m[2] === undefined || String(this.dataset[key]) === m[2];
      }
      return this.getAttribute(m[1]) !== null;
    }
    return this.tagName === sel.toUpperCase();
  }
  focus() {}
  blur() {}
  scrollIntoView() {}
  contains() {
    return false;
  }
  get offsetHeight() {
    return 0;
  }
  get offsetWidth() {
    return 0;
  }
  getBoundingClientRect() {
    return { top: 0, left: 0, width: 0, height: 0 };
  }
}

const registry = new Map();
function el(selector) {
  if (!registry.has(selector)) registry.set(selector, new StubEl('div', selector.replace(/^#/, '')));
  return registry.get(selector);
}

const docListeners = {};
const document = {
  readyState: 'complete',
  body: new StubEl('body'),
  documentElement: new StubEl('html'),
  addEventListener: (t, fn) => {
    (docListeners[t] = docListeners[t] || []).push(fn);
  },
  removeEventListener: () => {},
  createElement: (t) => new StubEl(t),
  getElementById: (id) => el('#' + id),
  querySelector: (sel) => (sel && sel.startsWith('#') ? el(sel) : null),
  querySelectorAll: () => [],
};

/* ---------------- fetch：GET 走真实后端，写操作走 mock ---------------- */
const calls = [];
let mockMode = null; // null=真实；'patch'/'delete'/'align' 时拦截写操作

const sandboxFetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = ((init && init.method) || 'GET').toUpperCase();
  const full = new URL(url, BASE).toString();
  if (mockMode && method !== 'GET') {
    calls.push({ url: full, method, body: init && init.body ? JSON.parse(init.body) : null });
    if (mockMode === 'patch') {
      return new Response(
        JSON.stringify({ ok: true, message: 'mock 修改成功', reloadMs: 321, total: 7594, aligned: true, rule: { i: 1, type: 'DOMAIN-SUFFIX', value: 'x', target: 'DIRECT' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (mockMode === 'conflict') {
      return new Response(JSON.stringify({ ok: false, error: '配置已被外部修改（目标不符），请点「刷新」重新加载' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (mockMode === 'align') {
      return new Response(JSON.stringify({ ok: true, aligned: true, inserted: 1, message: 'mock 已对齐' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, message: 'mock ok', total: 7593, reloadMs: 300 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return realFetch(full, init);
};

/* 二次确认弹窗：submit/delete 会先弹确认，测试里自动点「确定」 */
async function withAutoConfirm(fn) {
  let resolved = false;
  const timer = (async () => {
    for (let i = 0; i < 100 && !resolved; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      if (typeof context.__app.state.confirmResolver === 'function') {
        context.__app.state.confirmResolver(true);
        resolved = true;
      }
    }
  })();
  const result = await fn();
  await timer;
  return result;
}

/* ---------------- 载入 app.js ---------------- */
const src = fs.readFileSync(path.join(APP_DIR, 'app.js'), 'utf8');
const sandbox = {
  document,
  window: {},
  console,
  fetch: sandboxFetch,
  Response,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  Date,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  alert: () => {},
  confirm: () => true,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const context = vm.createContext(sandbox);
const expose = `
;globalThis.__toasts = [];
(function () {
  const _toast = toast;
  toast = function (msg) { globalThis.__toasts.push(String(msg)); return _toast.apply(null, arguments); };
})();
;globalThis.__app = {
  state, els,
  switchView, loadMainRules, renderMainTable, getFilteredMainRules,
  openMainRuleModal, submitMainRuleForm, deleteMainRule, alignMainTemplate,
};`;
vm.runInContext(src + expose, context, { filename: 'app.js' });

const app = context.__app;
if (!app || !app.state) {
  console.error('无法从 vm 上下文取出内部符号');
  process.exit(1);
}

(async () => {
  await new Promise((r) => setTimeout(r, 1500)); // 等 init() 的首屏请求

  /* 1. 首屏 */
  check('init 后拿到 state.data', !!app.state.data, JSON.stringify(app.state.error));
  check('state.meta.installed 为 true', app.state.data && app.state.data.meta && app.state.data.meta.installed === true);
  check('groups 已加载(28)', app.state.data && app.state.data.groups && app.state.data.groups.length === 28, String(app.state.data && app.state.data.groups && app.state.data.groups.length));
  check('typeDefs 已加载(13)', app.state.typeDefs.length === 13, String(app.state.typeDefs.length));
  check('默认视图是 custom', app.state.view === 'custom');
  check('tab 计数已写入', /\d/.test(el('#tab-main-count').textContent) || el('#tab-main-count').textContent.includes('7'), el('#tab-main-count').textContent);

  /* 2. 切到主配置视图并加载 7594 条 */
  app.switchView('main');
  check('切换后 view=main', app.state.view === 'main');
  check('主配置 tab 高亮', el('#tab-main').classList.contains('is-active'));
  check('自定义 tab 取消高亮', !el('#tab-custom').classList.contains('is-active'));

  // switchView('main') 内部会触发 loadMainRules，此处等它跑完（1.4MB JSON 需要一会儿）
  for (let i = 0; i < 100 && !app.state.main.loaded && !app.state.main.error; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!app.state.main.loaded && !app.state.main.error) {
    await app.loadMainRules();
    for (let i = 0; i < 100 && !app.state.main.loaded && !app.state.main.error; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  check('loadMainRules 成功', app.state.main.loaded === true, app.state.main.error);
  check('主配置规则数 7594', app.state.main.total === 7594, String(app.state.main.total));
  check('aligned=true', app.state.main.aligned === true);

  /* 3. 分页 */
  app.renderMainTable();
  const pageSize = app.state.main.pageSize;
  const totalPages = Math.ceil(7594 / pageSize);
  check('pageSize=50', pageSize === 50);
  const html = el('#main-rules-body').innerHTML;
  const rowCount = (html.match(/<tr class="rule-row/g) || []).length;
  check('第一页渲染 50 行', rowCount === 50, '实际 ' + rowCount);
  check('分页指示器正确', el('#main-page-indicator').textContent.includes('1') && el('#main-page-indicator').textContent.includes(String(totalPages)), el('#main-page-indicator').textContent);
  check('总数文案正确', el('#main-count').textContent.includes('7594'), el('#main-count').textContent);

  app.state.main.page = 2;
  app.renderMainTable();
  const html2 = el('#main-rules-body').innerHTML;
  check('翻到第 2 页', app.state.main.page === 2);
  check('第 2 页内容与第 1 页不同', html2 !== html);

  /* 4. 搜索过滤 */
  app.state.main.filter.search = 'github';
  app.state.main.page = 1;
  app.renderMainTable();
  const filteredCount = app.getFilteredMainRules ? app.getFilteredMainRules().length : -1;
  check('搜索 github 有结果', filteredCount > 0 && filteredCount < 7594, String(filteredCount));
  const hits = (el('#main-rules-body').innerHTML.match(/github/gi) || []).length;
  check('渲染结果里含 github', hits > 0, String(hits));

  app.state.main.filter.search = 'zzz-not-exist-zzz';
  app.renderMainTable();
  check('无结果时显示提示', el('#main-table-state').hidden === false && /没有匹配/.test(el('#main-table-state').innerHTML), el('#main-table-state').innerHTML.slice(0, 80));

  app.state.main.filter.search = '';
  app.state.main.page = 1;
  app.renderMainTable();

  /* 5. 打开编辑弹窗 */
  const target = app.state.main.rules[7];
  const snap = { type: target.type, value: target.value, target: target.target };
  app.openMainRuleModal(target);
  check('弹窗打开', app.state.main.editingIndex === 7);
  check('类型只读回填（含原始 type）', String(el('#m-type').value).includes(target.type), el('#m-type').value);
  check('值回填', el('#m-value').value === target.value, el('#m-value').value);
  check('目标下拉回填', el('#m-target').value === target.target, el('#m-target').value);
  check('目标下拉含 optgroup', /optgroup/i.test(el('#m-target').innerHTML));

  /* 6. 提交修改（mock PATCH） */
  mockMode = 'patch';
  el('#m-target').value = 'DIRECT';
  el('#m-value').value = target.value;
  await withAutoConfirm(() => app.submitMainRuleForm({ preventDefault() {} }));
  check('发出了 PATCH', calls.length === 1 && calls[0].method === 'PATCH', JSON.stringify(calls.map((c) => c.method)));
  const body = calls.length ? calls[0].body : {};
  check('PATCH 路径含索引', calls.length && /\/api\/main-rules\/7$/.test(calls[0].url), calls.length ? calls[0].url : '');
  check('PATCH 带 expect.type', body.expect && body.expect.type === snap.type, JSON.stringify(body.expect));
  check('PATCH 带 expect.value', body.expect && body.expect.value === snap.value, JSON.stringify(body.expect));
  check('PATCH 带 expect.target', body.expect && body.expect.target === snap.target, JSON.stringify(body.expect));
  check('PATCH body.target 正确', body.target === 'DIRECT', JSON.stringify(body));

  /* 7. 409 冲突处理 */
  calls.length = 0;
  mockMode = 'conflict';
  app.openMainRuleModal(app.state.main.rules[7]);
  el('#m-target').value = 'REJECT';
  await withAutoConfirm(() => app.submitMainRuleForm({ preventDefault() {} }));
  const toasts = (context.__toasts || []).join(' | ');
  const errText = el('#m-form-error').textContent + ' | ' + toasts;
  check('409 有"外部修改/刷新"提示', /外部修改|刷新/.test(errText), errText.slice(0, 160));

  /* 8. 删除（mock DELETE） */
  calls.length = 0;
  mockMode = null; // -> 走默认 mock（非 GET 都拦截）
  mockMode = 'delete';
  const toDel = app.state.main.rules[9];
  await withAutoConfirm(() => app.deleteMainRule(toDel));
  const delCall = calls.find((c) => c.method === 'DELETE');
  check('发出了 DELETE', !!delCall, JSON.stringify(calls.map((c) => c.method)));
  check('DELETE 路径含索引', delCall && new RegExp('/api/main-rules/' + toDel.i + '$').test(delCall.url), delCall ? delCall.url : '');
  check('DELETE 带 expect', delCall && delCall.body && delCall.body.expect && delCall.body.expect.value === toDel.value, delCall ? JSON.stringify(delCall.body) : '');

  /* 9. 对齐模板 */
  calls.length = 0;
  mockMode = 'align';
  await app.alignMainTemplate();
  const alignCall = calls.find((c) => /\/api\/main-rules\/align$/.test(c.url));
  check('发出了 align 请求', !!alignCall, JSON.stringify(calls.map((c) => c.url)));

  console.log('\n' + (failures === 0 ? '全部通过' : '失败 ' + failures + ' 项') + '（共 ' + checks + ' 项）');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
