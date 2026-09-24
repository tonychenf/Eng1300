// 导入管线注册表：**按能力注册，不按学科**（同 normalizers 的组织方式）。
//
// 这份注册表在两处被用到：命令行的 scripts/import-subject.mjs，和后台的上传接口
// （跑在 Worker 里）。所以它和它依赖的解析器都放在 worker/src/ 下——
// 与"种子生成器反过来 import worker/src/lib/stem-assets.js"是同一个方向：
// **两边都要用的东西放在 Worker 侧，脚本去取它**，而不是各存一份。
//
// 学科用哪条管线不写在这里，写在 subjects.ingest_pipeline 里。理由：上传接口
// 拿到的是一个学科码，它要从库里查这个学科怎么解析——把对应关系再在代码里存一份，
// 两处迟早不一致，而不一致的表现是"后台传上去解析出来的东西和命令行不一样"。
import { importDocx } from './docx-structured.js';

export const PIPELINES = {
  'docx-structured': {
    name: 'docx 结构化提取',
    accepts: '.docx',
    run: importDocx,
  },
  // 'pdf-ocr-llm'：蓝本时代跑完的链路（扫描 PDF → OCR → LLM 结构化），
  // 产物已在 data/subjects/english/groups/，本仓库不重跑它，所以这里没有实现。
};

/** 按管线名取。认不出就抛错，不回落到某个"默认管线"——那会拿错误的解析器去读文件。 */
export function resolvePipeline(name) {
  const pipeline = PIPELINES[name];
  if (!pipeline) {
    const err = new Error(
      `pipeline_not_implemented: 本仓库没有实现导入管线 ${JSON.stringify(name)}` +
      `（已实现 ${Object.keys(PIPELINES).join('、') || '（无）'}）`);
    err.code = 'pipeline_not_implemented';
    throw err;
  }
  return pipeline;
}
