function tell_raw(Player: string, ...Message: string[]) {
  return `tellraw ${Player} {"rawtext":[{"text":"${now()} ${Message.join(
    "\n"
  )}"}]}`;
}

/** 游戏内回显的时间统一按 UTC+8（服务器本身可能是 UTC） */
function now(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return `[${d.toISOString().slice(11, 19)}]`;
}

export { tell_raw };
