#!/usr/bin/env node
// 把题库资源拷进 Worker 的静态托管目录（需求文档 §6.4.6、验收 G10）。
//
//   data/subjects/<code>/assets/<rest>   →   worker/public/bank/<code>/<rest>
//
// 于是 question_assets.path 里的 `<code>/<rest>` 直接就是 URL：/bank/<code>/<rest>。
// 路径里带学科码是有意的——这样一行资源记录自己就能拼出 URL，前端不必再去
// 拿一次学科上下文，也就不会出现"拿着生化的图去拼英语的路径"这种错。
//
// **必须排在 vite build 之后。** vite 的 outDir 是 worker/public 且 emptyOutDir=true，
// 每次构建都会把这个目录清空——先拷后构建等于没拷，而且不报错：页面正常、图全裂。
// 所以这里先检查 public 在不在，不在就报错退出，把顺序错误变成一次失败而不是一堆破图。
//
// 图片不进 D1（G10）：一张 200KB 的 png 存成 base64 是 27 万字符，导入会超时，
// 备份和 diff 也全毁了。D1 里只有 question_assets 那一行元数据。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const subjectsDir = path.join(root, 'data', 'subjects');
const publicDir = path.join(root, 'worker', 'public');
const bankDir = path.join(publicDir, 'bank');

// 只拷题目资源该有的那几种。放进 public 的东西是公开可取的，
// 所以宁可漏拷一种格式（会在契约校验里报"文件不在盘上"），也不要把整个目录端出去。
//
// **不收 .svg**：svg 里可以写 <script>，而它和前端同源。题库的图来自 docx 导入，
// 都是位图，收 svg 只是在给自己开一个不需要的口子。
const ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp3', '.m4a', '.ogg', '.wav']);

if (!fs.existsSync(publicDir)) {
  console.error('worker/public 不存在。先构建前端（npm run build --prefix web），' +
    '再拷题库资源——反过来的话 vite 会把刚拷进去的东西清掉。');
  process.exit(1);
}

let copied = 0;
let skipped = [];
let bytes = 0;

function walk(dir, rel, destRoot) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const from = path.join(dir, entry.name);
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { walk(from, next, destRoot); continue; }
    if (!ALLOWED.has(path.extname(entry.name).toLowerCase())) { skipped.push(next); continue; }
    const to = path.join(destRoot, next);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    bytes += fs.statSync(from).size;
    copied++;
  }
}

fs.rmSync(bankDir, { recursive: true, force: true });
const subjects = fs.existsSync(subjectsDir)
  ? fs.readdirSync(subjectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];
for (const code of subjects) {
  const src = path.join(subjectsDir, code, 'assets');
  if (!fs.existsSync(src)) continue;
  walk(src, '', path.join(bankDir, code));
}

if (skipped.length) {
  console.log(`跳过 ${skipped.length} 个不是题目资源的文件：${skipped.slice(0, 5).join('、')}` +
    (skipped.length > 5 ? ' …' : ''));
}
console.log(`题库资源：${subjects.length} 个学科，拷了 ${copied} 个文件（${(bytes / 1024).toFixed(1)} KB）` +
  ` -> worker/public/bank/`);
