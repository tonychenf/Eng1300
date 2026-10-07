// 上传接口：声明的长度超过上限时，读文件之前就拒（CR L8，2026-10-07），纯 node，不起服务。
//
// 为什么不在 n6b-upload.sh 里对着本地服务测：要发一个"请求头说 10MB、实际只有 1 个字节"的请求，
// 本地的 wrangler dev 一收到它整个进程就挂了（试过，后面所有请求都没有响应）。线上由边缘节点挡着。
// 这里直接把请求交给接口：请求体是一个"被读就记一笔"的流，断的是 413 并且**一个字节都没被读**——
// 以前是先 arrayBuffer() 把整个文件读进内存、再判大小，状态码一样是 413，区别只在读没读。
import { importRouter, MAX_BYTES } from '../src/routes/admin-import.js';

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (Object.is(got, want)) { pass++; console.log(`  OK   ${desc}`); }
  else { fail++; console.log(`  FAIL ${desc} (期望 ${JSON.stringify(want)}, 实际 ${JSON.stringify(got)})`); }
};

function tripwire() {
  const seen = { read: false };
  // highWaterMark: 0——默认是 1，流一建好就会先 pull 一次把队列填上，那就分不清是谁读的了
  const body = new ReadableStream({
    pull(ctrl) { seen.read = true; ctrl.enqueue(new Uint8Array([0x50, 0x4b])); ctrl.close(); },
  }, { highWaterMark: 0 });
  return { seen, body };
}
const Q = '/import?subjectCode=biochem&groupId=size-test&label=a&orderKey=1';
// 一个最小的假库，答得上读文件之前那几问：学科是生化（docx 管线）、名下一门课、这个内容组还不存在。
// 有了它，没在最前面拦住的请求会一路走到读文件那一步——和线上一样；拦住了就一个字节都不读
const FAKE_DB = {
  prepare(sql) {
    const row = /FROM subjects/.test(sql)
      ? { subject_id: 2, code: 'biochem', name: '生化', status: '启用', ingest_pipeline: 'docx-structured' }
      : null;
    const rows = /FROM courses/.test(sql) ? [{ course_code: 'biochem-main', course_name: '生化' }] : [];
    const q = { first: async () => row, all: async () => ({ results: rows }) };
    return { ...q, bind: () => q };
  },
};
async function send(declared) {
  const { seen, body } = tripwire();
  const res = await importRouter.request(Q, {
    method: 'POST', headers: { 'content-length': String(declared) }, body, duplex: 'half',
  }, { DB: FAKE_DB });
  let json = null;
  try { json = await res.json(); } catch { /* 走到查库那一步就停，回的不一定是 JSON */ }
  return { status: res.status, read: seen.read, json };
}

const over = await send(MAX_BYTES + 1);
check(`声明 ${MAX_BYTES + 1} 字节（上限 + 1）：413`, over.status, 413);
check('  请求体一个字节都没读', over.read, false);
check('  错误码与说明', `${over.json?.error}/${/超过上限/.test(over.json?.message || '')}`, 'file_too_large/true');
// 对照：没超的照常往下走、真的读了文件（读到的两个字节不是 docx，于是 422 bad_zip）。
// 它同时证明这根"绊线"是灵的：读了就记得下来——不然上面那条"没读"就说明不了什么
const ok = await send(2);
check('声明 2 字节：照常读文件、按 docx 解析（不是 docx，422 bad_zip）', `${ok.status}/${ok.json?.error}/${ok.read}`, '422/bad_zip/true');

console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
