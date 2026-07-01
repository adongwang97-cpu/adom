// 掃 photos/ 資料夾產生 photos.json（阿東把圖丟進 photos/ 後跑：node build-gallery.mjs）
import { readdirSync, writeFileSync } from 'fs';
const exts = /\.(webp|jpg|jpeg|png|gif)$/i;
const files = readdirSync('photos')
  .filter(f => exts.test(f) && !/^avatar\./i.test(f))
  .sort();
writeFileSync('photos.json', JSON.stringify(files, null, 2));
console.log('photos.json 已更新：' + files.length + ' 張圖');
