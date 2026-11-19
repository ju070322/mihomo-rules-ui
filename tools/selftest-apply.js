// 沙箱测试「应用」流水线：不碰真实的 mihomo，reload/verify 用桩替换。
const fs = require('node:fs');
const path = require('node:path');
const store = require('../lib/store');
const mihomo = require('../lib/mihomo');
const applier = require('../lib/applier');

mihomo.reload = async () => true;
mihomo.verifyProviders = async (exp) => ({ providers: exp.length, attempts: 1 });
mihomo.rulesSummary = async () => ({ count: 7594 });

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? '  ' + extra : ''));
  if (!cond) fails++;
};

(async () => {
  const cfgPath = mihomo.CONFIG_PATH;
  const original = fs.readFileSync(cfgPath, 'utf8');
  fs.rmSync(store.DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(store.DATA_DIR, { recursive: true });

  check('沙箱数据目录', store.dirStatus().ok, store.DATA_DIR);

  store.add({ type: 'DOMAIN-SUFFIX', value: 'test-rule.example', target: '🎯Direct', desc: '沙箱' });
  store.add({ type: 'IP-CIDR', value: '10.9.8.0/24', target: 'Proxies', noResolve: true });
  check('custom.yaml 已生成', fs.existsSync(store.CUSTOM_FILE));
  check('规则数 = 2', store.list().length === 2);

  const r1 = await applier.apply();
  check('首次 apply ok', r1.ok === true);
  check('配置有改动', r1.configChanged === true);
  check('provider 2 个', r1.providers.length === 2, JSON.stringify(r1.providers.map(p => p.name + ':' + p.count)));
  check('写了 2 个 provider 文件', r1.providerFilesWritten.length === 2);

  const providers = fs.readdirSync(store.PROVIDER_DIR).filter(f => /^rui-/.test(f));
  check('provider 文件落盘', providers.length === 2, providers.join(','));
  const one = fs.readFileSync(path.join(store.PROVIDER_DIR, providers[0]), 'utf8');
  check('provider 内容含 payload', /^payload:$/m.test(one));

  const text1 = fs.readFileSync(cfgPath, 'utf8');
  check('主配置含 rules 区块', text1.includes('# >>> rules-ui:rules:begin'));
  check('主配置含 providers 区块', /^rule-providers:$/m.test(text1));

  const r2 = await applier.apply();
  check('二次 apply 无配置改动', r2.configChanged === false);
  check('二次 apply 不重写 provider', r2.providerFilesWritten.length === 0);

  // 删掉一个目标下的所有规则 -> provider 应被清理
  const rules = store.list();
  const direct = rules.find(r => r.target === '🎯Direct');
  store.remove(direct.id);
  const r3 = await applier.apply();
  check('删除后 provider 只剩 1 个', r3.providers.length === 1);
  check('失效 provider 文件被清理', r3.providerFilesRemoved.length === 1, r3.providerFilesRemoved.join(','));

  // 全部删掉 -> 空计划
  for (const r of store.list()) store.remove(r.id);
  const r4 = await applier.apply();
  check('空计划 providers=0', r4.providers.length === 0);
  check('空计划配置合法', fs.readFileSync(cfgPath, 'utf8').includes('rule-providers: {}'));

  // pending 计算
  const st = JSON.parse(fs.readFileSync(store.STATE_FILE, 'utf8'));
  check('state 记录了 lastFingerprint', typeof st.lastFingerprint === 'string');

  check('备份已生成', applier.listBackups().length >= 2, String(applier.listBackups().length));

  // 还原沙箱配置
  fs.writeFileSync(cfgPath, original, 'utf8');
  console.log(fails === 0 ? '\n全部通过' : '\n失败 ' + fails + ' 项');
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('异常:', e); process.exit(1); });
