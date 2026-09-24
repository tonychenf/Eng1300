// 导入管线注册表：**按学科注册管线，不在一个脚本里写 if (学科 === ...)**（§6.4.3）。
//
// 英语走的是 pdf-ocr-llm（扫描件 → OCR → LLM 结构化），那条链路在蓝本时代就跑完了，
// 产物已经在 data/subjects/english/groups/ 里；这里不重建它，只登记它存在过，
// 免得有人以为"英语没有管线"。
//
// 解析器本身在 worker/src/import/ 下——后台上传接口也要用它，而那边跑在 Worker 里。
// 这个文件只留命令行才需要的东西：**哪个学科的原始资料在盘上的什么位置**。
import { PIPELINES, resolvePipeline as resolveByName } from '../../worker/src/import/index.js';

export { PIPELINES };

// 学科 → 用哪条管线、以及这条管线要的参数
export const SUBJECT_IMPORTS = {
  biochem: {
    pipeline: 'docx-structured',
    // 必须与 0013_n6_biochem.sql 建的那行课程、以及 groups/ 里那份人工整理的一致。
    // 对不上的话题目会挂到一个不存在的课程上：外键在 D1 上不强制，
    // 入库不报错，subject_id 取出来是 NULL，题查不到也判不了分。
    courseCode: 'biochem-main',
    // 每章一个内容组。orderKey 就是章节号（§6.4.2：内容组之间真正的差异只有排序依据）
    groups: [
      {
        groupId: 'biochem-ch01',
        chapterNo: 1,
        label: '第01章 蛋白质的化学',
        source: 'source/第01章-蛋白质的化学.docx',
      },
    ],
  },
  english: {
    pipeline: 'pdf-ocr-llm',
    note: '蓝本时代跑完的链路：扫描 PDF → OCR → LLM 结构化。原始 PDF 因版权不在仓库里，'
        + '产物已在 data/subjects/english/groups/。本仓库不重跑它。',
  },
};

export function resolvePipeline(subjectCode) {
  const cfg = SUBJECT_IMPORTS[subjectCode];
  if (!cfg) {
    const err = new Error(`unknown_subject: 没有登记学科 ${subjectCode} 的导入管线` +
      `（已登记 ${Object.keys(SUBJECT_IMPORTS).join('、')}）`);
    err.code = 'unknown_subject';
    throw err;
  }
  let pipeline;
  try {
    pipeline = resolveByName(cfg.pipeline);
  } catch (e) {
    // 把"这个学科用的管线没实现"说清楚，而不是只报管线名——
    // 命令行的使用者是按学科码来的。
    e.message = `学科 ${subjectCode} 用的管线 ${cfg.pipeline} 本仓库没有实现` +
      `${cfg.note ? '：' + cfg.note : ''}`;
    throw e;
  }
  return { cfg, pipeline };
}
