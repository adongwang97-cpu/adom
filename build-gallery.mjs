// 掃 photos/ 依前綴分類產生 photos.json
//   公開：soccer- / cafe- / life-    解鎖專區：vip-(高清照,鎖起來)
// 用法：把圖丟 photos/ 命名好前綴 → node build-gallery.mjs
import { readdirSync, writeFileSync } from 'fs';
const exts = /\.(webp|jpg|jpeg|png|gif)$/i;
const files = readdirSync('photos').filter(f => exts.test(f) && !/^avatar\./i.test(f)).sort();
const out = { soccer: [], cafe: [], life: [], vip: [], other: [] };
for (const f of files) {
  if (/^soccer-/i.test(f)) out.soccer.push(f);
  else if (/^cafe-/i.test(f)) out.cafe.push(f);
  else if (/^life-/i.test(f)) out.life.push(f);
  else if (/^vip-/i.test(f)) out.vip.push(f);
  else out.other.push(f);
}
for (const k of ['life','vip','other']) if (!out[k].length) delete out[k];
writeFileSync('photos.json', JSON.stringify(out, null, 2));
console.log('photos.json → 世足 ' + out.soccer.length + ' / 下午茶 ' + out.cafe.length + ' / 生活 ' + (out.life?out.life.length:0) + ' / 🔒VIP ' + (out.vip?out.vip.length:0));
