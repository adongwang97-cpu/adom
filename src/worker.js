/**
 * 阿東寫真站 — 後台 Worker（D1 版，不做圖片上傳；圖片仍靠 git push 進 photos/）
 * 公開路由：
 *   GET  /api/photos.json        合併「git 內建照片」+ D1 排序/刪除狀態，給前台用
 * 後台路由（需登入，密碼比對 env.ADMIN_PASS）：
 *   POST /api/admin/login        {password} → 設簽章 cookie
 *   POST /api/admin/logout
 *   GET  /api/admin/check        目前是否已登入 + D1 是否已綁定
 *   GET  /api/admin/data         後台編輯用的完整資料(所有分類/照片/文案)
 *   POST /api/admin/photo/delete {cat, file}   軟刪除(不動 git 檔案，只是不顯示)
 *   POST /api/admin/photo/order  {cat, order:[filename,...]}
 *   POST /api/admin/story        {cat, text}
 *   POST /api/admin/section      新增/更新分類 {k, n, ic, d}
 *   POST /api/admin/section/delete  {k}
 *   POST /api/admin/section/order   {order:[k,...]}
 *   POST /api/admin/theme        {theme}
 * 抖內（OxaPay，免商戶KYC，跟 picks168 同一套簽章邏輯）：
 *   POST /api/donate/create      {tier, name} → 建發票，回 pay_url
 *   POST /api/donate/webhook     OxaPay 付款完成回調（header HMAC 簽章）
 *   GET  /api/donate/status      ?order=xxx → 感謝頁輪詢用
 *   GET  /api/supporters         公開，感謝牆用（最近抖內暱稱，來自 donations 表）
 * 其餘 → 靜態檔(env.ASSETS)
 *
 * 需要的 CF 綁定：D1(binding名稱=DB) + Secrets(ADMIN_PASS/ADMIN_SECRET/OXAPAY_API_KEY)
 * 表格首次使用自動建立(CREATE TABLE IF NOT EXISTS)，不用手動貼 SQL。
 */

const COOKIE_NAME = 'admin_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 天

// ── 抖內三階：改這裡數字/文案即可，不用動邏輯 ──
const DONATE_TIERS = {
  bronze: { n: '應援 Bronze', usd: 5, perks: ['解鎖 🔒解鎖專區 全部高清寫真', '感謝牆掛名'] },
  silver: { n: 'VIP Silver', usd: 15, perks: ['以上全部', '私密 TG 頻道（獨家影片・搶先看）'] },
  gold: { n: '摯友 Gold', usd: 30, perks: ['以上全部', '每月 1 則阿東親自回覆', '感謝牆置頂金色標示'] },
};
const DEFAULT_SECTIONS = [
  { k: 'soccer', n: '世足賽系列', ic: 'i-bolt', d: '跟著世界盃一起瘋 —— 球場邊最亮的那個就是我，穿上球衣為我的主隊尖叫 ⚽' },
  { k: 'cafe', n: '下午茶系列', ic: 'i-cam', d: '沒有比賽的午後，一杯咖啡、一點慵懶 —— 這是只給你們看的悠閒時光 ☕' },
  { k: 'life', n: '生活照系列', ic: 'i-heart', d: '沒有濾鏡的日常，最真實、最放鬆的阿東，都在這裡 ♡' },
];
const ALLOWED_ICONS = new Set(['i-heart', 'i-cam', 'i-bolt', 'i-spark', 'i-lock', 'i-dice', 'i-coin']);

const json = (data, status = 200, extraHeaders) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(extraHeaders || {}) },
});

// ── HMAC 簽章 cookie（不依賴任何套件，Web Crypto 內建）──
const enc = new TextEncoder(), dec = new TextDecoder();
function b64u(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(str) { str = str.replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; const bin = atob(str); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
async function hmacKey(secret) { return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function sign(payload, secret) { const body = b64u(enc.encode(JSON.stringify(payload))); const key = await hmacKey(secret); const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body)); return `${body}.${b64u(new Uint8Array(sig))}`; }
async function verify(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, unb64u(sig), enc.encode(body));
    if (!ok) return null;
    const p = JSON.parse(dec.decode(unb64u(body)));
    if (p.exp && Date.now() / 1000 > p.exp) return null;
    return p;
  } catch { return null; }
}
function getCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function requireAdmin(request, env) {
  if (!env.ADMIN_SECRET) return false;
  const p = await verify(getCookie(request, COOKIE_NAME), env.ADMIN_SECRET);
  return !!(p && p.admin);
}

// ── D1：首次使用自動建表，不用手動貼 SQL ──
let schemaReady = false;
async function ensureSchema(env) {
  if (!env.DB || schemaReady) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS sections (k TEXT PRIMARY KEY, n TEXT NOT NULL, ic TEXT NOT NULL DEFAULT 'i-cam', d TEXT DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS photo_state (cat TEXT NOT NULL, file TEXT NOT NULL, sort_order INTEGER, deleted INTEGER DEFAULT 0, PRIMARY KEY (cat, file))`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
    `CREATE TABLE IF NOT EXISTS donations (order_id TEXT PRIMARY KEY, tier TEXT NOT NULL, name TEXT, amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')), paid_at TEXT)`,
  ];
  try {
    for (const s of stmts) await env.DB.prepare(s).run();
    schemaReady = true;
  } catch { /* 下次請求再試 */ }
}

async function getSetting(env, key, def) {
  if (!env.DB) return def;
  try { const r = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first(); return r ? r.value : def; } catch { return def; }
}
async function setSetting(env, key, value) {
  if (!env.DB) return;
  await env.DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, value).run();
}

async function getSections(env) {
  if (!env.DB) return DEFAULT_SECTIONS;
  try {
    const { results } = await env.DB.prepare('SELECT k,n,ic,d FROM sections ORDER BY sort_order ASC, rowid ASC').all();
    if (results && results.length) return results;
  } catch { /* fall through */ }
  return DEFAULT_SECTIONS;
}

// ── 讀 git 內建的靜態 photos.json（每個分類的「原始」照片清單，圖片本身仍由 git push 管理）──
async function getStaticPhotos(request, env) {
  try {
    const r = await env.ASSETS.fetch(new Request(new URL('/photos.json', request.url), { method: 'GET' }));
    if (!r.ok) return {};
    return await r.json();
  } catch { return {}; }
}

// ── 合併靜態照片 + D1 排序/刪除狀態，產出前台/後台都能用的完整資料 ──
async function buildMerged(request, env) {
  const [staticPhotos, sections] = await Promise.all([getStaticPhotos(request, env), getSections(env)]);
  let stateRows = [];
  if (env.DB) {
    try { stateRows = (await env.DB.prepare('SELECT cat, file, sort_order, deleted FROM photo_state').all()).results || []; } catch { /* ignore */ }
  }
  const byCat = {};
  for (const r of stateRows) { (byCat[r.cat] = byCat[r.cat] || []).push(r); }

  const photos = {};
  for (const k of Object.keys(staticPhotos)) {
    const state = byCat[k] || [];
    const deleted = new Set(state.filter(r => r.deleted).map(r => r.file));
    const orderMap = new Map(state.filter(r => r.sort_order != null).map(r => [r.file, r.sort_order]));
    let list = (staticPhotos[k] || []).filter(f => !deleted.has(f));
    if (orderMap.size) {
      list = list.slice().sort((a, b) => {
        const oa = orderMap.has(a) ? orderMap.get(a) : 9999, ob = orderMap.has(b) ? orderMap.get(b) : 9999;
        return oa - ob;
      });
    }
    if (list.length) photos[k] = list;
  }
  const theme = await getSetting(env, 'theme', 'glam');
  return { photos, sections, theme };
}

function sanitizeKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24); }

// ── OxaPay：與 picks168(functions/api/pay/_oxapay.js) 同一套 API 合約，
//    但務必用「阿東自己的」商戶 key（env.OXAPAY_API_KEY），不可共用 picks168 那組（footprint 隔離）──
const OXA_INVOICE_API = 'https://api.oxapay.com/v1/payment/invoice';
async function oxaCreateInvoice(env, { amount, order_id, callbackUrl, returnUrl, description }) {
  const res = await fetch(OXA_INVOICE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', merchant_api_key: env.OXAPAY_API_KEY },
    body: JSON.stringify({ amount: Number(amount), currency: 'USD', to_currency: 'USDT', lifetime: 60, callback_url: callbackUrl, return_url: returnUrl, order_id, description: description || '阿東抖內' }),
  });
  const data = await res.json().catch(() => ({}));
  const body = data && data.data ? data.data : data;
  return { ok: res.ok, pay_url: body && (body.payment_url || body.pay_link), track_id: body && body.track_id, raw: data };
}
async function oxaVerifySign(rawBody, headerSig, apiKey) {
  try {
    if (!headerSig || !apiKey) return false;
    const key = await crypto.subtle.importKey('raw', enc.encode(apiKey), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
    const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
    return hex === String(headerSig).toLowerCase();
  } catch { return false; }
}
const OXA_PAID = new Set(['Paid', 'paid']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;
    await ensureSchema(env);

    try {
      // ── 公開：前台合併資料 ──
      if (p === '/api/photos.json' && method === 'GET') {
        const { photos, sections, theme } = await buildMerged(request, env);
        return json({ ...photos, __sections: sections, __theme: theme });
      }

      // ── 公開：抖內三階 → 建 OxaPay 發票 ──
      if (p === '/api/donate/create' && method === 'POST') {
        if (!env.OXAPAY_API_KEY) return json({ error: 'gateway_not_configured', hint: '尚未設定 OXAPAY_API_KEY(阿東自己的商戶key，不可跟 picks168 共用)' }, 503);
        if (!env.DB) return json({ error: 'db_not_bound', hint: '請先在 CF 綁定 D1(binding名稱=DB)' }, 503);
        const body = await request.json().catch(() => ({}));
        const tierKey = sanitizeKey(body.tier);
        const tier = DONATE_TIERS[tierKey];
        if (!tier) return json({ error: 'bad_tier' }, 400);
        const name = String(body.name || '').replace(/[<>]/g, '').slice(0, 24);
        const order_id = `dn_${tierKey}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const origin = url.origin;
        const inv = await oxaCreateInvoice(env, {
          amount: tier.usd, order_id,
          callbackUrl: `${origin}/api/donate/webhook`,
          returnUrl: `${origin}/?paid=${order_id}`,
          description: `阿東抖內・${tier.n}`,
        });
        if (!inv.ok || !inv.pay_url) return json({ error: 'invoice_failed', raw: inv.raw }, 502);
        await env.DB.prepare('INSERT INTO donations (order_id, tier, name, amount, status) VALUES (?,?,?,?,\'pending\')')
          .bind(order_id, tierKey, name, tier.usd).run();
        return json({ ok: true, order_id, pay_url: inv.pay_url });
      }

      // ── 公開：OxaPay webhook（付款完成回調）──
      if (p === '/api/donate/webhook' && method === 'POST') {
        if (!env.OXAPAY_API_KEY || !env.DB) return new Response('not_configured', { status: 503 });
        const raw = await request.text();
        const sig = request.headers.get('HMAC') || request.headers.get('hmac');
        if (!(await oxaVerifySign(raw, sig, env.OXAPAY_API_KEY))) return new Response('bad_sign', { status: 401 });
        let data; try { data = JSON.parse(raw); } catch { return new Response('bad_json', { status: 400 }); }
        const orderId = data.order_id || '';
        if (orderId && OXA_PAID.has(data.status)) {
          await env.DB.prepare("UPDATE donations SET status='paid', paid_at=datetime('now') WHERE order_id=? AND status!='paid'").bind(orderId).run();
        }
        return new Response('OK', { status: 200 });
      }

      // ── 公開：感謝頁輪詢付款狀態 ──
      if (p === '/api/donate/status' && method === 'GET') {
        const order = url.searchParams.get('order') || '';
        if (!env.DB) return json({ status: 'unknown' });
        const rec = await env.DB.prepare('SELECT status, tier FROM donations WHERE order_id=?').bind(order).first().catch(() => null);
        if (!rec) return json({ status: 'unknown' });
        return json({ status: rec.status, tier: rec.tier });
      }

      // ── 公開：感謝牆(來自已付款的抖內紀錄) ──
      if (p === '/api/supporters' && method === 'GET') {
        if (!env.DB) return json({ list: [] });
        const { results } = await env.DB.prepare(
          "SELECT name, tier, paid_at FROM donations WHERE status='paid' AND name IS NOT NULL AND name!='' ORDER BY paid_at DESC LIMIT 20"
        ).all().catch(() => ({ results: [] }));
        return json({ list: (results || []).map(r => ({ name: r.name, tier: r.tier, ts: r.paid_at })) });
      }

      // ── 後台：登入 ──
      if (p === '/api/admin/login' && method === 'POST') {
        if (!env.ADMIN_PASS || !env.ADMIN_SECRET) return json({ error: 'admin_not_configured', hint: '尚未在 CF 設定 ADMIN_PASS / ADMIN_SECRET' }, 503);
        const body = await request.json().catch(() => ({}));
        if (String(body.password || '') !== String(env.ADMIN_PASS)) return json({ error: 'wrong_password' }, 401);
        const token = await sign({ admin: true, exp: Math.floor(Date.now() / 1000) + MAX_AGE }, env.ADMIN_SECRET);
        return json({ ok: true }, 200, { 'set-cookie': `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}` });
      }
      if (p === '/api/admin/logout' && method === 'POST') {
        return json({ ok: true }, 200, { 'set-cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
      }
      if (p === '/api/admin/check' && method === 'GET') {
        const ok = await requireAdmin(request, env);
        return json({ authed: ok, db: !!env.DB, configured: !!(env.ADMIN_PASS && env.ADMIN_SECRET) });
      }

      // ── 以下都要登入 ──
      if (p.startsWith('/api/admin/')) {
        const authed = await requireAdmin(request, env);
        if (!authed) return json({ error: 'unauthorized' }, 401);

        if (p === '/api/admin/data' && method === 'GET') {
          const { photos, sections } = await buildMerged(request, env);
          return json({ photos, sections });
        }

        if (p === '/api/admin/photo/delete' && method === 'POST') {
          if (!env.DB) return json({ error: 'db_not_bound' }, 503);
          const { cat, file } = await request.json().catch(() => ({}));
          if (!cat || !file) return json({ error: 'missing_params' }, 400);
          await env.DB.prepare('INSERT INTO photo_state (cat,file,deleted) VALUES (?,?,1) ON CONFLICT(cat,file) DO UPDATE SET deleted=1').bind(cat, file).run();
          return json({ ok: true });
        }

        if (p === '/api/admin/photo/order' && method === 'POST') {
          if (!env.DB) return json({ error: 'db_not_bound' }, 503);
          const { cat, order } = await request.json().catch(() => ({}));
          if (!cat || !Array.isArray(order)) return json({ error: 'missing_params' }, 400);
          for (let i = 0; i < order.length; i++) {
            await env.DB.prepare('INSERT INTO photo_state (cat,file,sort_order) VALUES (?,?,?) ON CONFLICT(cat,file) DO UPDATE SET sort_order=excluded.sort_order')
              .bind(cat, order[i], i).run();
          }
          return json({ ok: true });
        }

        if (p === '/api/admin/story' && method === 'POST') {
          if (!env.DB) return json({ error: 'db_not_bound' }, 503);
          const { cat, text } = await request.json().catch(() => ({}));
          if (!cat) return json({ error: 'missing_cat' }, 400);
          await env.DB.prepare('UPDATE sections SET d=? WHERE k=?').bind(String(text || '').slice(0, 300), cat).run();
          return json({ ok: true });
        }

        if (p === '/api/admin/section' && method === 'POST') {
          if (!env.DB) return json({ error: 'db_not_bound' }, 503);
          const body = await request.json().catch(() => ({}));
          const k = sanitizeKey(body.k);
          if (!k) return json({ error: 'missing_key' }, 400);
          const n = String(body.n || k).slice(0, 20);
          const ic = ALLOWED_ICONS.has(body.ic) ? body.ic : 'i-cam';
          const d = String(body.d || '').slice(0, 300);
          const existing = await env.DB.prepare('SELECT k FROM sections WHERE k=?').bind(k).first().catch(() => null);
          if (existing) {
            await env.DB.prepare('UPDATE sections SET n=?, ic=?, d=? WHERE k=?').bind(n, ic, d, k).run();
          } else {
            const max = await env.DB.prepare('SELECT COALESCE(MAX(sort_order),-1) m FROM sections').first().catch(() => ({ m: -1 }));
            await env.DB.prepare('INSERT INTO sections (k,n,ic,d,sort_order) VALUES (?,?,?,?,?)').bind(k, n, ic, d, (max?.m ?? -1) + 1).run();
          }
          return json({ ok: true });
        }

        if (p === '/api/admin/section/delete' && method === 'POST') {
          if (!env.DB) return json({ error: 'db_not_bound' }, 503);
          const { k } = await request.json().catch(() => ({}));
          if (!k) return json({ error: 'missing_key' }, 400);
          await env.DB.prepare('DELETE FROM sections WHERE k=?').bind(k).run();
          return json({ ok: true });
        }

        if (p === '/api/admin/section/order' && method === 'POST') {
          if (!env.DB) return json({ error: 'db_not_bound' }, 503);
          const { order } = await request.json().catch(() => ({}));
          if (!Array.isArray(order)) return json({ error: 'missing_order' }, 400);
          for (let i = 0; i < order.length; i++) await env.DB.prepare('UPDATE sections SET sort_order=? WHERE k=?').bind(i, order[i]).run();
          return json({ ok: true });
        }

        if (p === '/api/admin/theme' && method === 'POST') {
          const { theme } = await request.json().catch(() => ({}));
          await setSetting(env, 'theme', sanitizeKey(theme) || 'glam');
          return json({ ok: true });
        }

        return json({ error: 'unknown_route' }, 404);
      }

      // ── 其餘一律靜態檔 ──
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: 'server_error', message: String(e && e.message || e) }, 500);
    }
  },
};
