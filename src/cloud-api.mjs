import { spawn } from "node:child_process";
import { VERSION } from "./version.mjs";

const failure = (code, message) => Object.assign(new Error(message), { code, execution_environment: "cloud" });
const LIMIT = 16 * 1024 * 1024;

// Credentials stay in memory and come from the official process, never auth.json.
// No model session is started and no Desktop connection is used.
export function cloudCredentials({ spawnProcess = spawn, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let child, buffer = "", bytes = 0, settled = false, killTimer, initialized = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child?.stdin.destroy(); child?.kill();
      killTimer = setTimeout(() => child?.kill("SIGKILL"), 500); killTimer.unref();
      buffer = "";
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(failure("CLOUD_AUTH_TIMEOUT", "Official CLI authentication timed out.")), timeoutMs);
    try { child = spawnProcess("codex", ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); }
    catch { finish(failure("CLOUD_AUTH_UNAVAILABLE", "Cannot start the official Codex App Server.")); return; }
    child.on("error", () => finish(failure("CLOUD_AUTH_UNAVAILABLE", "Cannot start the official Codex App Server.")));
    child.on("close", () => { clearTimeout(killTimer); finish(failure("CLOUD_AUTH_FAILED", "Official CLI authentication closed before completion.")); });
    const count = chunk => { bytes += Buffer.byteLength(chunk); if (bytes > LIMIT) finish(failure("CLOUD_OUTPUT_LIMIT", "Official authentication exceeded the response limit.")); };
    child.stderr.on("data", count);
    child.stdin.on("error", () => finish(failure("CLOUD_AUTH_FAILED", "Official CLI authentication failed.")));
    const send = value => child.stdin.write(JSON.stringify(value) + "\n");
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      count(chunk); if (settled) return;
      buffer += chunk;
      let newline;
      while (!settled && (newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { finish(failure("CLOUD_AUTH_PROTOCOL", "Invalid official authentication response.")); return; }
        if (message.id === 1) {
          if (initialized || !message.result || message.error) { finish(failure("CLOUD_AUTH_PROTOCOL", "Official authentication initialization failed.")); return; }
          initialized = true;
          send({ method: "initialized" });
          send({ id: 2, method: "getAuthStatus", params: { includeToken: true, refreshToken: false } });
        } else if (message.id === 2) {
          const result = message.result;
          if (!initialized || message.error || result?.authMethod !== "chatgpt" || typeof result.authToken !== "string" || !result.authToken || /[\s\x00-\x1f\x7f]/u.test(result.authToken)) {
            finish(failure("CLOUD_LOGIN_REQUIRED", "Sign in to the official Codex CLI with ChatGPT to list cloud environments.")); return;
          }
          let accountId;
          try { accountId = JSON.parse(Buffer.from(result.authToken.split(".")[1], "base64url").toString("utf8"))["https://api.openai.com/auth"]?.chatgpt_account_id; } catch {}
          if (typeof accountId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(accountId)) { finish(failure("CLOUD_AUTH_PROTOCOL", "Official authentication did not identify a ChatGPT account.")); return; }
          finish(null, { token: result.authToken, accountId });
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "codexteer", version: VERSION } } });
  });
}

// Fixed official origin, no redirects, URL overrides, raw diagnostics or retries.
export async function cloudApi(route, { timeoutMs = 120000, credentials = cloudCredentials, fetchRequest = fetch, body } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw failure("CLOUD_OPTIONS_INVALID", "Invalid cloud request deadline.");
  if (!(body === undefined ? /^(?:environments|tasks\/task_[A-Za-z0-9_-]{1,200}(?:\/turns)?)$/.test(route) : route === "tasks")) throw failure("CLOUD_OPTIONS_INVALID", "Unsupported cloud API route.");
  const started = Date.now();
  const auth = await credentials({ timeoutMs: Math.min(timeoutMs, 15000) });
  const remaining = timeoutMs - (Date.now() - started);
  if (remaining <= 0) throw failure("CLOUD_TIMEOUT", "Cloud authentication exceeded the request deadline.");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining);
  try {
    const response = await fetchRequest(`https://chatgpt.com/backend-api/wham/${route}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal: controller.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { Authorization: `Bearer ${auth.token}`, "ChatGPT-Account-ID": auth.accountId, Accept: "application/json", "Content-Type": "application/json", "User-Agent": `codexteer/${VERSION}` },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw failure(response.status === 401 ? "CLOUD_LOGIN_REQUIRED" : response.status === 403 ? "CLOUD_ACCESS_DENIED" : "CLOUD_HTTP_FAILED", `Cloud request failed (HTTP ${response.status}). No response body or credentials were disclosed.`);
    }
    let bytes = 0; const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > LIMIT) { controller.abort(); throw failure("CLOUD_OUTPUT_LIMIT", "Cloud response exceeded the 16 MiB limit."); }
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw failure("CLOUD_PROTOCOL_UNVERIFIED", "Cloud returned an unrecognized response. No raw payload was disclosed."); }
  } catch (error) {
    if (error.code?.startsWith("CLOUD_")) throw error;
    throw failure(controller.signal.aborted ? "CLOUD_TIMEOUT" : "CLOUD_CONNECTION_FAILED", "Cloud request did not complete. No credentials or raw diagnostics were disclosed.");
  } finally { clearTimeout(timer); }
}

export async function cloudEnvironments(settings = {}, { request = cloudApi } = {}) {
  if (settings.timeoutMs !== undefined && (!Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs < 1000 || settings.timeoutMs > 600000)) throw failure("CLOUD_OPTIONS_INVALID", "--timeout-ms must be 1000..600000.");
  const rows = await request("environments", settings);
  if (!Array.isArray(rows) || rows.length > 10000 || rows.some(row => !row || typeof row.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(row.id)
    || (row.label != null && (typeof row.label !== "string" || row.label.length > 1000)))) throw failure("CLOUD_PROTOCOL_UNVERIFIED", "Cloud returned an unrecognized environment inventory.");
  return { backend: "codex-api", execution_environment: "cloud", environments: rows.map(row => ({ id: row.id, name: row.label ?? null, pinned: row.is_pinned === true,
    repositories: Object.values(row.repo_map ?? {}).flatMap(repo => typeof repo?.repository_full_name === "string" && repo.repository_full_name.length < 1000
      ? [{ name: repo.repository_full_name, default_branch: typeof repo.default_branch === "string" && repo.default_branch.length < 256 ? repo.default_branch : null }] : []),
  })), source: "accessible-legacy-task-environments", availability: "listed-access-only; execution-not-verified" };
}
