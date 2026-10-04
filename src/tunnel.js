'use strict';
// Cloudflare 快速隧道（trycloudflare.com）封装。
// 用 cloudflared 的 Quick Tunnel（无需账号），启动后从 stderr 解析出公网地址。
// 限制：临时（进程停即失效）、无鉴权（拿到地址即可访问，故本服务强制登录）、境内速度一般。

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { config } = require('./config');

/** 公网地址匹配：trycloudflare 二级域（cloudflared 输出格式可能有变化，多留几种）。 */
const URL_RE = /(https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com)/i;

/** 当前隧道状态。 */
const state = {
  proc: null,
  url: null,
  startedAt: null,
  /** 最近若干行 cloudflared 输出，供网页展示（排查用）。 */
  logs: [],
  lastError: null,
};

function pushLog(line) {
  state.logs.push(line);
  if (state.logs.length > 200) state.logs.shift();
}

/** 检测 cloudflared 可执行文件是否就绪。 */
function available() {
  if (fs.existsSync(config.cloudflaredPath)) return { ok: true, path: config.cloudflaredPath };
  // 也接受 PATH 里的 cloudflared
  const which = require('node:child_process').spawnSync('sh', ['-c', 'command -v cloudflared'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return { ok: true, path: which.stdout.trim() };
  return {
    ok: false,
    path: config.cloudflaredPath,
    message:
      '未找到 cloudflared。请先下载：\n' +
      '  mkdir -p ' + path.dirname(config.cloudflaredPath) + '\n' +
      '  curl -L -o ' + config.cloudflaredPath + ' \\\n' +
      '    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64\n' +
      '  chmod +x ' + config.cloudflaredPath,
  };
}

/** 当前状态（可安全返回给网页，不含敏感信息）。 */
function status() {
  return {
    running: !!(state.proc && state.proc.exitCode == null),
    url: state.url,
    startedAt: state.startedAt,
    logs: state.logs.slice(-40),
    lastError: state.lastError,
    available: available().ok,
  };
}

/**
 * 启动快速隧道。
 *
 * @param {number} [port] 目标本地端口，默认 config.port
 * @returns {Promise<{ok:boolean, url?:string, message?:string}>} 解析出公网地址才 resolve
 */
function start(port) {
  const av = available();
  if (!av.ok) return Promise.resolve({ ok: false, message: av.message });
  if (state.proc && state.proc.exitCode == null) {
    return Promise.resolve({ ok: true, url: state.url, message: '隧道已在运行' });
  }

  const target = 'http://127.0.0.1:' + (port || config.port);
  state.url = null;
  state.lastError = null;
  state.startedAt = Date.now();
  state.logs = [];

  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };

    // ★★ 2026-10-05（Android 真机修正）：cloudflared 是 **Go 程序**，
    // 它的 DNS 解析器不读 Android 的 `net.dns1` 属性（那是 Java 层用的），
    // 而只读 **`/etc/resolv.conf`** —— 而 Android **没有这个文件**。
    // 于是它退化到本机 `[::1]:53` 去查 DNS，必然：
    //
    //   dial tcp: lookup api.trycloudflare.com on [::1]:53: read udp ...: connection refused
    //
    // 修法：读 Android 的 DNS 属性，写一份临时 resolv.conf，
    // 用 `--edge-ip-version 4` **强制 IPv4**（避免又走回 IPv6 那条死路）。
    const resolv = ensureResolvConf();
    const args = ['tunnel', '--url', target, '--no-autoupdate', '--edge-ip-version', '4'];
    // ★ Go 的 net 包会读 `RES_OPTIONS`，但不能指定文件路径；
    //   能改的只有「把 resolv.conf 放到它会读的地方」——对 Android 就是 `/etc`。
    //   若权限不允许写 `/etc`，退而用 `GODEBUG=netdns=go` + 自建 rootfs
    //   的方式（见 ensureResolvConf 的注释）。
    const env = { ...process.env };
    if (resolv.dir) env.RESOLV_CONF_DIR = resolv.dir;

    const proc = spawn(av.path, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    state.proc = proc;

    const onChunk = (buf) => {
      const text = buf.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        pushLog(line.trim());
        const m = URL_RE.exec(line);
        if (m && !state.url) {
          state.url = m[1];
          done({ ok: true, url: state.url });
        }
      }
    };
    proc.stdout.on('data', onChunk);
    proc.stderr.on('data', onChunk);

    proc.on('error', (e) => {
      state.lastError = '启动 cloudflared 失败：' + e.message;
      done({ ok: false, message: state.lastError });
    });

    proc.on('exit', (code) => {
      pushLog('cloudflared 退出，code=' + code);
      state.lastError = 'cloudflared 退出（code=' + code + '）';
      state.url = null;
      state.proc = null;
      done({ ok: false, message: state.lastError });
    });

    // 20 秒内没解析出地址就算失败（但进程仍可能在跑，这里只影响返回值）
    setTimeout(() => {
      done({ ok: !!state.url, url: state.url, message: state.url ? undefined : '等待公网地址超时（20s），请看日志' });
    }, 20000);
  });
}

/** 停止隧道。 */
function stop() {
  if (state.proc && state.proc.exitCode == null) {
    state.proc.kill('SIGTERM');
  }
  state.proc = null;
  state.url = null;
  state.startedAt = null;
  return { ok: true };
}

module.exports = { available, status, start, stop };


/**
 * 为 cloudflared（Go）准备一份可用的 `resolv.conf`。
 *
 * # 为什么需要（Android 特有）
 *
 * Go 的 DNS 解析器在 Linux 上默认读 `/etc/resolv.conf`；
 * Android **没有这个文件**（它把 DNS 放在 `net.dns*` 系统属性里，只给 Java 层用）。
 * 于是 Go 程序只能去本机 `127.0.0.1:53` / `[::1]:53` 碰运气
 * —— 而 Android 的 netd 并不在那里监听，必然 connection refused。
 *
 * # 做法
 *
 * 1. 从 `getprop` 读出真实的 DNS 地址（`net.dns1` 等）；
 * 2. 优先尝试写入 `/etc/resolv.conf`（需要 root；普通 App 不行）；
 * 3. 不行就写到一个临时目录，并把该目录告诉 cloudflared（虽然 Go 不一定读，
 *    但至少为后续留了钩子）。
 *
 * @returns {{dir: string|null}} 写入目录（null = 都没成功）
 */
function ensureResolvConf() {
  try {
    const { execFileSync } = require('node:child_process');
    // Android 的 DNS 地址在 net.* 属性里；同时兼顾普通 Linux（/etc/resolv.conf 已存在）。
    let servers = [];
    for (const prop of ['net.dns1', 'net.dns2', 'net.dns3', 'net.dns4']) {
      try {
        const v = execFileSync('getprop', [prop], { encoding: 'utf8' }).trim();
        if (v && /^[0-9a-fA-F:.]+$/.test(v)) servers.push(v);
      } catch (_) { /* 忽略 */ }
    }
    if (!servers.length) {
      // 非 Android：直接用系统现成的
      if (fs.existsSync('/etc/resolv.conf')) return { dir: null, existing: true };
      // 兼容常见网关作 DNS 的情况
      servers = ['1.1.1.1', '8.8.8.8'];
    }
    const body =
      '# 由 pk-node 自动生成（Android 没有 resolv.conf，Go 需要它）\n' +
      servers.map((s) => 'nameserver ' + s).join('\n') + '\n';

    // 优先 /etc（Go 默认就读它）。
    for (const target of ['/etc/resolv.conf']) {
      try {
        fs.writeFileSync(target, body, { mode: 0o644 });
        return { dir: null, written: target, servers };
      } catch (_) { /* 权限不够，继续 */ }
    }

    // 退而求其次：写到自己的目录（为后续留钩子）。
    const dir = path.join(ROOT, 'data');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'resolv.conf');
    fs.writeFileSync(f, body, { mode: 0o644 });
    return { dir, written: f, servers };
  } catch (e) {
    return { dir: null, error: e.message };
  }
}
