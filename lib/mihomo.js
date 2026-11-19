'use strict';
/**
 * mihomo 控制接口客户端（无第三方依赖，Node 24 原生 fetch）。
 * 只做四件事：读 secret/controller、通用调用、重载配置、读 provider 状态。
 */
const fs = require('node:fs');
const settings = require('./settings');

const CONFIG_PATH = settings.CONFIG_PATH;
// 容器内看到的配置文件路径（PUT /configs 需要容器内路径）
const CONTAINER_CONFIG = settings.CONTAINER_CONFIG;

function unquote(s) {
  s = String(s == null ? '' : s).trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    s = s.slice(1, -1);
  }
  return s;
}

function firstMatch(text, re) {
  const m = re.exec(text);
  return m ? m[1] : '';
}

/** 从主配置里取 secret 与 external-controller，拼成可用的 base URL。 */
function controlEndpoint() {
  const text = fs.readFileSync(CONFIG_PATH, 'utf8');
  const secret = unquote(firstMatch(text, /^secret:(.*)$/m));
  let ctrl = unquote(firstMatch(text, /^external-controller:(.*)$/m)) || '127.0.0.1:9090';
  // 监听 0.0.0.0 / * 时用回环地址访问
  if (/^(0\.0\.0\.0|\*):/.test(ctrl)) ctrl = ctrl.replace(/^(0\.0\.0\.0|\*):/, '127.0.0.1:');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(ctrl)) ctrl = 'http://' + ctrl;
  return { base: ctrl.replace(/\/+$/, ''), secret };
}

async function call(path, { method = 'GET', body, timeout = 20000 } = {}) {
  const { base, secret } = controlEndpoint();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(base + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + secret,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: res.status, ok: res.ok, data };
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('mihomo 控制接口超时（' + path + '）');
    throw new Error('无法连接 mihomo 控制接口：' + err.message);
  } finally {
    clearTimeout(timer);
  }
}

async function version() {
  const r = await call('/version');
  if (!r.ok) throw new Error('读取 mihomo 版本失败 HTTP ' + r.status);
  return r.data;
}

/** 返回 { 名字: {name, behavior, ruleCount, ...} } */
async function ruleProviders() {
  const r = await call('/providers/rules');
  if (!r.ok) throw new Error('读取 rule-providers 失败 HTTP ' + r.status);
  return (r.data && r.data.providers) || {};
}

async function rulesSummary() {
  const r = await call('/rules', { timeout: 30000 });
  if (!r.ok) throw new Error('读取规则失败 HTTP ' + r.status);
  const list = (r.data && r.data.rules) || [];
  return { count: list.length, list };
}

/** 触发 mihomo 重载主配置（PUT /configs?force=true）。 */
async function reload() {
  const r = await call('/configs?force=true', {
    method: 'PUT',
    body: { path: CONTAINER_CONFIG, force: true },
    timeout: 60000,
  });
  if (!r.ok) {
    const detail = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    throw new Error('mihomo 重载失败 HTTP ' + r.status + (detail ? '：' + detail : ''));
  }
  return true;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * 重载后轮询确认真实生效：每个期望的 provider 都要出现且 ruleCount 正确。
 * @param {Array<{name:string,count:number}>} expected
 */
async function verifyProviders(expected, { attempts = 24, delay = 250 } = {}) {
  const want = expected.filter((p) => p.count > 0);
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const providers = await ruleProviders();
      const bad = [];
      for (const p of want) {
        const got = providers[p.name];
        if (!got) bad.push(`${p.name} 未加载`);
        else if (typeof got.ruleCount === 'number' && got.ruleCount !== p.count) {
          bad.push(`${p.name} 规则数 ${got.ruleCount} ≠ 期望 ${p.count}`);
        }
      }
      if (bad.length === 0) return { providers: want.length, attempts: i + 1 };
      lastErr = bad.join('；');
    } catch (err) {
      lastErr = err.message;
    }
    await sleep(delay);
  }
  throw new Error('重载后校验未通过：' + (lastErr || '未知原因'));
}

module.exports = {
  CONFIG_PATH,
  CONTAINER_CONFIG,
  controlEndpoint,
  call,
  version,
  ruleProviders,
  rulesSummary,
  reload,
  verifyProviders,
  unquote,
};
