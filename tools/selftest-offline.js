'use strict';
/**
 * 离线自测：用一份合成的迷你 mihomo 配置验证纯逻辑，不读写任何真实文件。
 * 适合在 CI / 没有 mihomo 的机器上跑：`npm test`
 */
const cfg = require('../lib/config');
const mainrules = require('../lib/mainrules');

const CONFIG = `mode: rule
log-level: info
secret: dummy-secret
proxy-groups:
- name: Proxies
  type: select
  proxies:
  - DIRECT
- name: Proxies-1x
  type: select
  proxies:
  - DIRECT
- name: Proxies-2x
  type: select
  proxies:
  - DIRECT
rules:
- DOMAIN-SUFFIX,a.example,Proxies
- IP-CIDR,10.0.0.0/8,Proxies,no-resolve
- MATCH,Proxies
sub-rules:
  rule-1x:
  - DOMAIN-SUFFIX,a.example,Proxies-1x
  - IP-CIDR,10.0.0.0/8,Proxies-1x,no-resolve
  - MATCH,Proxies-1x
  rule-2x:
  - DOMAIN-SUFFIX,a.example,Proxies-2x
  - IP-CIDR,10.0.0.0/8,Proxies-2x,no-resolve
  - MATCH,Proxies-2x
`;

let fails = 0;
let checks = 0;
function check(name, cond, extra) {
  checks += 1;
  if (!cond) fails += 1;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra && !cond ? '  → ' + extra : ''));
}

/* 1. 三个规则段解析 */
const { sec, regionCount } = mainrules.scan(CONFIG);
check('global 段解析出 3 条', sec.global.length === 3, String(sec.global.length));
check('rule-1x 段解析出 3 条', sec['rule-1x'].length === 3, String(sec['rule-1x'].length));
check('rule-2x 段解析出 3 条', sec['rule-2x'].length === 3, String(sec['rule-2x'].length));
check('no-resolve 被识别为参数', sec.global[1].params.includes('no-resolve'), JSON.stringify(sec.global[1].params));
check('MATCH 的目标解析正确', sec.global[2].type === 'MATCH' && sec.global[2].target === 'Proxies', JSON.stringify(sec.global[2]));
check('行号从 1 开始且递增', sec.global[0].lineNo < sec.global[1].lineNo);

/* 2. rules-ui 自己插入的区块必须被跳过 */
const withRegion = CONFIG.replace(
  'rules:\n',
  'rules:\n# >>> rules-ui:rules:begin\n- RULE-SET,rui-1234abcd,Proxies\n# <<< rules-ui:rules:end\n',
);
const scanned = mainrules.scan(withRegion);
check('跳过 rules-ui 插入的 RULE-SET 行', scanned.sec.global.length === 3, String(scanned.sec.global.length));
check('regionCount 记录了 1 行', scanned.regionCount.global === 1, String(scanned.regionCount.global));

/* 3. 代理组解析与目标映射 */
const { groups, nameSet } = cfg.parseGroups(CONFIG);
// groups 只列"基础组"（供下拉框用），-1x/-2x 变体只在 nameSet 里
check('解析出 1 个基础策略组', groups.filter((g) => !g.builtin).length === 1, String(groups.filter((g) => !g.builtin).length));
check('三个策略名都在 nameSet', ['Proxies', 'Proxies-1x', 'Proxies-2x'].every((n) => nameSet.has(n)));
check('含内置策略', groups.some((g) => g.builtin && g.name === 'DIRECT'));
check('nameSet 含 -1x 变体', nameSet.has('Proxies-1x'));
check('策略组映射到 -1x', cfg.mapTarget('Proxies', '-1x') === 'Proxies-1x');
check('内置策略不加上缀', cfg.mapTarget('DIRECT', '-1x') === 'DIRECT');
check('已带后缀不重复加', cfg.mapTarget('Proxies-1x', '-1x') === 'Proxies-1x');
check('全局映射保持原名', cfg.mapTarget('Proxies', '') === 'Proxies');

/* 4. provider 名稳定推导 */
check('provider 名确定且带前缀', /^rui-[0-9a-f]{8}$/.test(cfg.providerNameFor('Proxies')));
check('同一目标名稳定', cfg.providerNameFor('Proxies') === cfg.providerNameFor('Proxies'));
check('不同目标名不同', cfg.providerNameFor('Proxies') !== cfg.providerNameFor('DIRECT'));

/* 5. 主配置区块插入：幂等 / 只插一次 / 自愈 */
const plan = [
  { target: 'Proxies', provider: 'rui-aaaaaaaa', count: 1, payload: ['DOMAIN-SUFFIX,a.example'], egress: { global: 'Proxies', '1x': 'Proxies-1x', '2x': 'Proxies-2x' } },
];
const once = cfg.applyRegions(CONFIG, plan);
check('首次插入有改动', once.changed === true);
check('插入后仍是合法结构（含 rule-providers）', /^rule-providers:$/m.test(once.text));
const twice = cfg.applyRegions(once.text, plan);
check('重复插入幂等', twice.text === once.text);
check('只出现一个 rule-providers 键', (once.text.match(/^rule-providers:/gm) || []).length === 1);
check('RULE-SET 行插入到 rules 顶部', /rules:\n# >>> rules-ui:rules:begin[\s\S]*RULE-SET,rui-aaaaaaaa,Proxies/.test(once.text));
check('1x 段使用 -1x 目标', /RULE-SET,rui-aaaaaaaa,Proxies-1x/.test(once.text));
check('2x 段使用 -2x 目标', /RULE-SET,rui-aaaaaaaa,Proxies-2x/.test(once.text));
check('regionsInstalled 判定正确', cfg.regionsInstalled(once.text) === true);
check('空 plan 得到 rule-providers: {}', cfg.applyRegions(CONFIG, []).text.includes('rule-providers: {}'));

/* 6. 已存在外部 rule-providers 时合并，不产生重复顶层键 */
const withForeign = CONFIG.replace(
  'mode: rule\n',
  'mode: rule\nrule-providers:\n  other:\n    type: file\n    behavior: classical\n    path: ./rules/other.yaml\n',
);
const merged = cfg.applyRegions(withForeign, plan);
check('合并外部 provider 后只有一个 rule-providers 键', (merged.text.match(/^rule-providers:/gm) || []).length === 1);
check('外部 provider 保留', merged.text.includes('path: ./rules/other.yaml'));
check('我们的 provider 也写入', merged.text.includes('rui-aaaaaaaa'));

console.log('\n' + (fails === 0 ? '全部通过' : '失败 ' + fails + ' 项') + '（共 ' + checks + ' 项）');
process.exit(fails === 0 ? 0 : 1);
