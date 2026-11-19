'use strict';
/**
 * 主配置（1.4MB config.yaml）的"外科式"接入：
 * 只在三个位置插一小段带标记的区块，其余字节原样保留，避免整份重写语义漂移。
 *
 *   1) rules: 顶部            -> RULE-SET,rui-xxx,<全局目标>
 *   2) sub-rules.rule-1x 顶部 -> RULE-SET,rui-xxx,<目标-1x>
 *   3) sub-rules.rule-2x 顶部 -> RULE-SET,rui-xxx,<目标-2x>
 *   4) 文件末尾               -> rule-providers: 声明（type: file / behavior: classical）
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const { CONFIG_PATH } = require('./mihomo');
const { q } = require('./yamlutil');

const BUILTIN_TARGETS = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL'];
const BUILTIN_SET = new Set(BUILTIN_TARGETS);
const IP_RULE_TYPES = new Set(['IP-CIDR', 'IP-CIDR6', 'GEOIP', 'IP-ASN']);

const REGION_PROVIDERS = 'providers';
const REGION_RULES = 'rules';
const REGION_1X = 'rule-1x';
const REGION_2X = 'rule-2x';

const BEGIN_RE = /^\s*# >>> rules-ui:([\w-]+):begin\b/;
const END_RE = /^\s*# <<< rules-ui:([\w-]+):end\b/;

function readConfigText() {
  return fs.readFileSync(CONFIG_PATH, 'utf8');
}

/** 从代理组名推导 1x/2x 变体名；不存在的变体回退为原名。 */
function parseGroups(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^proxy-groups:\s*$/.test(l));
  const names = [];
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^[A-Za-z]/.test(line)) break; // 下一个顶层键
      const m = /^-\s+name:\s*(.+?)\s*$/.exec(line);
      if (m) names.push(unquoteScalar(m[1]));
    }
  }
  const nameSet = new Set(names);
  const base = names.filter((n) => !/-1x$/.test(n) && !/-2x$/.test(n));
  const groups = base.map((name) => ({
    name,
    name1x: nameSet.has(name + '-1x') ? name + '-1x' : name,
    name2x: nameSet.has(name + '-2x') ? name + '-2x' : name,
    builtin: false,
  }));
  for (const b of BUILTIN_TARGETS) {
    groups.push({ name: b, name1x: b, name2x: b, builtin: true });
  }
  return { groups, nameSet };
}

function unquoteScalar(s) {
  s = String(s || '').trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** provider 名由目标名稳定推导，换个目标就换一组 provider，不用维护映射表。 */
function providerNameFor(target) {
  const h = crypto.createHash('sha1').update('rules-ui:' + target).digest('hex').slice(0, 8);
  return 'rui-' + h;
}

/** 目标在某个出口下的实际策略名。 */
function mapTarget(target, egress) {
  if (!egress) return target;
  if (BUILTIN_SET.has(target)) return target;
  if (target.endsWith(egress)) return target;
  return target + egress;
}

function payloadLine(rule) {
  const parts = [rule.type, rule.value];
  if (rule.noResolve && IP_RULE_TYPES.has(rule.type)) parts.push('no-resolve');
  return parts.join(',');
}

/**
 * 把规则按目标分组，产出 provider 计划（顺序 = 目标在规则列表里首次出现的顺序）。
 * @returns {{plan: Array, warnings: string[]}}
 */
function buildPlan(rules, groupInfo) {
  const enabled = rules.filter((r) => r.enabled);
  const order = [];
  const byTarget = new Map();
  const warnings = [];
  for (const r of enabled) {
    if (!byTarget.has(r.target)) {
      byTarget.set(r.target, []);
      order.push(r.target);
    }
    byTarget.get(r.target).push(r);
  }
  const plan = order.map((target) => {
    const items = byTarget.get(target);
    const provider = providerNameFor(target);
    const egress = { global: target, '1x': mapTarget(target, '-1x'), '2x': mapTarget(target, '-2x') };
    if (!BUILTIN_SET.has(target) && !groupInfo.nameSet.has(egress.global)) {
      warnings.push('目标策略「' + target + '」不在当前配置的代理组里（mihomo 可能拒绝加载）');
    }
    if (egress['1x'] !== target && !groupInfo.nameSet.has(egress['1x'])) {
      warnings.push('「' + target + '」缺少 1x 出口策略组，已回退为原名');
      egress['1x'] = target;
    }
    if (egress['2x'] !== target && !groupInfo.nameSet.has(egress['2x'])) {
      warnings.push('「' + target + '」缺少 2x 出口策略组，已回退为原名');
      egress['2x'] = target;
    }
    return {
      target,
      provider,
      count: items.length,
      payload: items.map(payloadLine),
      egress,
    };
  });
  return { plan, warnings };
}

function providerFile(pathInConfig) {
  return pathInConfig;
}

/** provider 文件内容：classical 行为 -> payload 里只有 类型,值[,no-resolve]。 */
function providerYaml(p) {
  const lines = [
    '# 由 mihomo rules-ui 自动生成，请勿手工编辑（改网页或 rules/custom.yaml）',
    '# target: ' + p.target + '  (共 ' + p.count + ' 条)',
  ];
  if (p.payload.length === 0) {
    lines.push('payload: []');
  } else {
    lines.push('payload:');
    for (const item of p.payload) lines.push('  - ' + q(item));
  }
  return lines.join('\n') + '\n';
}

function providerPathInConfig(p) {
  return './rules/providers/' + p.provider + '.yaml';
}

function regionLines(name, indent, body) {
  const pad = ' '.repeat(indent);
  const out = [pad + '# >>> rules-ui:' + name + ':begin  (rules-ui 自动维护，删掉这段会被网页重建)'];
  for (const b of body) out.push(b);
  out.push(pad + '# <<< rules-ui:' + name + ':end');
  return out;
}

function ruleSetLine(p, egressKey, indent) {
  return ' '.repeat(indent) + '- RULE-SET,' + p.provider + ',' + p.egress[egressKey];
}

function providerEntries(plan, indent) {
  const pad = ' '.repeat(indent);
  const out = [];
  for (const p of plan) {
    out.push(pad + p.provider + ':');
    out.push(pad + '  type: file');
    out.push(pad + '  behavior: classical');
    out.push(pad + '  path: ' + q(providerPathInConfig(p)));
  }
  return out;
}

/** 独立的 rule-providers 区块（配置文件里原本没有该键时使用）。 */
function providersBlock(plan) {
  if (plan.length === 0) return ['rule-providers: {}'];
  return ['rule-providers:'].concat(providerEntries(plan, 2));
}

/** 移除所有已有标记区块（含标记行本身）。 */
function stripRegions(lines) {
  const out = [];
  let skipping = null;
  for (const line of lines) {
    if (skipping) {
      const end = END_RE.exec(line);
      if (end && end[1] === skipping) skipping = null;
      continue;
    }
    const begin = BEGIN_RE.exec(line);
    if (begin) {
      skipping = begin[1];
      continue;
    }
    const stray = END_RE.exec(line);
    if (stray) continue; // 孤立的结束标记直接丢弃
    out.push(line);
  }
  return out;
}

/**
 * 生成接入后的新配置文本（幂等：同样的 plan 反复执行结果相同）。
 * @returns {{text: string, changed: boolean}}
 */
function applyRegions(text, plan) {
  const lines = stripRegions(text.split('\n'));

  // 用"操作列表 + 从后往前应用"避免插入后行号错位
  const ops = []; // {kind:'insert'|'replace', index, lines}

  const rulesIdx = lines.findIndex((l) => /^rules:\s*$/.test(l));
  if (rulesIdx < 0) throw new Error('主配置里找不到顶层 rules: 段，拒绝自动修改');
  ops.push({
    kind: 'insert',
    index: rulesIdx + 1,
    lines: regionLines(REGION_RULES, 0, plan.map((p) => ruleSetLine(p, 'global', 0))),
  });

  const subIdx = lines.findIndex((l) => /^sub-rules:\s*$/.test(l));
  if (subIdx >= 0) {
    const oneXIdx = lines.findIndex((l, i) => i > subIdx && /^ {2}rule-1x:\s*$/.test(l));
    const twoXIdx = lines.findIndex((l, i) => i > subIdx && /^ {2}rule-2x:\s*$/.test(l));
    if (oneXIdx >= 0) {
      ops.push({
        kind: 'insert',
        index: oneXIdx + 1,
        lines: regionLines(REGION_1X, 2, plan.map((p) => ruleSetLine(p, '1x', 2))),
      });
    }
    if (twoXIdx >= 0) {
      ops.push({
        kind: 'insert',
        index: twoXIdx + 1,
        lines: regionLines(REGION_2X, 2, plan.map((p) => ruleSetLine(p, '2x', 2))),
      });
    }
  }

  // rule-providers：主配置里若已存在这个顶层键（例如以后加了别的 provider），
  // 就合并进去，绝不追加第二个同名键（重复键会让 YAML 语义变得不可预期）。
  const foreignIdx = lines.findIndex((l) => /^rule-providers:/.test(l));
  if (foreignIdx >= 0) {
    const inline = /^rule-providers:\s*\{\s*\}\s*$/.test(lines[foreignIdx]);
    if (inline) {
      ops.push({
        kind: 'replace',
        index: foreignIdx,
        lines: ['rule-providers:'].concat(
          regionLines(REGION_PROVIDERS, 2, providerEntries(plan, 2)),
        ),
      });
    } else {
      ops.push({
        kind: 'insert',
        index: foreignIdx + 1,
        lines: regionLines(REGION_PROVIDERS, 2, providerEntries(plan, 2)),
      });
    }
  } else {
    let tail = lines.length;
    while (tail > 0 && lines[tail - 1].trim() === '') tail -= 1;
    ops.push({
      kind: 'insert',
      index: tail,
      lines: regionLines(REGION_PROVIDERS, 0, providersBlock(plan)),
    });
  }

  ops.sort((a, b) => b.index - a.index);
  for (const op of ops) {
    if (op.kind === 'replace') lines.splice(op.index, 1, ...op.lines);
    else lines.splice(op.index, 0, ...op.lines);
  }

  const next = lines.join('\n');
  return { text: next, changed: next !== text };
}

function regionsInstalled(text) {
  return (
    text.includes('# >>> rules-ui:' + REGION_RULES + ':begin') &&
    text.includes('# >>> rules-ui:' + REGION_PROVIDERS + ':begin')
  );
}

module.exports = {
  BUILTIN_TARGETS,
  BUILTIN_SET,
  readConfigText,
  parseGroups,
  providerNameFor,
  mapTarget,
  buildPlan,
  providerYaml,
  providerPathInConfig,
  applyRegions,
  regionsInstalled,
  stripRegions,
};
