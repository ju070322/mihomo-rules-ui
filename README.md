# mihomo-rules-ui

给 [mihomo](https://github.com/MetaCubeX/mihomo)（Clash.Meta）用的**分流规则管理网页**：在浏览器里增删改自定义规则，也能直接搜索并修改主配置里那几千条内置规则。改完一键重载，全程自动备份、YAML 校验、重载后回读校验，失败自动回滚。

零依赖：后端只用 Node 原生模块，前端纯 HTML/CSS/JS，不打包、不引 CDN，离线环境可用。

```
┌────────────┐   增删改   ┌──────────────┐   生成   ┌───────────────────┐
│  浏览器 UI │ ────────▶ │ custom.yaml  │ ───────▶ │ providers/rui-*.yaml│
└────────────┘           └──────────────┘          └─────────┬─────────┘
                                                             │ rule-providers 引用
┌────────────┐   PATCH    ┌──────────────┐                    ▼
│  浏览器 UI │ ────────▶ │ 主配置 rules │ ──▶ PUT /configs?force=true ──▶ 生效
└────────────┘            └──────────────┘
```

---

## 为什么需要它

mihomo 的控制接口**没有规则增删 API**，只有：

- `GET /rules` 读取
- `PATCH /rules/disable` 临时禁用（重启失效）
- `PUT /configs?force=true` 重载整份配置

想改一条规则，只能手工编辑那份动辄上兆字节的 YAML 再重载。这个项目把手动流程做成了网页，并补上手工操作最容易出错的几件事：**备份、校验、重载后验证、失败回滚**。

它提供两条互不冲突的路径：

| | 自定义规则 | 主配置规则 |
| --- | --- | --- |
| 存哪 | 独立文件（rule-provider），主配置只加几行引用 | 直接改主配置 `rules:` / `sub-rules` |
| 优先级 | 最高（插在规则列表顶部，覆盖内置规则） | 原位替换 |
| 适合 | 新增一条分流、临时改某个域名走向 | 内置规则本身写错、要删除某条内置规则 |
| 风险 | 低（可随时删掉，主配置不动） | 中（改的是核心配置，但有备份+回滚） |

**建议优先用「自定义规则」**，只有在"内置规则本身是错的"这类场景才动主配置。

---

## 特性

- **两种视图**：自定义规则（外置 rule-provider）、主配置规则（7594 条量级，实测流畅）
- **搜索**：按值 / 目标 / 类型 / 中文类型名过滤，客户端过滤，输入即出结果
- **主配置规则直接改**：改目标策略、改规则值、删除单条
- **三份列表同步**：`rules:` / `sub-rules.rule-1x` / `sub-rules.rule-2x` 按索引同步，1x/2x 目标自动加后缀
- **可选双写部署模板**：配置了模板路径时，改主配置会同时写模板，避免重新部署被覆盖
- **安全网**：写前 PyYAML 全量校验 → 备份 → 写入 → 回读校验 → 重载 → 失败自动回滚
- **并发防护**：主配置里常有重复的 `(类型,值)`（本机实测 482 组），所以按索引定位 + 内容指纹比对，配置变了返回 409 让你刷新，绝不改错行
- **备份与回滚**：网页里可直接回滚到任一历史备份
- **零依赖、离线可用、手机可用**

---

## 环境要求

- Node.js **>= 18**（用到原生 `fetch`；实测 24.x）
- Python 3 + PyYAML（用于写入前的 YAML 全量校验；缺失时可以跑，但会跳过校验，**不建议**）
- mihomo 控制接口可访问（默认 `127.0.0.1:9090`，secret 从主配置读取）

---

## 快速开始

### 1. 放置代码并配置

```bash
git clone <this-repo> mihomo-rules-ui
cd mihomo-rules-ui
cp rules-ui.env.example rules-ui.env
vi rules-ui.env          # 至少改 MIHOMO_CONFIG_PATH
```

### 2. 准备自定义规则目录

rule-provider 的 `path` 被 mihomo 限制在它的 **HomeDir** 内（容器里通常是 `/root/.config/mihomo`），所以要在这个目录下建一个可写的子目录：

```bash
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 755 /etc/mihomo/rules
```

目录位置通过 `RULES_DATA_DIR` 指定，默认是**主配置同级的 `rules/`**。

### 3. 启动

```bash
./start.sh          # 后台启动，会自动 source rules-ui.env
./status.sh         # 进程 / 健康 / 目录权限 / 最近日志
./stop.sh
```

打开 `http://<服务器IP>:3085`。

首次启动后进入「自定义规则」→ 新增一条 → 点「应用并重载」，程序会自动在主配置里插入这几行（带标记，可重复执行、可自愈）：

```yaml
rules:
# >>> rules-ui:rules:begin  (rules-ui 自动维护，删掉这段会被网页重建)
- RULE-SET,rui-3dedd768,Proxies
# <<< rules-ui:rules:end

sub-rules:
  rule-1x:
  # >>> rules-ui:rule-1x:begin
  - RULE-SET,rui-3dedd768,Proxies-1x
  # <<< rules-ui:rule-1x:end

# 文件末尾
# >>> rules-ui:providers:begin
rule-providers:
  rui-3dedd768:
    type: file
    behavior: classical
    path: "./rules/providers/rui-3dedd768.yaml"
# <<< rules-ui:providers:end
```

> 主配置里如果已经有别人写的 `rule-providers:`，会**合并进去**，不会产生重复顶层键。

---

## 配置

全部通过环境变量（`start.sh` 会自动读取同目录的 `rules-ui.env`）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MIHOMO_CONFIG_PATH` | `/etc/mihomo/config.yaml` | mihomo 主配置路径（需可读写） |
| `RULES_DATA_DIR` | `<主配置目录>/rules` | 自定义规则目录（`custom.yaml` + `providers/`） |
| `MIHOMO_TEMPLATE_PATH` | 空 | 可选。部署模板路径，设置后会双写 |
| `MIHOMO_CONTAINER_CONFIG` | `/root/.config/mihomo/config.yaml` | 容器内看到的主配置路径（`PUT /configs` 用） |
| `RULES_UI_STATE` | `./data/state.json` | 状态（上次应用指纹） |
| `RULES_UI_BACKUP_DIR` | `./data/backups` | 主配置备份目录 |
| `HOST` / `PORT` | `0.0.0.0` / `3085` | 监听地址与端口 |

**关于 `MIHOMO_TEMPLATE_PATH`**：如果你用脚本（`cp 模板 → 线上配置`）来部署 mihomo，一定要配它，否则重新部署会把网页里的改动整份覆盖掉。

---

## 使用

### 自定义规则

新增时选类型（域名后缀 / 完整域名 / 关键字 / IP 段 / GeoSite / 进程名 / 端口…）、填值、选目标策略。目标策略来自主配置里已有的代理组，选中后会提示它在 1x / 2x 出口对应的名字。

保存后顶部出现「有未应用的改动」，点**应用并重载**才生效。删除规则同样需要再点一次应用。

### 主配置规则

切换到「主配置规则」视图，搜索 7594 条内置规则（每页 50 条），可直接：

- **改目标策略** —— 例如某域名现在走 `Proxies`，改成 `DIRECT`
- **改规则值** —— 修写错的域名/CIDR（`MATCH` 兜底规则没有值，只能改目标）
- **删除** —— 从三份列表里彻底移除

每次操作**立即生效**（约 3 秒，其中 2.7 秒是两份 1.4MB 配置的 YAML 校验）。保存前会弹二次确认，说明会同时改 1x/2x 两份。

### 备份

「备份」按钮里能看到主配置的历史备份（保留最近 60 份），一键回滚。模板备份在 `data/backups-template/`（保留 40 份）。

---

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 自定义规则、代理组、元信息 |
| GET | `/api/rule-types` | 支持的规则类型 |
| POST | `/api/rules` | 新增自定义规则 |
| PUT | `/api/rules/{id}` | 修改 |
| DELETE | `/api/rules/{id}` | 删除 |
| POST | `/api/apply` | 生成 provider + 改主配置 + 重载 |
| GET | `/api/backups` | 备份列表 |
| POST | `/api/backups/{id}/restore` | 回滚到某份备份 |
| GET | `/api/main-rules` | 主配置全部规则（约 700KB，前端分页） |
| PATCH | `/api/main-rules/{index}` | 改目标/值（body 带 `expect` 做并发防护） |
| DELETE | `/api/main-rules/{index}` | 删除该条 |
| POST | `/api/main-rules/align` | 对齐部署模板与线上配置 |
| GET | `/api/lookup?type=&value=` | 查主配置里有没有会冲突的规则 |
| GET | `/api/health` | 健康检查 |

错误统一返回 `{"ok":false,"error":"..."}`，状态码：`400` 参数非法、`404` 不存在、`409` 配置已被外部修改（需刷新）、`500` 其他。

---

## 安全与可靠性

每次写配置都走同一条流水线：

```
校验索引/参数 → 三份列表平行性检查 → 生成新文本
  → PyYAML 全量校验（有模板时两份并行）
  → 备份（线上进 data/backups，模板进 data/backups-template）
  → 写入 → 回读校验行内容 → PUT /configs?force=true 重载
  → 失败：恢复全部文件并重新重载
```

几点设计取舍：

- **主配置是"外科式"修改**：只替换目标行/插入标记区块，1.4MB 其余字节原样保留。
- **改一条内置规则 = 改三个位置**（global + 1x + 2x）。三份列表实测完全平行，按索引同步。
- **一个目标一个 rule-provider**：mihomo 的 `classical` 规则集 payload 不带策略，策略由 `RULE-SET,provider,policy` 那一行决定（见 `rules/provider/rule_set.go` 的 `Match()`），所以自定义规则按目标分组各生成一个 provider。
- **不落半成品配置**：YAML 校验在写入之前，校验不过直接放弃，磁盘上不会出现坏配置。

---

## 已知限制

- 无鉴权，建议只在内网使用（与 mihomo 面板本身的安全级别一致）
- 主配置规则不支持**调整顺序**和批量操作
- 不能往主配置里**新增**规则（新增请用「自定义规则」）
- 自定义规则在规则列表最顶部，所以是"全覆盖"语义：无法只对某条内置规则做例外
- 没有内置的进程守护（systemd/cron 请自行配置；仓库提供了一个 `start.sh` 示例）

---

## 测试

```bash
npm test              # 离线自测（31 项，不依赖 mihomo，CI 可跑）
npm run lint          # 全量 node --check

# 需要真实环境的：
npm run test:regions  # 区块插入/合并/自愈（17 项，需 MIHOMO_CONFIG_PATH）
npm run test:apply    # 应用流水线（19 项，沙箱目录）
npm run test:ui       # 前端联调（37 项，DOM 桩 + 真实后端）
```

---

## 目录结构

```
.
├── server.js               HTTP 服务（路由 + 静态托管，零依赖）
├── lib/
│   ├── settings.js         环境变量集中配置
│   ├── store.js            custom.yaml 读写、校验、指纹
│   ├── config.js           主配置区块插入/合并/幂等/自愈
│   ├── applier.js          应用流水线（生成 → 校验 → 备份 → 写 → 重载 → 回滚）
│   ├── mainrules.js        主配置内置规则的搜索与修改
│   ├── mihomo.js           mihomo 控制接口客户端
│   └── yamlutil.js         YAML 校验（调用 PyYAML）+ 字符串转义
├── public/                 前端（原生 JS，无构建）
├── tools/                  自测脚本
├── start.sh / stop.sh / status.sh
└── rules-ui.env.example    环境变量样例
```

---

## License

[MIT](LICENSE)
