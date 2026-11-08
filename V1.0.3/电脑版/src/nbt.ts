/**
 * 极简 NBT 解析器（仅支持读，Little-Endian，用于 .mcstructure）
 * 标签类型：1 Byte / 2 Short / 3 Int / 4 Long / 5 Float / 6 Double /
 *           7 ByteArray / 8 String / 9 List / 10 Compound / 11 IntArray / 12 LongArray
 */
export function parseNbt(buf: Buffer): any {
  let off = 0;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const i8 = () => dv.getInt8(off++);
  const i16 = () => {
    const v = dv.getInt16(off, true);
    off += 2;
    return v;
  };
  const i32 = () => {
    const v = dv.getInt32(off, true);
    off += 4;
    return v;
  };
  const i64 = () => {
    const v = dv.getBigInt64(off, true);
    off += 8;
    return Number(v);
  };
  const f32 = () => {
    const v = dv.getFloat32(off, true);
    off += 4;
    return v;
  };
  const f64 = () => {
    const v = dv.getFloat64(off, true);
    off += 8;
    return v;
  };
  const str = () => {
    const len = dv.getUint16(off, true);
    off += 2;
    const s = buf.toString("utf8", off, off + len);
    off += len;
    return s;
  };

  function readTag(type: number): any {
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
        for (let i = 0; i < n; i++) a.push(i8());
        return a;
      }
      case 8:
        return str();
      case 9: {
        const t = i8();
        const n = i32();
        const a: any[] = [];
        for (let i = 0; i < n; i++) a.push(readTag(t));
        return a;
      }
      case 10: {
        const o: any = {};
        for (;;) {
          const t = i8();
          if (t === 0) break;
          const name = str();
          o[name] = readTag(t);
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
        const a: number[] = [];
        for (let i = 0; i < n; i++) a.push(i64());
        return a;
      }
      default:
        throw new Error(`不支持的 NBT 标签类型：${type}`);
    }
  }

  if (off >= buf.length) throw new Error("文件为空");
  const rootType = i8();
  if (rootType !== 10) throw new Error("不是合法的结构文件（根标签不是 Compound）");
  str(); // 根名称
  return readTag(10);
}
