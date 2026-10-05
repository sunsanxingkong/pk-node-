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

    // ★★ 2026-10-05（Android 真机修正）：cloudflared 是 **Go 静态链接**程序，
    // 它的 DNS 解析器**纯 Go 实现**，在 Linux 上只读 `/etc/resolv.conf`：
    //
    //   · Android **没有** `/etc/resolv.conf`（`/etc` 是 `/system/etc` 只读软链，
    //     且 `/` 是 erofs 只读 —— **连 root 都 remount 不了**，已实测）；
    //   · Go **不读** Android 的 `net.dns1` 属性（那是 bionic/Java 层的机制）；
    //   · 于是它退化成「去本机 53 端口查」，而 netd 并不监听那里 ——
    //     报错就是：`lookup api.trycloudflare.com on [::1]:53: connection refused`。
    //
    // 前一版我试图「写一份 resolv.conf」——**写不进去**，这条路是死的。
    // `--edge-ip-version 4` 也只是把 `::1` 换成 `127.0.0.1`，本机依旧没人监听 53。
    //
    // ## 正解：让 Node 代替它做 DNS
    //
    // 内置 Node 的 DNS 是好的（走 `getaddrinfo()` → bionic → netd）。
    // 而 Go 的 HTTP 客户端**尊重 `HTTPS_PROXY`** 且对 HTTPS 目标发 CONNECT。
    // 于是在本机起一个极小 CONNECT 代理（[./dns-proxy]），
    // **域名解析由 Node 完成**，Go 侧完全不参与 —— 问题从根上消失。
    // 不需要 root、不改系统文件、不需要重新编译 cloudflared。
    ensureDnsProxy().then((proxy) => {
      // ★ `--protocol http2` 是**必须的**：cloudflared 默认 `auto`，很可能选 **QUIC**，
      //   而 QUIC 跑在 **UDP** 上 —— HTTP CONNECT 代理只支持 TCP（Go 的
      //   `HTTPS_PROXY` 也只作用于 TCP/TLS）。走 QUIC 的话它会绕过代理直连，
      //   于是又要自己解析域名 → 回到原来的失败。
      //   强制 http2 后所有出站都是 TCP/TLS，全部经由代理。
      const args = [
        'tunnel', '--url', target, '--no-autoupdate',
        '--edge-ip-version', '4',
        '--protocol', 'http2',
      ];
      const env = { ...process.env };
      if (proxy) {
        // Go 读 HTTPS_PROXY；http_proxy/HTTP_PROXY 一并设上，覆盖不同代码路径。
        const p = 'http://127.0.0.1:' + proxy.port;
        env.HTTPS_PROXY = p;
        env.https_proxy = p;
        env.HTTP_PROXY = p;
        env.http_proxy = p;
        // ★ 关键：清空 NO_PROXY —— 否则 Go 可能对某些目标（含本机/私网）直连，
        //   那些目标又会走它自己的 DNS。
        env.NO_PROXY = '';
        env.no_proxy = '';
        pushLog('DNS 代理已启用：' + p + '（由 Node 代 Go 解析域名）');
      } else {
        pushLog('⚠ DNS 代理未启动，cloudflared 可能因无法解析域名而失败');
      }
      spawnTunnel(av, args, env, done);
    }).catch((e) => {
      pushLog('⚠ DNS 代理启动异常：' + e.message);
      spawnTunnel(av, args, { ...process.env }, done);
    });
  });
}

/**
 * 启动 cloudflared 进程并解析输出。
 *
 * 抽出来是因为它现在被两条路径调用（有/无 DNS 代理），避免重复。
 */
function spawnTunnel(av, args, env, done) {
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
}

/** 已启动的 DNS 代理（进程级单例）。 */
let dnsProxy = null;

/**
 * 按需启动 DNS 代理（只启一次）。
 *
 * @returns {Promise<{port:number}|null>} null = 启动失败（此时退回直连，行为与旧版一致）
 */
function ensureDnsProxy() {
  if (dnsProxy) return Promise.resolve(dnsProxy);
  return Promise.resolve()
    .then(() => require('./dns-proxy').create({ onLog: (l) => pushLog('[dns] ' + l) }))
    .then((p) => { dnsProxy = p; return p; })
    .catch((e) => {
      pushLog('[dns] 代理启动失败：' + e.message);
      return null;
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

// ★ 2026-10-05：原 `ensureResolvConf()` 已删除。
//
// 它尝试「读 Android 的 net.dns1 属性 → 写一份 resolv.conf」，但真机实测：
//   · `/` 是 erofs **只读**，`/etc` 是 `/system/etc` 的只读软链 —— 连 root 都写不进去；
//   · 写到临时目录也没用 —— **Go 不支持指定 resolv.conf 路径**（只读 /etc）。
// 所以那条路是死的。现改为 `dns-proxy.js`（Node 侧 CONNECT 代理），
// 让 Node 用 bionic 的 `getaddrinfo()` 代 Go 解析域名，见本文件 start() 的说明。
