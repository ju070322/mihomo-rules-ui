'use strict';
/**
 * YAML 辅助：解析交给 Python 的 PyYAML，生成由本文件负责。
 * 这样既不用引入 npm 依赖，也不会被手写解析器坑到；只在"应用"时用较慢的全量校验。
 */
const { execFileSync, execFile } = require('node:child_process');

const PY_LOAD_FULL = `
import sys, json, yaml
try:
    data = yaml.safe_load(sys.stdin.buffer.read().decode("utf-8", "replace"))
    out = {"ok": True, "data": data}
except Exception as exc:
    out = {"ok": False, "error": str(exc)}
sys.stdout.write(json.dumps(out, ensure_ascii=True))
`;

const PY_VALIDATE = `
import sys, yaml
try:
    yaml.safe_load(sys.stdin.buffer.read().decode("utf-8", "replace"))
    out = {"ok": True}
except Exception as exc:
    out = {"ok": False, "error": str(exc)}
sys.stdout.write(__import__("json").dumps(out, ensure_ascii=True))
`;

function runPython(script, text, timeout = 120000) {
  try {
    const out = execFileSync('python3', ['-c', script], {
      input: text,
      maxBuffer: 128 * 1024 * 1024,
      timeout,
    });
    return JSON.parse(out.toString('utf8'));
  } catch (err) {
    const extra = err.stderr ? '：' + err.stderr.toString('utf8').slice(0, 500) : '';
    throw new Error('调用 python3 解析 YAML 失败' + extra);
  }
}

/** 完整解析（小文件用，例如 custom.yaml）。 */
function yamlLoad(text) {
  const res = runPython(PY_LOAD_FULL, text);
  if (!res.ok) throw new Error('YAML 解析失败：' + res.error);
  return res.data;
}

/** 只校验能否解析（1.4MB 主配置用），返回 {ok, error}。 */
function yamlValidate(text) {
  const res = runPython(PY_VALIDATE, text);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** 双引号字符串转义，输出对 YAML/JSON 都安全。 */
function q(value) {
  return (
    '"' +
    String(value == null ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '')
      .replace(/\n/g, '\\n') +
    '"'
  );
}

/** 异步校验（多个大文件并行解析时用，避免串行等待） */
function yamlValidateAsync(text) {
  return new Promise((resolve, reject) => {
    const child = execFile('python3', ['-c', PY_VALIDATE], { maxBuffer: 128 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error('调用 python3 校验 YAML 失败' + (stderr ? '：' + String(stderr).slice(0, 300) : '：' + err.message)));
        return;
      }
      try {
        const res = JSON.parse(String(stdout));
        resolve(res.ok ? { ok: true } : { ok: false, error: res.error });
      } catch (e) {
        reject(new Error('解析 python3 输出失败：' + e.message));
      }
    });
    child.stdin.end(text);
  });
}

module.exports = { yamlLoad, yamlValidate, yamlValidateAsync, q };
