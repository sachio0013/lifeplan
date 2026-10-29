// app/ の各ファイルを1枚のHTMLにまとめる。
//   dist/lifeplan.html … Artifact として公開する本体（<html>等の外枠は公開時に付く）
//   dist/preview.html  … 手元のブラウザ・E2Eテスト用に外枠を付けたもの
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const safeJs = (s) => s.replace(/<\/script/gi, '<\\/script');

const body = read('app/index.html')
  .replace('/*@STYLE@*/', () => read('app/style.css'))
  .replace('/*@ENGINE@*/', () => safeJs(read('app/engine.js')))
  .replace('/*@SAMPLE@*/', () => safeJs(read('app/sample.js')))
  .replace('/*@BOOK@*/', () => safeJs(read('app/book.js')))
  .replace('/*@XLSX@*/', () => safeJs(read('app/xlsx.js')))
  .replace('/*@APP@*/', () => safeJs(read('app/app.js')));

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/lifeplan.html'), body);
writeFileSync(
  join(root, 'dist/preview.html'),
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>\n${body}\n</body></html>\n`
);
console.log(`dist/lifeplan.html ${(Buffer.byteLength(body) / 1024).toFixed(0)}KB`);
