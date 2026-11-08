class Sandbox {
  sandbox: object;
  constructor(sandbox: object) {
    this.sandbox = sandbox;
  }

  eval(code: string): unknown {
    const body = `with(inside) { ${code} }`;
    // 必须用 eval 求值才能拿到最后一条表达式的值：
    // Function 构造出的函数体只会返回 undefined（语句的完成值不是 return 值）。
    const fn = new Function("inside", `return eval(${JSON.stringify(body)});`);
    return fn(this.sandbox);
  }

  updateEnv(...env: object[]) {
    Object.assign(this.sandbox, env[0]);
  }
}

export { Sandbox };
