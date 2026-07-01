// 掃 photos/ 依前綴分類產生 photos.json（丟圖命名 soccer- / cafe- / life- 即自動歸類）
import { readdirSync, writeFileSync } from 'fs';
const exts = /\.(webp|jpg|jpeg|png|gif)$/i;
const files = readdirSync('photos').filter(f => exts.test(f) && !/^avatar\./i.test(f)).sort();
const out = { soccer: [], cafe: [], life: [], other: [] };
for (const f of files) {
  if (/^soccer-/i.test(f)) out.soccer.push(f);
  else if (/^cafe-/i.test(f)) out.cafe.push(f);
  else if (/^life-/i.test(f)) out.life.push(f);
  else out.other.push(f);
}
if (!out.other.length) delete out.other;
if (!out.life.length) delete out.life;
writeFileSync('photos.json', JSON.stringify(out, null, 2));
console.log('photos.json → 世足 ' + out.soccer.length + ' / 下午茶 ' + out.cafe.length + ' / 生活 ' + (out.life ? out.life.length : 0));
