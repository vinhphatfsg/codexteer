// Requests whose parameters hold no instruction, title or other user text. A
// server may quote a request in its error message, so only these keep it.
const READ_METHODS = new Set(["initialize", "thread/read", "thread/turns/list", "thread/items/list", "thread/list", "model/list"]);
const RPC_MESSAGE_BYTES = 300;

function boundedMessage(text) {
  // One line, with any credential-like run removed.
  const message = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/[A-Za-z0-9_\-.=+]{64,}/g, "[redacted]").trim();
  if (Buffer.byteLength(JSON.stringify(message)) <= RPC_MESSAGE_BYTES) return message;
  const characters = [...message.slice(0, RPC_MESSAGE_BYTES)];
  while (characters.length && Buffer.byteLength(JSON.stringify(`${characters.join("")}…`)) > RPC_MESSAGE_BYTES) characters.pop();
  return `${characters.join("")}…`;
}

// What a JSON-RPC error says beyond its code: the server's message for a read,
// and data.reason when it is a short identifier such as serverShuttingDown.
export function rpcErrorDetail(error, method) {
  const detail = {}, reason = error?.data?.reason;
  if (READ_METHODS.has(method) && typeof error?.message === "string" && error.message.trim()) detail.rpcMessage = boundedMessage(error.message);
  if (typeof reason === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(reason)) detail.rpcReason = reason;
  return detail;
}

// The same detail in the form the CLI prints and a project row carries.
export function publicRpcDetail(error, { message = true } = {}) {
  const code = error?.rpc_code ?? error?.rpcCode, text = error?.rpc_message ?? error?.rpcMessage, reason = error?.rpc_reason ?? error?.rpcReason;
  if (!Number.isSafeInteger(code)) return undefined;
  return { rpc_code: code, ...(typeof reason === "string" ? { rpc_reason: reason } : {}), ...(message && typeof text === "string" ? { rpc_message: text } : {}) };
}
