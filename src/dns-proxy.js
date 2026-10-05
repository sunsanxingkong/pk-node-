// 本地 CONNECT 代理 —— 给「不读 Android DNS 的 Go 程序」（cloudflared）用。
//
// ============================================================================
// 为什么需要它（2026-10-05 定案）
// ============================================================================
//
// cloudflared 是 **Go 静态链接**程序，它的 DNS 解析器是**纯 Go 实现**，
// 在 Linux 上只读 `/etc/resolv.conf`：
//
//   · Android **没有** `/etc/resolv.conf`（`/etc` 是 `/system/etc` 的只读软链，
//     且 `/` 是 erofs 只读，**连 root 也不能 remount**——已真机实测）；
//   · Go **不读** Android 的 `net.dns1` 属性（那是 Java/bionic 层的机制）；
//   · 于是它退化成「去本机 53 端口查」，而 netd 并不监听那里；
//     报错就是：`lookup api.trycloudflare.com on [::1]:53: read: udp ...: connection refused`
//   · `--edge-ip-version 4` 也不行：它只是把 `::1` 换成 `127.0.0.1`，
//     本机仍然没有人监听 53。
//
// 之前我试过「写 resolv.conf」，但**写不进去**（只读系统分区）。死路。
//
// ============================================================================
// 解法：让 Node 替它解析 DNS
// ============================================================================
//
// 关键观察：**内置的 Node 自己 DNS 是好的** —— 它走 `getaddrinfo()`，
// 由 bionic libc 转给 Android netd，所以能正常解析。
//
// 而 Go 的 HTTP 客户端**尊重 `HTTPS_PROXY` 环境变量**，并且对 HTTPS 目标
// 会发 **HTTP CONNECT** 请求。
//
// 所以在 Node 里起一个极小的 CONNECT 代理：
//
//   ① cloudflared 要连 api.trycloudflare.com:443
//   ② 它把 `CONNECT api.trycloudflare.com:443` 发给 127.0.0.1:<port>
//   ③ Node 用**自己的** DNS（bionic → netd）解析出 IP
//   ④ Node 连上真目标，之后就是这么一条字节透传的双向管道
//
// 域名解析这件事**根本不需要 Go 参与**，问题从根上消失。
// 而且不需要 root、不需要改系统文件、不需要重新编译 cloudflared。
//
// 安全性：代理**只监听 127.0.0.1**，不做任何转发规则、不缓存、不记录正文，
// 仅对回环地址上的本进程可用。

'use strict';

const net = require('node:net');

/** CONNECT 请求行：`CONNECT host:port HTTP/1.1` */
const CONNECT_RE = /^CONNECT\s+([^\s:]+):(\d+)\s+HTTP\/1\.[01]\s*$/i;

/**
 * 建一个只监听回环的 CONNECT 代理。
 *
 * @param {{onLog?: (line: string) => void}} [opts]
 * @returns {Promise<{port: number, close: () => void}>} 端口随机（由内核分配）
 */
function create(opts) {
  const onLog = (opts && opts.onLog) || (() => {});

  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.on('connection', (client) => {
      let settled = false;
      let buffered = '';

      const fail = (code, msg) => {
        if (settled) return;
        settled = true;
        try {
          client.write('HTTP/1.1 ' + code + ' ' + msg + '\r\n\r\n');
        } catch (_) { /* 忽略 */ }
        client.destroy();
      };

      // CONNECT 请求很小（几十字节），给 8KB 上限防止被喂垃圾。
      const onData = (chunk) => {
        buffered += chunk.toString('latin1');
        if (buffered.length > 8192) { fail(400, 'Bad Request'); return; }
        const idx = buffered.indexOf('\r\n');
        if (idx < 0) return; // 头还没收完

        const requestLine = buffered.slice(0, idx);
        const m = CONNECT_RE.exec(requestLine);
        if (!m) { fail(405, 'Method Not Allowed'); return; }

        const host = m[1];
        const port = parseInt(m[2], 10);

        client.removeListener('data', onData);

        // ★ 关键一步：用 Node 的 DNS（= Android bionic）解析，而不是让 Go 去解析。
        const upstream = net.connect({ host, port }, () => {
          if (settled) return;
          settled = true;
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          // 之后就是纯字节透传（TLS 握手在里面进行，我们不解析）。
          upstream.pipe(client);
          client.pipe(upstream);
          onLog('CONNECT ' + host + ':' + port + ' → ok');
        });

        upstream.on('error', (e) => {
          onLog('CONNECT ' + host + ':' + port + ' → 失败：' + e.message);
          fail(502, 'Bad Gateway');
        });
        client.on('error', () => { try { upstream.destroy(); } catch (_) {} });
        client.on('close', () => { try { upstream.destroy(); } catch (_) {} });

        // 连上游最多等 15 秒（DNS 慢/网络差时不至于永久挂着）。
        upstream.setTimeout(15000, () => {
          onLog('CONNECT ' + host + ':' + port + ' → 超时');
          fail(504, 'Gateway Timeout');
          upstream.destroy();
        });
        upstream.on('connect', () => upstream.setTimeout(0));
      };

      client.on('data', onData);
      client.on('error', () => { /* 客户端断开，忽略 */ });
    });

    server.on('error', reject);

    // ★ 只绑定 127.0.0.1，端口传 0 让内核分配（避免和别的服务抢端口）。
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      onLog('本地 CONNECT 代理已就绪：127.0.0.1:' + port);
      resolve({
        port,
        close: () => { try { server.close(); } catch (_) {} },
      });
    });
  });
}

module.exports = { create };
