// 掃 photos/ 依前綴分類產生 photos.json（丟圖命名 soccer-xx / cafe-xx 即自動歸類）
import { readdirSync, writeFileSync } from 'fs';
const exts = /\.(webp|jpg|jpeg|png|gif)$/i;
const files = readdirSync('photos').filter(f => exts.test(f) && !/^avatar\./i.test(f)).sort();
const out = { soccer: [], cafe: [], other: [] };
for (const f of files) {
  if (/^soccer-/i.test(f)) out.soccer.push(f);
  else if (/^cafe-/i.test(f)) out.cafe.push(f);
  else out.other.push(f);
}
if (!out.other.length) delete out.other;
writeFileSync('photos.json', JSON.stringify(out, null, 2));
console.log('photos.json 更新 → 世足 ' + out.soccer.length + ' 張 / 下午茶 ' + out.cafe.length + ' 張' + (out.other ? ' / 其他 ' + out.other.length : ''));
