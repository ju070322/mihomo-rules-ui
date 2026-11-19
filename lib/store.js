'use strict';
/**
 * 自定义规则存储：<RULES_DATA_DIR>/custom.yaml 是唯一数据源。
 * 结构固定为 { version, rules: [ {id,type,value,target,desc,enabled,no_resolve,...} ] }。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { yamlLoad, q } = require('./yamlutil');
const settings = require('./settings');

// 默认放在 mihomo 主配置同级（rule-provider 的 path 必须落在 mihomo HomeDir 内）
const DATA_DIR = settings.DATA_DIR;
const CUSTOM_FILE = path.join(DATA_DIR, 'custom.yaml');
const PROVIDER_DIR = path.join(DATA_DIR, 'providers');
const APP_DIR = settings.APP_DIR;
const STATE_FILE = settings.STATE_FILE;
const BACKUP_DIR = settings.BACKUP_DIR;

const RULE_TYPES = [
  { type: 'DOMAIN-SUFFIX', label: '域名后缀', valueHint: 'example.com', noResolve: false },
  { type: 'DOMAIN', label: '完整域名', valueHint: 'a.example.com', noResolve: false },
  { type: 'DOMAIN-KEYWORD', label: '域名关键字', valueHint: 'google', noResolve: false },
  { type: 'DOMAIN-WILDCARD', label: '域名通配', valueHint: '*.example.com', noResolve: false },
  { type: 'DOMAIN-REGEX', label: '域名正则', valueHint: '^abc.*\\.com$', noResolve: false },
  { type: 'GEOSITE', label: 'Geosite', valueHint: 'youtube', noResolve: false },
  { type: 'IP-CIDR', label: 'IP 段', valueHint: '1.2.3.0/24', noResolve: true },
  { type: 'IP-CIDR6', label: 'IPv6 段', valueHint: '2001:db8::/32', noResolve: true },
  { type: 'GEOIP', label: 'IP 归属地', valueHint: 'CN', noResolve: true },
  { type: 'IP-ASN', label: 'IP ASN', valueHint: '13335', noResolve: true },
  { type: 'PROCESS-NAME', label: '进程名', valueHint: 'curl', noResolve: false },
  { type: 'DST-PORT', label: '目标端口', valueHint: '443', noResolve: false },
  { type: 'SRC-PORT', label: '源端口', valueHint: '1234', noResolve: false },
];
const RULE_TYPE_MAP = new Map(RULE_TYPES.map((t) => [t.type, t]));

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

let cache = { mtimeMs: -1, rules: [] };

function dirStatus() {
  let user = 'fn-deepseek-harness';
  try {
    user = require('node:os').userInfo().username || user;
  } catch {
    /* 保底用默认用户名 */
  }

  try {
    const st = fs.statSync(DATA_DIR);
    if (!st.isDirectory()) return { ok: false, error: DATA_DIR + ' 不是目录' };
  } catch (err) {
    return {
      ok: false,
      error:
        DATA_DIR +
        ' 不存在（' + (err.code || err.message) + '）。请以拥有该目录的用户身份执行一次：\n' +
        'sudo install -d -o ' + user + ' -g ' + user + ' -m 755 ' + DATA_DIR,
    };
  }

  // access(W_OK) 会被 ACL 或沙箱策略误导（看起来可写、实际 EACCES），所以真写一次探针文件
  const probe = path.join(DATA_DIR, '.rules-ui-write-probe');
  try {
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        DATA_DIR +
        ' 目录存在但无法写入（' + (err.code || err.message) + '）。\n' +
        '① 文件系统权限问题：sudo install -d -o ' + user + ' -g ' + user + ' -m 755 ' + DATA_DIR + '\n' +
        '② 权限看起来正常但仍 EACCES：说明启动服务的进程被容器/沙箱策略限制，' +
        '请在普通 shell 里以拥有该目录的用户身份启动（./start.sh）。',
    };
  }
}

function ensureDirs() {
  const st = dirStatus();
  if (!st.ok) throw fail(409, st.error);
  fs.mkdirSync(PROVIDER_DIR, { recursive: true });
}

function nowIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    d.getFullYear() +
    '-' + pad(d.getMonth() + 1) +
    '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) +
    ':' + pad(d.getMinutes()) +
    ':' + pad(d.getSeconds()) +
    sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60)
  );
}

function newId() {
  return 'r_' + crypto.randomBytes(4).toString('hex');
}

function normalizeRule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '').trim().toUpperCase();
  if (!RULE_TYPE_MAP.has(type)) return null;
  const value = String(raw.value == null ? '' : raw.value).trim();
  if (!value) return null;
  const target = String(raw.target == null ? '' : raw.target).trim();
  if (!target) return null;
  return {
    id: String(raw.id || '').trim() || newId(),
    type,
    value,
    target,
    desc: String(raw.desc == null ? '' : raw.desc),
    enabled: raw.enabled !== false,
    noResolve: raw.no_resolve === true || raw.noResolve === true,
    createdAt: String(raw.created_at || raw.createdAt || ''),
    updatedAt: String(raw.updated_at || raw.updatedAt || ''),
  };
}

/** 兜底解析：PyYAML 不可用时，按本文件固定格式逐行读。 */
function parseFallback(text) {
  const rules = [];
  let cur = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line || /^\s*#/.test(line)) continue;
    if (/^version:/.test(line)) continue;
    let m = /^\s*-\s+id:\s*(.+)$/.exec(line);
    if (m) {
      cur = { id: unq(m[1]) };
      rules.push(cur);
      continue;
    }
    m = /^\s+(type|value|target|desc|created_at|updated_at):\s*(.*)$/.exec(line);
    if (m && cur) {
      cur[m[1]] = unq(m[2]);
      continue;
    }
    m = /^\s+enabled:\s*(true|false)\s*$/.exec(line);
    if (m && cur) {
      cur.enabled = m[1] === 'true';
      continue;
    }
    m = /^\s+no_resolve:\s*(true|false)\s*$/.exec(line);
    if (m && cur) {
      cur.no_resolve = m[1] === 'true';
      continue;
    }
  }
  return { version: 1, rules };
}

function unq(s) {
  s = String(s == null ? '' : s).trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    const inner = s.slice(1, -1);
    if (s[0] === '"') return inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return inner.replace(/''/g, "'");
  }
  return s;
}

function load({ force = false } = {}) {
  let stat;
  try {
    stat = fs.statSync(CUSTOM_FILE);
  } catch {
    cache = { mtimeMs: -1, rules: [] };
    return [];
  }
  if (!force && stat.mtimeMs === cache.mtimeMs) return cache.rules;

  const text = fs.readFileSync(CUSTOM_FILE, 'utf8');
  let doc;
  try {
    doc = yamlLoad(text) || {};
  } catch {
    doc = parseFallback(text); // PyYAML 挂了也不能让整个页面不可用
  }
  const list = Array.isArray(doc.rules) ? doc.rules : [];
  const rules = list.map(normalizeRule).filter(Boolean);
  // 兜底：id 重复的补一个新 id，避免前端行为异常
  const seen = new Set();
  for (const r of rules) {
    if (seen.has(r.id)) r.id = newId();
    seen.add(r.id);
  }
  cache = { mtimeMs: stat.mtimeMs, rules };
  return rules;
}

function toYaml(rules) {
  const lines = [
    '# mihomo rules-ui —— 自定义分流规则（由网页维护）',
    '# 改完需要在网页点「应用并重载」，否则 mihomo 不会重新读取。',
    '# 生成物：同级 providers/*.yaml 与主配置里的 rule-providers 区块。',
    'version: 1',
    'rules:',
  ];
  if (rules.length === 0) lines[lines.length - 1] = 'rules: []';
  for (const r of rules) {
    lines.push('  - id: ' + q(r.id));
    lines.push('    type: ' + q(r.type));
    lines.push('    value: ' + q(r.value));
    lines.push('    target: ' + q(r.target));
    lines.push('    desc: ' + q(r.desc));
    lines.push('    enabled: ' + (r.enabled ? 'true' : 'false'));
    lines.push('    no_resolve: ' + (r.noResolve ? 'true' : 'false'));
    if (r.createdAt) lines.push('    created_at: ' + q(r.createdAt));
    lines.push('    updated_at: ' + q(r.updatedAt || nowIso()));
  }
  return lines.join('\n') + '\n';
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function save(rules) {
  ensureDirs();
  writeAtomic(CUSTOM_FILE, toYaml(rules));
  cache = { mtimeMs: -1, rules: [] };
  return load({ force: true });
}

function list() {
  return load().slice();
}

function get(id) {
  return list().find((r) => r.id === id) || null;
}

function validateInput(input, { partial = false } = {}) {
  const errs = [];
  const out = {};
  if (input.type !== undefined || !partial) {
    const type = String(input.type || '').trim().toUpperCase();
    if (!RULE_TYPE_MAP.has(type)) errs.push('规则类型不支持：' + (input.type || '(空)'));
    out.type = type;
  }
  if (input.value !== undefined || !partial) {
    const value = String(input.value == null ? '' : input.value).trim();
    if (!value) errs.push('规则值不能为空');
    if (/[\n\r]/.test(value)) errs.push('规则值不能包含换行');
    if (value.includes(',')) errs.push('规则值不能包含英文逗号（会被当成字段分隔）');
    out.value = value;
  }
  if (input.target !== undefined || !partial) {
    const target = String(input.target == null ? '' : input.target).trim();
    if (!target) errs.push('必须选择目标策略');
    if (/[\n\r,]/.test(target)) errs.push('目标策略名不能包含换行或逗号');
    out.target = target;
  }
  if (input.desc !== undefined || !partial) out.desc = String(input.desc == null ? '' : input.desc);
  if (input.enabled !== undefined || !partial) out.enabled = input.enabled !== false;
  if (input.noResolve !== undefined || !partial) out.noResolve = input.noResolve === true;
  return { ok: errs.length === 0, errors: errs, value: out };
}

function add(input) {
  const v = validateInput(input);
  if (!v.ok) throw fail(400, v.errors.join('；'));
  const rules = list();
  const dup = rules.find(
    (r) => r.type === v.value.type && r.value === v.value.value && r.target === v.value.target,
  );
  if (dup) throw fail(400, '已存在完全相同的规则（' + dup.type + ' ' + dup.value + ' → ' + dup.target + '）');
  const ts = nowIso();
  const rule = {
    id: newId(),
    type: v.value.type,
    value: v.value.value,
    target: v.value.target,
    desc: v.value.desc,
    enabled: v.value.enabled,
    noResolve: v.value.noResolve,
    createdAt: ts,
    updatedAt: ts,
  };
  rules.push(rule);
  save(rules);
  return get(rule.id);
}

function update(id, patch) {
  const rules = list();
  const idx = rules.findIndex((r) => r.id === id);
  if (idx < 0) throw fail(404, '规则不存在：' + id);
  const v = validateInput(patch, { partial: true });
  if (!v.ok) throw fail(400, v.errors.join('；'));
  const next = { ...rules[idx], ...v.value, updatedAt: nowIso() };
  rules[idx] = next;
  save(rules);
  return get(id);
}

function remove(id) {
  const rules = list();
  const idx = rules.findIndex((r) => r.id === id);
  if (idx < 0) throw fail(404, '规则不存在：' + id);
  rules.splice(idx, 1);
  save(rules);
  return true;
}

/** 规则列表指纹，用来判断"是否有未应用的改动"。 */
function fingerprint(rules = list()) {
  const payload = JSON.stringify(
    rules.map((r) => [r.id, r.type, r.value, r.target, r.enabled, r.noResolve]),
  );
  return crypto.createHash('sha1').update(payload).digest('hex');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeState(patch) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const next = { ...readState(), ...patch };
  writeAtomic(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

module.exports = {
  fail,
  DATA_DIR,
  CUSTOM_FILE,
  PROVIDER_DIR,
  APP_DIR,
  STATE_FILE,
  BACKUP_DIR,
  RULE_TYPES,
  RULE_TYPE_MAP,
  dirStatus,
  ensureDirs,
  nowIso,
  writeAtomic,
  load,
  list,
  get,
  add,
  update,
  remove,
  save,
  fingerprint,
  readState,
  writeState,
  validateInput,
  toYaml,
};
