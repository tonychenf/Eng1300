// OOXML（docx）里我们真正需要的那一小块：段落文本 + 自动编号。
//
// **必须还原自动编号**（§6.4.3 硬性要求 1）。只取 <w:t> 的话，附件里 13 道选择题
// 全部丢题号、12 道题的 A 选项全部丢字母——因为那些数字和字母根本不在文本里，
// 它们由 numbering.xml 生成。丢了题号，题目边界就断了，切出来的题数会对不上。
//
// 这不是一个通用 docx 解析器：只认这份资料用到的元素，碰到没见过的编号覆盖
// （w:lvlOverride）直接抛错而不是忽略——忽略的后果是题号从某一处开始整体错位，
// 而文本本身看着一切正常。

function fail(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.replace(/&(#x?[0-9A-Fa-f]+|[a-z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

// 标签扫描。属性值里可能有 > ，所以要认引号，不能简单地找下一个 >。
const TAG_RE = /<(\/?)([A-Za-z0-9:_.-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

function attrs(raw) {
  const out = {};
  for (const m of String(raw).matchAll(/([A-Za-z0-9:_.-]+)\s*=\s*"([^"]*)"/g)) {
    out[m[1]] = unescapeXml(m[2]);
  }
  return out;
}

/**
 * document.xml → 段落数组。
 * 每项：{ index, text, numId, ilvl, style }
 *
 * index 是**正文段落序号**（0 起），会回写进题目的 sourcePara，
 * 人工核对时照着它就能翻回原文（§6.4.3 硬性要求 4）。
 */
export function parseParagraphs(xml) {
  const paras = [];
  const stack = [];          // 开着的段落，处理表格里嵌套段落的情形
  let inPPr = 0;             // 只认段落自己的 pPr，不认 pPrChange 里那份
  let inDeleted = 0;         // 修订删除的文字不算数
  let textTag = null;        // 正在收集文本的标签名
  let last = 0;

  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(xml)) !== null) {
    const [whole, close, name, rawAttrs, selfClose] = m;
    if (textTag && stack.length) {
      // 两个标签之间的内容就是文本
      const chunk = xml.slice(last, m.index);
      if (chunk) stack[stack.length - 1].text += unescapeXml(chunk);
    }
    last = m.index + whole.length;

    const closing = close === '/';
    const self = selfClose === '/';

    if (name === 'w:p') {
      if (closing) { const p = stack.pop(); if (p) paras.push(p); }
      else if (!self) stack.push({ index: paras.length + stack.length, text: '', numId: null, ilvl: null, style: null });
      continue;
    }
    if (!stack.length) continue;
    const cur = stack[stack.length - 1];

    if (name === 'w:pPrChange' || name === 'w:del') {
      if (closing) inDeleted--; else if (!self) inDeleted++;
      continue;
    }
    if (inDeleted > 0) { textTag = null; continue; }

    if (name === 'w:pPr') { if (closing) inPPr--; else if (!self) inPPr++; continue; }
    if (name === 'w:numPr' && !closing) continue;
    if (inPPr > 0) {
      const a = attrs(rawAttrs);
      if (name === 'w:ilvl' && a['w:val'] !== undefined) cur.ilvl = String(a['w:val']);
      if (name === 'w:numId' && a['w:val'] !== undefined) cur.numId = String(a['w:val']);
      if (name === 'w:pStyle' && a['w:val'] !== undefined) cur.style = String(a['w:val']);
    }
    if (name === 'w:t') { textTag = closing ? null : 'w:t'; continue; }
    if (name === 'w:tab' && !closing) { cur.text += '\t'; continue; }
    if ((name === 'w:br' || name === 'w:cr') && !closing) { cur.text += '\n'; continue; }
    if (!closing && !self) textTag = null;   // 进了别的元素就不再收文本
  }
  if (stack.length) throw fail('bad_docx', `document.xml 里有 ${stack.length} 个段落没有闭合`);
  // 段落序号在嵌套时会算歪，这里统一按最终顺序重排一遍
  paras.forEach((p, i) => { p.index = i; });
  return paras;
}

const CN_DIGITS = '一二三四五六七八九十';

/** 按 numFmt 把计数渲染成显示用的那个字符。认不出的格式抛错，不猜。 */
export function renderNumber(fmt, value) {
  switch (fmt) {
    case 'decimal': return String(value);
    case 'upperLetter': return String.fromCharCode(64 + ((value - 1) % 26) + 1);
    case 'lowerLetter': return String.fromCharCode(96 + ((value - 1) % 26) + 1);
    case 'japaneseCounting':
    case 'chineseCounting': return value >= 1 && value <= 10 ? CN_DIGITS[value - 1] : String(value);
    case 'upperRoman': return toRoman(value);
    case 'lowerRoman': return toRoman(value).toLowerCase();
    case 'none': return '';
    default:
      throw fail('unsupported_numbering', `没见过的编号格式 ${JSON.stringify(fmt)}`);
  }
}

function toRoman(n) {
  const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let v = n; let out = '';
  for (const [k, s] of map) while (v >= k) { out += s; v -= k; }
  return out;
}

/** numbering.xml → { numId → { abstractId, levels: { ilvl → {fmt, lvlText, start} } } } */
export function parseNumbering(xml) {
  const abstracts = new Map();
  for (const block of xml.split(/<w:abstractNum\b/).slice(1)) {
    const id = /w:abstractNumId="(\d+)"/.exec(block)?.[1];
    if (id === undefined) continue;
    const body = block.split('</w:abstractNum>')[0];
    const levels = {};
    for (const lvl of body.split(/<w:lvl\b/).slice(1)) {
      const ilvl = /w:ilvl="(\d+)"/.exec(lvl)?.[1];
      if (ilvl === undefined) continue;
      const seg = lvl.split('</w:lvl>')[0];
      levels[ilvl] = {
        start: Number(/<w:start w:val="(-?\d+)"/.exec(seg)?.[1] ?? 1),
        fmt: /<w:numFmt w:val="([^"]+)"/.exec(seg)?.[1] ?? 'decimal',
        lvlText: unescapeXml(/<w:lvlText w:val="([^"]*)"/.exec(seg)?.[1] ?? '%1.'),
      };
    }
    abstracts.set(id, levels);
  }

  const nums = new Map();
  for (const block of xml.split(/<w:num\b/).slice(1)) {
    const numId = /^\s+w:numId="(\d+)"/.exec(block)?.[1] ?? /w:numId="(\d+)"/.exec(block)?.[1];
    if (numId === undefined) continue;
    const body = block.split('</w:num>')[0];
    // 编号覆盖会让某个实例从别的数字起算。这份资料里没有；真碰上了要停下来想，
    // 忽略它的后果是题号从某处开始整体错位，而文本看着一切正常。
    if (/<w:lvlOverride\b/.test(body)) {
      throw fail('unsupported_numbering', `numId ${numId} 用了 w:lvlOverride，本导入器没有实现`);
    }
    const abstractId = /<w:abstractNumId w:val="(\d+)"/.exec(body)?.[1];
    if (abstractId === undefined) continue;
    nums.set(numId, { abstractId, levels: abstracts.get(abstractId) || {} });
  }
  return nums;
}

/**
 * 给每个带编号的段落算出它显示出来的那个编号（如 `1.`、`A.`、`三、`）。
 *
 * 计数器按 **numId 实例** 维护：本资料里每个 numId 各自对应一个 abstractNum，
 * 两种口径结果一样。将来若有多个 numId 共用一个 abstractNum，这里要重新想——
 * 而题数自检（34 题 / 50 空）会替你发现那件事。
 */
export function applyNumbering(paras, nums) {
  const counters = new Map();   // numId → { ilvl → 当前值 }
  for (const p of paras) {
    p.number = '';
    if (!p.numId) continue;
    const def = nums.get(p.numId);
    if (!def) continue;
    const ilvl = p.ilvl ?? '0';
    const lvl = def.levels[ilvl];
    if (!lvl) continue;

    if (!counters.has(p.numId)) counters.set(p.numId, {});
    const c = counters.get(p.numId);
    c[ilvl] = (c[ilvl] === undefined ? lvl.start - 1 : c[ilvl]) + 1;
    // 深一层的计数器要跟着上层递增而重置，否则"二、"下面的第 1 题会接着上一节数
    for (const other of Object.keys(c)) {
      if (Number(other) > Number(ilvl)) delete c[other];
    }
    p.number = lvl.lvlText.replace(/%(\d)/g, (whole, k) => {
      const li = String(Number(k) - 1);
      const sub = def.levels[li];
      const val = c[li] !== undefined ? c[li] : (sub ? sub.start : 1);
      return renderNumber(sub ? sub.fmt : 'decimal', val);
    });
  }
  return paras;
}
