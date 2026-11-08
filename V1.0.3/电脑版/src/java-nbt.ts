/**
 * Java Edition NBT 解析（Big-Endian，可自动解 gzip）
 * 用于：.litematic / .schem / .schematic / 结构方块 .nbt 等「投影文件」
 *
 * 与 src/nbt.ts（Bedrock 未压缩 Little-Endian，.mcstructure 用）不同，
 * 这里 TAG_Long / TAG_LongArray 返回 BigInt，避免打包位图（BlockStates）精度丢失。
 */
import * as zlib from "node:zlib";

export function gunzipIfNeeded(buf: Buffer): Buffer {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return zlib.gunzipSync(buf);
  }
  return buf;
}

/** 解析 Java 版 NBT（大端）。输入可以是 gzip 压缩的。 */
export function parseJavaNbt(input: Buffer): any {
  const buf = gunzipIfNeeded(input);
  let off = 0;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const i8 = () => dv.getInt8(off++);
  const u8 = () => dv.getUint8(off++);
  const i16 = () => {
    const v = dv.getInt16(off, false);
    off += 2;
    return v;
  };
  const i32 = () => {
    const v = dv.getInt32(off, false);
    off += 4;
    return v;
  };
  const i64 = () => {
    const v = dv.getBigInt64(off, false);
    off += 8;
    return v;
  };
  const f32 = () => {
    const v = dv.getFloat32(off, false);
    off += 4;
    return v;
  };
  const f64 = () => {
    const v = dv.getFloat64(off, false);
    off += 8;
    return v;
  };
  const str = () => {
    const len = dv.getUint16(off, false);
    off += 2;
    const s = buf.toString("utf8", off, off + len);
    off += len;
    return s;
  };

  function readPayload(type: number): any {
    switch (type) {
      case 1:
        return i8();
      case 2:
        return i16();
      case 3:
        return i32();
      case 4:
        return i64();
      case 5:
        return f32();
      case 6:
        return f64();
      case 7: {
        const n = i32();
        const a: number[] = [];
        for (let i = 0; i < n; i++) a.push(u8());
        return a;
      }
      case 8:
        return str();
      case 9: {
        const t = i8();
        const n = i32();
        const a: any[] = [];
        for (let i = 0; i < n; i++) a.push(readPayload(t));
        return a;
      }
      case 10: {
        const o: any = {};
        for (;;) {
          const t = i8();
          if (t === 0) break;
          const name = str();
          o[name] = readPayload(t);
        }
        return o;
      }
      case 11: {
        const n = i32();
        const a: number[] = [];
        for (let i = 0; i < n; i++) a.push(i32());
        return a;
      }
      case 12: {
        const n = i32();
        const a: bigint[] = [];
        for (let i = 0; i < n; i++) a.push(i64());
        return a;
      }
      default:
        throw new Error(`不支持的 NBT 标签类型：${type}`);
    }
  }

  if (buf.length < 3) throw new Error("文件为空或过短");
  const rootType = i8();
  if (rootType !== 10) throw new Error("根标签不是 Compound（不是有效的投影文件）");
  str(); // 根名称
  return readPayload(10);
}
