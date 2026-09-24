// 最小 ZIP 读取：只为读 docx。
//
// 为什么不引第三方库：这个解析器的产出有一道很强的自检——导入器必须数出
// 34 道题、50 个空（§6.4.3），数量对不上 CI 就红。所以"自己写会不会解析错"
// 这件事有人盯着，而少一个依赖意味着构建链路少一个会变的东西。
//
// 只支持 docx 实际会用到的两种存储方式：stored(0) 与 deflate(8)。
// 碰到别的方式直接抛错——**不猜**。猜的后果是拿到一段乱码，
// 然后在"为什么这一章少了三道题"上查半天。
//
// **全部用 Web 标准，不用 node:zlib、不用 Buffer。** 这个解析器有两个调用方：
// 命令行的 import-subject.mjs 和后台的上传接口，后者跑在 Worker 里，那边既没有
// node:zlib 也没有 Buffer。Node 22 有 DecompressionStream，所以两边共用一份实现。
// 写两份的话迟早分叉，而分叉的表现是"命令行导出来是对的，后台传上去少两道题"。
const u16 = (v, off) => v.getUint16(off, true);
const u32 = (v, off) => v.getUint32(off, true);
const view = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
const utf8 = new TextDecoder();

/** deflate-raw 解压。DecompressionStream 在 Worker 与 Node 18+ 都有。 */
async function inflateRaw(u8) {
  const ds = new DecompressionStream('deflate-raw');
  // 先把读端挂上再写：反过来的话大块数据会把管道写满而没人读，当场死锁。
  const done = new Response(ds.readable).arrayBuffer();
  const w = ds.writable.getWriter();
  await w.write(u8);
  await w.close();
  return new Uint8Array(await done);
}

function fail(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/** 从尾部找中央目录结束记录。注释区最长 65535 字节，所以往回最多找这么多。 */
function findEocd(u8, v) {
  const min = Math.max(0, u8.length - 0xffff - 22);
  for (let i = u8.length - 22; i >= min; i--) {
    if (u32(v, i) === EOCD_SIG) return i;
  }
  throw fail('bad_zip', '找不到 ZIP 的中央目录结束记录，这多半不是一个 zip 文件');
}

/**
 * 读出压缩包里的全部条目，返回 名字 → Buffer。
 * **以中央目录为准**，不去扫本地文件头：本地头的长度字段在用数据描述符时是 0，
 * 照着它读会读到空内容，而且不报错。
 */
export async function readZip(input) {
  // Node 的 Buffer 是 Uint8Array 的子类，Worker 那边拿到的是 ArrayBuffer，两种都收。
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const v = view(u8);
  const eocd = findEocd(u8, v);
  const count = u16(v, eocd + 10);
  let p = u32(v, eocd + 16);
  const out = new Map();

  for (let i = 0; i < count; i++) {
    if (u32(v, p) !== CEN_SIG) {
      throw fail('bad_zip', `第 ${i + 1} 条中央目录记录的签名不对`);
    }
    const method = u16(v, p + 10);
    const compSize = u32(v, p + 20);
    const nameLen = u16(v, p + 28);
    const extraLen = u16(v, p + 30);
    const commentLen = u16(v, p + 32);
    const localOff = u32(v, p + 42);
    const name = utf8.decode(u8.subarray(p + 46, p + 46 + nameLen));

    // 本地文件头：固定 30 字节，后面跟着文件名与扩展区（长度可能与中央目录里的不同）
    const lNameLen = u16(v, localOff + 26);
    const lExtraLen = u16(v, localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = u8.subarray(start, start + compSize);

    if (method === 0) out.set(name, raw.slice());
    else if (method === 8) out.set(name, await inflateRaw(raw));
    else throw fail('bad_zip', `条目 ${name} 用了不支持的压缩方式 ${method}`);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 条目内容按 UTF-8 读成字符串。调用方过去写的是 Buffer 的 .toString('utf8')。 */
export const entryText = (u8) => utf8.decode(u8);
