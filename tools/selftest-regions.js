const cfg = require('../lib/config');
const { yamlValidate } = require('../lib/yamlutil');
const fs = require('node:fs');
const CONFIG = process.env.MIHOMO_CONFIG_PATH || '/etc/mihomo/config.yaml';
const base = fs.readFileSync(CONFIG,'utf8');
const gi = cfg.parseGroups(base);
const rules = [
  {id:'r_1',type:'DOMAIN-SUFFIX',value:'example.com',target:'🎯Direct',enabled:true,noResolve:false},
  {id:'r_2',type:'IP-CIDR',value:'1.2.3.0/24',target:'Proxies',enabled:true,noResolve:true},
  {id:'r_3',type:'DOMAIN',value:'a.test',target:'DIRECT',enabled:false,noResolve:false},
];
let fails = 0;
const check = (name, cond, extra='') => { console.log((cond?'PASS':'FAIL')+' '+name+(extra?'  '+extra:'')); if(!cond) fails++; };

// 1. 基本插入 + 幂等
const plan1 = cfg.buildPlan(rules, gi).plan;
const a1 = cfg.applyRegions(base, plan1);
const a2 = cfg.applyRegions(a1.text, plan1);
check('基本插入 changed', a1.changed);
check('幂等', a2.text === a1.text);
check('YAML 合法', yamlValidate(a1.text).ok);
check('只出现一次 rule-providers', (a1.text.match(/^rule-providers:/gm)||[]).length === 1);
check('rules 段新增 2 条 RULE-SET', (a1.text.match(/^- RULE-SET,/gm)||[]).length === 2);
check('1x 段新增 2 条', (a1.text.match(/^  - RULE-SET,/gm)||[]).length === 4);

// 2. 空计划
const a3 = cfg.applyRegions(base, []);
check('空计划 YAML 合法', yamlValidate(a3.text).ok);
check('空计划 rule-providers: {}', a3.text.includes('rule-providers: {}'));
const a3b = cfg.applyRegions(a3.text, []);
check('空计划幂等', a3b.text === a3.text);

// 3. 已存在外部 rule-providers（模拟用户以后自己加 provider）
const foreign = base.replace(/^profile:/m, 'rule-providers:\n  other:\n    type: file\n    behavior: classical\n    path: ./rules/other.yaml\n\nprofile:');
const a4 = cfg.applyRegions(foreign, plan1);
check('合并外部 rule-providers 后 YAML 合法', yamlValidate(a4.text).ok);
check('合并后仍只有一个 rule-providers 键', (a4.text.match(/^rule-providers:/gm)||[]).length === 1);
check('合并后外部 provider 保留', a4.text.includes('    path: ./rules/other.yaml'));
check('合并后我们的 provider 也在', a4.text.includes('rui-'));
const a5 = cfg.applyRegions(a4.text, plan1);
check('合并模式幂等', a5.text === a4.text);

// 4. 配置被外部脚本重生成（标记丢失）后能自愈
const reset = cfg.applyRegions(base, plan1).text;
const wiped = cfg.stripRegions(reset.split('\n')).join('\n');
check('模拟重生成后不再有标记', !cfg.regionsInstalled(wiped));
const healed = cfg.applyRegions(wiped, plan1);
check('自愈后与首次结果一致', healed.text === a1.text);
check('自愈后 YAML 合法', yamlValidate(healed.text).ok);

console.log(fails === 0 ? '\n全部通过' : '\n失败 '+fails+' 项');
process.exit(fails === 0 ? 0 : 1);
