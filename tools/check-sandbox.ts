/**
 * 沙箱与连接鉴权的自测脚本（开发用，不参与运行）。
 *
 *   npx tsx tools/check-sandbox.ts
 *
 * 覆盖三件事：
 *   1. 命令沙箱拿不到宿主全局（process / require / Buffer）
 *   2. 字符串构造代码（Function / eval）与死循环被拦
 *   3. VoxelGeometry API 在沙箱里照常可用
 *   4. 回环 / 外部连接的 requireAuth 判定
 */
import * as V from "@pureeval/voxel-geometry";
import { Sandbox } from "../src/sandbox";
import { isLoopback, resolveRequireAuth } from "../src/session";

let pass = 0;
let fail = 0;

function check(name: string, fn: () => boolean) {
  try {
    if (fn()) {
      pass++;
      console.log(`  ✔ ${name}`);
    } else {
      fail++;
      console.log(`  ✘ ${name}`);
    }
  } catch (e: any) {
    fail++;
    console.log(`  ✘ ${name} → ${e?.constructor?.name}: ${e?.message}`);
  }
}

console.log("== 沙箱隔离 ==");
const s = new Sandbox({
  ...V.Generator,
  ...V.Exp,
  ...V.Transform,
  ...V.LSystem,
  ...V.IFS,
  ...V.DLA,
  Turtle2D: V.Turtle2D,
  Turtle3D: V.Turtle3D,
  vec3: (x: number, y: number, z: number) => new V.Vec3(x, y, z),
});

check("process 不可达", () => s.eval("typeof process") === "undefined");
check("require 不可达", () => s.eval("typeof require") === "undefined");
check("Buffer 不可达", () => s.eval("typeof Buffer") === "undefined");
check("globalThis.process 不可达", () => s.eval("typeof globalThis.process") === "undefined");
check("基本表达式求值", () => s.eval("1+1") === 2);
check("返回最后表达式的值", () => s.eval("let x = 3; x * 7") === 21);
check("两次 const 不冲突", () => s.eval("const a=1; a") === 1 && s.eval("const a=2; a") === 2);

check("Function 字符串构造被拦", () => {
  try { s.eval('Function("return 1")()'); return false; }
  catch { return true; }
});
check("eval 被拦", () => {
  try { s.eval('eval("1+1")'); return false; }
  catch { return true; }
});
check("死循环被超时打断", () => {
  try { s.eval("while(true){}"); return false; }
  catch { return true; }
});

console.log("== VoxelGeometry 功能未回退 ==");
check("sphere", () => (s.eval("sphere(3,0).length") as number) === 123);
check("circle", () => (s.eval("circle(5,4).length") as number) === 36);
check("simple_equation", () => (s.eval("simple_equation('x*x+y*y+z*z<=5', -5, 5, 1).length") as number) === 57);
check("Turtle2D", () => (s.eval("(()=>{const t=new Turtle2D(); t.forward(10); return t.getTrack().length})()") as number) === 11);
check("lsystem", () => (s.eval("lsystem('X',{X:'XFYFX+F+YFXFY-F-XFXFY',Y:'YFXFY-F-XFXFY+F+YFXFY'},4).length") as number) > 0);
check("move + vec3", () => (s.eval("move(sphere(2,0), vec3(10,0,0)).length") as number) === 33);

console.log("== 连接来源判定 ==");
check("127.0.0.1 属于回环", () => isLoopback("127.0.0.1") === true);
check("127.1.2.3 属于回环", () => isLoopback("127.1.2.3") === true);
check("::1 属于回环", () => isLoopback("::1") === true);
check("::ffff:127.0.0.1 属于回环", () => isLoopback("::ffff:127.0.0.1") === true);
check("192.168.1.5 不是回环", () => isLoopback("192.168.1.5") === false);
check("空地址不是回环", () => isLoopback(undefined) === false);

const savedEnv = { ...process.env };
delete process.env.FB_USERS_FILE;
delete process.env.FB_ALLOW_ANON;
delete process.env.FB_REQUIRE_AUTH;
check("单机 + 回环 → 免验证", () => resolveRequireAuth("127.0.0.1") === false);
check("单机 + 外部 → 需要验证", () => resolveRequireAuth("192.168.1.5") === true);
process.env.FB_ALLOW_ANON = "1";
check("FB_ALLOW_ANON=1 → 全放开", () => resolveRequireAuth("192.168.1.5") === false);
delete process.env.FB_ALLOW_ANON;
process.env.FB_USERS_FILE = "/tmp/users.json";
check("托管站模式 → 回环也要令牌", () => resolveRequireAuth("127.0.0.1") === true);
delete process.env.FB_USERS_FILE;
process.env.FB_REQUIRE_AUTH = "1";
check("FB_REQUIRE_AUTH=1 → 本机也验证", () => resolveRequireAuth("127.0.0.1") === true);
process.env = savedEnv as any;

console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
