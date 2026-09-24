// 生化的导入管线：docx → XML 结构化提取 → 规则切分 → JSON（需求文档 §6.4.3）。
//
// **不走 OCR 也不走 LLM**：附件是数字 docx、有完整文字层，OCR 只会引入错误；
// 题型边界由标题段落明确标出，规则切分即可；走 LLM 反而引入不确定性还要花钱。
//
// 这一段的每一条规则都对应 §4.2 里一条真实的资料形态，注释里标了是哪一条。
// 拿不准的一律写进 parsingNotes 并**写明题号**，不自己猜着填。
import { readZip } from './lib/zip.mjs';
import { parseParagraphs, parseNumbering, applyNumbering } from './lib/ooxml.mjs';

function fail(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

// 章节标题 → 题型。**按标题文字认，不按段落编号认**：编号是 Word 生成的，
// 换一份资料就可能变；"填空题"这三个字是资料自己写的。
const SECTION_TYPES = [
  { title: '填空题', type: 'fill_text' },
  { title: '选择题', type: 'single_choice' },
  { title: '名词解释', type: 'term_explain' },
  { title: '问答题', type: 'short_answer' },
];

// 空白游程就是一个空（§4.2 事实 2）。阈值取 2：单个空格在中文题干里是正常排版，
// 连续两个及以上才是"这里要填东西"。50 个空这个数就是这么数出来的。
const BLANK_RUN = /[ 　\t]{2,}/g;
const BLANK_MARK = '＿';

// 题号：手打的（全角/半角/带空格三种标点都有）与自动编号还原出来的，长一个样
const Q_NUM = /^\s*(\d+)\s*[.．、]\s*/;
const OPT_LABEL = /^\s*([A-Za-z])\s*[.．、]\s*/;

const fullText = (p) => `${p.number || ''}${p.text || ''}`;

/** 一行里可能排着好几个选项：`A.甲    B.乙    C.丙`。按字母标号切开。 */
function splitOptions(line) {
  const marks = [];
  const re = /(^|[\s　])([A-Za-z])\s*[.．、]/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    marks.push({ at: m.index + m[1].length, label: m[2].toUpperCase(), end: re.lastIndex });
  }
  if (!marks.length) return [];
  return marks.map((mk, i) => ({
    label: mk.label,
    text: line.slice(mk.end, i + 1 < marks.length ? marks[i + 1].at : undefined).trim(),
  }));
}

/**
 * 选项标号是不是 A、B、C…这样一路下来。
 * 附件第 9 题的第二项标成了 D（D 出现两次）——**错在原始资料**，不是解析错
 * （§6.4.10）。这里只负责发现并按位置订正，同时把订正前后都留痕：
 * "我们改了原题"这件事将来会被质疑。
 */
function checkLabels(options) {
  const expected = options.map((_, i) => String.fromCharCode(65 + i));
  const actual = options.map((o) => o.label);
  if (actual.join('') === expected.join('')) return null;
  return {
    from: actual.join('/'),
    to: expected.join('/'),
    // 留痕要留**原文**，不是"A/D/C/D → A/B/C/D"这种标号缩写。
    // 将来有人质疑"你们把原题改了什么"，要能直接对着这两行看，
    // 而标号缩写只说得清标号变了，说不清哪个选项被挪到了哪个字母下面。
    fromText: options.map((o) => `${o.label}.${o.text}`).join('  '),
    toText: options.map((o, i) => `${expected[i]}.${o.text}`).join('  '),
  };
}

function cleanStem(raw) {
  return raw.replace(/\s+$/, '').replace(/^\s+/, '');
}

/** 把 docx 的段落切成四个题型分组。找不到任何一个标题就抛错，不返回半份结果。 */
function splitSections(paras) {
  const heads = [];
  for (const p of paras) {
    const t = (p.text || '').trim();
    const hit = SECTION_TYPES.find((s) => s.title === t);
    if (hit) heads.push({ ...hit, at: p.index });
  }
  const missing = SECTION_TYPES.filter((s) => !heads.some((h) => h.title === s.title));
  if (missing.length) {
    throw fail('bad_source',
      `资料里找不到这些题型标题：${missing.map((s) => s.title).join('、')}` +
      `（找到的是 ${heads.map((h) => h.title).join('、') || '一个都没有'}）`);
  }
  return heads.map((h, i) => ({
    ...h,
    from: h.at + 1,
    to: i + 1 < heads.length ? heads[i + 1].at : paras.length,
  }));
}

/**
 * 把一个题型分组里的段落切成题。
 * 带题号的段落开一道新题；不带题号的非空段落**接在上一道题后面**——
 * 附件第 7 题的 `nm。` 就是独立一段（§4.2 事实 9、§6.4.3 硬性要求 3）。
 */
function splitQuestions(paras, section, notes) {
  const out = [];
  let cur = null;
  for (let i = section.from; i < section.to; i++) {
    const p = paras[i];
    const line = fullText(p);
    if (!line.trim()) continue;

    const optish = section.type === 'single_choice' && OPT_LABEL.test(line);
    const numMatch = optish ? null : Q_NUM.exec(line);
    if (numMatch) {
      cur = { order: Number(numMatch[1]), sourcePara: p.index, lines: [line.slice(numMatch[0].length)], optionLines: [] };
      out.push(cur);
      continue;
    }
    if (!cur) {
      notes.push(`${section.title}：第 ${p.index} 段没有题号也不在任何题下面，已跳过：${line.slice(0, 30)}`);
      continue;
    }
    if (optish) cur.optionLines.push(line);
    else cur.lines.push(line);
  }
  return out;
}

/**
 * 跑一遍导入。
 * @returns { group, stats }  group 是可直接写盘的题库 JSON，stats 供自检
 */
export function importDocx(buf, { subjectCode, courseCode, groupId, chapterNo, label }) {
  const entries = readZip(buf);
  const docXml = entries.get('word/document.xml');
  if (!docXml) throw fail('bad_docx', 'docx 里没有 word/document.xml');
  const numXml = entries.get('word/numbering.xml');
  // 没有 numbering.xml 不是"少个可选文件"，是自动编号还原不了——
  // 而这份资料的题号大半来自自动编号，缺了它切出来的题数会静静地少一截。
  if (!numXml) throw fail('bad_docx', 'docx 里没有 word/numbering.xml，自动编号还原不了');

  const paras = applyNumbering(
    parseParagraphs(docXml.toString('utf8')),
    parseNumbering(numXml.toString('utf8')),
  );

  const notes = [];
  const sections = [];
  let ord = 0;

  for (const sec of splitSections(paras)) {
    const raw = splitQuestions(paras, sec, notes);
    const questions = [];
    for (const q of raw) {
      ord += 1;
      const questionId = `${groupId}-q${String(ord).padStart(2, '0')}`;
      const joined = cleanStem(q.lines.join(''));

      if (sec.type === 'single_choice') {
        const options = q.optionLines.flatMap((l) => splitOptions(l));
        if (!options.length) {
          notes.push(`${sec.title}第 ${q.order} 题没有解析出任何选项，已标为存疑`);
        }
        const fixed = checkLabels(options);
        const question = {
          questionId,
          order: ord,
          questionType: sec.type,
          requiresContext: false,
          // 两个维度分开写（§6.4.10 在本项目的落实，见 0002_bank.sql 的注释）：
          // status 说校对到哪一步了，answerState 说答案能不能拿来判分。
          // 合成一格的话"选项没解析出来"和"答案还没补"会互相盖掉。
          status: options.length ? '草稿' : '存疑',
          answerState: '缺答案',
          sourcePara: q.sourcePara,
          stem: joined.replace(/（\s*）/g, '（  ）'),
          options: options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o.text}`),
        };
        if (fixed) {
          // 原题有误：订正并留痕（§6.4.10）。选项文字一个字不改，只改标号。
          question.correctionApplied =
            `原卷选项标号有误（${fixed.from}），已按 ${fixed.to} 顺序订正，选项文字未改`;
          notes.push({
            kind: '原题有误',
            // 点名题号用**内容组内的 order**，不用 sec 里的原卷题号：
            // 按题型分组之后两者对不上（选择题第 9 题是内容组里的第 21 题），
            // 而下游要靠它决定扣哪道题。正文里仍写出原卷题号，人工核对时好定位。
            questionOrders: [ord],
            note: `${sec.title}第 ${q.order} 题（内容组内第 ${ord} 题）选项标号为 ` +
              `${fixed.from}，应为 ${fixed.to}；已按位置订正，选项文字未改`,
            correctedFrom: fixed.fromText,
            correctedTo: fixed.toText,
            correctedBy: `导入器 docx-structured`,
          });
        }
        questions.push(question);
        continue;
      }

      if (sec.type === 'fill_text') {
        const blanks = joined.match(BLANK_RUN)?.length || 0;
        questions.push({
          questionId,
          order: ord,
          questionType: sec.type,
          stem: joined.replace(BLANK_RUN, BLANK_MARK),
          requiresContext: false,
          status: '草稿',
          answerState: '缺答案',
          sourcePara: q.sourcePara,
          // 空的位置由资料给出，答案不在资料里（附件只有题目）。
          // 所以这里只出空位，answer 留空，等补答案工作流（§6.4.10）。
          items: Array.from({ length: blanks }, (_, i) => ({ ord: i + 1, kind: 'BLANK' })),
        });
        continue;
      }

      // 名词解释 / 问答题：题面就是一句话，采分点要人工或 AI 补，资料里没有
      questions.push({
        questionId,
        order: ord,
        questionType: sec.type,
        stem: joined,
        requiresContext: false,
        status: '草稿',
        answerState: '缺答案',
        sourcePara: q.sourcePara,
        items: [],
      });
    }
    sections.push({
      sectionId: `${groupId}-s${sections.length + 1}`,
      type: sec.title,
      order: sections.length + 1,
      questions,
    });
  }

  const stats = {
    questions: sections.reduce((n, s) => n + s.questions.length, 0),
    perSection: sections.map((s) => ({ type: s.type, count: s.questions.length })),
    blanks: sections.reduce((n, s) => n + s.questions.reduce(
      (m, q) => m + (q.items ? q.items.filter((i) => i.kind === 'BLANK').length : 0), 0), 0),
    paragraphs: paras.length,
  };

  return {
    group: {
      groupId,
      subjectCode,
      courseCode,
      groupKind: '章节',
      orderKey: chapterNo,
      chapterNo,
      label,
      // 整组的默认答案状态；逐题可以覆盖。导入器产出的一律缺答案——
      // 附件只有题目。answerSource 留空是因为"还没有答案"，不是"来源不详"。
      answerState: '缺答案',
      answerSource: null,
      answerReviewed: false,
      answerNote: '由 docx 导入器产出，只有题面，答案待补（§6.4.10 的补答案工作流）',
      sections,
      parsingNotes: notes.map((n) => (typeof n === 'string' ? { kind: '解析存疑', note: n } : n)),
    },
    stats,
  };
}
