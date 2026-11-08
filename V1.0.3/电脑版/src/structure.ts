/**
 * .mcstructure 解析与命令生成
 *
 * 文件格式（Bedrock，未压缩 little-endian NBT）：
 *   { format_version:int, size:[x,y,z], structure:{ block_indices:[[...],[...]],
 *     palette:{ default:{ block_palette:[{name,states,version}], block_position_data } } } }
 *
 * block_indices 每个子列表按 ZYX 顺序（z 变化最快）：
 *   index = (x * sizeY + y) * sizeZ + z
 *   -1 表示空（保持原方块）；palette 里 minecraft:air 也视为空。
 */
import { parseNbt } from "./nbt";

export type StructureBlock = { x: number; y: number; z: number; block: string };

export type ParsedStructure = {
  name: string;
  size: { x: number; y: number; z: number };
  /** 需要放置的方块（已去掉空气与空位），按 z 最快的顺序 */
  blocks: StructureBlock[];
  total: number;
  paletteSize: number;
  skippedAir: number;
  /** 调色板里出现过的方块名（去重） */
  materials: string[];
};

export type BuildCommand = { command: string; count: number };

export function parseMcStructure(buf: Buffer, name: string): ParsedStructure {
  const root = parseNbt(buf);

  const sizeArr = root?.size;
  if (!Array.isArray(sizeArr) || sizeArr.length !== 3) {
    throw new Error("结构文件缺少 size 字段");
  }
  const sx = Math.max(0, Math.trunc(Number(sizeArr[0])));
  const sy = Math.max(0, Math.trunc(Number(sizeArr[1])));
  const sz = Math.max(0, Math.trunc(Number(sizeArr[2])));
  if (!sx || !sy || !sz) throw new Error(`结构尺寸无效：${sx}×${sy}×${sz}`);

  const palette = root?.structure?.palette?.default?.block_palette;
  if (!Array.isArray(palette) || palette.length === 0) {
    throw new Error("结构文件缺少 palette.default.block_palette 字段");
  }
  const names: string[] = palette.map((p: any) => String(p?.name ?? "minecraft:air").toLowerCase());

  const layers = root?.structure?.block_indices;
  if (!Array.isArray(layers) || !Array.isArray(layers[0])) {
    throw new Error("结构文件缺少 structure.block_indices 字段");
  }
  const layer0: number[] = layers[0].map((v: any) => Number(v));
  const totalPositions = sx * sy * sz;
  if (layer0.length !== totalPositions) {
    throw new Error(
      `block_indices 数量（${layer0.length}）与尺寸 ${sx}×${sy}×${sz}（${totalPositions}）不一致`
    );
  }

  const blocks: StructureBlock[] = [];
  let skippedAir = 0;
  for (let i = 0; i < layer0.length; i++) {
    const idx = layer0[i];
    if (idx < 0) continue; // 空位，保持原方块
    const block = names[idx];
    if (!block || block === "minecraft:air" || block === "minecraft:structure_void") {
      skippedAir++;
      continue;
    }
    const z = i % sz;
    const y = Math.floor(i / sz) % sy;
    const x = Math.floor(i / (sz * sy));
    blocks.push({ x, y, z, block });
  }

  const materials = [...new Set(blocks.map((b) => b.block))];
  return {
    name,
    size: { x: sx, y: sy, z: sz },
    blocks,
    total: blocks.length,
    paletteSize: palette.length,
    skippedAir,
    materials: materials.slice(0, 40),
  };
}

/**
 * 生成放置命令：沿 z 轴把连续同方块合并成 fill，显著减少命令数
 * @param origin 放置原点（世界坐标，对应结构局部坐标 0,0,0）
 * @param offsetY Y 方向额外偏移
 */
export function structureCommands(
  st: ParsedStructure,
  origin: { x: number; y: number; z: number },
  offsetY = 0
): BuildCommand[] {
  const cmds: BuildCommand[] = [];
  const MAX_RUN = 64;
  const blocks = st.blocks;
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    let j = i + 1;
    while (
      j < blocks.length &&
      j - i < MAX_RUN &&
      blocks[j].x === b.x &&
      blocks[j].y === b.y &&
      blocks[j].z === b.z + (j - i) &&
      blocks[j].block === b.block
    ) {
      j++;
    }
    const len = j - i;
    const wx = origin.x + b.x;
    const wy = origin.y + b.y + offsetY;
    const wz = origin.z + b.z;
    if (len === 1) {
      cmds.push({ command: `setblock ${wx} ${wy} ${wz} ${b.block}`, count: 1 });
    } else {
      cmds.push({
        command: `fill ${wx} ${wy} ${wz} ${wx} ${wy} ${wz + len - 1} ${b.block}`,
        count: len,
      });
    }
    i = j;
  }
  return cmds;
}
