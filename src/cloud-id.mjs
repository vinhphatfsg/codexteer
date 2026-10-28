const pattern = /^task_[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const failure = () => Object.assign(new Error("Invalid Codex Cloud task. Use a task ID or an official chatgpt.com/codex/tasks link."), { code: "CLOUD_OPTIONS_INVALID" });

export function isCloudTask(value) {
  return typeof value === "string" && (value.startsWith("task_") || /^https:\/\/chatgpt\.com\/codex\/tasks\//.test(value));
}

export function cloudTaskId(value) {
  if (typeof value !== "string") throw failure();
  if (pattern.test(value)) return value;
  try {
    const url = new URL(value), id = url.pathname.slice("/codex/tasks/".length);
    if (url.origin === "https://chatgpt.com" && !url.username && !url.password && url.pathname.startsWith("/codex/tasks/") && pattern.test(id)) return id;
  } catch {}
  throw failure();
}
