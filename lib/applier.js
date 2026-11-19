'use strict';
/**
 * 应用流程（唯一会碰 mihomo 主配置和重载的入口）：
 *   生成 provider 文件 -> 计算主配置新区块 -> PyYAML 校验 -> 备份 -> 写入 -> 重载 -> 轮询校验 -> 失败自动回滚
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const cfg = require('./config');
const mihomo = require('./mihomo');
const { yamlValidate } = require('./yamlutil');

const MAX_BACKUPS = 60;

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  );
}

function backupConfig(text, kind) {
  fs.mkdirSync(store.BACKUP_DIR, { recursive: true });
  const id = ts() + '-' + (kind || 'apply') + '-' + sha1(text).slice(0, 6);
  const file = path.join(store.BACKUP_DIR, 'config.' + id + '.yaml');
  fs.writeFileSync(file, text, 'utf8');
  pruneBackups();
  return { id, file };
}

function pruneBackups() {
  try {
    const files = fs
      .readdirSync(store.BACKUP_DIR)
      .filter((f) => /^config\..+\.yaml$/.test(f))
      .map((f) => ({ f, m: fs.statSync(path.join(store.BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const item of files.slice(MAX_BACKUPS)) {
      fs.unlinkSync(path.join(store.BACKUP_DIR, item.f));
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

function listBackups() {
  try {
    return fs
      .readdirSync(store.BACKUP_DIR)
      .filter((f) => /^config\..+\.yaml$/.test(f))
      .map((f) => {
        const full = path.join(store.BACKUP_DIR, f);
        const st = fs.statSync(full);
        const id = f.replace(/^config\./, '').replace(/\.yaml$/, '');
        return { id, file: f, size: st.size, ts: new Date(st.mtimeMs).toLocaleString('zh-CN', { hour12: false }) };
      })
      .sort((a, b) => (a.id < b.id ? 1 : -1));
  } catch {
    return [];
  }
}

/** 同步 provider 文件：写入计划内的，删掉计划外（只动 rui- 前缀）。 */
function syncProviderFiles(plan) {
  fs.mkdirSync(store.PROVIDER_DIR, { recursive: true });
  const written = [];
  const keep = new Set();
  for (const p of plan) {
    const file = path.join(store.PROVIDER_DIR, p.provider + '.yaml');
    keep.add(p.provider + '.yaml');
    const content = cfg.providerYaml(p);
    let current = null;
    try {
      current = fs.readFileSync(file, 'utf8');
    } catch {
      current = null;
    }
    if (current !== content) {
      store.writeAtomic(file, content);
      written.push(p.provider);
    }
  }
  const removed = [];
  for (const f of fs.readdirSync(store.PROVIDER_DIR)) {
    if (!/^rui-[0-9a-f]{8}\.yaml$/.test(f)) continue;
    if (keep.has(f)) continue;
    fs.unlinkSync(path.join(store.PROVIDER_DIR, f));
    removed.push(f.replace(/\.yaml$/, ''));
  }
  return { written, removed };
}

/**
 * 应用并重载。任何一步失败都会回滚主配置并再次重载，保证 mihomo 始终回到可用状态。
 */
async function apply() {
  const started = Date.now();
  const status = store.dirStatus();
  if (!status.ok) throw Object.assign(new Error(status.error), { status: 409 });

  const rules = store.list();
  const original = cfg.readConfigText();
  const groupInfo = cfg.parseGroups(original);
  const { plan, warnings } = cfg.buildPlan(rules, groupInfo);

  const providerOps = syncProviderFiles(plan);

  const { text: nextText, changed } = cfg.applyRegions(original, plan);

  let backup = null;
  let configChanged = false;

  if (changed) {
    // 写之前先过一遍 YAML 解析，任何结构错误都不会落到磁盘
    const check = yamlValidate(nextText);
    if (!check.ok) {
      throw new Error('新配置 YAML 校验失败，已放弃写入：' + check.error);
    }
    backup = backupConfig(original, 'apply');
    fs.writeFileSync(mihomo.CONFIG_PATH, nextText, 'utf8');
    configChanged = true;
  }

  const reloadStart = Date.now();
  try {
    await mihomo.reload();
    const verify = await mihomo.verifyProviders(plan.map((p) => ({ name: p.provider, count: p.count })));
    const reloadMs = Date.now() - reloadStart;
    const rulesAfter = await mihomo.rulesSummary();
    const state = store.writeState({
      lastApply: store.nowIso(),
      lastFingerprint: store.fingerprint(rules),
      lastApplyMs: Date.now() - started,
    });
    return {
      ok: true,
      reloadMs,
      totalMs: Date.now() - started,
      providers: plan.map((p) => ({ name: p.provider, target: p.target, count: p.count })),
      verifiedProviders: verify.providers,
      configChanged,
      providerFilesWritten: providerOps.written,
      providerFilesRemoved: providerOps.removed,
      backup: backup ? backup.id : null,
      ruleCount: rulesAfter.count,
      warnings,
      lastApply: state.lastApply,
      message:
        '已应用：' + plan.length + ' 组 / ' + rules.filter((r) => r.enabled).length + ' 条规则，重载耗时 ' + reloadMs + 'ms',
    };
  } catch (err) {
    let rollbackMsg = '未修改主配置';
    if (configChanged && backup) {
      try {
        fs.writeFileSync(mihomo.CONFIG_PATH, original, 'utf8');
        await mihomo.reload();
        rollbackMsg = '已回滚到应用前配置';
      } catch (rbErr) {
        rollbackMsg = '回滚也失败了，请手工恢复备份 ' + backup.file + '：' + rbErr.message;
      }
    }
    throw new Error(err.message + '（' + rollbackMsg + '）');
  }
}

async function restoreBackup(id) {
  const item = listBackups().find((b) => b.id === id);
  if (!item) throw Object.assign(new Error('备份不存在：' + id), { status: 404 });
  const file = path.join(store.BACKUP_DIR, item.file);
  const text = fs.readFileSync(file, 'utf8');
  const check = yamlValidate(text);
  if (!check.ok) throw new Error('该备份本身不是合法 YAML，已拒绝恢复：' + check.error);

  const current = cfg.readConfigText();
  backupConfig(current, 'before-restore');
  fs.writeFileSync(mihomo.CONFIG_PATH, text, 'utf8');
  try {
    await mihomo.reload();
  } catch (err) {
    fs.writeFileSync(mihomo.CONFIG_PATH, current, 'utf8');
    try {
      await mihomo.reload();
    } catch {
      /* 尽力而为 */
    }
    throw new Error('恢复后重载失败，已还原：' + err.message);
  }
  store.writeState({ lastApply: store.nowIso(), restoredFrom: id });
  return { ok: true, message: '已恢复到备份 ' + id + ' 并重载' };
}

module.exports = { apply, restoreBackup, listBackups, backupConfig };
