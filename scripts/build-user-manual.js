const fs = require('fs');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
  TableOfContents, PageBreak, LevelFormat, convertInchesToTwip,
} = require('docx');

const W = 9000;                 // 正文可用宽度（DXA），A4 减去左右页边距
const INK = '1A1A1A';
const MUTED = '5A5A5A';
const RULE = 'C8C8C8';
const HEAD_BG = 'F0F2F5';

const P = (text, opts = {}) => new Paragraph({
  spacing: { after: opts.after ?? 140, line: 300 },
  alignment: opts.align,
  indent: opts.indent,
  children: [new TextRun({
    text, size: opts.size ?? 21, color: opts.color ?? INK,
    bold: opts.bold, italics: opts.italics, font: '等线',
  })],
});

// 由多个片段组成的一段（用于段内加粗）
const PRuns = (runs, opts = {}) => new Paragraph({
  spacing: { after: opts.after ?? 140, line: 300 },
  children: runs.map((r) => new TextRun({
    text: r.t, bold: r.b, size: r.size ?? 21, color: r.color ?? INK, font: '等线',
  })),
});

const H1 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 360, after: 180 },
  children: [new TextRun({ text, size: 30, bold: true, color: INK, font: '等线' })],
});

const H2 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 260, after: 120 },
  children: [new TextRun({ text, size: 24, bold: true, color: INK, font: '等线' })],
});

const BULLET = (text) => new Paragraph({
  numbering: { reference: 'dot', level: 0 },
  spacing: { after: 90, line: 300 },
  children: [new TextRun({ text, size: 21, color: INK, font: '等线' })],
});

const STEP = (text) => new Paragraph({
  numbering: { reference: 'steps', level: 0 },
  spacing: { after: 90, line: 300 },
  children: [new TextRun({ text, size: 21, color: INK, font: '等线' })],
});

const NOTE = (text) => new Paragraph({
  spacing: { before: 60, after: 180, line: 300 },
  indent: { left: 240 },
  border: { left: { style: BorderStyle.SINGLE, size: 12, color: RULE, space: 10 } },
  children: [new TextRun({ text, size: 20, color: MUTED, font: '等线' })],
});

const cell = (text, { bold, bg, width, align } = {}) => new TableCell({
  width: { size: width, type: WidthType.DXA },
  shading: bg ? { type: ShadingType.CLEAR, fill: bg, color: 'auto' } : undefined,
  margins: { top: 90, bottom: 90, left: 130, right: 130 },
  children: [new Paragraph({
    alignment: align,
    spacing: { after: 0, line: 280 },
    children: [new TextRun({ text, bold, size: 20, color: INK, font: '等线' })],
  })],
});

const table = (widths, header, rows) => new Table({
  columnWidths: widths,
  width: { size: W, type: WidthType.DXA },
  borders: {
    top: { style: BorderStyle.SINGLE, size: 6, color: RULE },
    bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE },
    left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: RULE },
    insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  },
  rows: [
    new TableRow({
      tableHeader: true,
      children: header.map((h, i) => cell(h, {
        bold: true, bg: HEAD_BG, width: widths[i], align: i ? AlignmentType.CENTER : undefined,
      })),
    }),
    ...rows.map((r) => new TableRow({
      children: r.map((c, i) => cell(c, {
        width: widths[i], align: i ? AlignmentType.CENTER : undefined,
      })),
    })),
  ],
});

const SPACER = (h = 120) => new Paragraph({ spacing: { after: h }, children: [] });

const URL = 'https://eng1300-mvp.eng1300-79fe2787.workers.dev';

const children = [];

// ────────────────────────── 封面 ──────────────────────────
children.push(
  new Paragraph({ spacing: { before: 2600, after: 0 }, children: [] }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 160 },
    children: [new TextRun({ text: '自考英语真题练习', size: 52, bold: true, color: INK, font: '等线' })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 700 },
    children: [new TextRun({ text: '学员使用手册', size: 32, color: MUTED, font: '等线' })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 },
    children: [new TextRun({ text: '英语(二) / 英语(专升本)　课程代码 13000', size: 21, color: MUTED, font: '等线' })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 0 },
    children: [new TextRun({ text: URL, size: 20, color: MUTED, font: '等线' })],
  }),
  new Paragraph({ children: [new PageBreak()] }),
);

// ────────────────────────── 目录 ──────────────────────────
children.push(
  H1('目录'),
  new TableOfContents('目录', { hyperlink: true, headingStyleRange: '1-2' }),
  NOTE('目录页码在 Word 中打开后按 F9 可刷新。'),
  new Paragraph({ children: [new PageBreak()] }),
);

// ────────────────────────── 一、开始使用 ──────────────────────────
children.push(
  H1('一、开始使用'),
  P('这个系统用来练习自考英语（二）/英语（专升本）的历年真题。它做三件事：按真题结构随机组一套新卷让你模考，按你的掌握情况出题让你专项练习，把你做错的题收起来反复订正。'),

  H2('1.1 打开网址'),
  PRuns([
    { t: '在手机、平板或电脑的浏览器里打开：' },
    { t: URL, b: true },
  ]),
  P('页面会自动适应屏幕宽度，手机上竖屏使用即可，不需要安装任何应用。'),

  H2('1.2 登录'),
  STEP('打开网址后进入登录页，页面标题是"自考英语真题练习"。'),
  STEP('输入老师发给你的用户名和密码。'),
  STEP('点"登录"，进入首页。'),
  NOTE('密码连续输错 5 次，账号会被锁定 10 分钟，这段时间内即使输对也进不去。等 10 分钟后再试，或者联系老师帮你重置。'),

  H2('1.3 修改密码'),
  P('第一次登录后建议改成自己记得住的密码。在页面导航里找到"修改密码"，依次填写当前密码、新密码、确认新密码。'),
  BULLET('新密码至少 8 位'),
  BULLET('必须同时包含字母和数字'),
  P('改完之后用新密码重新登录。'),
);

// ────────────────────────── 二、首页 ──────────────────────────
children.push(
  H1('二、首页有什么'),
  P('登录后看到的第一页会显示你的用户名、课程信息，以及本课程当前可用的真题套数和题目数量。下面三个入口是你平时用得最多的：'),
  SPACER(60),
  table(
    [2100, 6900],
    ['入口', '用途'],
    [
      ['模拟考试', '按真题结构随机组一套新卷，限时作答，交卷后出成绩报告'],
      ['专项练习', '不限时，按你的掌握情况出题，答一题看一题的反馈'],
      ['历史记录', '看过去每次模考的成绩、用时，也可以继续没做完的那次'],
    ],
  ),
  SPACER(),
  P('导航里另有"错题本"、"能力评估"和"修改密码"。'),
);

// ────────────────────────── 三、模拟考试 ──────────────────────────
children.push(
  H1('三、模拟考试'),
  P('模考是完整地按真题结构做一整套卷子，限时、不给即时反馈，交卷后一次性出成绩。想检验自己现在大概能考多少分，用这个。'),

  H2('3.1 试卷构成'),
  P('每套卷子固定 51 题、满分 100 分、限时 150 分钟，七个部分的题量与分值如下：'),
  SPACER(60),
  table(
    [3200, 1500, 2100, 2200],
    ['部分', '题量', '每题分值', '小计'],
    [
      ['阅读判断', '10', '1 分', '10 分'],
      ['阅读理解选择', '5', '2 分', '10 分'],
      ['段落大意与句子补全', '10', '1 分', '10 分'],
      ['填句补文', '5', '2 分', '10 分'],
      ['填词补文', '10', '1.5 分', '15 分'],
      ['完形填空', '10', '1.5 分', '15 分'],
      ['写作', '1', '30 分', '30 分'],
      ['合计', '51', '—', '100 分'],
    ],
  ),
  SPACER(),
  P('题目全部来自历年真题，每次组卷会尽量避开你最近几次考过的篇章，所以连着考几套不会总是同一批文章。'),

  H2('3.2 组一套新卷'),
  STEP('首页点"模拟考试"。'),
  STEP('选一个"难度倾向"（见下表）。'),
  STEP('页面会先给出这套卷的构成预览：各部分题量、分值、覆盖多少个考点。'),
  STEP('觉得合适就点"开始模拟考试"；想换一套点"重新组卷"。'),
  SPACER(60),
  table(
    [1800, 7200],
    ['难度倾向', '含义'],
    [
      ['随机', '不看你的历史记录，纯随机组卷'],
      ['简单', '偏向你做得好的考点'],
      ['正常', '难易均衡'],
      ['困难', '偏向你薄弱的考点'],
    ],
  ),
  SPACER(),
  NOTE('偶尔会遇到提示说题目不够组不成卷。这是因为题库里某个部分可用的完整篇章暂时不足，换个难度倾向再试一次通常就好了。'),

  H2('3.3 答题'),
  P('进入答题页后是全屏作答，顶部显示剩余时间。'),
  BULLET('答过的题会有标记，方便你回头检查'),
  BULLET('作答内容随时保存，中途关掉页面或换个设备重新登录，进度还在'),
  BULLET('剩余时间不足 5 分钟时会提醒你一次'),
  BULLET('时间到会自动交卷，已答的部分照常计分'),

  H2('3.4 交卷'),
  P('点"交卷"。如果还有题没作答，系统会先问一句"还有 N 题没作答，确认交卷？交卷后不能再修改"。确认后立刻判分，跳转到成绩报告。'),

  H2('3.5 看成绩报告'),
  P('报告页分几块：'),
  BULLET('客观题得分：交卷时就算好了，不用等'),
  BULLET('各部分得分：七个部分分别得了多少'),
  BULLET('本卷薄弱考点：正确率低于 60% 的考点，按由低到高排列'),
  BULLET('逐题解析：每道题的正确答案和题库里的官方解析'),
  P('写作部分需要 AI 批改，交卷时先显示"作文 30 分待 AI 批改"，总分暂时只含客观题。'),

  H2('3.6 生成 AI 解析'),
  P('报告页上有一个按钮，点一次会同时做两件事：给作文打分，并为这次的错题生成错因分析。整个过程大约 30 秒，请耐心等它转完，不要反复点。'),
  P('完成后报告会就地刷新：作文分补上、总分变成客观题加作文，错题本里也能看到 AI 写的错因和记忆要点。'),
  NOTE('如果提示"AI 暂时不可用"，你的客观题成绩完全不受影响，过一会儿回到这份报告再点一次即可。'),
);

// ────────────────────────── 四、专项练习 ──────────────────────────
children.push(
  H1('四、专项练习'),
  P('专项练习不限时，一题一题做，每答完一题立刻告诉你对错和解析。适合平时零散时间用来补弱项。'),

  H2('4.1 它怎么给你出题'),
  P('练习分两个阶段，系统自动切换，你不用管：'),
  BULLET('摸底阶段：每个考点先出一道，快速找出你的薄弱面'),
  BULLET('强化阶段：按掌握度反复出题，越薄弱的考点出得越多'),

  H2('4.2 开始一轮练习'),
  STEP('首页点"专项练习"。'),
  STEP('在"题型范围"里勾选想练的题型，都不选表示不限题型。'),
  STEP('页面会显示"本次范围"：可用题目多少道、覆盖多少个考点。'),
  STEP('点开始。'),
  NOTE('写作题不进入专项练习。作文需要 AI 批改，成本高也慢，只在模考里出现。'),
  P('如果提示"所选范围内没有可用题目"，少选几个题型或者改成不限即可。'),

  H2('4.3 答题与反馈'),
  P('提交一道题后，页面就地展开反馈：这题答对还是答错、正确答案是什么、考的是哪个考点、题库里的官方解析。'),
  P('看完由你点"下一题"继续，不会自动跳走。顶部一直显示已答题数和正确率。'),
  P('练习可以随时离开，下次进入设置页会提示"有一次练习还没结束"，点"继续"接着做，已答的题数不会归零。'),

  H2('4.4 练习总结'),
  P('点"结束练习"或做完当前范围后进入总结页，显示做题数、正确率、覆盖考点，并把考点按掌握情况分档列出。'),
  P('薄弱的考点可以一键进入单考点专项：把该考点下的题目挨个做一遍，同样不限时。'),
);

// ────────────────────────── 五、错题本 ──────────────────────────
children.push(
  H1('五、错题本'),
  P('做错的题会自动收进错题本，不需要你手动加。'),

  H2('5.1 怎么算订正'),
  PRuns([
    { t: '同一道题连续答对两次', b: true },
    { t: '，就自动标记为"已订正"。之后如果再答错，会退回未订正状态重新计数。' },
  ]),
  P('错题本默认不显示已订正的题，勾选"显示已订正"可以看到全部。'),

  H2('5.2 筛选'),
  P('可以按题型和考点筛选。筛选项里只会列出你真正有错题的那些维度，不会给你一堆空选项。'),

  H2('5.3 每条错题能看到什么'),
  BULLET('完整题目、你当时选的答案、正确答案'),
  BULLET('题库里的官方解析'),
  BULLET('AI 写的"错在哪"和"记住这点"'),
  NOTE('AI 那两栏要在成绩报告页点过一次生成才有。显示"解析待重试"表示上次生成失败了，回到那次的成绩报告重新点一次即可。'),
);

// ────────────────────────── 六、能力评估 ──────────────────────────
children.push(
  H1('六、能力评估'),
  P('这一页回答一个问题：按目前的状态去考，大概能得多少分，还差在哪。'),

  H2('6.1 预测区间'),
  PRuns([
    { t: '需要至少 2 次模考才会给出预测', b: true },
    { t: '。只考过一次时页面会写明还差几次——一次考试的预测没有意义，所以系统不给。' },
  ]),
  P('预测采用时间衰减权重：越近的成绩权重越高，早期的成绩影响较小。页面同时显示统计模型的预测区间和 AI 的综合意见，两者并列，互不覆盖。AI 意见要手动点一次生成，统计预测不等它。'),

  H2('6.2 考点掌握度'),
  P('每个考点会归入四档之一：'),
  SPACER(60),
  table(
    [1800, 7200],
    ['分档', '含义'],
    [
      ['未测', '还没做过这个考点的题'],
      ['薄弱', '最近一次答错，或整体正确率低于 50%'],
      ['待巩固', '做对过，但还不够稳'],
      ['已掌握', '做过至少 3 题且连续答对 3 次以上'],
    ],
  ),
  SPACER(),
  P('页面还会列出"优先补强"的部分，得分率越低的排得越靠前。'),
);

// ────────────────────────── 七、历史记录 ──────────────────────────
children.push(
  H1('七、历史记录'),
  P('按时间列出每次模考的难度、状态、客观题得分和用时。'),
  BULLET('状态是"已交卷"的，点"看报告"回到那次的成绩报告'),
  BULLET('状态是"进行中"的，点"继续作答"接着做（注意考试时间仍在走）'),
  BULLET('还没考过时，页面会提示你去开一套'),
);

// ────────────────────────── 八、常见问题 ──────────────────────────
children.push(
  H1('八、常见问题'),

  H2('登录进不去，提示次数过多'),
  P('密码连错 5 次会锁 10 分钟。等 10 分钟后重试，或联系老师重置密码。'),

  H2('答到一半退出了，进度会丢吗'),
  P('不会。作答内容随时保存，重新登录后从历史记录点"继续作答"即可，换设备也一样。'),

  H2('能力评估为什么不给我预测分数'),
  P('模考次数不足 2 次。再考一套就有了。'),

  H2('点了生成 AI 解析，转了很久'),
  P('正常大约 30 秒，请等它转完。如果提示 AI 暂时不可用，客观题成绩不受影响，稍后回到这份报告再点一次。'),

  H2('页面提示"数据库今日写入额度已用尽"'),
  P('这是系统当天的容量上限，会在北京时间早上八点自动恢复。这段时间里你仍然可以登录和查看已有的记录，但交卷、答题这类需要保存的操作要等恢复后再做。'),

  H2('手机上能用吗'),
  P('可以。手机、平板、电脑三种屏幕都做过适配，用浏览器打开即可，不需要安装应用。'),
);

const doc = new Document({
  creator: '自考英语真题练习',
  title: '自考英语真题练习 学员使用手册',
  description: '面向学员的功能使用说明',
  numbering: {
    config: [
      {
        reference: 'dot',
        levels: [{
          level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: convertInchesToTwip(0.3), hanging: convertInchesToTwip(0.18) } } },
        }],
      },
      {
        reference: 'steps',
        levels: [{
          level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: convertInchesToTwip(0.3), hanging: convertInchesToTwip(0.18) } } },
        }],
      },
    ],
  },
  styles: {
    default: {
      document: { run: { font: '等线', size: 21, color: INK } },
    },
  },
  sections: [{
    properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    children,
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync('自考英语真题练习-学员使用手册.docx', buf);
  console.log('已生成，', buf.length, '字节');
});
