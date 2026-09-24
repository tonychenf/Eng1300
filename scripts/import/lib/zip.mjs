// 最小 ZIP 读取：只为读 docx。
//
// 为什么不引第三方库：这个解析器的产出有一道很强的自检——导入器必须数出
// 34 道题、50 个空（§6.4.3），数量对不上 CI 就红。所以"自己写会不会解析错"
// 这件事有人盯着，而少一个依赖意味着构建链路少一个会变的东西。
//
// 只支持 docx 实际会用到的两种存储方式：stored(0) 与 deflate(8)。
// 碰到别的方式直接抛错——**不猜**。猜的后果是拿到一段乱码，
// 然后在"为什么这一章少了三道题"上查半天。
import { inflateRawSync } from 'node:zlib';

function fail(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/** 从尾部找中央目录结束记录。注释区最长 65535 字节，所以往回最多找这么多。 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw fail('bad_zip', '找不到 ZIP 的中央目录结束记录，这多半不是一个 zip 文件');
}

/**
 * 读出压缩包里的全部条目，返回 名字 → Buffer。
 * **以中央目录为准**，不去扫本地文件头：本地头的长度字段在用数据描述符时是 0，
 * 照着它读会读到空内容，而且不报错。
 */
export function readZip(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) {
      throw fail('bad_zip', `第 ${i + 1} 条中央目录记录的签名不对`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // 本地文件头：固定 30 字节，后面跟着文件名与扩展区（长度可能与中央目录里的不同）
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);

    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, inflateRawSync(raw));
    else throw fail('bad_zip', `条目 ${name} 用了不支持的压缩方式 ${method}`);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
