/**
 * 投影文件解析（Java 版格式 → 统一的 ParsedStructure）
 *
 * 支持：
 *  - .litematic  Litematica 投影（gzip + 大端 NBT，BlockStates 位打包）
 *  - .schem      Sponge 原理图 v1/v2/v3（gzip，BlockData 变长整数）
 *  - .schematic  MCEdit/WorldEdit 经典原理图（gzip，Blocks 字节数组 + 可选 AddBlocks）
 *  - .nbt        结构方块导出的结构（大端 NBT）
 *  - .mcstructure Bedrock 结构（沿用 src/structure.ts）
 *
 * 只处理方块 ID（忽略方块状态），与原 .mcstructure 管线保持一致。
 */
import { parseNbt } from "./nbt";
import { parseJavaNbt } from "./java-nbt";
import { parseMcStructure, ParsedStructure, StructureBlock } from "./structure";

const AIR = new Set([
  "minecraft:air",
  "minecraft:cave_air",
  "minecraft:void_air",
  "minecraft:structure_void",
]);

/** 经典 .schematic 数字 ID → 方块名（常见方块子集） */
const LEGACY_IDS: Record<number, string> = {
  1: "minecraft:stone",
  2: "minecraft:grass_block",
  3: "minecraft:dirt",
  4: "minecraft:cobblestone",
  5: "minecraft:oak_planks",
  6: "minecraft:oak_sapling",
  7: "minecraft:bedrock",
  8: "minecraft:water",
  9: "minecraft:water",
  10: "minecraft:lava",
  11: "minecraft:lava",
  12: "minecraft:sand",
  13: "minecraft:gravel",
  14: "minecraft:gold_ore",
  15: "minecraft:iron_ore",
  16: "minecraft:coal_ore",
  17: "minecraft:oak_log",
  18: "minecraft:oak_leaves",
  19: "minecraft:sponge",
  20: "minecraft:glass",
  21: "minecraft:lapis_ore",
  22: "minecraft:lapis_block",
  23: "minecraft:dispenser",
  24: "minecraft:sandstone",
  25: "minecraft:note_block",
  26: "minecraft:red_bed",
  27: "minecraft:powered_rail",
  28: "minecraft:detector_rail",
  29: "minecraft:sticky_piston",
  30: "minecraft:cobweb",
  31: "minecraft:grass",
  32: "minecraft:dead_bush",
  33: "minecraft:piston",
  34: "minecraft:piston_head",
  35: "minecraft:white_wool",
  37: "minecraft:dandelion",
  38: "minecraft:poppy",
  39: "minecraft:brown_mushroom",
  40: "minecraft:red_mushroom",
  41: "minecraft:gold_block",
  42: "minecraft:iron_block",
  43: "minecraft:smooth_stone_slab",
  44: "minecraft:stone_slab",
  45: "minecraft:bricks",
  46: "minecraft:tnt",
  47: "minecraft:bookshelf",
  48: "minecraft:mossy_cobblestone",
  49: "minecraft:obsidian",
  50: "minecraft:torch",
  51: "minecraft:fire",
  52: "minecraft:spawner",
  53: "minecraft:oak_stairs",
  54: "minecraft:chest",
  55: "minecraft:redstone_wire",
  56: "minecraft:diamond_ore",
  57: "minecraft:diamond_block",
  58: "minecraft:crafting_table",
  59: "minecraft:wheat",
  60: "minecraft:farmland",
  61: "minecraft:furnace",
  62: "minecraft:oak_sign",
  63: "minecraft:oak_door",
  64: "minecraft:ladder",
  65: "minecraft:rail",
  66: "minecraft:cobblestone_stairs",
  67: "minecraft:cobblestone_stairs",
  68: "minecraft:oak_wall_sign",
  69: "minecraft:lever",
  70: "minecraft:stone_pressure_plate",
  71: "minecraft:iron_door",
  72: "minecraft:oak_pressure_plate",
  73: "minecraft:redstone_ore",
  74: "minecraft:redstone_torch",
  75: "minecraft:redstone_wall_torch",
  76: "minecraft:redstone_torch",
  77: "minecraft:stone_button",
  78: "minecraft:snow",
  79: "minecraft:ice",
  80: "minecraft:snow_block",
  81: "minecraft:cactus",
  82: "minecraft:clay",
  83: "minecraft:sugar_cane",
  84: "minecraft:jukebox",
  85: "minecraft:oak_fence",
  86: "minecraft:carved_pumpkin",
  87: "minecraft:netherrack",
  88: "minecraft:soul_sand",
  89: "minecraft:glowstone",
  90: "minecraft:nether_portal",
  91: "minecraft:jack_o_lantern",
  92: "minecraft:cake",
  93: "minecraft:repeater",
  94: "minecraft:repeater",
  95: "minecraft:white_stained_glass",
  96: "minecraft:oak_trapdoor",
  97: "minecraft:infested_stone",
  98: "minecraft:stone_bricks",
  99: "minecraft:brown_mushroom_block",
  100: "minecraft:red_mushroom_block",
  101: "minecraft:iron_bars",
  102: "minecraft:glass_pane",
  103: "minecraft:melon",
  104: "minecraft:pumpkin_stem",
  105: "minecraft:melon_stem",
  106: "minecraft:vine",
  107: "minecraft:oak_fence_gate",
  108: "minecraft:brick_stairs",
  109: "minecraft:stone_brick_stairs",
  110: "minecraft:mycelium",
  111: "minecraft:lily_pad",
  112: "minecraft:nether_bricks",
  113: "minecraft:nether_brick_fence",
  114: "minecraft:nether_brick_stairs",
  115: "minecraft:nether_wart",
  116: "minecraft:enchanting_table",
  117: "minecraft:brewing_stand",
  118: "minecraft:cauldron",
  119: "minecraft:end_portal",
  120: "minecraft:end_portal_frame",
  121: "minecraft:end_stone",
  122: "minecraft:dragon_egg",
  123: "minecraft:redstone_lamp",
  124: "minecraft:redstone_lamp",
  125: "minecraft:oak_slab",
  126: "minecraft:oak_slab",
  128: "minecraft:sandstone_stairs",
  129: "minecraft:emerald_ore",
  130: "minecraft:ender_chest",
  131: "minecraft:tripwire_hook",
  132: "minecraft:tripwire",
  133: "minecraft:emerald_block",
  134: "minecraft:spruce_stairs",
  135: "minecraft:birch_stairs",
  136: "minecraft:jungle_stairs",
  137: "minecraft:command_block",
  138: "minecraft:beacon",
  139: "minecraft:cobblestone_wall",
  140: "minecraft:flower_pot",
  141: "minecraft:carrots",
  142: "minecraft:potatoes",
  143: "minecraft:oak_button",
  144: "minecraft:skeleton_skull",
  145: "minecraft:anvil",
  146: "minecraft:trapped_chest",
  147: "minecraft:light_weighted_pressure_plate",
  148: "minecraft:heavy_weighted_pressure_plate",
  149: "minecraft:comparator",
  150: "minecraft:comparator",
  151: "minecraft:daylight_detector",
  152: "minecraft:redstone_block",
  153: "minecraft:nether_quartz_ore",
  154: "minecraft:hopper",
  155: "minecraft:quartz_block",
  156: "minecraft:quartz_stairs",
  157: "minecraft:activator_rail",
  158: "minecraft:dropper",
  159: "minecraft:white_terracotta",
  160: "minecraft:white_stained_glass_pane",
  161: "minecraft:acacia_leaves",
  162: "minecraft:acacia_log",
  163: "minecraft:acacia_stairs",
  164: "minecraft:dark_oak_stairs",
  168: "minecraft:prismarine",
  169: "minecraft:sea_lantern",
  170: "minecraft:hay_block",
  171: "minecraft:white_carpet",
  172: "minecraft:terracotta",
  173: "minecraft:coal_block",
  174: "minecraft:packed_ice",
  175: "minecraft:sunflower",
  179: "minecraft:red_sandstone",
  180: "minecraft:red_sandstone_stairs",
  181: "minecraft:red_sandstone_slab",
  182: "minecraft:spruce_fence_gate",
  183: "minecraft:birch_fence_gate",
  184: "minecraft:jungle_fence_gate",
  185: "minecraft:dark_oak_fence_gate",
  186: "minecraft:acacia_fence_gate",
  187: "minecraft:spruce_fence",
  188: "minecraft:birch_fence",
  189: "minecraft:jungle_fence",
  190: "minecraft:dark_oak_fence",
  191: "minecraft:acacia_fence",
  192: "minecraft:spruce_door",
  193: "minecraft:birch_door",
  194: "minecraft:jungle_door",
  195: "minecraft:acacia_door",
  196: "minecraft:dark_oak_door",
  197: "minecraft:end_rod",
  198: "minecraft:chorus_plant",
  199: "minecraft:chorus_flower",
  200: "minecraft:purpur_block",
  201: "minecraft:purpur_pillar",
  202: "minecraft:purpur_stairs",
  203: "minecraft:purpur_slab",
  204: "minecraft:purpur_slab",
  205: "minecraft:purpur_slab",
  206: "minecraft:end_stone_bricks",
  208: "minecraft:dirt_path",
  210: "minecraft:repeating_command_block",
  211: "minecraft:chain_command_block",
  213: "minecraft:magma_block",
  214: "minecraft:nether_wart_block",
  215: "minecraft:red_nether_bricks",
  216: "minecraft:bone_block",
  218: "minecraft:observer",
  219: "minecraft:white_shulker_box",
  220: "minecraft:white_glazed_terracotta",
  251: "minecraft:white_concrete",
  252: "minecraft:white_concrete_powder",
};

function normName(n: any): string {
  return String(n ?? "minecraft:air").toLowerCase();
}

function isAir(name: string): boolean {
  return AIR.has(name);
}

/** 统一收尾：把坐标平移到最小角、排序（x→y→z）、生成 ParsedStructure */
function finish(
  name: string,
  raw: StructureBlock[],
  paletteSize: number,
  skippedAir: number
): ParsedStructure {
  if (!raw.length) throw new Error("文件里没有可放置的方块（可能全是空气）");
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const b of raw) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.z < minZ) minZ = b.z;
    if (b.x > maxX) maxX = b.x;
    if (b.y > maxY) maxY = b.y;
    if (b.z > maxZ) maxZ = b.z;
  }
  const size = { x: maxX - minX + 1, y: maxY - minY + 1, z: maxZ - minZ + 1 };
  const blocks = raw.map((b) => ({ x: b.x - minX, y: b.y - minY, z: b.z - minZ, block: b.block }));
  blocks.sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
  return {
    name,
    size,
    blocks,
    total: blocks.length,
    paletteSize: Math.max(1, paletteSize),
    skippedAir,
    materials: [...new Set(blocks.map((b) => b.block))].slice(0, 40),
  };
}

/** ===== Litematica ===== */
function unpackLitematic(states: bigint[], bits: number, count: number, paletteLen: number): number[] {
  const mask = (1n << BigInt(bits)) - 1n;
  const read = (arr: bigint[], i: number): number => {
    const bitPos = i * bits;
    const word = bitPos >> 6;
    const shift = bitPos & 63;
    let v = BigInt.asUintN(64, arr[word] ?? 0n) >> BigInt(shift);
    if (shift + bits > 64) {
      const hi = BigInt.asUintN(64, arr[word + 1] ?? 0n) << BigInt(64 - shift);
      v = (v | hi) & mask;
    } else {
      v &= mask;
    }
    return Number(v);
  };
  // 先按「连续位流」解（Litematica 实际格式）
  const ids: number[] = new Array(count);
  for (let i = 0; i < count; i++) ids[i] = read(states, i);
  if (ids.every((v) => v < paletteLen)) return ids;
  // 兜底：按「每个 long 内补齐」解
  const perLong = Math.max(1, Math.floor(64 / bits));
  const padded: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const word = Math.floor(i / perLong);
    const shift = (i % perLong) * bits;
    const v = BigInt.asUintN(64, states[word] ?? 0n) >> BigInt(shift);
    padded[i] = Number(v & mask);
  }
  if (padded.every((v) => v < paletteLen)) return padded;
  return ids;
}

function parseLitematic(root: any, name: string): ParsedStructure {
  const regions = root.Regions;
  if (!regions || typeof regions !== "object") throw new Error("不是 Litematica 投影（缺少 Regions）");
  const raw: StructureBlock[] = [];
  let paletteSize = 0;
  let skipped = 0;
  for (const region of Object.values<any>(regions)) {
    const pos = region?.Position || { x: 0, y: 0, z: 0 };
    const size = region?.Size || { x: 0, y: 0, z: 0 };
    const sx = Math.abs(Math.trunc(Number(size.x)));
    const sy = Math.abs(Math.trunc(Number(size.y)));
    const sz = Math.abs(Math.trunc(Number(size.z)));
    if (!sx || !sy || !sz) continue;
    const palette: any[] = Array.isArray(region?.BlockStatePalette) ? region.BlockStatePalette : [];
    paletteSize = Math.max(paletteSize, palette.length);
    const names = palette.map((p) => normName(p?.Name ?? p?.name));
    const volume = sx * sy * sz;
    const states: bigint[] | undefined = Array.isArray(region?.BlockStates) ? region.BlockStates : undefined;
    let ids: number[];
    if (!states || !states.length) {
      ids = new Array(volume).fill(0);
    } else {
      const bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, palette.length))));
      ids = unpackLitematic(states, bits, volume, Math.max(1, palette.length));
    }
    const px = Math.trunc(Number(pos.x));
    const py = Math.trunc(Number(pos.y));
    const pz = Math.trunc(Number(pos.z));
    const negX = Number(size.x) < 0;
    const negY = Number(size.y) < 0;
    const negZ = Number(size.z) < 0;
    for (let i = 0; i < volume; i++) {
      const nm = names[ids[i]] ?? "minecraft:air";
      if (isAir(nm)) {
        skipped++;
        continue;
      }
      const lx = i % sx;
      const lz = Math.floor(i / sx) % sz;
      const ly = Math.floor(i / (sx * sz));
      raw.push({
        x: px + (negX ? -lx - 1 : lx),
        y: py + (negY ? -ly - 1 : ly),
        z: pz + (negZ ? -lz - 1 : lz),
        block: nm,
      });
    }
  }
  return finish(name, raw, paletteSize, skipped);
}

/** ===== Sponge 原理图（.schem） ===== */
function decodeVarints(data: number[], count: number): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < data.length && out.length < count) {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = data[i++] & 0xff;
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) throw new Error("BlockData 变长整数损坏");
    }
    out.push(value >>> 0);
  }
  return out;
}

function parseSponge(root: any, name: string): ParsedStructure {
  const sch = root.Schematic && typeof root.Schematic === "object" ? root.Schematic : root;
  const sx = Math.trunc(Number(sch.Width));
  const sy = Math.trunc(Number(sch.Height));
  const sz = Math.trunc(Number(sch.Length));
  if (!sx || !sy || !sz) throw new Error("Sponge 原理图缺少 Width/Height/Length");
  const palette = sch.Palette;
  const data = sch.BlockData;
  if (!palette || typeof palette !== "object" || !Array.isArray(data)) {
    throw new Error("Sponge 原理图缺少 Palette/BlockData");
  }
  const rev = new Map<number, string>();
  for (const [n, idx] of Object.entries(palette)) rev.set(Number(idx), normName(n));
  const ids = decodeVarints(data, sx * sy * sz);
  const raw: StructureBlock[] = [];
  let skipped = 0;
  for (let i = 0; i < ids.length; i++) {
    const nm = rev.get(ids[i]);
    if (!nm || isAir(nm)) {
      skipped++;
      continue;
    }
    const x = i % sx;
    const z = Math.floor(i / sx) % sz;
    const y = Math.floor(i / (sx * sz));
    raw.push({ x, y, z, block: nm });
  }
  return finish(name, raw, rev.size, skipped);
}

/** ===== MCEdit / WorldEdit 经典 .schematic ===== */
function parseSchematic(root: any, name: string): ParsedStructure {
  const sx = Math.trunc(Number(root.Width));
  const sy = Math.trunc(Number(root.Height));
  const sz = Math.trunc(Number(root.Length));
  if (!sx || !sy || !sz) throw new Error("原理图缺少 Width/Height/Length");

  // 少数工具把 Sponge 的 Palette/BlockData 塞进 .schematic
  if (root.Palette && Array.isArray(root.BlockData)) return parseSponge(root, name);

  const blocksArr = root.Blocks;
  if (!Array.isArray(blocksArr)) throw new Error("原理图缺少 Blocks 数据");
  const add = Array.isArray(root.AddBlocks) ? root.AddBlocks : null;
  const palette: Record<string, any> | null =
    root.Palette && typeof root.Palette === "object" && !Array.isArray(root.Palette) ? root.Palette : null;
  const rev = new Map<number, string>();
  if (palette) for (const [n, idx] of Object.entries(palette)) rev.set(Number(idx), normName(n));

  const raw: StructureBlock[] = [];
  let skipped = 0;
  let unknown = 0;
  const volume = sx * sy * sz;
  for (let i = 0; i < volume; i++) {
    const low = (blocksArr[i] ?? 0) & 0xff;
    let high = 0;
    if (add) high = (add[i >> 1] >> ((i & 1) * 4)) & 0x0f;
    const id = low | (high << 8);
    let nm: string | undefined = rev.get(id) ?? LEGACY_IDS[id];
    if (nm === undefined) {
      unknown++;
      skipped++;
      continue;
    }
    if (isAir(nm)) {
      skipped++;
      continue;
    }
    const x = i % sx;
    const z = Math.floor(i / sx) % sz;
    const y = Math.floor(i / (sx * sz));
    raw.push({ x, y, z, block: nm });
  }
  if (unknown > 0 && raw.length === 0) {
    throw new Error(`无法识别的旧版方块 ID ${unknown} 个（该文件可能没有 Palette，暂不支持）`);
  }
  if (unknown > 0) {
    // 有部分未知 ID 时仍然可用，但记录下来
    skipped += unknown;
  }
  return finish(name, raw, rev.size || 256, skipped);
}

/** ===== 结构方块 .nbt（Java） ===== */
function parseJavaStructure(root: any, name: string): ParsedStructure {
  const size = Array.isArray(root.size) ? root.size : null;
  if (!size || size.length !== 3) throw new Error("结构文件缺少 size");
  const sx = Math.trunc(Number(size[0]));
  const sy = Math.trunc(Number(size[1]));
  const sz = Math.trunc(Number(size[2]));
  if (!sx || !sy || !sz) throw new Error("结构尺寸无效");
  const palette: any[] = Array.isArray(root.palette) ? root.palette : [];
  const names = palette.map((p) => normName(p?.Name ?? p?.name));
  const blocks: any[] = Array.isArray(root.blocks) ? root.blocks : [];
  const raw: StructureBlock[] = [];
  let skipped = 0;
  for (const b of blocks) {
    const pos = Array.isArray(b?.pos) ? b.pos : null;
    const st = Math.trunc(Number(b?.state ?? 0));
    if (!pos || pos.length !== 3) continue;
    const nm = names[st];
    if (!nm || isAir(nm)) {
      skipped++;
      continue;
    }
    raw.push({ x: Math.trunc(Number(pos[0])), y: Math.trunc(Number(pos[1])), z: Math.trunc(Number(pos[2])), block: nm });
  }
  return finish(name, raw, palette.length, skipped);
}

/** 根据 NBT 根节点判断投影格式并解析 */
function fromJavaRoot(root: any, name: string): ParsedStructure {
  if (root && typeof root === "object") {
    if (root.Regions || root.Metadata) return parseLitematic(root, name);
    if (root.Schematic && typeof root.Schematic === "object") return parseSponge(root, name);
    if (root.Palette && Array.isArray(root.BlockData)) return parseSponge(root, name);
    if (root.Width !== undefined && root.Height !== undefined && root.Length !== undefined) {
      return root.Palette && !Array.isArray(root.Blocks)
        ? parseSponge(root, name)
        : parseSchematic(root, name);
    }
    if (root.size && root.palette && root.blocks) return parseJavaStructure(root, name);
  }
  throw new Error("无法识别的投影文件格式（支持 .litematic / .schem / .schematic / .nbt / .mcstructure）");
}

/** 是否 gzip 压缩（Java 版投影文件基本都是） */
export function isGzip(buf: Buffer): boolean {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/**
 * 统一解析入口：自动识别 .mcstructure（Bedrock LE）与各类 Java 投影文件。
 */
export function parseStructureFile(buf: Buffer, name: string): ParsedStructure {
  if (!buf.length) throw new Error("文件为空");

  // Java 版投影文件基本都是 gzip
  if (isGzip(buf)) {
    return fromJavaRoot(parseJavaNbt(buf), name);
  }

  // 先试 Bedrock .mcstructure（LE，未压缩）
  try {
    const root = parseNbt(buf);
    if (root && root.structure && Array.isArray(root.size)) {
      return parseMcStructure(buf, name);
    }
  } catch {}

  // 再试 Java 大端 NBT（未压缩的 .nbt / .litematic）
  try {
    return fromJavaRoot(parseJavaNbt(buf), name);
  } catch (e: any) {
    throw new Error(`无法识别文件格式：${e?.message ?? e}`);
  }
}
