# mihomo-rules-ui

A **web UI for managing [mihomo](https://github.com/MetaCubeX/mihomo) (Clash.Meta) routing rules** — add/edit/delete custom rules as rule-provider files, and search / edit / delete the thousands of built-in rules in the main config. Every change is backed up, YAML-validated, verified after reload, and rolled back automatically on failure.

Zero dependencies: Node built-in modules only, plain HTML/CSS/JS frontend, no bundler, no CDN — works offline.

> 中文文档见 [README.md](README.md)

---

## Why

mihomo's control API has **no rule mutation endpoints** — only `GET /rules`, temporary `PATCH /rules/disable`, and a whole-config `PUT /configs?force=true`. Changing one rule means hand-editing a multi-megabyte YAML and reloading.

This project turns that manual workflow into a web UI and adds the parts humans get wrong: **backup, validation, post-reload verification, automatic rollback**.

Two independent paths:

| | Custom rules | Main-config rules |
| --- | --- | --- |
| Stored in | separate rule-provider files (config only references them) | the main config itself |
| Priority | highest (inserted at top of the rule list) | in place |
| Use for | adding routes, overriding a domain | fixing/deleting a wrong built-in rule |
| Risk | low (config untouched) | medium (backed up + rollback) |

**Prefer custom rules.** Only touch the main config when a built-in rule is itself wrong.

---

## Features

- Two views: custom rules, and main-config rules (7,500+ entries, paged)
- Instant client-side search over value / target / type
- Edit target policy, edit value, delete single rule — for built-in rules too
- Keeps `rules:` / `sub-rules.rule-1x` / `sub-rules.rule-2x` in sync (1x/2x targets get the `-1x`/`-2x` suffix automatically)
- Optional **dual-write to a deployment template** so re-deploying doesn't wipe your edits
- Safety pipeline: full YAML validation → backup → write → read-back verify → reload → auto rollback
- Concurrency guard: duplicate `(type, value)` pairs are common, so edits are index-based and fingerprinted; a changed config returns `409` instead of editing the wrong line
- Backup browser with one-click restore
- Zero deps, offline, mobile friendly

---

## Requirements

- Node.js **>= 18** (uses native `fetch`)
- Python 3 + PyYAML (for pre-write YAML validation; strongly recommended)
- Reachable mihomo control API (default `127.0.0.1:9090`, secret read from the config)

---

## Quick start

```bash
git clone <this-repo> mihomo-rules-ui
cd mihomo-rules-ui
cp rules-ui.env.example rules-ui.env
vi rules-ui.env                      # set MIHOMO_CONFIG_PATH at least

# rule-provider paths must live inside mihomo's HomeDir
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 755 /etc/mihomo/rules

./start.sh                           # reads rules-ui.env automatically
./status.sh
```

Open `http://<host>:3085`, add a custom rule, click **Apply & reload**. The tool will insert a small marked block into your config (idempotent, self-healing) and create one rule-provider per target policy.

---

## Configuration

All via environment variables (auto-loaded from `rules-ui.env` by `start.sh`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `MIHOMO_CONFIG_PATH` | `/etc/mihomo/config.yaml` | main config (needs read+write) |
| `RULES_DATA_DIR` | `<config dir>/rules` | where `custom.yaml` + `providers/` live |
| `MIHOMO_TEMPLATE_PATH` | *(empty)* | optional deployment template for dual-write |
| `MIHOMO_CONTAINER_CONFIG` | `/root/.config/mihomo/config.yaml` | config path as seen inside the container |
| `RULES_UI_STATE` | `./data/state.json` | state file |
| `RULES_UI_BACKUP_DIR` | `./data/backups` | backup directory |
| `HOST` / `PORT` | `0.0.0.0` / `3085` | listen address / port |

---

## Safety model

```
validate index/params → verify the three rule lists are parallel → build new text
  → full YAML validation (both files in parallel when a template is configured)
  → backup both files
  → write → read back and verify the exact lines → PUT /configs?force=true
  → on any failure: restore every file and reload again
```

The main config is edited "surgically": only the target line is replaced or a marked block is inserted — the other ~1.4 MB stays byte-identical. A broken config never reaches disk, because validation happens before writing.

---

## Limitations

- No authentication — keep it on a trusted network (same level as the mihomo dashboard)
- Main-config rules: no reordering, no bulk operations
- Cannot *add* rules to the main config (use custom rules)
- Custom rules sit at the very top of the rule list, so they fully override built-in rules
- No process supervision included (pair `start.sh` with systemd/cron yourself)

---

## Tests

```bash
npm test              # offline self-test (31 checks, no mihomo needed — CI-ready)
npm run lint          # node --check over every file

# need a real environment:
npm run test:regions  # region insert/merge/self-heal (17 checks)
npm run test:apply    # apply pipeline (19 checks, sandboxed)
npm run test:ui       # frontend integration (37 checks, DOM stub + live backend)
```

---

## License

[MIT](LICENSE)
