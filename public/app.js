'use strict';

/* =========================================================================
 * mihomo 规则管理 · 前端逻辑
 * 纯原生 JavaScript，零外部依赖，所有接口与页面同源。
 *
 * 两个视图（各自独立的搜索 / 筛选 / 分页状态）：
 *   - custom：自定义规则（rule-provider 外置文件，改完需「应用并重载」）
 *   - main  ：主配置内置规则（直接改主配置，保存/删除立即备份并重载）
 *
 * 代码分区：
 *   1. 工具函数
 *   2. API 请求层
 *   3. 应用状态
 *   4. 渲染（视图切换 / 自定义规则 / 主配置规则 / 统计）
 *   5. 弹窗（规则表单 / 主配置编辑 / 二次确认 / 备份）
 *   6. 业务动作（自定义规则增删改 / 主配置改删对齐 / 应用 / 回滚）
 *   7. 事件绑定
 *   8. 初始化
 * ========================================================================= */

/* ==================== 1. 工具函数 ==================== */

const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML 转义：规则值、备注等来自配置文件，不能直接拼进 innerHTML */
function esc(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch]);
}

function $(selector, root) {
  return (root || document).querySelector(selector);
}

/** 备份文件大小 */
function formatSize(bytes) {
  if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

/** 时间展示：兼容 ISO 带时区与 "YYYY-MM-DD HH:mm:ss" */
function formatTime(text) {
  if (!text) return '—';
  const date = new Date(text);
  if (isNaN(date.getTime())) return String(text);
  const pad = (n) => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

/** 从当前 state 中查找自定义规则 */
function findRule(id) {
  const rules = state.data && Array.isArray(state.data.rules) ? state.data.rules : [];
  for (let i = 0; i < rules.length; i += 1) {
    if (rules[i].id === id) return rules[i];
  }
  return null;
}

/** 按索引查找主配置规则（GET /api/main-rules 返回的 i 是数组下标） */
function findMainRule(index) {
  const rules = state.main.rules;
  for (let i = 0; i < rules.length; i += 1) {
    if (rules[i].i === index) return rules[i];
  }
  return null;
}

/** 按名称查找策略组（用于 target 的 1x / 2x 映射提示） */
function groupByName(name) {
  const groups = state.data && Array.isArray(state.data.groups) ? state.data.groups : [];
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i].name === name) return groups[i];
  }
  return null;
}

/** 规则类型定义（GET /api/rule-types） */
function getTypeDef(type) {
  return state.typeMap.get(type) || null;
}

/** 合并后的规则类型列表：后端类型定义 + 规则里出现的未知类型（容错） */
function allTypeDefs() {
  return state.typeDefs;
}

/** 把主配置规则总数同步到 state.meta，保证顶部/信息条/标签页数字一致 */
function syncMainTotalToMeta() {
  if (state.data && state.data.meta && typeof state.main.total === 'number') {
    state.data.meta.mainRuleCount = state.main.total;
  }
}

/* ==================== 2. API 请求层 ==================== */

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status || 0;
  }
}

/**
 * 统一请求封装：
 * - 自动 JSON 序列化 / 反序列化
 * - 非 2xx 时读取 body.error 作为中文错误信息
 * - 网络异常转换为 ApiError
 */
async function request(path, options) {
  const opts = options || {};
  const fetchOptions = {
    method: opts.method || 'GET',
    headers: { Accept: 'application/json' },
  };
  if (opts.body !== undefined) {
    fetchOptions.headers['Content-Type'] = 'application/json';
    fetchOptions.body = JSON.stringify(opts.body);
  }

  let res;
  try {
    res = await fetch(path, fetchOptions);
  } catch (err) {
    throw new ApiError('网络请求失败，请确认规则服务正在运行', 0);
  }

  let data = null;
  let text = '';
  try {
    text = await res.text();
  } catch (err) {
    text = '';
  }
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = null;
    }
  }

  if (!res.ok) {
    const message = (data && data.error) || '请求失败（HTTP ' + res.status + '）';
    throw new ApiError(message, res.status);
  }
  // 后端约定失败走 4xx/5xx；这里再兜底检查 ok:false
  if (data && data.ok === false) {
    throw new ApiError(data.error || '操作失败', res.status);
  }
  if (data === null) {
    throw new ApiError('服务返回了无法解析的数据', res.status);
  }
  return data;
}

/* ==================== 3. 应用状态 ==================== */

const state = {
  data: null,          // GET /api/state 的最近结果
  typeDefs: [],        // 规则类型定义
  typeMap: new Map(),  // type => 定义
  filter: { search: '', target: '', type: '' },  // 自定义规则视图的筛选
  editingId: null,     // 正在编辑的自定义规则 id；null 表示新增
  applying: false,     // 「应用并重载」进行中
  loading: true,       // 首屏加载中
  error: '',           // 首屏加载错误
  confirmResolver: null,
  view: 'custom',      // 'custom' | 'main'
  main: {
    loaded: false,     // 是否已成功拉取过主配置规则
    loading: false,
    error: '',
    total: 0,          // 服务端返回的主配置规则总数
    aligned: true,     // 主配置与部署模板是否对齐
    templatePath: '',
    templateError: '',
    rules: [],         // [{ i, type, value, target, noResolve, line }]
    filter: { search: '', target: '', type: '' },  // 主配置视图的独立筛选
    page: 1,
    pageSize: 50,
    editingIndex: null,  // 正在编辑的主配置规则索引
    mutating: false,     // 主配置保存 / 删除 / 对齐进行中
    saving: false,       // 主配置编辑弹窗提交中
    deletingIndex: null, // 正在删除的主配置规则索引（行内 loading）
  },
};

const els = {};
const openModals = [];

/** 用服务端返回的 state 覆盖本地状态，并补齐缺省字段 */
function applyState(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const meta = data.meta && typeof data.meta === 'object' ? data.meta : {};
  state.data = {
    meta: {
      configPath: '',
      customFile: '',
      lastApply: null,
      pending: false,
      mainRuleCount: 0,
      installed: true,
      ...meta,
    },
    groups: Array.isArray(data.groups) ? data.groups : [],
    rules: Array.isArray(data.rules) ? data.rules : [],
    stats: data.stats && typeof data.stats === 'object'
      ? data.stats
      : { total: 0, enabled: 0, byTarget: {} },
    backupCount: typeof data.backupCount === 'number' ? data.backupCount : 0,
  };
  state.error = '';
}

/** 记录规则类型定义（GET /api/rule-types） */
function applyTypes(raw) {
  const types = raw && Array.isArray(raw.types) ? raw.types : [];
  state.typeDefs = types
    .filter((t) => t && typeof t.type === 'string' && t.type)
    .map((t) => ({
      type: t.type,
      label: typeof t.label === 'string' && t.label ? t.label : t.type,
      valueHint: typeof t.valueHint === 'string' ? t.valueHint : '',
      noResolve: !!t.noResolve,
    }));
  refreshTypeMap();
}

/**
 * 重建 typeMap：后端类型定义 + 自定义规则里出现的未知类型（容错）。
 * 注意不要合并主配置规则的类型：主配置里有 MATCH 等 store 不支持的写入类型，
 * 合并后会让「自定义规则 → 新增」的类型下拉出现不能保存的选项。
 */
function refreshTypeMap() {
  const defs = state.typeDefs.slice();
  const known = new Set(defs.map((d) => d.type));
  const customRules = state.data && Array.isArray(state.data.rules) ? state.data.rules : [];
  for (let i = 0; i < customRules.length; i += 1) {
    const type = customRules[i].type;
    if (type && !known.has(type)) {
      known.add(type);
      defs.push({ type: type, label: type, valueHint: '', noResolve: false });
    }
  }
  state.typeDefs = defs;
  state.typeMap = new Map(defs.map((d) => [d.type, d]));
}

/** 主配置里允许出现、但 /api/rule-types 不返回的类型，补一个展示用中文名 */
const MAIN_EXTRA_TYPE_LABELS = { MATCH: '兜底规则' };

/** 主配置规则的展示类型定义（仅用于显示，不进入自定义规则的类型下拉） */
function mainTypeDef(type) {
  const def = getTypeDef(type);
  if (def) return def;
  return {
    type: type,
    label: MAIN_EXTRA_TYPE_LABELS[type] || type,
    valueHint: '',
    noResolve: false,
  };
}

/* ==================== 4. 渲染 ==================== */

/** 自定义规则视图：当前筛选条件过滤后的规则 */
function getFilteredRules() {
  const rules = state.data && Array.isArray(state.data.rules) ? state.data.rules : [];
  const search = state.filter.search.trim().toLowerCase();
  const target = state.filter.target;
  const type = state.filter.type;
  return rules.filter((rule) => {
    if (target && rule.target !== target) return false;
    if (type && rule.type !== type) return false;
    if (!search) return true;
    const def = getTypeDef(rule.type);
    const haystack = [
      rule.value,
      rule.desc,
      rule.target,
      rule.type,
      def ? def.label : '',
    ].join('\n').toLowerCase();
    return haystack.indexOf(search) !== -1;
  });
}

/** 渲染全部界面（自定义视图始终渲染；主配置视图仅在激活时渲染） */
function renderAll() {
  refreshTypeMap();
  renderMeta();
  renderFilters();
  renderTable();
  renderStats();
  renderTabs();
  if (state.view === 'main') renderMainView();
}

/** 视图切换：标签状态 + 视图显隐 + 主配置按需加载 */
function renderTabs() {
  const customCount = state.data && state.data.stats && typeof state.data.stats.total === 'number'
    ? state.data.stats.total
    : null;
  const metaMainCount = state.data && state.data.meta && typeof state.data.meta.mainRuleCount === 'number'
    ? state.data.meta.mainRuleCount
    : null;
  const mainCount = state.main.loaded && typeof state.main.total === 'number'
    ? state.main.total
    : metaMainCount;

  els.tabCustomCount.textContent = '(' + (customCount === null ? '—' : customCount) + ')';
  els.tabMainCount.textContent = '(' + (mainCount === null ? '—' : mainCount) + ')';

  const isMain = state.view === 'main';
  els.tabCustom.classList.toggle('is-active', !isMain);
  els.tabMain.classList.toggle('is-active', isMain);
  els.tabCustom.setAttribute('aria-selected', String(!isMain));
  els.tabMain.setAttribute('aria-selected', String(isMain));
  els.viewCustom.hidden = isMain;
  els.viewMain.hidden = !isMain;
}

/** 切换视图（主配置数据懒加载，避免首屏多拉 700KB） */
function switchView(view) {
  if (view !== 'custom' && view !== 'main') return;
  if (state.view === view) return;
  state.view = view;
  renderTabs();
  if (view === 'main') {
    if (!state.main.loaded && !state.main.loading) loadMainRules();
    else renderMainView();
  } else {
    renderMeta();
    renderTabs();
  }
}

/** 自定义规则：顶部信息栏 + 待应用徽标 + 按钮状态 */
function renderMeta() {
  const data = state.data;

  if (!data) {
    els.brandSub.textContent = state.error ? '加载失败，请点击「刷新」重试' : '正在加载运行信息…';
    els.pendingBadge.hidden = true;
    els.installedWarning.hidden = true;
    els.btnBackups.textContent = '💾 备份';
    els.metaStrip.innerHTML =
      '<div class="meta-item"><span class="meta-label">状态</span>' +
      '<span class="meta-value ' + (state.error ? 'warn' : '') + '">' +
      (state.error ? '加载失败' : '加载中…') + '</span></div>';
    updateApplyButton();
    return;
  }

  const meta = data.meta;
  const stats = data.stats;
  const backupCount = data.backupCount;

  els.brandSub.textContent = '自定义分流规则 · 共 ' + (stats.total || 0) + ' 条 · 主配置内置规则 ' +
    (meta.mainRuleCount || 0) + ' 条';
  els.pendingBadge.hidden = !meta.pending;
  els.installedWarning.hidden = meta.installed !== false;
  // 数据目录不可用是硬阻塞：必须显眼提示，否则用户只会看到「新增失败」的 toast
  if (els.dataError) {
    const fatal = meta.dataDirOk === false ? meta.error || '自定义规则目录不可用' : '';
    els.dataError.hidden = !fatal;
    els.dataErrorText.textContent = fatal;
  }
  els.btnBackups.textContent = backupCount > 0 ? '💾 备份 (' + backupCount + ')' : '💾 备份';

  const items = [
    ['主配置', meta.configPath || '—', 'mono'],
    ['自定义规则文件', meta.customFile || '—', 'mono'],
    ['主配置规则', (meta.mainRuleCount || 0) + ' 条', ''],
    ['最后应用', meta.lastApply ? formatTime(meta.lastApply) : '尚未应用', meta.lastApply ? '' : 'warn'],
    ['规则提供者', meta.installed === false ? '未安装' : '已安装', meta.installed === false ? 'warn' : 'ok'],
    ['备份数量', backupCount + ' 个', ''],
  ];
  els.metaStrip.innerHTML = items.map((item) => {
    return '<div class="meta-item">' +
      '<span class="meta-label">' + item[0] + '</span>' +
      '<span class="meta-value ' + item[2] + '" title="' + esc(item[1]) + '">' + esc(item[1]) + '</span>' +
      '</div>';
  }).join('');

  updateApplyButton();
}

/** 「应用并重载」按钮可用性 */
function updateApplyButton() {
  const meta = state.data ? state.data.meta : null;
  const pending = !!(meta && meta.pending);
  els.btnApply.disabled = !pending || state.applying;
  els.btnApply.textContent = state.applying ? '⚡ 应用中…' : '⚡ 应用并重载';
  els.btnApply.title = pending
    ? '把自定义规则写入主配置并重载 mihomo'
    : '当前没有未应用的改动';
}

/** 自定义规则：目标 / 类型筛选下拉 */
function renderFilters() {
  const data = state.data;
  const groups = data && Array.isArray(data.groups) ? data.groups : [];
  const rules = data && Array.isArray(data.rules) ? data.rules : [];

  // 目标下拉：后端策略组顺序 + 规则里出现过但不在策略组中的目标
  const targetNames = [];
  const seenTargets = new Set();
  groups.forEach((g) => {
    if (g && g.name && !seenTargets.has(g.name)) {
      seenTargets.add(g.name);
      targetNames.push(g.name);
    }
  });
  rules.forEach((r) => {
    if (r && r.target && !seenTargets.has(r.target)) {
      seenTargets.add(r.target);
      targetNames.push(r.target);
    }
  });
  if (state.filter.target && !seenTargets.has(state.filter.target)) state.filter.target = '';
  els.filterTarget.innerHTML = '<option value="">全部目标</option>' +
    targetNames.map((name) => '<option value="' + esc(name) + '">' + esc(name) + '</option>').join('');
  els.filterTarget.value = state.filter.target;

  // 类型下拉：来自 /api/rule-types
  const defs = allTypeDefs();
  const seenTypes = new Set(defs.map((d) => d.type));
  if (state.filter.type && !seenTypes.has(state.filter.type)) state.filter.type = '';
  els.filterType.innerHTML = '<option value="">全部类型</option>' +
    defs.map((d) => '<option value="' + esc(d.type) + '">' + esc(d.label) + '（' + esc(d.type) + '）</option>').join('');
  els.filterType.value = state.filter.type;
}

/** 自定义规则：单行表格 HTML（桌面为表格行，手机端由 CSS 转为卡片） */
function ruleRowHtml(rule, index) {
  const def = getTypeDef(rule.type);
  const typeLabel = def ? def.label : rule.type;
  const group = groupByName(rule.target);
  const isBuiltin = !!(group && group.builtin);
  const targetTip = group
    ? 'Mihomo 策略「' + group.name + '」：1x 出口 → ' + group.name1x + '；2x 出口 → ' + group.name2x
    : '该目标不在当前策略列表中（可能已被从配置里删除）';
  const desc = rule.desc || '';

  return '<tr class="rule-row' + (rule.enabled ? '' : ' row-disabled') + '" data-id="' + esc(rule.id) + '">' +
    '<td class="col-idx" data-label="#">' + (index + 1) + '</td>' +
    '<td data-label="类型"><span class="type-cell">' +
      '<span class="type-label">' + esc(typeLabel) + '</span>' +
      '<span class="type-raw mono">' + esc(rule.type) + '</span>' +
    '</span></td>' +
    '<td data-label="值"><code class="rule-value" title="' + esc(rule.value) + '">' + esc(rule.value) + '</code></td>' +
    '<td data-label="目标">' +
      '<span class="target-badge' + (isBuiltin ? ' builtin' : '') + '" title="' + esc(targetTip) + '">' + esc(rule.target) + '</span>' +
    '</td>' +
    '<td class="col-desc" data-label="备注"><span class="rule-desc" title="' + esc(desc) + '">' + esc(desc || '—') + '</span></td>' +
    '<td data-label="状态">' +
      '<label class="switch" title="启用或停用该规则">' +
        '<input type="checkbox" data-action="toggle" data-id="' + esc(rule.id) + '"' + (rule.enabled ? ' checked' : '') + '>' +
        '<span class="switch-track"></span>' +
      '</label>' +
    '</td>' +
    '<td class="col-actions" data-label="操作">' +
      '<button type="button" class="icon-btn" data-action="edit" data-id="' + esc(rule.id) + '" title="编辑" aria-label="编辑规则">✎</button>' +
      '<button type="button" class="icon-btn danger" data-action="delete" data-id="' + esc(rule.id) + '" title="删除" aria-label="删除规则">🗑</button>' +
    '</td>' +
  '</tr>';
}

/** 自定义规则：表格主体 + 空状态 / 加载 / 错误提示 */
function renderTable() {
  const rules = state.data && Array.isArray(state.data.rules) ? state.data.rules : [];
  const filtered = getFilteredRules();
  els.rulesBody.innerHTML = filtered.map(ruleRowHtml).join('');
  renderTableState(rules.length, filtered.length);
}

function renderTableState(total, filteredCount) {
  if (state.loading) {
    els.tableState.hidden = false;
    els.tableScroll.hidden = true;
    els.tableState.innerHTML = '<div class="state-inline"><span class="spinner" aria-hidden="true"></span><span>正在加载规则…</span></div>';
    return;
  }
  if (state.error) {
    els.tableState.hidden = false;
    els.tableScroll.hidden = true;
    els.tableState.innerHTML = '<div class="state-inline error">' +
      '<span>⚠ 加载失败：' + esc(state.error) + '</span>' +
      '<button type="button" class="btn btn-ghost btn-small" data-action="retry">重试</button>' +
      '</div>';
    return;
  }
  if (!total) {
    els.tableState.hidden = false;
    els.tableScroll.hidden = true;
    els.tableState.innerHTML = '<div class="empty-state">' +
      '<div class="empty-icon" aria-hidden="true">📋</div>' +
      '<p class="empty-title">还没有自定义规则</p>' +
      '<p class="empty-desc">点击「新增规则」添加第一条分流规则。保存后需要点击「<span class="nowrap">应用并重载</span>」，规则才会写入主配置并生效。</p>' +
      '<button type="button" class="btn btn-primary" data-action="add">＋ 新增规则</button>' +
      '</div>';
    return;
  }
  if (!filteredCount) {
    els.tableState.hidden = false;
    els.tableScroll.hidden = true;
    els.tableState.innerHTML = '<div class="empty-state">' +
      '<div class="empty-icon" aria-hidden="true">🔍</div>' +
      '<p class="empty-title">没有匹配的规则</p>' +
      '<p class="empty-desc">当前搜索或筛选条件下没有结果，试试调整条件。</p>' +
      '<button type="button" class="btn btn-ghost" data-action="clear-filters">清除筛选条件</button>' +
      '</div>';
    return;
  }
  els.tableState.hidden = true;
  els.tableScroll.hidden = false;
}

/** 自定义规则：底部统计 */
function renderStats() {
  const data = state.data;
  if (!data) {
    els.stats.innerHTML = '<span class="stats-empty">暂无统计数据</span>';
    return;
  }
  const stats = data.stats;
  const total = stats.total || 0;
  const enabled = stats.enabled || 0;
  const disabled = Math.max(0, total - enabled);
  const byTarget = stats.byTarget && typeof stats.byTarget === 'object' ? stats.byTarget : {};
  const entries = Object.keys(byTarget)
    .map((name) => [name, byTarget[name]])
    .filter((pair) => typeof pair[1] === 'number' && pair[1] > 0)
    .sort((a, b) => b[1] - a[1]);

  const chips = entries.length
    ? entries.map((pair) => {
      const group = groupByName(pair[0]);
      const tip = group ? '1x 出口 → ' + group.name1x + ' · 2x 出口 → ' + group.name2x : '';
      return '<span class="stat-chip" title="' + esc(tip) + '">' +
        '<span class="stat-dot" aria-hidden="true"></span>' + esc(pair[0]) +
        '<b>' + pair[1] + '</b></span>';
    }).join('')
    : '<span class="stats-empty">暂无已启用的规则</span>';

  els.stats.innerHTML = '<div class="stats-counts">' +
      '<span class="stat"><span class="stat-num">' + total + '</span><span class="stat-label">自定义规则</span></span>' +
      '<span class="stat"><span class="stat-num ok">' + enabled + '</span><span class="stat-label">已启用</span></span>' +
      '<span class="stat"><span class="stat-num dim">' + disabled + '</span><span class="stat-label">已停用</span></span>' +
    '</div>' +
    '<div class="stats-targets"><span class="stats-caption">按目标分布</span>' + chips + '</div>';
}

/* ---------------- 4.1 主配置规则视图 ---------------- */

/** 主配置规则：筛选后的列表 */
function getFilteredMainRules() {
  const rules = state.main.rules;
  const filter = state.main.filter;
  const search = filter.search.trim().toLowerCase();
  const target = filter.target;
  const type = filter.type;
  if (!search && !target && !type) return rules;
  return rules.filter((rule) => {
    if (target && rule.target !== target) return false;
    if (type && rule.type !== type) return false;
    if (!search) return true;
    const def = getTypeDef(rule.type);
    const haystack = [
      rule.value,
      rule.target,
      rule.type,
      def ? def.label : '',
    ].join('\n').toLowerCase();
    return haystack.indexOf(search) !== -1;
  });
}

/** 主配置规则：当前分页信息 */
function mainPageInfo() {
  const filtered = getFilteredMainRules();
  const pageSize = state.main.pageSize;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(Math.max(1, state.main.page), totalPages);
  const start = (page - 1) * pageSize;
  return {
    filtered: filtered,
    page: page,
    totalPages: totalPages,
    pageRules: filtered.slice(start, start + pageSize),
  };
}

/** 主配置规则：渲染整个视图（横幅 / 筛选 / 表格 / 分页） */
function renderMainView() {
  renderMainBanners();
  renderMainFilters();
  renderMainTable();
  els.mainPagination.hidden = !state.main.loaded || !!state.main.error || state.main.loading;
}

/** 主配置规则：高危横幅 + 对齐提示 */
function renderMainBanners() {
  const metaMainCount = state.data && state.data.meta ? state.data.meta.mainRuleCount : 0;
  const total = state.main.total || metaMainCount || 0;
  els.mainRiskText.textContent = '这里直接修改 mihomo 主配置（' + total +
    ' 条），每次保存会自动备份并重载。只是想改变某个域名的走向，优先用『自定义规则』覆盖，更安全也可随时撤销。';
  if (state.main.templatePath) els.mainRiskBanner.title = '部署模板：' + state.main.templatePath;

  const misaligned = state.main.loaded && state.main.aligned === false;
  els.mainAlignBanner.hidden = !misaligned;
  if (misaligned) {
    const parts = ['主配置与部署模板不一致（aligned=false）'];
    if (state.main.templatePath) parts.push('模板：' + state.main.templatePath);
    if (state.main.templateError) parts.push('读取模板失败：' + state.main.templateError);
    parts.push('直接修改可能覆盖模板结构，建议先「对齐模板」。');
    els.mainAlignText.textContent = parts.join('；');
  }
}

/** 主配置规则：目标 / 类型筛选下拉（各自独立于自定义视图） */
function renderMainFilters() {
  const groups = state.data && Array.isArray(state.data.groups) ? state.data.groups : [];
  const rules = state.main.rules;

  const targetNames = [];
  const seenTargets = new Set();
  groups.forEach((g) => {
    if (g && g.name && !seenTargets.has(g.name)) {
      seenTargets.add(g.name);
      targetNames.push(g.name);
    }
  });
  rules.forEach((r) => {
    if (r && r.target && !seenTargets.has(r.target)) {
      seenTargets.add(r.target);
      targetNames.push(r.target);
    }
  });
  if (state.main.filter.target && !seenTargets.has(state.main.filter.target)) state.main.filter.target = '';
  els.mainFilterTarget.innerHTML = '<option value="">全部目标</option>' +
    targetNames.map((name) => '<option value="' + esc(name) + '">' + esc(name) + '</option>').join('');
  els.mainFilterTarget.value = state.main.filter.target;

  const types = [];
  const seenTypes = new Set();
  rules.forEach((r) => {
    if (r && r.type && !seenTypes.has(r.type)) {
      seenTypes.add(r.type);
      types.push(r.type);
    }
  });
  if (state.main.filter.type && !seenTypes.has(state.main.filter.type)) state.main.filter.type = '';
  els.mainFilterType.innerHTML = '<option value="">全部类型</option>' +
    types.map((type) => {
      const def = mainTypeDef(type);
      const text = def.label !== type ? def.label + '（' + type + '）' : type;
      return '<option value="' + esc(type) + '">' + esc(text) + '</option>';
    }).join('');
  els.mainFilterType.value = state.main.filter.type;
}

/** 主配置规则：单行 HTML */
function mainRuleRowHtml(rule) {
  const def = mainTypeDef(rule.type);
  const typeLabel = def.label;
  const group = groupByName(rule.target);
  const isBuiltin = !group || group.builtin;
  const targetTip = group
    ? 'Mihomo 策略「' + group.name + '」：1x 出口 → ' + group.name1x + '；2x 出口 → ' + group.name2x
    : '内置策略，或不在当前代理组列表中的目标';
  const deleting = state.main.deletingIndex === rule.i;
  const busy = state.main.mutating || deleting;
  const valueHtml = rule.value
    ? '<code class="rule-value" title="' + esc(rule.value) + '">' + esc(rule.value) + '</code>'
    : '<span class="rule-desc">—</span>';
  const indexTitle = rule.line ? '主配置第 ' + rule.line + ' 行' : '主配置规则索引 ' + rule.i;

  return '<tr class="rule-row main-rule-row' + (deleting ? ' row-busy' : '') + '" data-i="' + rule.i + '">' +
    '<td class="col-idx" data-label="#" title="' + esc(indexTitle) + '">' + (rule.i + 1) + '</td>' +
    '<td data-label="类型"><span class="type-cell">' +
      '<span class="type-label">' + esc(typeLabel) + '</span>' +
      (typeLabel !== rule.type ? '<span class="type-raw mono">' + esc(rule.type) + '</span>' : '') +
    '</span></td>' +
    '<td data-label="值">' + valueHtml + '</td>' +
    '<td data-label="目标"><span class="target-badge' + (isBuiltin ? ' builtin' : '') + '" title="' + esc(targetTip) + '">' + esc(rule.target) + '</span></td>' +
    '<td class="col-actions" data-label="操作">' +
      '<button type="button" class="icon-btn" data-action="main-edit" data-i="' + rule.i + '" title="编辑（直接写入主配置）" aria-label="编辑主配置规则"' + (busy ? ' disabled' : '') + '>✎</button>' +
      '<button type="button" class="icon-btn danger" data-action="main-delete" data-i="' + rule.i + '" title="删除（立即备份并重载）" aria-label="删除主配置规则"' + (busy ? ' disabled' : '') + '>' +
        (deleting ? '<span class="spinner spinner-sm" aria-hidden="true"></span>' : '🗑') +
      '</button>' +
    '</td>' +
  '</tr>';
}

/** 主配置规则：表格 + 分页 + 空/加载/错误状态 */
function renderMainTable() {
  const info = mainPageInfo();
  state.main.page = info.page;
  els.mainRulesBody.innerHTML = info.pageRules.map(mainRuleRowHtml).join('');

  els.mainCount.textContent = '共 ' + (state.main.total || 0) + ' 条，筛选后 ' + info.filtered.length + ' 条';
  els.mainPageIndicator.textContent = '第 ' + info.page + '/' + info.totalPages + ' 页';
  els.mainPrev.disabled = info.page <= 1;
  els.mainNext.disabled = info.page >= info.totalPages;

  renderMainTableState(info);
}

function renderMainTableState(info) {
  if (state.main.loading) {
    els.mainTableState.hidden = false;
    els.mainTableScroll.hidden = true;
    els.mainTableState.innerHTML = '<div class="state-inline"><span class="spinner" aria-hidden="true"></span><span>正在加载主配置规则（约 700 KB）…</span></div>';
    return;
  }
  if (state.main.error) {
    els.mainTableState.hidden = false;
    els.mainTableScroll.hidden = true;
    els.mainTableState.innerHTML = '<div class="state-inline error">' +
      '<span>⚠ 加载失败：' + esc(state.main.error) + '</span>' +
      '<button type="button" class="btn btn-ghost btn-small" data-action="main-retry">重试</button>' +
      '</div>';
    return;
  }
  if (!state.main.loaded) {
    els.mainTableState.hidden = false;
    els.mainTableScroll.hidden = true;
    els.mainTableState.innerHTML = '<div class="state-inline">正在准备主配置规则…</div>';
    return;
  }
  if (!state.main.rules.length) {
    els.mainTableState.hidden = false;
    els.mainTableScroll.hidden = true;
    els.mainTableState.innerHTML = '<div class="empty-state">' +
      '<div class="empty-icon" aria-hidden="true">📄</div>' +
      '<p class="empty-title">主配置里没有可编辑的规则</p>' +
      '<p class="empty-desc">没有从主配置中解析到内置规则，请检查主配置的 rules 段。</p>' +
      '</div>';
    return;
  }
  if (!info.filtered.length) {
    els.mainTableState.hidden = false;
    els.mainTableScroll.hidden = true;
    els.mainTableState.innerHTML = '<div class="empty-state">' +
      '<div class="empty-icon" aria-hidden="true">🔍</div>' +
      '<p class="empty-title">没有匹配的内置规则</p>' +
      '<p class="empty-desc">当前搜索或筛选条件下没有结果，试试调整条件。</p>' +
      '<button type="button" class="btn btn-ghost" data-action="main-clear-filters">清除筛选条件</button>' +
      '</div>';
    return;
  }
  els.mainTableState.hidden = true;
  els.mainTableScroll.hidden = false;
}

/** 主配置规则：加载全部规则（一次约 700KB，前端内存里过滤 + 分页） */
async function loadMainRules(options) {
  const opts = options || {};
  if (state.main.loading) return;
  state.main.loading = true;
  state.main.error = '';
  renderMainView();

  try {
    const res = await request('/api/main-rules');
    const rawRules = Array.isArray(res.rules) ? res.rules : [];
    state.main.rules = rawRules.map((rule, idx) => {
      return {
        i: typeof rule.i === 'number' ? rule.i : idx,
        type: typeof rule.type === 'string' ? rule.type : '',
        value: typeof rule.value === 'string' ? rule.value : (rule.value === null || rule.value === undefined ? '' : String(rule.value)),
        target: typeof rule.target === 'string' ? rule.target : '',
        noResolve: !!rule.noResolve,
        line: typeof rule.line === 'number' ? rule.line : null,
      };
    }).sort((a, b) => a.i - b.i);
    state.main.total = typeof res.total === 'number' ? res.total : state.main.rules.length;
    state.main.aligned = res.aligned !== false;
    state.main.templatePath = typeof res.templatePath === 'string' ? res.templatePath : '';
    state.main.templateError = typeof res.templateError === 'string' ? res.templateError : '';
    state.main.loaded = true;
    state.main.loading = false;
    state.main.error = '';
    state.main.page = 1;
    syncMainTotalToMeta();
    refreshTypeMap();
    renderMeta();
    renderTabs();
    renderMainView();
    if (opts.showSuccessToast) {
      toast('主配置规则已刷新（共 ' + state.main.total + ' 条）', 'success', 2000);
    }
  } catch (err) {
    state.main.loading = false;
    state.main.error = err && err.message ? err.message : '无法读取主配置规则';
    renderMainView();
    renderTabs();
    toast('主配置规则加载失败：' + state.main.error, 'error', 5000);
  }
}

/** 主配置规则：清除全部筛选条件 */
function clearMainFilters() {
  state.main.filter = { search: '', target: '', type: '' };
  state.main.page = 1;
  els.mainSearchInput.value = '';
  els.mainFilterTarget.value = '';
  els.mainFilterType.value = '';
  renderMainTable();
}

/* ==================== 4.2 轻提示 Toast ==================== */

const TOAST_ICONS = { success: '✓', error: '✕', warn: '!', info: 'i' };

/**
 * 轻提示，统一提示所有错误（红色）
 * @param {string} message 文本
 * @param {'success'|'error'|'warn'|'info'} type 类型
 * @param {number} duration 自动消失毫秒数
 */
function toast(message, type, duration) {
  const kind = TOAST_ICONS[type] ? type : 'info';
  const el = document.createElement('div');
  el.className = 'toast toast-' + kind;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = '<span class="toast-icon" aria-hidden="true">' + TOAST_ICONS[kind] + '</span>' +
    '<span class="toast-text">' + esc(message) + '</span>';
  els.toastRoot.appendChild(el);
  requestAnimationFrame(function () {
    el.classList.add('show');
  });

  let removed = false;
  function remove() {
    if (removed) return;
    removed = true;
    el.classList.remove('show');
    setTimeout(function () {
      el.remove();
    }, 220);
  }
  const timer = setTimeout(remove, duration || 3400);
  el.addEventListener('click', function () {
    clearTimeout(timer);
    remove();
  });

  // 最多保留 5 条，避免刷屏
  while (els.toastRoot.children.length > 5) {
    els.toastRoot.firstElementChild.remove();
  }
}

/* ==================== 5. 弹窗 ==================== */

function showModal(el) {
  if (!el.hidden) return;
  el.hidden = false;
  openModals.push(el);
  document.body.classList.add('modal-open');
  requestAnimationFrame(function () {
    el.classList.add('show');
  });
}

function hideModal(el) {
  if (!el || el.hidden) return;
  el.classList.remove('show');
  el.hidden = true;
  const index = openModals.indexOf(el);
  if (index >= 0) openModals.splice(index, 1);
  if (!openModals.length) document.body.classList.remove('modal-open');
}

/* ---------- 5.1 目标策略下拉（两个弹窗共用） ---------- */

/**
 * 生成目标策略下拉的 HTML：optgroup 区分「内置策略」和「策略组」
 * @param {string[]} extraNames 不在 groups 里、但需要保留的当前目标
 */
function targetSelectHtml(extraNames) {
  const groups = state.data && Array.isArray(state.data.groups) ? state.data.groups : [];
  const builtin = groups.filter(function (g) { return g && g.builtin; });
  const normal = groups.filter(function (g) { return g && !g.builtin; });
  const extras = Array.isArray(extraNames) ? extraNames : [];

  function option(name) {
    return '<option value="' + esc(name) + '">' + esc(name) + '</option>';
  }

  let html = '<option value="" disabled>请选择目标策略</option>';
  if (builtin.length) {
    html += '<optgroup label="内置策略">' + builtin.map(function (g) { return option(g.name); }).join('') + '</optgroup>';
  }
  if (normal.length) {
    html += '<optgroup label="策略组">' + normal.map(function (g) { return option(g.name); }).join('') + '</optgroup>';
  }
  if (extras.length) {
    html += '<optgroup label="其他（当前规则使用）">' + extras.map(option).join('') + '</optgroup>';
  }
  return html;
}

/* ---------- 5.2 自定义规则表单弹窗 ---------- */

/** 构建自定义规则类型下拉 */
function buildTypeOptions() {
  const defs = allTypeDefs();
  els.fType.innerHTML = defs.map(function (def) {
    return '<option value="' + esc(def.type) + '">' + esc(def.label) + '（' + esc(def.type) + '）</option>';
  }).join('');
}

/** 构建自定义规则目标下拉 */
function buildTargetOptions(selected) {
  const data = state.data || { groups: [], rules: [] };
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const rules = Array.isArray(data.rules) ? data.rules : [];
  const known = new Set(groups.map(function (g) { return g.name; }));
  const extra = [];
  rules.forEach(function (rule) {
    if (rule && rule.target && !known.has(rule.target)) {
      known.add(rule.target);
      extra.push(rule.target);
    }
  });
  els.fTarget.innerHTML = targetSelectHtml(extra);
  els.fTarget.value = selected || '';
  updateTargetHint();
}

/** 目标下拉下方的 1x / 2x 映射说明 */
function updateTargetHint() {
  const name = els.fTarget.value;
  const group = name ? groupByName(name) : null;
  if (!group) {
    els.targetHint.textContent = '选择目标后，这里会显示该策略在 1x / 2x 出口的映射关系。';
    return;
  }
  if (group.builtin) {
    els.targetHint.textContent = '内置策略，三个出口一致：' + group.name1x + ' / ' + group.name2x;
  } else {
    els.targetHint.textContent = '1x 出口 → ' + group.name1x + '；2x 出口 → ' + group.name2x +
      '（自动映射到 -1x / -2x，无需手写后缀）';
  }
}

/** 类型变化：更新占位符、示例、no-resolve 开关显隐 */
function syncTypeFields() {
  const def = getTypeDef(els.fType.value);
  els.fValue.placeholder = def && def.valueHint ? def.valueHint : '规则值，例如 example.com';
  els.valueHint.textContent = def && def.valueHint ? '格式示例：' + def.valueHint : '';
  els.typeHint.textContent = def
    ? '对应 mihomo 规则类型 ' + def.type + (def.noResolve ? '，支持 no-resolve' : '')
    : '未知类型';
  const showNoResolve = !!(def && def.noResolve);
  els.rowNoResolve.hidden = !showNoResolve;
  if (!showNoResolve) els.fNoResolve.checked = false;
}

function showFormError(message) {
  els.formError.textContent = message;
  els.formError.hidden = false;
}

function hideFormError() {
  els.formError.hidden = true;
  els.formError.textContent = '';
}

/** 打开自定义规则新增 / 编辑弹窗 */
function openRuleModal(rule) {
  if (!state.data) {
    toast('状态还没加载完成，请先点击「刷新」', 'warn');
    return;
  }
  const isEdit = !!rule;
  state.editingId = isEdit ? rule.id : null;
  els.ruleTitle.textContent = isEdit ? '编辑规则' : '新增规则';
  els.ruleSubmit.textContent = isEdit ? '保存修改' : '创建规则';
  hideFormError();

  buildTypeOptions();
  buildTargetOptions(isEdit ? rule.target : '');

  const initialType = isEdit ? rule.type : (allTypeDefs()[0] ? allTypeDefs()[0].type : '');
  els.fType.value = initialType;
  syncTypeFields();

  els.fValue.value = isEdit ? rule.value : '';
  els.fDesc.value = isEdit ? (rule.desc || '') : '';
  els.fEnabled.checked = isEdit ? !!rule.enabled : true;
  els.fNoResolve.checked = isEdit ? !!rule.noResolve : false;
  updateTargetHint();

  showModal(els.ruleModal);
  setTimeout(function () {
    (isEdit ? els.fValue : els.fType).focus();
  }, 30);
}

function closeRuleModal() {
  hideModal(els.ruleModal);
  state.editingId = null;
  hideFormError();
}

/* ---------- 5.3 主配置规则编辑弹窗 ---------- */

function showMainFormError(message) {
  els.mainFormError.textContent = message;
  els.mainFormError.hidden = false;
}

function hideMainFormError() {
  els.mainFormError.hidden = true;
  els.mainFormError.textContent = '';
}

/** 主配置编辑弹窗：目标下拉（groups + 当前目标兜底） */
function buildMainTargetOptions(selected) {
  const groups = state.data && Array.isArray(state.data.groups) ? state.data.groups : [];
  const known = new Set(groups.map(function (g) { return g.name; }));
  const extra = [];
  if (selected && !known.has(selected)) {
    known.add(selected);
    extra.push(selected);
  }
  state.main.rules.forEach(function (rule) {
    if (rule && rule.target && !known.has(rule.target)) {
      known.add(rule.target);
      extra.push(rule.target);
    }
  });
  els.mTarget.innerHTML = targetSelectHtml(extra);
  els.mTarget.value = selected || '';
}

/** 主配置编辑弹窗：1x / 2x 映射提示 */
function updateMainTargetHint() {
  const name = els.mTarget.value;
  const group = name ? groupByName(name) : null;
  if (!group) {
    els.mTargetHint.textContent = '该目标不在当前代理组列表中，保存可能被后端拒绝。';
    return;
  }
  if (group.builtin) {
    els.mTargetHint.textContent = '内置策略，三个出口一致：' + group.name1x + ' / ' + group.name2x;
  } else {
    els.mTargetHint.textContent = '1x 出口 → ' + group.name1x + '；2x 出口 → ' + group.name2x +
      '（保存时同时写入 1x / 2x 两份列表）';
  }
}

/** 打开主配置规则编辑弹窗 */
function openMainRuleModal(rule) {
  if (!state.data) {
    toast('状态还没加载完成，请稍后重试', 'warn');
    return;
  }
  if (state.main.mutating) return;

  state.main.editingIndex = rule.i;
  hideMainFormError();
  els.mainRuleTitle.textContent = '编辑主配置规则';
  els.mainRuleSubmit.textContent = '保存并重载';
  els.mainRuleSubmit.disabled = false;
  els.mainRuleCancel.disabled = false;
  els.mainRuleClose.disabled = false;

  const def = mainTypeDef(rule.type);
  els.mType.value = def.label !== rule.type ? def.label + '（' + rule.type + '）' : rule.type;
  els.mType.title = rule.type;
  els.mTypeHint.textContent = '类型固定，不可修改；主配置规则按索引修改。';

  const isMatch = rule.type === 'MATCH';
  els.mValue.value = isMatch ? '' : rule.value;
  els.mValue.disabled = isMatch;
  els.mValue.placeholder = isMatch ? 'MATCH 兜底规则没有值' : (def && def.valueHint ? def.valueHint : '规则值');
  els.mValueHint.textContent = isMatch
    ? 'MATCH 是兜底规则，没有匹配值，只能修改目标策略。'
    : '会同时写入主配置、1x、2x 三份列表；规则值不能为空，且不能包含英文逗号。';

  buildMainTargetOptions(rule.target);
  updateMainTargetHint();

  showModal(els.mainRuleModal);
  setTimeout(function () {
    (isMatch ? els.mTarget : els.mValue).focus();
  }, 30);
}

function closeMainRuleModal() {
  hideModal(els.mainRuleModal);
  state.main.editingIndex = null;
  hideMainFormError();
}

/* ---------- 5.4 二次确认弹窗 ---------- */

/**
 * 自定义确认框（Promise 化）
 * @returns {Promise<boolean>}
 */
function confirmDialog(options) {
  const opts = options || {};
  return new Promise(function (resolve) {
    if (state.confirmResolver) {
      const previous = state.confirmResolver;
      state.confirmResolver = null;
      previous(false);
    }
    els.confirmTitle.textContent = opts.title || '确认操作';
    els.confirmMessage.textContent = opts.message || '';
    els.confirmOk.textContent = opts.okText || '确定';
    els.confirmOk.className = opts.danger ? 'btn btn-danger' : 'btn btn-primary';
    state.confirmResolver = resolve;
    showModal(els.confirmModal);
    setTimeout(function () {
      els.confirmOk.focus();
    }, 30);
  });
}

function closeConfirm(result) {
  const resolve = state.confirmResolver;
  state.confirmResolver = null;
  hideModal(els.confirmModal);
  if (resolve) resolve(result);
}

/* ---------- 5.5 备份弹窗 ---------- */

async function openBackups() {
  showModal(els.backupsModal);
  await loadBackups();
}

async function loadBackups() {
  els.backupsList.innerHTML = '<p class="state-inline"><span class="spinner" aria-hidden="true"></span><span>正在加载备份列表…</span></p>';
  try {
    const res = await request('/api/backups');
    renderBackups(Array.isArray(res.backups) ? res.backups : []);
  } catch (err) {
    els.backupsList.innerHTML = '<p class="state-inline error">⚠ 备份列表加载失败：' + esc(err.message) + '</p>';
    toast(err.message, 'error');
  }
}

function renderBackups(backups) {
  if (!backups.length) {
    els.backupsList.innerHTML = '<p class="state-inline">暂无备份记录</p>';
    return;
  }
  const kindLabels = { config: '主配置', custom: '自定义规则', rules: '自定义规则', template: '部署模板' };
  els.backupsList.innerHTML = backups.map(function (backup) {
    const id = String(backup && backup.id ? backup.id : '');
    const tsText = formatTime(backup && backup.ts ? backup.ts : id);
    const kind = (backup && backup.kind) || 'config';
    const kindLabel = kindLabels[kind] || kind;
    return '<div class="backup-item">' +
      '<div class="backup-main">' +
        '<span class="backup-ts">' + esc(tsText) + '</span>' +
        '<span class="backup-sub">' + esc(kindLabel) + ' · ' + esc(formatSize(backup && backup.size)) + ' · ' + esc(id) + '</span>' +
      '</div>' +
      '<button type="button" class="btn btn-small btn-danger-ghost" data-action="restore" data-id="' + esc(id) + '" data-ts="' + esc(tsText) + '">回滚</button>' +
    '</div>';
  }).join('');
}

/* ==================== 6. 业务动作 ==================== */

/* ---------------- 6.1 自定义规则 ---------------- */

/** 手动刷新 GET /api/state */
async function refreshState(showSuccessToast) {
  if (els.btnRefresh.disabled) return;
  els.btnRefresh.disabled = true;
  els.btnRefresh.textContent = '↻ 刷新中…';
  try {
    const res = await request('/api/state');
    applyState(res);
    renderAll();
    if (showSuccessToast) toast('状态已刷新', 'success', 1800);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    els.btnRefresh.textContent = '↻ 刷新';
    els.btnRefresh.disabled = false;
  }
}

/** 首屏加载：同时拉取 state 与 rule-types */
async function loadInitial() {
  state.loading = true;
  state.error = '';
  renderAll();

  const results = await Promise.allSettled([request('/api/state'), request('/api/rule-types')]);
  const stateResult = results[0];
  const typesResult = results[1];

  if (typesResult.status === 'fulfilled') {
    applyTypes(typesResult.value);
  } else {
    toast('规则类型列表加载失败：' + (typesResult.reason && typesResult.reason.message ? typesResult.reason.message : '未知错误'), 'warn', 5000);
  }

  if (stateResult.status === 'fulfilled') {
    applyState(stateResult.value);
    state.loading = false;
    state.error = '';
    renderAll();
  } else {
    state.loading = false;
    state.error = stateResult.reason && stateResult.reason.message
      ? stateResult.reason.message
      : '无法读取规则状态';
    renderAll();
    toast('加载失败：' + state.error, 'error', 5000);
  }
}

/** 自定义规则：新增 / 编辑提交 */
async function submitRuleForm(event) {
  event.preventDefault();
  if (els.ruleSubmit.disabled) return;
  hideFormError();

  const type = els.fType.value;
  const value = els.fValue.value.trim();
  const target = els.fTarget.value;
  const def = getTypeDef(type);

  if (!type) {
    showFormError('请选择规则类型');
    els.fType.focus();
    return;
  }
  if (!value) {
    showFormError('规则值不能为空');
    els.fValue.focus();
    return;
  }
  if (!target) {
    showFormError('请选择目标策略');
    els.fTarget.focus();
    return;
  }

  const payload = {
    type: type,
    value: value,
    target: target,
    desc: els.fDesc.value.trim(),
    enabled: els.fEnabled.checked,
    noResolve: def && def.noResolve ? els.fNoResolve.checked : false,
  };

  const editing = !!state.editingId;
  const editingId = state.editingId;
  const previousText = els.ruleSubmit.textContent;
  els.ruleSubmit.disabled = true;
  els.ruleSubmit.textContent = editing ? '保存中…' : '创建中…';

  try {
    const res = editing
      ? await request('/api/rules/' + encodeURIComponent(editingId), { method: 'PUT', body: payload })
      : await request('/api/rules', { method: 'POST', body: payload });
    if (res && res.state) {
      applyState(res.state);
    } else {
      await refreshState(false);
    }
    closeRuleModal();
    renderAll();
    toast(editing ? '规则已保存' : '规则已创建', 'success');
  } catch (err) {
    showFormError(err.message);
    toast(err.message, 'error', 5000);
  } finally {
    els.ruleSubmit.disabled = false;
    els.ruleSubmit.textContent = previousText;
  }
}

/** 自定义规则：行内启用 / 停用 */
async function toggleRule(rule, input) {
  const enabled = input.checked;
  input.disabled = true;
  try {
    const res = await request('/api/rules/' + encodeURIComponent(rule.id), {
      method: 'PUT',
      body: { enabled: enabled },
    });
    if (res && res.state) {
      applyState(res.state);
    } else {
      await refreshState(false);
    }
    renderAll();
    toast(enabled ? '规则已启用' : '规则已停用', 'success', 1800);
  } catch (err) {
    input.checked = !enabled;
    toast(err.message, 'error');
  } finally {
    input.disabled = false;
  }
}

/** 自定义规则：删除（二次确认） */
async function deleteRule(rule) {
  const def = getTypeDef(rule.type);
  const label = def ? def.label : rule.type;
  const confirmed = await confirmDialog({
    title: '删除规则',
    message: '确定删除规则「' + label + ' ' + rule.value + '」吗？\n删除后需要点击「应用并重载」，规则才会真正失效。',
    okText: '删除',
    danger: true,
  });
  if (!confirmed) return;

  try {
    const res = await request('/api/rules/' + encodeURIComponent(rule.id), { method: 'DELETE' });
    if (res && res.state) {
      applyState(res.state);
    } else {
      await refreshState(false);
    }
    renderAll();
    toast('规则已删除', 'success');
  } catch (err) {
    toast(err.message, 'error', 5000);
  }
}

/** 自定义规则：应用并重载 */
async function applyRules() {
  const meta = state.data ? state.data.meta : null;
  if (!meta || !meta.pending || state.applying) return;

  state.applying = true;
  updateApplyButton();
  try {
    const res = await request('/api/apply', { method: 'POST' });
    toast(buildApplyMessage(res), 'success', 5000);
    // apply 响应不含完整 state，重新拉取以更新 pending / lastApply 等元信息
    await refreshState(false);
  } catch (err) {
    toast(err.message, 'error', 5000);
  } finally {
    state.applying = false;
    updateApplyButton();
  }
}

function buildApplyMessage(res) {
  const providers = res && Array.isArray(res.providers) ? res.providers : [];
  const parts = [];
  if (res && typeof res.reloadMs === 'number') parts.push('重载 ' + res.reloadMs + ' ms');
  parts.push(providers.length + ' 个 provider');
  if (res && typeof res.ruleCount === 'number') parts.push('主规则 ' + res.ruleCount + ' 条');
  return '已应用并重载 · ' + parts.join(' · ');
}

/** 备份回滚（二次确认） */
async function restoreBackup(id, tsText) {
  const confirmed = await confirmDialog({
    title: '恢复备份',
    message: '确定用备份「' + (tsText || id) + '」（' + id + '）覆盖当前配置吗？\n回滚会立即生效，操作前请确认。',
    okText: '确认回滚',
    danger: true,
  });
  if (!confirmed) return;

  try {
    const res = await request('/api/backups/' + encodeURIComponent(id) + '/restore', { method: 'POST' });
    toast((res && res.message) || '已回滚到所选备份', 'success', 5000);
    await refreshState(false);
    await loadBackups();
    // 回滚改变的是主配置，主配置视图需要重新加载
    if (state.view === 'main' && state.main.loaded) loadMainRules();
  } catch (err) {
    toast(err.message, 'error', 5000);
  }
}

/** 自定义规则：清除全部筛选条件 */
function clearFilters() {
  state.filter = { search: '', target: '', type: '' };
  els.searchInput.value = '';
  els.filterTarget.value = '';
  els.filterType.value = '';
  renderTable();
}

/* ---------------- 6.2 主配置规则（立即生效） ---------------- */

/** 主配置视图刷新：重新拉取规则 + 同步 state（groups / meta） */
function refreshMainView(showSuccessToast) {
  if (showSuccessToast) loadMainRules({ showSuccessToast: true });
  else loadMainRules();
  refreshState(false);
}

/** 主配置规则：409（expect 不匹配）统一处理 —— 提示并触发刷新 */
function handleMainConflict() {
  toast('配置已被外部修改，请点刷新重新加载', 'warn', 6500);
  loadMainRules();
  refreshState(false);
}

/** 主配置规则：保存成功后的本地状态更新 */
function applyMainPatchResult(index, res) {
  const rule = findMainRule(index);
  const next = res && res.rule && typeof res.rule === 'object' ? res.rule : null;
  if (rule && next) {
    if (typeof next.type === 'string') rule.type = next.type;
    if (typeof next.value === 'string') rule.value = next.value;
    if (typeof next.target === 'string') rule.target = next.target;
    if (typeof next.noResolve === 'boolean') rule.noResolve = next.noResolve;
    if (typeof next.line === 'number') rule.line = next.line;
  }
  if (res && typeof res.total === 'number') state.main.total = res.total;
  if (res && typeof res.aligned === 'boolean') state.main.aligned = res.aligned;
  if (state.data) state.data.backupCount = (state.data.backupCount || 0) + 1;
  syncMainTotalToMeta();
}

/** 主配置规则：删除成功后的本地状态更新（索引要整体前移） */
function applyMainDeleteResult(index, removedLine, res) {
  state.main.rules = state.main.rules.filter(function (rule) { return rule.i !== index; });
  state.main.rules.forEach(function (rule, k) {
    rule.i = k;
    // 删除一行后，后面规则的行号整体前移 1 行（仅用于 tooltip，刷新后会以服务端为准）
    if (typeof removedLine === 'number' && typeof rule.line === 'number' && rule.line > removedLine) {
      rule.line -= 1;
    }
  });
  state.main.total = res && typeof res.total === 'number' ? res.total : state.main.rules.length;
  if (res && typeof res.aligned === 'boolean') state.main.aligned = res.aligned;
  if (state.data) state.data.backupCount = (state.data.backupCount || 0) + 1;
  syncMainTotalToMeta();
}

/** 主配置规则：拼接成功提示（后端 message 已含重载耗时） */
function buildMainMutationMessage(res, fallback) {
  if (res && typeof res.message === 'string' && res.message) return res.message;
  return fallback;
}

/** 主配置规则：保存（类型只读；MATCH 只能改目标；带 expect 并发校验） */
async function submitMainRuleForm(event) {
  event.preventDefault();
  if (state.main.mutating) return;
  hideMainFormError();

  const index = state.main.editingIndex;
  const rule = index === null ? null : findMainRule(index);
  if (!rule) {
    toast('规则已不存在，请点刷新重新加载', 'warn');
    closeMainRuleModal();
    return;
  }

  const isMatch = rule.type === 'MATCH';
  const target = els.mTarget.value;
  const value = isMatch ? rule.value : els.mValue.value.trim();

  if (!target) {
    showMainFormError('请选择目标策略');
    els.mTarget.focus();
    return;
  }
  if (!isMatch && !value) {
    showMainFormError('规则值不能为空');
    els.mValue.focus();
    return;
  }
  if (!isMatch && value.indexOf(',') !== -1) {
    showMainFormError('规则值不能包含英文逗号');
    els.mValue.focus();
    return;
  }
  if (target === rule.target && (isMatch || value === rule.value)) {
    showMainFormError('值和目标都没有变化，无需保存');
    return;
  }

  const messageLines = [
    '这次修改会直接写入 mihomo 主配置和部署模板：',
    '',
    '类型：' + rule.type,
  ];
  if (!isMatch) {
    messageLines.push('值：' + (rule.value || '（空）') + ' → ' + value);
  }
  messageLines.push('目标：' + rule.target + ' → ' + target);
  messageLines.push('会同时修改主配置、sub-rules.rule-1x、sub-rules.rule-2x 三份列表（1x / 2x 两份的目标会自动加后缀）。');
  messageLines.push('');
  messageLines.push('保存前会自动备份，保存后立即重载 mihomo（约 2-3 秒）。');

  const confirmed = await confirmDialog({
    title: '确认写入主配置',
    message: messageLines.join('\n'),
    okText: '确认保存',
    danger: true,
  });
  if (!confirmed) return;

  state.main.mutating = true;
  state.main.saving = true;
  els.mainRuleSubmit.disabled = true;
  els.mainRuleSubmit.textContent = '保存并重载中…';
  els.mainRuleCancel.disabled = true;
  els.mainRuleClose.disabled = true;

  try {
    // MATCH 规则不能传 value（后端会以 400 拒绝），只改 target
    const body = {
      target: target,
      expect: { type: rule.type, value: rule.value, target: rule.target },
    };
    if (!isMatch) body.value = value;

    const res = await request('/api/main-rules/' + index, { method: 'PATCH', body: body });
    applyMainPatchResult(index, res);
    state.main.mutating = false;
    closeMainRuleModal();
    renderMeta();
    renderTabs();
    renderMainView();
    toast(buildMainMutationMessage(res, '已保存并重载'), 'success', 5500);
  } catch (err) {
    state.main.mutating = false;
    if (err && err.status === 409) {
      closeMainRuleModal();
      handleMainConflict();
    } else if (err && err.status === 404) {
      closeMainRuleModal();
      toast(err.message || '规则索引已失效，正在重新加载', 'error', 5000);
      loadMainRules();
    } else {
      showMainFormError(err.message);
      toast(err.message, 'error', 5000);
    }
  } finally {
    state.main.saving = false;
    els.mainRuleSubmit.disabled = false;
    els.mainRuleSubmit.textContent = '保存并重载';
    els.mainRuleCancel.disabled = false;
    els.mainRuleClose.disabled = false;
  }
}

/** 主配置规则：删除（二次确认 + 行内 loading） */
async function deleteMainRule(rule) {
  if (state.main.mutating) return;
  const def = getTypeDef(rule.type);
  const label = def ? def.label : rule.type;
  const display = rule.type === 'MATCH'
    ? 'MATCH → ' + rule.target
    : label + ' ' + rule.value + ' → ' + rule.target;

  const confirmed = await confirmDialog({
    title: '删除主配置规则',
    message: '确定删除「' + display + '」吗？\n\n' +
      '该条会从主配置 rules、sub-rules.rule-1x、sub-rules.rule-2x 三份列表中同时移除，' +
      '删除前自动备份，删除后立即重载 mihomo（约 2-3 秒）。',
    okText: '删除并重载',
    danger: true,
  });
  if (!confirmed) return;

  state.main.mutating = true;
  state.main.deletingIndex = rule.i;
  renderMainTable();

  try {
    const res = await request('/api/main-rules/' + rule.i, {
      method: 'DELETE',
      body: { expect: { type: rule.type, value: rule.value, target: rule.target } },
    });
    applyMainDeleteResult(rule.i, typeof rule.line === 'number' ? rule.line : null, res);
    toast(buildMainMutationMessage(res, '已删除并重载'), 'success', 5500);
  } catch (err) {
    if (err && err.status === 409) {
      handleMainConflict();
    } else if (err && err.status === 404) {
      toast(err.message || '规则索引已失效，正在重新加载', 'error', 5000);
      loadMainRules();
    } else {
      toast(err.message, 'error', 5000);
    }
  } finally {
    state.main.mutating = false;
    state.main.deletingIndex = null;
    if (state.view === 'main') {
      renderMeta();
      renderTabs();
      renderMainView();
    }
  }
}

/** 主配置规则：把主配置对齐到部署模板（POST /api/main-rules/align） */
async function alignMainTemplate() {
  if (state.main.mutating) return;
  state.main.mutating = true;
  els.btnMainAlign.disabled = true;
  els.btnMainAlign.textContent = '对齐中…';

  try {
    const res = await request('/api/main-rules/align', { method: 'POST' });
    toast((res && res.message) || '已对齐模板', 'success', 5500);
    // 对齐后重新读取，确认 aligned 状态与索引
    await loadMainRules();
  } catch (err) {
    toast(err.message, 'error', 5500);
    if (err && err.status === 409) loadMainRules();
  } finally {
    state.main.mutating = false;
    els.btnMainAlign.disabled = false;
    els.btnMainAlign.textContent = '对齐模板';
    renderMainView();
  }
}

/* ==================== 7. 事件绑定 ==================== */

function bindEvents() {
  // 视图切换
  els.tabCustom.addEventListener('click', function () {
    switchView('custom');
  });
  els.tabMain.addEventListener('click', function () {
    switchView('main');
  });
  els.btnGotoCustom.addEventListener('click', function () {
    switchView('custom');
  });

  // 顶部按钮
  els.btnRefresh.addEventListener('click', function () {
    if (state.view === 'main') refreshMainView(true);
    else refreshState(true);
  });
  els.btnApply.addEventListener('click', applyRules);
  els.btnBackups.addEventListener('click', openBackups);
  els.btnAdd.addEventListener('click', function () {
    openRuleModal(null);
  });

  // 自定义规则：搜索与筛选
  els.searchInput.addEventListener('input', function () {
    state.filter.search = els.searchInput.value;
    renderTable();
  });
  els.filterTarget.addEventListener('change', function () {
    state.filter.target = els.filterTarget.value;
    renderTable();
  });
  els.filterType.addEventListener('change', function () {
    state.filter.type = els.filterType.value;
    renderTable();
  });

  // 自定义规则：表格点击（编辑 / 删除）
  els.rulesBody.addEventListener('click', function (event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const rule = findRule(button.dataset.id);
    if (!rule) return;
    if (button.dataset.action === 'edit') openRuleModal(rule);
    else if (button.dataset.action === 'delete') deleteRule(rule);
  });

  // 自定义规则：启停开关
  els.rulesBody.addEventListener('change', function (event) {
    const input = event.target;
    if (!input.matches('input[data-action="toggle"]')) return;
    const rule = findRule(input.dataset.id);
    if (rule) toggleRule(rule, input);
  });

  // 自定义规则：空状态 / 错误状态里的按钮
  els.tableState.addEventListener('click', function (event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'retry') loadInitial();
    else if (action === 'add') openRuleModal(null);
    else if (action === 'clear-filters') clearFilters();
  });

  // 主配置规则：筛选、分页、重新加载
  els.mainSearchInput.addEventListener('input', function () {
    state.main.filter.search = els.mainSearchInput.value;
    state.main.page = 1;
    renderMainTable();
  });
  els.mainFilterTarget.addEventListener('change', function () {
    state.main.filter.target = els.mainFilterTarget.value;
    state.main.page = 1;
    renderMainTable();
  });
  els.mainFilterType.addEventListener('change', function () {
    state.main.filter.type = els.mainFilterType.value;
    state.main.page = 1;
    renderMainTable();
  });
  els.mainPrev.addEventListener('click', function () {
    if (state.main.page <= 1) return;
    state.main.page -= 1;
    renderMainTable();
  });
  els.mainNext.addEventListener('click', function () {
    const info = mainPageInfo();
    if (state.main.page >= info.totalPages) return;
    state.main.page += 1;
    renderMainTable();
  });
  els.btnMainReload.addEventListener('click', function () {
    loadMainRules({ showSuccessToast: true });
  });
  els.btnMainAlign.addEventListener('click', alignMainTemplate);

  // 主配置规则：表格点击（编辑 / 删除）
  els.mainRulesBody.addEventListener('click', function (event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (state.main.mutating) return;
    const index = Number(button.dataset.i);
    const rule = findMainRule(index);
    if (!rule) return;
    if (button.dataset.action === 'main-edit') openMainRuleModal(rule);
    else if (button.dataset.action === 'main-delete') deleteMainRule(rule);
  });

  // 主配置规则：空状态 / 错误状态里的按钮
  els.mainTableState.addEventListener('click', function (event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'main-retry') loadMainRules();
    else if (button.dataset.action === 'main-clear-filters') clearMainFilters();
  });

  // 自定义规则表单
  els.ruleForm.addEventListener('submit', submitRuleForm);
  els.fType.addEventListener('change', syncTypeFields);
  els.fTarget.addEventListener('change', updateTargetHint);
  els.ruleCancel.addEventListener('click', closeRuleModal);
  els.ruleModalClose.addEventListener('click', closeRuleModal);

  // 主配置规则表单
  els.mainRuleForm.addEventListener('submit', submitMainRuleForm);
  els.mTarget.addEventListener('change', updateMainTargetHint);
  els.mainRuleCancel.addEventListener('click', function () {
    if (!state.main.mutating) closeMainRuleModal();
  });
  els.mainRuleClose.addEventListener('click', function () {
    if (!state.main.mutating) closeMainRuleModal();
  });

  // 确认框
  els.confirmOk.addEventListener('click', function () {
    closeConfirm(true);
  });
  els.confirmCancel.addEventListener('click', function () {
    closeConfirm(false);
  });

  // 备份弹窗
  els.backupsClose.addEventListener('click', function () {
    hideModal(els.backupsModal);
  });
  els.backupsDone.addEventListener('click', function () {
    hideModal(els.backupsModal);
  });
  els.backupsList.addEventListener('click', function (event) {
    const button = event.target.closest('button[data-action="restore"]');
    if (!button) return;
    restoreBackup(button.dataset.id, button.dataset.ts);
  });

  // 点击遮罩关闭（确认框视为取消；主配置编辑弹窗保存中不允许关闭）
  [els.ruleModal, els.mainRuleModal, els.backupsModal, els.confirmModal].forEach(function (backdrop) {
    backdrop.addEventListener('mousedown', function (event) {
      if (event.target !== backdrop) return;
      if (backdrop === els.confirmModal) closeConfirm(false);
      else if (backdrop === els.ruleModal) closeRuleModal();
      else if (backdrop === els.mainRuleModal) {
        if (!state.main.mutating) closeMainRuleModal();
      } else hideModal(els.backupsModal);
    });
  });

  // 键盘：Esc 关闭最上层弹窗；Enter 由表单 / 聚焦按钮原生处理
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (!els.confirmModal.hidden) {
      event.preventDefault();
      closeConfirm(false);
    } else if (!els.mainRuleModal.hidden) {
      event.preventDefault();
      if (!state.main.mutating) closeMainRuleModal();
    } else if (!els.ruleModal.hidden) {
      event.preventDefault();
      closeRuleModal();
    } else if (!els.backupsModal.hidden) {
      event.preventDefault();
      hideModal(els.backupsModal);
    }
  });
}

/* ==================== 8. 初始化 ==================== */

function cacheElements() {
  // 全局
  els.brandSub = $('#brand-sub');
  els.pendingBadge = $('#pending-badge');
  els.metaStrip = $('#meta-strip');
  els.btnBackups = $('#btn-backups');
  els.btnRefresh = $('#btn-refresh');
  els.btnApply = $('#btn-apply');
  els.toastRoot = $('#toast-root');

  // 视图切换
  els.viewCustom = $('#view-custom');
  els.viewMain = $('#view-main');
  els.tabCustom = $('#tab-custom');
  els.tabMain = $('#tab-main');
  els.tabCustomCount = $('#tab-custom-count');
  els.tabMainCount = $('#tab-main-count');

  // 自定义规则视图
  els.installedWarning = $('#installed-warning');
  els.dataError = $('#data-error');
  els.dataErrorText = $('#data-error-text');
  els.btnAdd = $('#btn-add');
  els.searchInput = $('#search-input');
  els.filterTarget = $('#filter-target');
  els.filterType = $('#filter-type');
  els.tableScroll = $('#table-scroll');
  els.rulesBody = $('#rules-body');
  els.tableState = $('#table-state');
  els.stats = $('#stats');

  // 主配置规则视图
  els.mainRiskBanner = $('#main-risk-banner');
  els.mainRiskText = $('#main-risk-text');
  els.btnGotoCustom = $('#btn-goto-custom');
  els.mainAlignBanner = $('#main-align-banner');
  els.mainAlignText = $('#main-align-text');
  els.btnMainAlign = $('#btn-main-align');
  els.btnMainReload = $('#btn-main-reload');
  els.mainSearchInput = $('#main-search-input');
  els.mainFilterTarget = $('#main-filter-target');
  els.mainFilterType = $('#main-filter-type');
  els.mainTableScroll = $('#main-table-scroll');
  els.mainRulesBody = $('#main-rules-body');
  els.mainTableState = $('#main-table-state');
  els.mainPagination = $('#main-pagination');
  els.mainCount = $('#main-count');
  els.mainPrev = $('#main-prev');
  els.mainNext = $('#main-next');
  els.mainPageIndicator = $('#main-page-indicator');

  // 自定义规则弹窗
  els.ruleModal = $('#rule-modal');
  els.ruleTitle = $('#rule-modal-title');
  els.ruleForm = $('#rule-form');
  els.fType = $('#f-type');
  els.fValue = $('#f-value');
  els.fTarget = $('#f-target');
  els.fDesc = $('#f-desc');
  els.fEnabled = $('#f-enabled');
  els.rowNoResolve = $('#row-no-resolve');
  els.fNoResolve = $('#f-no-resolve');
  els.typeHint = $('#type-hint');
  els.valueHint = $('#value-hint');
  els.targetHint = $('#target-hint');
  els.formError = $('#form-error');
  els.ruleCancel = $('#rule-cancel');
  els.ruleSubmit = $('#rule-submit');
  els.ruleModalClose = $('#rule-modal-close');

  // 主配置规则弹窗
  els.mainRuleModal = $('#main-rule-modal');
  els.mainRuleTitle = $('#main-rule-modal-title');
  els.mainRuleForm = $('#main-rule-form');
  els.mType = $('#m-type');
  els.mValue = $('#m-value');
  els.mTarget = $('#m-target');
  els.mTypeHint = $('#m-type-hint');
  els.mValueHint = $('#m-value-hint');
  els.mTargetHint = $('#m-target-hint');
  els.mainFormError = $('#m-form-error');
  els.mainRuleCancel = $('#main-rule-cancel');
  els.mainRuleSubmit = $('#main-rule-submit');
  els.mainRuleClose = $('#main-rule-modal-close');

  // 确认框
  els.confirmModal = $('#confirm-modal');
  els.confirmTitle = $('#confirm-title');
  els.confirmMessage = $('#confirm-message');
  els.confirmOk = $('#confirm-ok');
  els.confirmCancel = $('#confirm-cancel');

  // 备份弹窗
  els.backupsModal = $('#backups-modal');
  els.backupsList = $('#backups-list');
  els.backupsClose = $('#backups-close');
  els.backupsDone = $('#backups-done');
}

function init() {
  cacheElements();
  bindEvents();
  loadInitial();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
