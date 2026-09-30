// 生成线上实测（prod-e2e）「上传出题」那一段用的样本 docx（CR-M4）。
//
// 从仓库里已公开的生化第 1 章原件里摘 4 道题：填空（2 个空）、单选、名词解释、问答各一道，
// 连同书名和各自的题型标题。只动 word/document.xml 的正文段落，其余部件
// （numbering.xml、styles.xml……）与原件逐字节相同：题号、选项字母是 Word 自动编号，
// 靠 numbering.xml 还原，动了它解析出来的就不是原件的样子。
//
// 为什么只要 4 道：线上每道题一次真 AI 调用，花的是真钱；四种题型各一道，
// 正好覆盖 AI 出答案的四种形状（逐空、选项字母、名词解释、问答）。
//
// 用法：node scripts/ci/make-e2e-sample.mjs
//       → scripts/ci/fixtures/prod-e2e-sample.docx（时间戳写死，同样的输入每次生成同样的字节）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { readZip, entryText } from '../../worker/src/import/zip.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = join(ROOT, 'data/subjects/biochem/source/第01章-蛋白质的化学.docx');
const OUT = join(ROOT, 'scripts/ci/fixtures/prod-e2e-sample.docx');

// 原件正文里第几个段落（从 0 数）。每段是什么写在右边，改之前先对一眼原件。
const KEEP = [
  0,            // 《蛋白质的化学》
  1, 2, 3,      // 填空题 / 第 1 题（两个空）/ 空行
  28, 29, 30, 31, // 选择题 / 第 1 题题干 / 四个选项 / 空行
  73, 74,       // 名词解释 / 肽键
  81, 82, 83,   // 问答题 / 简述蛋白质结构与功能的关系 / 空行
];
// 摘出来的段落要是这几句话。原件哪天改了，段号就可能对不上，
// 那时生成出来的是另外几道题——宁可在这里停下，也不要悄悄换了样本。
const EXPECT = ['填空题', '选择题', '名词解释', '肽键', '问答题', '简述蛋白质结构与功能的关系'];

const entries = await readZip(readFileSync(SOURCE));
const xml = entryText(entries.get('word/document.xml'));
// 顶层段落。<w:pPr> 以 "<w:p" 开头但后面紧跟 P，不会被这个模式吃进去。
const paras = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)];
if (paras.length !== 85) throw new Error(`原件正文应有 85 段，实际 ${paras.length} 段——原件变了，先核对 KEEP`);
const text = (p) => [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
const kept = KEEP.map((i) => paras[i][0]);
const keptText = kept.map(text).join('\n');
const missing = EXPECT.filter((t) => !keptText.includes(t));
if (missing.length) throw new Error(`摘出来的段落里没有：${missing.join('、')}——原件变了，先核对 KEEP`);

const first = paras[0], last = paras[paras.length - 1];
const docXml = xml.slice(0, first.index) + kept.join('') + xml.slice(last.index + last[0].length);
entries.set('word/document.xml', new TextEncoder().encode(docXml));

// ---- 写 zip：deflate，时间戳固定为 1980-01-01 00:00 ----
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1;
const locals = [], centrals = [];
let offset = 0;
for (const [name, data] of entries) {
  const nameBuf = Buffer.from(name, 'utf8');
  const comp = deflateRawSync(data);
  const crc = crc32(data);
  const common = [u16(20), u16(0x0800), u16(8), u16(DOS_TIME), u16(DOS_DATE),
    u32(crc), u32(comp.length), u32(data.length), u16(nameBuf.length), u16(0)];
  const local = Buffer.concat([u32(0x04034b50), ...common, nameBuf, comp]);
  centrals.push(Buffer.concat([u32(0x02014b50), u16(20), ...common,
    u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf]));
  locals.push(local);
  offset += local.length;
}
const cen = Buffer.concat(centrals);
const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.size), u16(entries.size),
  u32(cen.length), u32(offset), u16(0)]);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.concat([...locals, cen, eocd]));
console.log(`写好了：${OUT}（${entries.size} 个部件，正文 ${kept.length} 段）`);
