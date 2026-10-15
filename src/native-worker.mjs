import { nativeRequest, nativeRpc } from "./native-rpc.mjs";
import { lstat, readFile } from "node:fs/promises";

// Spawned by the existing signed App Server through command/exec, without a
// thread or turn. Desktop authenticates this signed child using its unchanged
// peer policy. The helper opens only the owner-validated local native socket.
process.stdin.setEncoding("utf8");
let body = "";
try {
  if (process.argv[2]) {
    const info = await lstat(process.argv[2]);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 8 * 1024 * 1024) throw new Error("Unsafe native worker request file.");
    body = await readFile(process.argv[2], "utf8");
  } else for await (const chunk of process.stdin) {
      body += chunk;
      if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error("Native worker request exceeds its limit.");
    }
  const { endpoint, action, args, context, timeoutMs, callId } = JSON.parse(body);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error("Invalid native timeout.");
  const result = await nativeRpc(endpoint, nativeRequest(action, args, context, callId), { timeoutMs });
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: { message: error.message, code: error.code ?? "NATIVE_PROTOCOL_ERROR", uncertain: !!error.uncertain, rpcCode: Number.isSafeInteger(error.rpcCode) ? error.rpcCode : undefined } }));
  process.exitCode = 1;
}
