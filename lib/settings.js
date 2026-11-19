'use strict';
/**
 * 集中配置：全部来自环境变量，默认值都是通用路径。
 *
 * 环境变量：
 *   MIHOMO_CONFIG_PATH        mihomo 主配置路径          默认 /etc/mihomo/config.yaml
 *   RULES_DATA_DIR            自定义规则数据目录          默认 <主配置目录>/rules
 *   MIHOMO_TEMPLATE_PATH      可选的部署模板（双写目标）   默认空 = 不启用双写
 *   MIHOMO_CONTAINER_CONFIG   容器内看到的主配置路径       默认 /root/.config/mihomo/config.yaml
 *   RULES_UI_STATE            状态文件                    默认 <应用目录>/data/state.json
 *   RULES_UI_BACKUP_DIR       主配置备份目录              默认 <应用目录>/data/backups
 *   HOST / PORT               监听地址 / 端口             默认 0.0.0.0 / 3085
 */
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const CONFIG_PATH = path.resolve(env('MIHOMO_CONFIG_PATH', '/etc/mihomo/config.yaml'));
// mihomo 要求 rule-provider 的 path 落在它的 HomeDir 内，所以默认放在主配置同级
const DATA_DIR = path.resolve(env('RULES_DATA_DIR', path.join(path.dirname(CONFIG_PATH), 'rules')));
// 可选的"部署模板"：设置后，改主配置会同时写模板，避免重新部署时被覆盖
const TEMPLATE_PATH = env('MIHOMO_TEMPLATE_PATH', '')
  ? path.resolve(process.env.MIHOMO_TEMPLATE_PATH)
  : '';

const CONTAINER_CONFIG = env('MIHOMO_CONTAINER_CONFIG', '/root/.config/mihomo/config.yaml');

const STATE_FILE = path.resolve(env('RULES_UI_STATE', path.join(APP_DIR, 'data', 'state.json')));
const BACKUP_DIR = path.resolve(env('RULES_UI_BACKUP_DIR', path.join(APP_DIR, 'data', 'backups')));
const TEMPLATE_BACKUP_DIR = path.join(APP_DIR, 'data', 'backups-template');
const PUBLIC_DIR = path.join(APP_DIR, 'public');

const HOST = env('HOST', '0.0.0.0');
const PORT = Number(env('PORT', '3085'));

module.exports = {
  APP_DIR,
  CONFIG_PATH,
  DATA_DIR,
  TEMPLATE_PATH,
  CONTAINER_CONFIG,
  STATE_FILE,
  BACKUP_DIR,
  TEMPLATE_BACKUP_DIR,
  PUBLIC_DIR,
  HOST,
  PORT,
};
