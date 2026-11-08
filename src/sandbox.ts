import vm from "node:vm";

/** 单条命令的同步执行上限（毫秒），防止 `-while(true){}` 之类把实例卡死 */
const EXEC_TIMEOUT_MS = Math.max(
  100,
  Number(process.env.FB_SANDBOX_TIMEOUT ?? 5000) || 5000
);

/**
 * 命令沙箱。
 *
 * 旧实现是 `new Function("inside", "with(inside){ ... }")`：`with` 只把沙箱对象
 * 插到作用域链**前端**，宿主全局依旧可达，于是任何能连上 WS 端口的人都能在宿主
 * Node 进程里拿到 `process` 并执行任意代码。
 *
 * 现在改为 node:vm 的独立上下文：
 *   · 每次执行新建 context，不继承宿主全局 —— `process` / `require` / `Buffer` 不可达
 *   · `codeGeneration.strings: false` —— 挡住 `Function("return process")()` 这类字符串构造
 *   · `timeout` —— 限制同步执行时间，死循环会抛错而不是挂住进程
 *
 * 已知限制：注入给脚本的 API（`plot` / `setBlocks` / `session` ...）是宿主对象，
 * 理论上可以顺着它们的原型链摸到宿主 `Function`。这层挡的是"直取 process"这条
 * 最短路径，不是完整隔离。要做到完整隔离，需要把脚本执行搬进 worker_threads
 * 或独立子进程，只把生成好的方块数据回传主进程。
 */
class Sandbox {
  /** 累积注入的环境（跨次执行保留，避免每次 run 都重新注入全量 API） */
  private env: Record<string, unknown> = {};

  constructor(sandbox: object) {
    this.updateEnv(sandbox);
  }

  updateEnv(...env: object[]) {
    for (const e of env) {
      if (!e || typeof e !== "object") continue;
      Object.assign(this.env, e);
    }
  }

  /**
   * 每次执行使用新的 context：
   * 顶层 `const` / `let` 不会因为上一次执行而重复声明报错（与原实现行为一致），
   * 也不会把 `globalThis.xxx = 1` 之类的副作用带到下一次执行。
   */
  private createContext(): vm.Context {
    const ctx: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(this.env)) ctx[k] = v;
    return vm.createContext(ctx, {
      codeGeneration: { strings: false, wasm: false },
      name: "cyanqiuper-sandbox",
    });
  }

  eval(code: string): unknown {
    const context = this.createContext();
    return vm.runInContext(code, context, {
      timeout: EXEC_TIMEOUT_MS,
      displayErrors: true,
      breakOnSigint: false,
    });
  }
}

export { Sandbox };
