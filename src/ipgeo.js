'use strict';
/**
 * IP 归属查询（国家 / 省州 / 城市 / 运营商）。
 *
 * 双数据源策略（主 → 备）：
 *  1. 百度 opendata（HTTPS，约 140ms，中文「山西省太原市 电信」）— 主源
 *  2. ip-api.com（HTTP 免费，约 1.5s，结构化国家/省/市/ISP）— 兜底
 *
 * 特性：
 *  - 结果**内存缓存 24h**（查询失败的 null 也缓存，避免反复打空转）；
 *  - 内网 / 非法 IP 直接判定，不外呼；
 *  - 两次查询都失败时静默返回 null，**绝不影响登录主流程**。
 */

const https = require('node:https');
const http = require('node:http');

const CACHE = new Map(); // ip -> { geo, at }
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const INFLIGHT = new Map(); // ip -> Promise

const PRIVATE_RE = [
  /^10\./, /^127\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^::1$/, /^fc/i, /^fd/i, /^fe80/i,
];

function isPrivateIp(ip) {
  if (!ip) return true;
  const s = String(ip).replace(/^::ffff:/, ''); // IPv4-mapped IPv6
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return true;
  return PRIVATE_RE.some((re) => re.test(s));
}

/** 归并成一句话展示：「中国 山西省太原市 · 电信」。全空返回 null。 */
function formatGeo(g) {
  if (!g) return null;
  const loc = [g.country, g.region, g.city].filter(Boolean).join(' ');
  const isp = g.isp || '';
  if (!loc && !isp) return null;
  return loc + (isp ? (loc ? ' · ' : '') + isp : '');
}

/** 通用 GET → JSON（带超时，失败 resolve(null)）。 */
function getJson(url, timeoutMs, headers) {
  return new Promise((resolve) => {
    let lib;
    try { lib = new URL(url).protocol === 'https:' ? https : http; } catch (e) { return resolve(null); }
    const req = lib.get(url, { timeout: timeoutMs, headers: headers || {} }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/**
 * 源 1：百度 opendata。返回 location 形如「山西省太原市 电信」/「美国」/「北京市 联通」。
 * 做一次粗解析：省（含「省/市/自治区/特别行政区」）→ 市 → 运营商。
 */
async function viaBaidu(ip) {
  const url = 'https://opendata.baidu.com/api.php?query=' + encodeURIComponent(ip) +
    '&co=&resource_id=6006&oe=utf8&format=json';
  const j = await getJson(url, 4000, { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' });
  if (!j || j.status !== '0' || !Array.isArray(j.data) || !j.data.length) return null;
  const loc = String(j.data[0].location || '').trim();
  if (!loc) return null;

  // 拆「省市 运营商」
  let text = loc, isp = '';
  const seg = loc.split(/\s+/);
  if (seg.length >= 2) { text = seg[0]; isp = seg.slice(1).join(' '); }

  let country = '', region = '', city = '';
  if (/^(中国)?(北京|上海|天津|重庆)/.test(text)) {
    country = '中国';
    city = text.replace(/^中国/, '');
    region = city;
  } else if (text.indexOf('中国') === 0 || /省|自治区|特别行政区/.test(text)) {
    country = '中国';
    const m = /^中国?([^省]+省|[\u4e00-\u9fa5]+自治区|香港特别行政区|澳门特别行政区)?(.*)$/.exec(text);
    if (m) { region = (m[1] || '').trim(); city = (m[2] || '').trim(); }
    if (!region && !city) { region = text.replace(/^中国/, ''); }
  } else {
    // 纯国家名（如「美国」）
    country = text;
  }
  const geo = { country, region, city, isp, source: 'baidu' };
  geo.label = formatGeo(geo);
  return geo;
}

/** 源 2：ip-api.com（兜底，结构化字段更细）。 */
async function viaIpApi(ip) {
  const url = 'http://ip-api.com/json/' + encodeURIComponent(ip) +
    '?lang=zh-CN&fields=status,country,regionName,city,isp';
  const j = await getJson(url, 5000, {});
  if (!j || j.status !== 'success') return null;
  const geo = {
    country: j.country || '', region: j.regionName || '', city: j.city || '',
    isp: j.isp || '', source: 'ip-api',
  };
  geo.label = formatGeo(geo);
  return geo;
}

/**
 * 查询单个 IP 的归属（带缓存 + 双源兜底）。
 * @param {string} ip
 * @returns {Promise<{country:string,region:string,city:string,isp:string,label:string,source:string}|null>}
 */
function lookup(ip) {
  const s = String(ip || '').trim();
  if (!s) return Promise.resolve(null);
  const cached = CACHE.get(s);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.geo);
  if (INFLIGHT.has(s)) return INFLIGHT.get(s);

  if (isPrivateIp(s)) {
    const geo = { country: '内网', region: '', city: '', isp: '', label: '内网/本机', source: 'local' };
    CACHE.set(s, { geo, at: Date.now() });
    return Promise.resolve(geo);
  }

  const p = (async () => {
    let geo = null;
    try { geo = await viaBaidu(s); } catch (e) { geo = null; }
    if (!geo) { try { geo = await viaIpApi(s); } catch (e) { geo = null; } }
    CACHE.set(s, { geo, at: Date.now() });
    return geo;
  })().finally(() => INFLIGHT.delete(s));

  INFLIGHT.set(s, p);
  return p;
}

/**
 * 批量查询（去重 + 并发限流，最多 10 个并发）。
 * @param {string[]} ips
 * @returns {Promise<Record<string, object|null>>}
 */
async function lookupMany(ips, concurrency = 10) {
  const uniq = Array.from(new Set((ips || []).map((x) => String(x || '').trim()).filter(Boolean)));
  const out = {};
  let idx = 0;
  async function worker() {
    while (idx < uniq.length) {
      const ip = uniq[idx++];
      const c = CACHE.get(ip);
      out[ip] = (c && Date.now() - c.at < CACHE_TTL_MS)
        ? c.geo
        : await lookup(ip).catch(() => null);
    }
  }
  const n = Math.min(concurrency, Math.max(1, uniq.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

module.exports = { lookup, lookupMany, formatGeo, isPrivateIp };
