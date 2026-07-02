/**
 * 阿東寫真站 — 後台 Worker
 * 公開路由：
 *   GET  /api/photos.json        合併「git 內建照片」+「後台上傳照片」給前台用
 *   GET  /photos/r2/:key         從 R2 讀出上傳的圖(對外服務)
 * 後台路由（需登入,密碼比對 env.ADMIN_PASS）：
 *   POST /api/admin/login        {password} → 設簽章 cookie
 *   POST /api/admin/logout
 *   GET  /api/admin/check        目前是否已登入 + R2/KV 是否已綁定
 *   GET  /api/admin/data         後台編輯用的完整資料(含所有分類/照片/文案)
 *   POST /api/admin/upload       body=webp二進位, ?cat=xxx&name=xxx.webp
 *   POST /api/admin/photo/delete {cat, file}
 *   POST /api/admin/photo/order  {cat, order:[filename,...]}
 *   POST /api/admin/story        {cat, text}
 *   POST /api/admin/section      新增/更新分類 {k, n, ic, d}
 *   POST /api/admin/section/delete  {k}
 *   POST /api/admin/section/order   {order:[k,...]}
 *   POST /api/admin/theme        {theme}
 * 其餘 → 靜態檔(env.ASSETS)
 */

const COOKIE_NAME = 'admin_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 天
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

// ── KV site_config 讀寫（沒綁 KV 時回預設值，不炸站）──
async function getConfig(env) {
  const def = { stories: {}, uploads: {}, deleted: [], order: {}, sections: DEFAULT_SECTIONS, secOrder: null, theme: 'glam' };
  if (!env.SITE_KV) return def;
  try {
    const raw = await env.SITE_KV.get('site_config');
    if (!raw) return def;
    const c = JSON.parse(raw);
    return Object.assign({}, def, c, { sections: (c.sections && c.sections.length) ? c.sections : DEFAULT_SECTIONS });
  } catch { return def; }
}
async function saveConfig(env, cfg) { if (env.SITE_KV) await env.SITE_KV.put('site_config', JSON.stringify(cfg)); }

// ── 讀 git 內建的靜態 photos.json（作為每個分類的「原始」照片清單）──
async function getStaticPhotos(request, env) {
  try {
    const r = await env.ASSETS.fetch(new Request(new URL('/photos.json', request.url), { method: 'GET' }));
    if (!r.ok) return {};
    return await r.json();
  } catch { return {}; }
}

// ── 合併靜態 + 後台上傳 + 排序 + 已刪除，產出前台/後台都能用的完整資料 ──
async function buildMerged(request, env) {
  const [staticPhotos, cfg] = await Promise.all([getStaticPhotos(request, env), getConfig(env)]);
  const deleted = new Set(cfg.deleted || []);
  const allKeys = new Set([...Object.keys(staticPhotos), ...Object.keys(cfg.uploads || {})]);
  const photos = {};
  for (const k of allKeys) {
    const base = (staticPhotos[k] || []).filter(f => !deleted.has(f));
    const up = (cfg.uploads[k] || []).filter(f => !deleted.has(f));
    let merged = [...base, ...up];
    const order = (cfg.order || {})[k];
    if (order && order.length) {
      const set = new Set(merged);
      const ordered = order.filter(f => set.has(f));
      const rest = merged.filter(f => !order.includes(f));
      merged = [...ordered, ...rest];
    }
    if (merged.length) photos[k] = merged;
  }
  let sections = cfg.sections || DEFAULT_SECTIONS;
  if (cfg.secOrder && cfg.secOrder.length) {
    const map = new Map(sections.map(s => [s.k, s]));
    const ordered = cfg.secOrder.filter(k => map.has(k)).map(k => map.get(k));
    const rest = sections.filter(s => !cfg.secOrder.includes(s.k));
    sections = [...ordered, ...rest];
  }
  return { photos, sections, theme: cfg.theme || 'glam', cfg };
}

function sanitizeKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24); }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;

    try {
      // ── 公開：前台合併資料 ──
      if (p === '/api/photos.json' && method === 'GET') {
        const { photos, sections, theme } = await buildMerged(request, env);
        return json({ ...photos, __sections: sections, __theme: theme });
      }

      // ── 公開：R2 圖片代理 ──
      if (p.startsWith('/photos/r2/') && method === 'GET') {
        if (!env.PHOTOS) return new Response('not configured', { status: 503 });
        const key = decodeURIComponent(p.slice('/photos/r2/'.length));
        const obj = await env.PHOTOS.get(key);
        if (!obj) return new Response('not found', { status: 404 });
        return new Response(obj.body, { headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=31536000, immutable' } });
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
        return json({ authed: ok, r2: !!env.PHOTOS, kv: !!env.SITE_KV, configured: !!(env.ADMIN_PASS && env.ADMIN_SECRET) });
      }

      // ── 以下都要登入 ──
      if (p.startsWith('/api/admin/')) {
        const authed = await requireAdmin(request, env);
        if (!authed) return json({ error: 'unauthorized' }, 401);

        if (p === '/api/admin/data' && method === 'GET') {
          const { photos, sections } = await buildMerged(request, env);
          const cfg = await getConfig(env);
          return json({ photos, sections, stories: cfg.stories || {}, theme: cfg.theme || 'glam' });
        }

        if (p === '/api/admin/upload' && method === 'POST') {
          if (!env.PHOTOS) return json({ error: 'r2_not_bound', hint: '請先在 CF 綁定 R2(binding名稱=PHOTOS)' }, 503);
          const cat = sanitizeKey(url.searchParams.get('cat'));
          let name = (url.searchParams.get('name') || 'photo.webp').replace(/[^\w.-]/g, '_');
          if (!/\.webp$/i.test(name)) name += '.webp';
          if (!cat) return json({ error: 'missing_cat' }, 400);
          const buf = await request.arrayBuffer();
          if (buf.byteLength > 9 * 1024 * 1024) return json({ error: 'too_large' }, 413);
          if (buf.byteLength < 100) return json({ error: 'empty_file' }, 400);
          const key = `${cat}/${Date.now()}-${name}`;
          await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: 'image/webp' } });
          const cfg = await getConfig(env);
          cfg.uploads = cfg.uploads || {};
          cfg.uploads[cat] = cfg.uploads[cat] || [];
          const publicName = 'r2/' + key; // 前台用 photos/r2/<key> 讀
          cfg.uploads[cat].push(publicName);
          await saveConfig(env, cfg);
          return json({ ok: true, file: publicName });
        }

        if (p === '/api/admin/photo/delete' && method === 'POST') {
          const { cat, file } = await request.json().catch(() => ({}));
          if (!cat || !file) return json({ error: 'missing_params' }, 400);
          const cfg = await getConfig(env);
          if (String(file).startsWith('r2/')) {
            if (env.PHOTOS) await env.PHOTOS.delete(String(file).slice(3)).catch(() => {});
            cfg.uploads = cfg.uploads || {};
            cfg.uploads[cat] = (cfg.uploads[cat] || []).filter(f => f !== file);
          } else {
            cfg.deleted = cfg.deleted || [];
            if (!cfg.deleted.includes(file)) cfg.deleted.push(file);
          }
          await saveConfig(env, cfg);
          return json({ ok: true });
        }

        if (p === '/api/admin/photo/order' && method === 'POST') {
          const { cat, order } = await request.json().catch(() => ({}));
          if (!cat || !Array.isArray(order)) return json({ error: 'missing_params' }, 400);
          const cfg = await getConfig(env);
          cfg.order = cfg.order || {};
          cfg.order[cat] = order;
          await saveConfig(env, cfg);
          return json({ ok: true });
        }

        if (p === '/api/admin/story' && method === 'POST') {
          const { cat, text } = await request.json().catch(() => ({}));
          if (!cat) return json({ error: 'missing_cat' }, 400);
          const cfg = await getConfig(env);
          cfg.stories = cfg.stories || {};
          cfg.stories[cat] = String(text || '').slice(0, 300);
          await saveConfig(env, cfg);
          const sections = (cfg.sections || DEFAULT_SECTIONS).map(s => s.k === cat ? { ...s, d: cfg.stories[cat] } : s);
          cfg.sections = sections;
          await saveConfig(env, cfg);
          return json({ ok: true });
        }

        if (p === '/api/admin/section' && method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const k = sanitizeKey(body.k);
          if (!k) return json({ error: 'missing_key' }, 400);
          const n = String(body.n || k).slice(0, 20);
          const ic = ALLOWED_ICONS.has(body.ic) ? body.ic : 'i-cam';
          const d = String(body.d || '').slice(0, 300);
          const cfg = await getConfig(env);
          const list = cfg.sections || DEFAULT_SECTIONS;
          const idx = list.findIndex(s => s.k === k);
          if (idx >= 0) list[idx] = { k, n, ic, d }; else list.push({ k, n, ic, d });
          cfg.sections = list;
          await saveConfig(env, cfg);
          return json({ ok: true });
        }

        if (p === '/api/admin/section/delete' && method === 'POST') {
          const { k } = await request.json().catch(() => ({}));
          const cfg = await getConfig(env);
          cfg.sections = (cfg.sections || DEFAULT_SECTIONS).filter(s => s.k !== k);
          await saveConfig(env, cfg);
          return json({ ok: true });
        }

        if (p === '/api/admin/section/order' && method === 'POST') {
          const { order } = await request.json().catch(() => ({}));
          if (!Array.isArray(order)) return json({ error: 'missing_order' }, 400);
          const cfg = await getConfig(env);
          cfg.secOrder = order;
          await saveConfig(env, cfg);
          return json({ ok: true });
        }

        if (p === '/api/admin/theme' && method === 'POST') {
          const { theme } = await request.json().catch(() => ({}));
          const cfg = await getConfig(env);
          cfg.theme = sanitizeKey(theme) || 'glam';
          await saveConfig(env, cfg);
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
