'use strict';
/**
 * mihomo 规则管理网页 —— 零依赖 Node 服务（Node >= 18，实测 24.15）。
 *
 *   GET    /api/state                当前规则 + 可用目标策略 + 元信息
 *   GET    /api/rule-types           支持的规则类型
 *   POST   /api/rules                新增
 *   PUT    /api/rules/{id}           修改
 *   DELETE /api/rules/{id}           删除
 *   POST   /api/apply                生成 provider + 改主配置 + 重载 mihomo
 *   GET    /api/backups              主配置备份列表
 *   POST   /api/backups/{id}/restore 恢复某个备份
 *   GET    /api/lookup?type=&value=  查主配置里是否有会冲突的内置规则
 *   GET    /api/health               健康检查
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./lib/store');
const cfg = require('./lib/config');
const mihomo = require('./lib/mihomo');
const applier = require('./lib/applier');
const mainrules = require('./lib/mainrules');
const settings = require('./lib/settings');

const PORT = settings.PORT;
const HOST = settings.HOST;
const PUBLIC_DIR = settings.PUBLIC_DIR;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function log(...args) {
  const line = '[' + new Date().toISOString() + '] ' + args.map(String).join(' ');
  console.log(line);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { ok: false, error: message });
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 统计主配置 rules: 段的条数（避免为了一行数字去解析 1.4MB）。 */
function countMainRules(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^rules:\s*$/.test(l));
  if (start < 0) return 0;
  let n = 0;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z]/.test(lines[i])) break;
    if (/^- /.test(lines[i])) n += 1;
  }
  return n;
}

function buildState() {
  const status = store.dirStatus();
  const rules = status.ok ? store.list() : [];
  const persisted = store.readState();

  let groups = [];
  let installed = false;
  let mainRuleCount = 0;
  let mainError = null;
  try {
    const text = cfg.readConfigText();
    installed = cfg.regionsInstalled(text);
    groups = cfg.parseGroups(text).groups;
    mainRuleCount = countMainRules(text);
  } catch (err) {
    mainError = err.message;
  }

  const byTarget = {};
  for (const r of rules) byTarget[r.target] = (byTarget[r.target] || 0) + 1;

  const fp = store.fingerprint(rules);
  return {
    meta: {
      configPath: mihomo.CONFIG_PATH,
      customFile: store.CUSTOM_FILE,
      providerDir: store.PROVIDER_DIR,
      dataDir: store.DATA_DIR,
      dataDirOk: status.ok,
      error: status.ok ? mainError : status.error,
      installed,
      mainRuleCount,
      lastApply: persisted.lastApply || null,
      // 首次应用前不显示未应用改动，避免误报
      pending: persisted.lastFingerprint ? persisted.lastFingerprint !== fp : rules.length > 0,
      version: 1,
    },
    groups,
    rules,
    stats: {
      total: rules.length,
      enabled: rules.filter((r) => r.enabled).length,
      byTarget,
    },
    backupCount: applier.listBackups().length,
  };
}

/** 在主配置里找同类型、可能冲突的内置规则（帮助用户判断自定义是否真的改变了结果）。 */
function lookupConflicts(type, value) {
  const text = cfg.readConfigText();
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^rules:\s*$/.test(l));
  if (start < 0) return [];
  const v = String(value || '').toLowerCase();
  const wanted = String(type || '').toUpperCase();
  const hits = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[A-Za-z]/.test(line)) break;
    const m = /^-\s*([A-Z-]+),([^,]+),(.+?)\s*$/.exec(line);
    if (!m) continue;
    const [, rt, payload, target] = m;
    if (i - start - 1 > 9000) break;
    const p = payload.toLowerCase();
    let match = false;
    if (rt === wanted) {
      if (p === v) match = true;
      if (wanted === 'DOMAIN-SUFFIX' && (v === p || v.endsWith('.' + p))) match = true;
      if (wanted === 'DOMAIN' && v === p) match = true;
      if (wanted === 'DOMAIN-KEYWORD' && v.includes(p)) match = true;
    } else if (wanted && /^(DOMAIN|DOMAIN-SUFFIX)"?$/.test(wanted) === false) {
      // 类型不同也可能是实际拦住的规则，退回只报同类型，避免噪音
    }
    if (match) {
      hits.push({ line: rt + ',' + payload + ',' + target, index: i - start });
      if (hits.length >= 10) break;
    }
  }
  return hits;
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const decoded = decodeURIComponent(rel);
  const full = path.join(PUBLIC_DIR, decoded);
  if (!full.startsWith(PUBLIC_DIR)) return sendError(res, 403, '非法路径');
  fs.readFile(full, (err, data) => {
    if (err) return sendError(res, 404, '文件不存在：' + rel);
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

async function route(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method || 'GET';

  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, pid: process.pid, uptime: process.uptime() });
  }

  if (pathname === '/api/state' && method === 'GET') {
    return sendJson(res, 200, buildState());
  }

  if (pathname === '/api/rule-types' && method === 'GET') {
    return sendJson(res, 200, { types: store.RULE_TYPES });
  }

  if (pathname === '/api/rules' && method === 'POST') {
    const body = await readBody(req);
    const rule = store.add(body);
    log('新增规则', rule.type, rule.value, '->', rule.target);
    return sendJson(res, 200, { ok: true, rule, state: buildState() });
  }

  let m = /^\/api\/rules\/([\w-]+)$/.exec(pathname);
  if (m && method === 'PUT') {
    const body = await readBody(req);
    const rule = store.update(m[1], body);
    log('修改规则', rule.type, rule.value, '->', rule.target);
    return sendJson(res, 200, { ok: true, rule, state: buildState() });
  }
  if (m && method === 'DELETE') {
    store.remove(m[1]);
    log('删除规则', m[1]);
    return sendJson(res, 200, { ok: true, state: buildState() });
  }

  if (pathname === '/api/apply' && method === 'POST') {
    const result = await applier.apply();
    log('应用完成', result.message);
    return sendJson(res, 200, { ...result, state: buildState() });
  }

  // ---------- 主配置内置规则（7594 条）的搜索与修改 ----------
  if (pathname === '/api/main-rules' && method === 'GET') {
    return sendJson(res, 200, mainrules.list());
  }

  if (pathname === '/api/main-rules/align' && method === 'POST') {
    const result = await mainrules.align();
    log('对齐模板:', result.message);
    return sendJson(res, 200, result);
  }

  let mr = /^\/api\/main-rules\/(\d+)$/.exec(pathname);
  if (mr && method === 'PATCH') {
    const body = await readBody(req);
    const result = await mainrules.patch(Number(mr[1]), body);
    log('改主配置规则:', result.message);
    return sendJson(res, 200, result);
  }
  if (mr && method === 'DELETE') {
    const body = await readBody(req);
    const result = await mainrules.remove(Number(mr[1]), body);
    log('删主配置规则:', result.message);
    return sendJson(res, 200, result);
  }

  if (pathname === '/api/backups' && method === 'GET') {
    return sendJson(res, 200, { backups: applier.listBackups() });
  }

  m = /^\/api\/backups\/([\w.-]+)\/restore$/.exec(pathname);
  if (m && method === 'POST') {
    const result = await applier.restoreBackup(m[1]);
    log('恢复备份', m[1]);
    return sendJson(res, 200, { ...result, state: buildState() });
  }

  if (pathname === '/api/lookup' && method === 'GET') {
    const hits = lookupConflicts(searchParams.get('type'), searchParams.get('value'));
    return sendJson(res, 200, { ok: true, hits });
  }

  if (pathname.startsWith('/api/')) {
    return sendError(res, 404, '未知接口：' + pathname);
  }

  return serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
  route(req, res, url).catch((err) => {
    log('请求失败', req.method, req.url, err.message);
    if (!res.headersSent) sendError(res, err.status || 500, err.message || '服务器内部错误');
    else res.end();
  });
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  // 自己写 PID：用 setsid 启动时 shell 拿到的 $! 可能不是真实进程
  try {
    fs.mkdirSync(path.dirname(store.APP_DIR + '/data/x'), { recursive: true });
    fs.writeFileSync(path.join(store.APP_DIR, 'data', 'server.pid'), String(process.pid));
  } catch (err) {
    log('警告: 写 PID 文件失败 ' + err.message);
  }
  log('mihomo 规则管理网页已启动: http://' + HOST + ':' + PORT + ' (PID ' + process.pid + ')');
  log('主配置:', mihomo.CONFIG_PATH);
  log('自定义规则:', store.CUSTOM_FILE);
  const st = store.dirStatus();
  if (!st.ok) log('警告:', st.error);
  mihomo
    .version()
    .then((v) => log('mihomo 版本:', v && v.version))
    .catch((e) => log('警告: 无法访问 mihomo 控制接口 (' + e.message + ')'));
});

process.on('uncaughtException', (err) => log('未捕获异常:', err.stack || err.message));
process.on('unhandledRejection', (err) => log('未处理的 Promise 拒绝:', (err && err.stack) || String(err)));
