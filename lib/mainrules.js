'use strict';
/**
 * 主配置（7594 条内置规则）的搜索与修改。
 *
 * 关键事实（已实测确认）：
 *   - rules: / sub-rules.rule-1x / sub-rules.rule-2x 三份列表**完全平行**，
 *     同一索引对应同一条规则，只有 target 带 -1x / -2x 后缀。
 *   - 因此编辑/删除按「索引」在三份里同步处理，改完写回线上配置 + 部署模板两份。
 *   - 有 482 组重复的 (类型,值)，所以不能用内容定位，必须用索引 + 内容校验做并发防护。
 */
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');
const mihomo = require('./mihomo');
const store = require('./store');
const { yamlValidateAsync } = require('./yamlutil');
const settings = require('./settings');

// 可选的"部署模板"双写目标；未配置时只写线上配置（单文件模式）
const TEMPLATE_PATH = settings.TEMPLATE_PATH;
const TEMPLATE_BACKUP_DIR = settings.TEMPLATE_BACKUP_DIR;
const TEMPLATE_ENABLED = !!TEMPLATE_PATH;

const SECTIONS = ['global', 'rule-1x', 'rule-2x'];
const REGION_BEGIN = /^\s*# >>> rules-ui:[\w-]+:begin/;
const REGION_END = /^\s*# <<< rules-ui:[\w-]+:end/;
const MAX_BACKUPS = 40;

let lock = Promise.resolve();

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function serialize(task) {
  const run = lock.then(task, task);
  lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  );
}

function parseRecord(lineNo, indent, body) {
  const parts = body.split(',');
  const type = (parts[0] || '').trim();
  if (!type) return null;
  if (type === 'MATCH') {
    return { lineNo, indent, type, value: '', target: (parts[1] || '').trim(), params: [] };
  }
  if (parts.length < 3) return null;
  return {
    lineNo,
    indent,
    type,
    value: (parts[1] || '').trim(),
    target: (parts[2] || '').trim(),
    params: parts
      .slice(3)
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

function buildBody(type, value, target, params) {
  if (type === 'MATCH') return [type, target].join(',');
  return [type, value, target].concat(params || []).join(',');
}

/** 扫描文本，返回三个规则段的记录（行号 1-based），跳过 rules-ui 自己的标记区块。 */
function scan(text) {
  const lines = text.split('\n');
  const out = { global: [], 'rule-1x': [], 'rule-2x': [] };
  const regionCount = { global: 0, 'rule-1x': 0, 'rule-2x': 0 };
  let state = null;
  let inRegion = false;
  let regionSection = null;

  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i];
    if (REGION_BEGIN.test(ln)) {
      inRegion = true;
      regionSection = state;
      continue;
    }
    if (REGION_END.test(ln)) {
      inRegion = false;
      regionSection = null;
      continue;
    }
    if (/^rules:\s*$/.test(ln)) {
      state = 'global';
      continue;
    }
    if (/^sub-rules:\s*$/.test(ln)) {
      state = 'sub';
      continue;
    }
    if (state === 'sub' || state === 'rule-1x' || state === 'rule-2x') {
      const m = /^ {2}(rule-1x|rule-2x):\s*$/.exec(ln);
      if (m) {
        state = m[1];
        continue;
      }
    }
    if (/^[A-Za-z]/.test(ln)) {
      state = null;
      continue;
    }
    if (!state || state === 'sub') continue;

    const m = /^(\s*)-\s+(.*\S)\s*$/.exec(ln);
    if (!m) continue;
    if (inRegion) {
      // rules-ui 插入的 RULE-SET 行：不算主配置规则，但影响 /rules 里的偏移量
      if (regionSection === state || regionSection === 'global' || regionSection === null) {
        regionCount[state] += 1;
      }
      continue;
    }
    const rec = parseRecord(i + 1, m[1], m[2]);
    if (rec) out[state].push(rec);
  }
  return { sec: out, regionCount };
}

function readScanned(file) {
  const text = fs.readFileSync(file, 'utf8');
  const { sec, regionCount } = scan(text);
  return { file, text, lines: text.split('\n'), sec, regionCount };
}

function keyOf(rec) {
  return rec.type === 'MATCH' ? 'MATCH' : rec.type + '\u0000' + rec.value;
}

function isAligned(live, tmpl) {
  for (const s of SECTIONS) {
    if (live.sec[s].length !== tmpl.sec[s].length) return false;
    for (let i = 0; i < live.sec[s].length; i += 1) {
      if (keyOf(live.sec[s][i]) !== keyOf(tmpl.sec[s][i])) return false;
    }
  }
  return true;
}

/** 列出主配置全部规则（target 取全局那份，不带 -1x/-2x） */
function list() {
  const live = readScanned(mihomo.CONFIG_PATH);
  let tmpl = null;
  let tmplError = null;
  if (TEMPLATE_ENABLED) {
    try {
      tmpl = readScanned(TEMPLATE_PATH);
    } catch (err) {
      tmplError = err.message;
    }
  }
  const rules = live.sec.global.map((r, i) => ({
    i,
    type: r.type,
    value: r.value,
    target: r.target,
    noResolve: r.params.includes('no-resolve'),
    line: r.lineNo,
  }));
  return {
    ok: true,
    total: rules.length,
    aligned: TEMPLATE_ENABLED ? (tmpl ? isAligned(live, tmpl) : false) : true,
    templateEnabled: TEMPLATE_ENABLED,
    templatePath: TEMPLATE_PATH,
    templateError: tmplError,
    offset: live.regionCount.global,
    rules,
  };
}

function checkExpect(rec, expect) {
  if (!expect || typeof expect !== 'object') return;
  if (expect.type !== undefined && String(expect.type) !== rec.type) {
    throw fail(409, '配置已被外部修改（类型不符），请点「刷新」重新加载');
  }
  if (expect.value !== undefined && String(expect.value) !== rec.value) {
    throw fail(409, '配置已被外部修改（规则值不符），请点「刷新」重新加载');
  }
  if (expect.target !== undefined && String(expect.target) !== rec.target) {
    throw fail(409, '配置已被外部修改（目标不符），请点「刷新」重新加载');
  }
}

function validateTargets(liveText, targets) {
  // 必须用 nameSet：parseGroups().groups 只含基础组名，不含 -1x/-2x 变体
  const { nameSet } = cfg.parseGroups(liveText);
  for (const t of targets) {
    if (cfg.BUILTIN_SET.has(t)) continue;
    if (!nameSet.has(t)) {
      throw fail(400, '目标策略「' + t + '」不在当前配置的代理组里，会导致 mihomo 拒绝加载');
    }
  }
}

function backupFile(file, dir, prefix, text) {
  fs.mkdirSync(dir, { recursive: true });
  const name = prefix + '.' + ts() + '-' + Math.random().toString(16).slice(2, 8) + '.yaml';
  const full = path.join(dir, name);
  fs.writeFileSync(full, text, 'utf8');
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix + '.'))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const item of files.slice(MAX_BACKUPS)) fs.unlinkSync(path.join(dir, item.f));
  } catch {
    /* 清理失败不影响主流程 */
  }
  return full;
}

/** 生成两个文件的新文本 */
function buildNewTexts({ live, tmpl, index, kind, newTarget, newValue }) {
  const cur = live.sec.global[index];
  const liveLines = live.lines.slice();
  const tmplLines = tmpl ? tmpl.lines.slice() : null;
  const delLive = new Set();
  const delTmpl = new Set();

  const mapping = {
    global: newTarget,
    'rule-1x': cfg.mapTarget(newTarget, '-1x'),
    'rule-2x': cfg.mapTarget(newTarget, '-2x'),
  };

  for (const s of SECTIONS) {
    const lr = live.sec[s][index];
    if (!lr) throw fail(409, '三份规则列表长度不一致（' + s + '），无法安全修改，请刷新后重试');
    if (keyOf(lr) !== keyOf(cur)) throw fail(409, '线上三份列表不平行（' + s + '），已中止');
    const tr = tmpl ? tmpl.sec[s][index] : null;
    if (tmpl) {
      if (!tr) throw fail(409, '模板规则数不足（' + s + '），请先「对齐模板」');
      if (keyOf(tr) !== keyOf(lr)) throw fail(409, '模板与线上规则不对应（' + s + '），请先「对齐模板」');
    }

    if (kind === 'delete') {
      delLive.add(lr.lineNo);
      if (tr) delTmpl.add(tr.lineNo);
    } else {
      liveLines[lr.lineNo - 1] = lr.indent + '- ' + buildBody(lr.type, newValue, mapping[s], lr.params);
      if (tr) tmplLines[tr.lineNo - 1] = tr.indent + '- ' + buildBody(tr.type, newValue, mapping[s], tr.params);
    }
  }

  const joinFiltered = (lines, del) => lines.filter((_, i) => !del.has(i + 1)).join('\n');
  return {
    liveText: joinFiltered(liveLines, delLive),
    tmplText: tmplLines ? joinFiltered(tmplLines, delTmpl) : null,
    mapping,
  };
}

async function mutate(kind, index, body) {
  const live = readScanned(mihomo.CONFIG_PATH);
  let tmpl = null;
  if (TEMPLATE_ENABLED) {
    try {
      tmpl = readScanned(TEMPLATE_PATH);
    } catch (err) {
      throw fail(409, '读不到部署模板 ' + TEMPLATE_PATH + '：' + err.message);
    }
  }

  const g = live.sec.global;
  if (!Number.isInteger(index) || index < 0 || index >= g.length) {
    throw fail(404, '规则索引超出范围：' + index);
  }
  const cur = g[index];
  checkExpect(cur, body && body.expect);
  if (tmpl && !isAligned(live, tmpl)) {
    throw fail(409, '模板与线上的规则区不一致，请先点「对齐模板」再修改');
  }

  let newTarget = cur.target;
  let newValue = cur.value;

  if (kind === 'patch') {
    if (body.target !== undefined && body.target !== null) {
      const t = String(body.target).trim();
      if (!t) throw fail(400, '目标策略不能为空');
      if (/[\n\r,]/.test(t)) throw fail(400, '目标策略名不能包含换行或逗号');
      newTarget = t;
    }
    if (body.value !== undefined && body.value !== null) {
      if (cur.type === 'MATCH') throw fail(400, 'MATCH 是兜底规则，没有匹配值，只能改目标策略');
      const v = String(body.value).trim();
      if (!v) throw fail(400, '规则值不能为空');
      if (/[\n\r]/.test(v)) throw fail(400, '规则值不能包含换行');
      if (v.includes(',')) throw fail(400, '规则值不能包含英文逗号');
      newValue = v;
    }
    if (newTarget === cur.target && newValue === cur.value) throw fail(400, '没有做任何修改');
  }

  validateTargets(live.text, [cfg.mapTarget(newTarget, '-1x'), cfg.mapTarget(newTarget, '-2x')]);

  const { liveText, tmplText, mapping } = buildNewTexts({
    live,
    tmpl,
    index,
    kind,
    newTarget,
    newValue,
  });

  // 写入前并行校验（有模板时两份一起校验）
  const checks = await Promise.all(
    [yamlValidateAsync(liveText)].concat(tmplText === null ? [] : [yamlValidateAsync(tmplText)]),
  );
  if (!checks[0].ok) throw fail(500, '线上配置 YAML 校验失败，已放弃写入：' + checks[0].error);
  if (checks[1] && !checks[1].ok) throw fail(500, '模板配置 YAML 校验失败，已放弃写入：' + checks[1].error);

  const liveBackup = backupFile(mihomo.CONFIG_PATH, store.BACKUP_DIR, 'config', live.text);
  const tmplBackup = tmpl ? backupFile(TEMPLATE_PATH, TEMPLATE_BACKUP_DIR, 'template', tmpl.text) : null;

  const expectCount = g.length - (kind === 'delete' ? 1 : 0);
  const reloadStart = Date.now();
  try {
    fs.writeFileSync(mihomo.CONFIG_PATH, liveText, 'utf8');
    if (tmplText !== null) fs.writeFileSync(TEMPLATE_PATH, tmplText, 'utf8');

    // 落盘后立刻回读校验：确认写到了正确的行
    const after = readScanned(mihomo.CONFIG_PATH);
    if (after.sec.global.length !== expectCount) {
      throw new Error('回读校验失败：规则数 ' + after.sec.global.length + ' ≠ 期望 ' + expectCount);
    }
    if (kind === 'patch') {
      const rec = after.sec.global[index];
      const want = cfg.mapTarget(newTarget, '');
      if (!rec || rec.target !== want || rec.value !== newValue) {
        throw new Error('回读校验失败：第 ' + (index + 1) + ' 条内容不是预期值');
      }
      if (tmplText !== null) {
        const tmplAfter = readScanned(TEMPLATE_PATH);
        if (tmplAfter.sec['rule-1x'][index].target !== cfg.mapTarget(newTarget, '-1x')) {
          throw new Error('回读校验失败：模板 1x 段未同步');
        }
      }
    }

    await mihomo.reload();
    const reloadMs = Date.now() - reloadStart;

    const detail = kind === 'delete' ? '已删除' : '已修改';
    return {
      ok: true,
      message:
        detail + '第 ' + (index + 1) + ' 条规则（' + cur.type + ' ' + cur.value + ' → ' + mapping.global + '），' +
        '线上配置与模板已同步，重载 ' + reloadMs + 'ms',
      reloadMs,
      total: expectCount,
      aligned: true,
      backup: path.basename(liveBackup),
      templateBackup: tmplBackup ? path.basename(tmplBackup) : null,
      rule:
        kind === 'delete'
          ? null
          : {
              i: index,
              type: cur.type,
              value: newValue,
              target: mapping.global,
              noResolve: cur.params.includes('no-resolve'),
              line: after.sec.global[index].lineNo,
            },
    };
  } catch (err) {
    // 任一环节失败：两份都回滚，再重载一次
    let rollbackMsg = '已回滚两份配置';
    try {
      fs.writeFileSync(mihomo.CONFIG_PATH, live.text, 'utf8');
      if (tmpl) fs.writeFileSync(TEMPLATE_PATH, tmpl.text, 'utf8');
      await mihomo.reload();
    } catch (rbErr) {
      rollbackMsg = '回滚失败，请手工用 ' + liveBackup + ' 恢复：' + rbErr.message;
    }
    throw fail(500, err.message + '（' + rollbackMsg + '）');
  }
}

function patch(index, body) {
  return serialize(() => mutate('patch', index, body || {}));
}

function remove(index, body) {
  return serialize(() => mutate('delete', index, body || {}));
}

/** 把线上有、模板缺的规则（仅限"开头缺几条"这种情形）补进模板，让两边索引对齐。 */
function align() {
  return serialize(async () => {
    if (!TEMPLATE_ENABLED) {
      return { ok: true, aligned: true, message: '未配置部署模板（MIHOMO_TEMPLATE_PATH），只写线上配置，无需对齐' };
    }
    const live = readScanned(mihomo.CONFIG_PATH);
    const tmpl = readScanned(TEMPLATE_PATH);
    if (isAligned(live, tmpl)) return { ok: true, aligned: true, message: '模板已经和线上一致，无需对齐' };

    const liveKeys = live.sec.global.map(keyOf);
    const tmplKeys = tmpl.sec.global.map(keyOf);
    const missing = liveKeys.length - tmplKeys.length;
    if (missing <= 0) {
      throw fail(409, '模板的规则数不少于线上，差异不是「开头缺几条」，无法自动对齐，请手工处理');
    }

    // 找 k：模板 == 线上.slice(k)
    let k = -1;
    for (let cand = 0; cand + tmplKeys.length <= liveKeys.length; cand += 1) {
      let ok = true;
      for (let j = 0; j < tmplKeys.length; j += 1) {
        if (tmplKeys[j] !== liveKeys[cand + j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        k = cand;
        break;
      }
    }
    if (k < 0) throw fail(409, '模板与线上的规则差异无法自动对齐（不是简单的开头缺失），请手工处理');

    // 三个段各自校验平行性后再插入
    for (const s of SECTIONS) {
      const lk = live.sec[s].map(keyOf);
      const tk = tmpl.sec[s].map(keyOf);
      if (tk.length !== tmplKeys.length) throw fail(409, s + ' 段长度与其他段不一致，已中止');
      for (let j = 0; j < tk.length; j += 1) {
        if (tk[j] !== lk[k + j]) throw fail(409, s + ' 段与 global 段不对应（第 ' + j + ' 条），已中止');
      }
    }

    const tmplLines = tmpl.lines.slice();
    const inserts = [];
    for (const s of SECTIONS) {
      const records = tmpl.sec[s];
      const indent = s === 'global' ? '' : '  ';
      const newLines = [];
      for (let m = 0; m < k; m += 1) {
        const src = live.sec[s][m];
        newLines.push(indent + '- ' + buildBody(src.type, src.value, src.target, src.params));
      }
      let at;
      if (records.length > 0) {
        at = records[0].lineNo - 1;
      } else {
        const headerRe = s === 'global' ? /^rules:\s*$/ : new RegExp('^ {2}' + s + ':\\s*$');
        const hi = tmplLines.findIndex((l) => headerRe.test(l));
        if (hi < 0) throw fail(409, '模板里找不到 ' + s + ' 段，已中止');
        at = hi + 1;
      }
      inserts.push({ at, lines: newLines });
    }

    inserts.sort((a, b) => b.at - a.at);
    for (const ins of inserts) tmplLines.splice(ins.at, 0, ...ins.lines);
    const newTmplText = tmplLines.join('\n');

    const check = await yamlValidateAsync(newTmplText);
    if (!check.ok) throw fail(500, '对齐后的模板 YAML 校验失败，已放弃：' + check.error);

    backupFile(TEMPLATE_PATH, TEMPLATE_BACKUP_DIR, 'template', tmpl.text);
    fs.writeFileSync(TEMPLATE_PATH, newTmplText, 'utf8');

    const after = readScanned(TEMPLATE_PATH);
    if (!isAligned(readScanned(mihomo.CONFIG_PATH), after)) {
      throw fail(500, '对齐后回读校验失败，模板可能已损坏，请从 data/backups-template/ 恢复');
    }
    return {
      ok: true,
      aligned: true,
      inserted: k,
      message: '已把线上独有的 ' + k + ' 条规则补进模板（三份列表），现在两边索引一致',
    };
  });
}

module.exports = { TEMPLATE_PATH, TEMPLATE_BACKUP_DIR, TEMPLATE_ENABLED, list, patch, remove, align, scan };
