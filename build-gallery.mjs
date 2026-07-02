// 掃 photos/ 依「檔名前綴-」自動分類產生 photos.json（任意前綴都通用，不用改這支腳本）
//   例：soccer-01.webp → soccer 分類；travel-03.webp → travel 分類；vip-01.webp → 解鎖專區
// 用法：把圖丟 photos/ 命名好「分類代碼-序號」→ node build-gallery.mjs
import { readdirSync, writeFileSync } from 'fs';
const exts = /\.(webp|jpg|jpeg|png|gif)$/i;
const files = readdirSync('photos').filter(f => exts.test(f) && !/^avatar\./i.test(f)).sort();
const out = {};
for (const f of files) {
  const m = f.match(/^([a-z0-9]+)-/i);
  const cat = m ? m[1].toLowerCase() : 'other';
  (out[cat] = out[cat] || []).push(f);
}
writeFileSync('photos.json', JSON.stringify(out, null, 2));
console.log('photos.json → ' + Object.entries(out).map(([k, v]) => k + ' ' + v.length).join(' / '));
