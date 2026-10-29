import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { controlFailure } from "./remote-control-auth.mjs";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann", ISSUER = "https://auth.openai.com", SCOPE = "codex.remote_control.enroll";
const open = promisify(execFile);

export function validateStepUpToken(token, identity, now = Date.now()) {
  try {
    if (typeof token !== "string" || token.length > 32768) throw new Error();
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url")), account = claims["https://api.openai.com/auth"];
    const scopes = [...new Set([...(claims.scope?.split(/\s+/) ?? []), ...(claims.scp ?? [])].filter(Boolean))];
    if ((account.chatgpt_account_user_id ?? account.account_user_id) !== identity.accountUserId
      || ((account.chatgpt_account_id ?? account.account_id) != null && (account.chatgpt_account_id ?? account.account_id) !== identity.accountId)
      || !Number.isSafeInteger(claims.iat) || now / 1000 - claims.iat > 300 || claims.iat > now / 1000 + 60
      || !Number.isSafeInteger(claims.exp) || claims.exp <= now / 1000
      || !Number.isSafeInteger(claims.pwd_auth_time) || now - claims.pwd_auth_time > 300000 || claims.pwd_auth_time > now + 60000
      || scopes.length !== 1 || scopes[0] !== SCOPE) throw new Error();
    return token;
  } catch { throw controlFailure("Complete a fresh official browser authentication for this account and remote-control enrollment scope.", "REMOTE_STEP_UP_REQUIRED"); }
}

export function stepUpUrl(identity, redirectUri, verifier, state) {
  const url = new URL("/oauth/authorize", ISSUER);
  url.search = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: redirectUri, scope: SCOPE,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state,
    originator: "codexteer", reauth: "remote_control", max_age: "0", codex_cli_simplified_flow: "true",
    allowed_workspace_id: identity.accountId, current_workspace_id: identity.accountId }).toString();
  return url.toString();
}

export async function stepUpLogin(identity, { fetch: request = globalThis.fetch, openBrowser = url => open("/usr/bin/open", [url]),
  ports = [1455, 1457], timeoutMs = 600000, progress = () => {} } = {}) {
  const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
  let server, port, timer, resolveCode, rejectCode, settled = false;
  const code = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; }); code.catch(() => {});
  const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? rejectCode(error) : resolveCode(value); };
  const cancel = () => finish(controlFailure("Official enrollment login was cancelled.", "REMOTE_STEP_UP_REQUIRED"));
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    for (const candidate of ports) {
      const listener = createServer((req, res) => {
        const respond = (status, text) => { res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", Connection: "close", "Referrer-Policy": "no-referrer" }); res.end(text); };
        try {
          if (req.method !== "GET" || req.url?.length > 16384 || ![`localhost:${port}`, `127.0.0.1:${port}`].includes(req.headers.host)) return respond(400, "Invalid callback");
          const url = new URL(req.url, `http://localhost:${port}`);
          if (url.pathname !== "/auth/callback") return respond(404, "Not found");
          if (settled || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== state) return respond(400, "State mismatch");
          if (url.searchParams.has("error")) { respond(400, "Authorization failed"); finish(controlFailure("Official browser authorization was not completed.", "REMOTE_STEP_UP_REQUIRED")); return; }
          const value = url.searchParams.get("code");
          if (!value || url.searchParams.getAll("code").length !== 1) return respond(400, "Missing code");
          respond(200, "Authorization received. Return to the codexteer terminal to check registration."); finish(null, value);
        } catch { respond(400, "Invalid callback"); }
      });
      try { await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(candidate, "127.0.0.1", resolve); }); server = listener; port = listener.address().port; break; }
      catch (error) { listener.close(); if (error.code !== "EADDRINUSE") throw error; }
    }
    if (!server) throw controlFailure("Official callback ports 1455 and 1457 are unavailable. Nothing was enrolled.", "REMOTE_CALLBACK_UNAVAILABLE");
    const redirectUri = `http://localhost:${port}/auth/callback`;
    timer = setTimeout(() => finish(controlFailure("Browser authentication timed out. No enrollment was sent.", "REMOTE_STEP_UP_REQUIRED")), timeoutMs);
    progress("Complete fresh account authentication in the official browser window. Server registration has not been sent.");
    try { await openBrowser(stepUpUrl(identity, redirectUri, verifier, state)); }
    catch { throw controlFailure("Could not open the official browser authentication window. No registration was sent.", "REMOTE_BROWSER_OPEN_FAILED"); }
    const authorizationCode = await code;
    let response;
    try { response = await request(`${ISSUER}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: authorizationCode, redirect_uri: redirectUri, client_id: CLIENT_ID, code_verifier: verifier }).toString(), redirect: "error", signal: AbortSignal.timeout(15000) }); }
    catch { throw controlFailure("Official enrollment token exchange failed.", "REMOTE_STEP_UP_REQUIRED"); }
    if (!response.ok) { await response.body?.cancel(); throw controlFailure(`Official enrollment token exchange returned HTTP ${response.status}.`, "REMOTE_STEP_UP_REQUIRED"); }
    const text = await response.text(); if (text.length > 65536) throw controlFailure("Invalid official enrollment token response.", "REMOTE_STEP_UP_REQUIRED");
    let token; try { token = JSON.parse(text).access_token; } catch { throw controlFailure("Invalid official enrollment token response.", "REMOTE_STEP_UP_REQUIRED"); }
    return validateStepUpToken(token, identity);
  } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); clearTimeout(timer); if (!settled) finish(controlFailure("Browser authentication cancelled.", "REMOTE_STEP_UP_REQUIRED")); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
}
