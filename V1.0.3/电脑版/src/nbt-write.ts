/**
 * NBT 序列化（Little-Endian），用于把修补后的结构写回标准 .mcstructure
 * 只支持结构文件用得到的类型：Int / String / List / Compound
 */
export type NbtValue =
  | { type: "int"; value: number }
  | { type: "string"; value: string }
  | { type: "list"; element: "int" | "string" | "compound" | "list"; items: NbtValue[] }
  | { type: "compound"; fields: Record<string, NbtValue> };

const TAG = { int: 3, string: 8, list: 9, compound: 10 } as const;

function i32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(Math.trunc(v) | 0);
  return b;
}

function nbtString(s: string): Buffer {
  const body = Buffer.from(s, "utf8");
  const head = Buffer.alloc(2);
  head.writeUInt16LE(body.length, 0);
  return Buffer.concat([head, body]);
}

function payload(v: NbtValue): Buffer {
  switch (v.type) {
    case "int":
      return i32(v.value);
    case "string":
      return nbtString(v.value);
    case "compound": {
      const parts: Buffer[] = [];
      for (const [key, field] of Object.entries(v.fields)) {
        parts.push(Buffer.from([TAG[field.type]]), nbtString(key), payload(field));
      }
      parts.push(Buffer.from([0])); // TAG_End
      return Buffer.concat(parts);
    }
    case "list": {
      const elementType = TAG[v.element];
      return Buffer.concat([Buffer.from([elementType]), i32(v.items.length), ...v.items.map((item) => payload(item))]);
    }
  }
}

/** 写出完整文件：根标签必须是 compound，名称用 "root" */
export function serializeNbt(root: NbtValue): Buffer {
  if (root.type !== "compound") throw new Error("根标签必须是 Compound");
  return Buffer.concat([Buffer.from([TAG.compound]), nbtString("root"), payload(root)]);
}
