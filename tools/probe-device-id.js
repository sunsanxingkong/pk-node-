// 一次性探针：看账号 cookie 里有没有 YFD_U / deviceId / userid。
const db = require('/root/pk-node/src/db');
const config = require('/root/pk-node/src/config');
(async () => {
  try { await db.init(); } catch (e) { console.log('init err', e.message); }
  const acc = db.getLeoAccount(2);
  if (!acc) { console.log('no account 2'); return; }
  console.log('keys:', Object.keys(acc).join(','));
  console.log('yfd_u:', acc.yfd_u);
  const cks = (() => { try { return JSON.parse(acc.cookies_json); } catch (e) { return []; } })();
  const arr = Array.isArray(cks) ? cks : [];
  console.log('cookie count:', arr.length);
  console.log('names:', arr.map((c) => c.name + '@' + c.domain).join(' | '));
  for (const n of ['YFD_U', 'deviceId', 'userid', 'ks_deviceid']) {
    const c = arr.find((x) => String(x.name).toLowerCase() === n.toLowerCase());
    console.log('  ', n, '=>', c ? String(c.value).slice(0, 40) : '(无)');
  }
})();
