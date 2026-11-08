/**
 * .mcstructure 修补
 *
 * 常见损坏与处理：
 *  1. gzip 压缩（部分第三方工具会压缩）→ 自动解压
 *  2. 文件末尾缺少 TAG_End 结束标记（截断 1~16 字节）→ 补零后重试解析
 *  3. block_indices 层数不是 2 → 补/删第二层
 *  4. 层内数量与 size 乘积不一致 → 用 -1（保持原方块）补/截断
 *  5. 索引越界或非法 → 置为 -1
 *  6. 缺 format_version / structure_world_origin / entities / block_position_data → 补默认值
 *  7. 调色板条目缺 name → 视为 minecraft:air
 *  8. 调色板整体是字符串数组（少见）→ 转成标准结构
 *
 * 修补结果总是重新序列化成标准未压缩 little-endian NBT。
 */
import * as zlib from "node:zlib";
import { parseNbt } from "./nbt";
import { serializeNbt, NbtValue } from "./nbt-write";
import { parseMcStructure, ParsedStructure } from "./structure";

export type RepairResult = {
  ok: boolean;
  /** 是否真的改动了内容（false 表示文件本来就规范） */
  fixed: boolean;
  issues: string[];
  error?: string;
  data?: Buffer;
  parsed?: ParsedStructure;
};

function isObject(v: any): boolean {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function toIntArray(v: any): number[] {
  return Array.isArray(v) ? v.map((n) => Number(n)) : [];
}

export function repairMcStructure(input: Buffer, name: string): RepairResult {
  const issues: string[] = [];
  let data = input;

  if (!data.length) return { ok: false, fixed: false, issues, error: "文件为空" };

  // 1) gzip
  if (data[0] === 0x1f && data[1] === 0x8b) {
    try {
      data = zlib.gunzipSync(data);
      issues.push("检测到 gzip 压缩，已解压为标准未压缩 NBT");
    } catch (e: any) {
      return { ok: false, fixed: false, issues, error: `gzip 解压失败：${e?.message ?? e}` };
    }
  }

  // 2) 解析（末尾缺结束标记时补零重试）
  let root: any = null;
  for (let extra = 0; extra <= 16 && root === null; extra++) {
    try {
      const buf = extra ? Buffer.concat([data, Buffer.alloc(extra)]) : data;
      root = parseNbt(buf);
      if (extra) issues.push(`文件末尾缺少结束标记，已补齐 ${extra} 字节`);
    } catch {
      root = null;
    }
  }
  if (!isObject(root)) {
    return {
      ok: false,
      fixed: false,
      issues,
      error: "无法解析为 NBT 结构文件（文件可能被截断在数据中间，或不是 .mcstructure）",
    };
  }

  // 3) size
  const size = toIntArray(root.size);
  if (size.length !== 3 || size.some((n) => !Number.isFinite(n) || n <= 0)) {
    return { ok: false, fixed: false, issues, error: "缺少合法的 size 字段（无法确定结构尺寸）" };
  }
  const [sx, sy, sz] = size;
  const expected = sx * sy * sz;

  // 4) structure / palette
  const structure = isObject(root.structure) ? root.structure : {};
  if (!isObject(root.structure)) issues.push("缺少 structure 节点，已补空结构");

  let paletteRaw: any = structure?.palette?.default?.block_palette;
  if (!paletteRaw && Array.isArray(root.block_palette)) paletteRaw = root.block_palette; // 少数工具放在根上
  if (!Array.isArray(paletteRaw) || paletteRaw.length === 0) {
    return { ok: false, fixed: false, issues: [], error: "缺少 block_palette 调色板（无法恢复方块类型）" };
  }
  const palette = paletteRaw.map((entry: any) => {
    if (typeof entry === "string") return { name: entry, version: 18168865, hadStates: false };
    const nm = typeof entry?.name === "string" ? entry.name : null;
    if (!nm) issues.push("调色板里有条目缺少 name，已按 air 处理");
    const states = isObject(entry?.states) ? Object.keys(entry.states).length : 0;
    return {
      name: (nm ?? "minecraft:air").toLowerCase(),
      version: Number.isFinite(Number(entry?.version)) ? Number(entry.version) : 18168865,
      hadStates: states > 0,
    };
  });
  if (palette.some((p) => p.hadStates)) {
    issues.push("调色板包含方块状态（朝向/半砖等），已保留方块 ID 但未写入状态");
  }

  // 5) block_indices 两层
  let layersRaw = structure?.block_indices;
  if (Array.isArray(layersRaw) && layersRaw.length && !Array.isArray(layersRaw[0])) {
    // 只有一层，且不是数组套数组
    layersRaw = [layersRaw];
  }
  if (!Array.isArray(layersRaw) || !Array.isArray(layersRaw[0])) {
    return { ok: false, fixed: false, issues, error: "缺少 block_indices 方块索引数据" };
  }
  const layers = layersRaw.map((l: any) => toIntArray(l));
  if (layers.length < 2) {
    issues.push("block_indices 只有 1 层，已补第二层（全 -1）");
    layers.push(new Array(expected).fill(-1));
  } else if (layers.length > 2) {
    issues.push(`block_indices 有 ${layers.length} 层，已只保留前两层`);
    layers.length = 2;
  }

  // 6) 长度与索引校验
  let outOfRange = 0;
  for (let li = 0; li < 2; li++) {
    let layer = layers[li];
    if (layer.length < expected) {
      issues.push(`第 ${li + 1} 层数量 ${layer.length} < 尺寸 ${expected}，已用 -1 补齐`);
      layer = layer.concat(new Array(expected - layer.length).fill(li === 0 ? -1 : -1));
    } else if (layer.length > expected) {
      issues.push(`第 ${li + 1} 层数量 ${layer.length} > 尺寸 ${expected}，已截断`);
      layer = layer.slice(0, expected);
    }
    layer = layer.map((v) => {
      if (!Number.isInteger(v) || v < -1 || v >= palette.length) {
        outOfRange++;
        return -1;
      }
      return v;
    });
    layers[li] = layer;
  }
  if (outOfRange) issues.push(`有 ${outOfRange} 个方块索引越界/非法，已置为 -1（保持原方块）`);

  // 7) 其他可选字段
  const formatVersion = Number.isFinite(Number(root.format_version)) ? Number(root.format_version) : 1;
  if (root.format_version === undefined) issues.push("缺少 format_version，已补 1");
  const origin = toIntArray(root.structure_world_origin);
  const fixedOrigin = origin.length === 3 && origin.every((n) => Number.isFinite(n)) ? origin : [0, 0, 0];
  if (root.structure_world_origin === undefined) issues.push("缺少 structure_world_origin，已补 [0,0,0]");

  // 8) 重新序列化
  const intList = (values: number[]): NbtValue => ({
    type: "list",
    element: "int",
    items: values.map((v) => ({ type: "int", value: v })),
  });
  const fixedRoot: NbtValue = {
    type: "compound",
    fields: {
      format_version: { type: "int", value: formatVersion },
      size: intList([sx, sy, sz]),
      structure: {
        type: "compound",
        fields: {
          block_indices: {
            type: "list",
            element: "list",
            items: [layers[0], layers[1]].map(intList),
          },
          entities: { type: "list", element: "compound", items: [] },
          palette: {
            type: "compound",
            fields: {
              default: {
                type: "compound",
                fields: {
                  block_palette: {
                    type: "list",
                    element: "compound",
                    items: palette.map((p) => ({
                      type: "compound",
                      fields: {
                        name: { type: "string", value: p.name },
                        version: { type: "int", value: p.version },
                      },
                    })),
                  },
                  block_position_data: { type: "compound", fields: {} },
                },
              },
            },
          },
        },
      },
      structure_world_origin: intList(fixedOrigin),
    },
  };

  const out = serializeNbt(fixedRoot);

  // 9) 再解析一遍确认能用（顺便拿到导入信息）
  let parsed: ParsedStructure;
  try {
    parsed = parseMcStructure(out, name);
  } catch (e: any) {
    return { ok: false, fixed: issues.length > 0, issues, error: `修补后仍无法解析：${e?.message ?? e}` };
  }

  return { ok: true, fixed: issues.length > 0, issues, data: out, parsed };
}
