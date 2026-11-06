import { connectDesktopCloud } from "./desktop-cloud-api.mjs";
import { readRecord, writeRecord, storePath, withStoreLock } from "./store.mjs";

const bucket = "settings", key = "desktop-cloud-model";
const failure = (message, code = "DESKTOP_CLOUD_MODEL_INVALID") => Object.assign(new Error(message), { code, execution_environment: "cloud" });
const modelId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/.test(value);
const effortId = value => typeof value === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(value);

export function validateCloudModelOptions({ model, thinking } = {}) {
  if (model !== undefined && !modelId(model)) throw failure("Invalid --model. Choose a model from models list.");
  if (thinking !== undefined && !effortId(thinking)) throw failure("Invalid --thinking. Choose an effort from models list.");
}

// Read the current account's complete catalog; never cache a model or effort list.
export async function cloudModelsOnClient(client) {
  const models = [], seen = new Set(), cursors = new Set(); let cursor;
  for (let page = 0; page < 100; page++) {
    const response = await client.request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(response?.data)) throw failure("Cloud returned an invalid model catalog.", "DESKTOP_CLOUD_MODELS_UNVERIFIED");
    for (const row of response.data) {
      if (row?.hidden === true) continue;
      const efforts = Array.isArray(row?.supportedReasoningEfforts) ? row.supportedReasoningEfforts.map(item => item?.reasoningEffort) : null;
      if (!modelId(row?.model) || seen.has(row.model) || !Array.isArray(efforts) || efforts.length === 0
        || !efforts.every(effortId) || new Set(efforts).size !== efforts.length || !efforts.includes(row.defaultReasoningEffort)) {
        throw failure("Cloud returned an invalid or conflicting model/effort catalog.", "DESKTOP_CLOUD_MODELS_UNVERIFIED");
      }
      seen.add(row.model);
      models.push({ model: row.model, name: typeof row.displayName === "string" ? row.displayName : row.model,
        efforts, default_thinking: row.defaultReasoningEffort, is_default: row.isDefault === true });
    }
    cursor = response.nextCursor;
    if (cursor == null) {
      if (!models.length) throw failure("Cloud returned no selectable models.", "DESKTOP_CLOUD_MODELS_UNVERIFIED");
      return models;
    }
    if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) break;
    cursors.add(cursor);
  }
  throw failure("Cloud model pagination did not complete.", "DESKTOP_CLOUD_MODELS_UNVERIFIED");
}

export async function desktopCloudModels({ connect = connectDesktopCloud, signal } = {}) {
  let client; const cancel = () => client?.close();
  try {
    client = await connect({ signal });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) throw failure("Model selection cancelled. Defaults were not changed.", "DESKTOP_CLOUD_MODEL_CANCELLED");
    return await cloudModelsOnClient(client);
  } catch (error) {
    // Catalog work is read-only. Do not reinterpret errors after a settings
    // write: publication may have succeeded even if its acknowledgement failed.
    if (signal?.aborted) throw failure("Model selection cancelled. Defaults were not changed.", "DESKTOP_CLOUD_MODEL_CANCELLED");
    throw error;
  } finally { signal?.removeEventListener("abort", cancel); client?.close(); }
}

export async function readCloudModelDefaults(storage = {}) {
  let record;
  try { record = await readRecord(bucket, key, storage); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw failure("Saved Cloud defaults are invalid. Use models set or models reset.", "DESKTOP_CLOUD_MODEL_SETTINGS_INVALID");
  }
  if (record === null) return null;
  if (record.schema !== 1 || !(record.model === null && record.thinking === null || modelId(record.model) && effortId(record.thinking))) {
    throw failure("Saved Cloud defaults are invalid. Use models set or models reset.", "DESKTOP_CLOUD_MODEL_SETTINGS_INVALID");
  }
  return record.model === null ? null : { model: record.model, thinking: record.thinking };
}

export function selectCloudModel(models, options = {}, saved = null) {
  validateCloudModelOptions(options);
  let model = options.model ?? saved?.model;
  if (model === undefined) {
    const defaults = models.filter(row => row.is_default);
    if (defaults.length !== 1) throw failure("Cloud did not identify one default model. Select one with models select.", "DESKTOP_CLOUD_MODELS_UNVERIFIED");
    model = defaults[0].model;
  }
  const selected = models.find(row => row.model === model);
  if (!selected) throw failure("The selected model is no longer available. Choose another with models select.");
  const useSavedEffort = saved?.model === model;
  const thinking = options.thinking ?? (useSavedEffort ? saved.thinking : selected.default_thinking);
  if (!selected.efforts.includes(thinking)) throw failure("The selected model does not support this effort. Choose a supported pair with models select.");
  return { model, thinking, model_source: options.model !== undefined ? "explicit" : saved ? "saved" : "server",
    thinking_source: options.thinking !== undefined ? "explicit" : useSavedEffort ? "saved" : "server" };
}

export async function resolveCloudModelSelection(options = {}, { models, ...dependencies } = {}) {
  validateCloudModelOptions(options);
  if (options.modelSelection !== undefined) {
    const pinned = options.modelSelection;
    if (!pinned || !modelId(pinned.model) || !effortId(pinned.thinking)
      || ![pinned.model_source, pinned.thinking_source].every(value => ["explicit", "saved", "server"].includes(value))) throw failure("Invalid pinned Cloud model selection.");
    selectCloudModel(models ?? await desktopCloudModels(dependencies), pinned);
    return { ...pinned };
  }
  // A complete explicit pair also permits repairing/overriding stale saved defaults.
  const saved = options.model !== undefined && options.thinking !== undefined ? null : await readCloudModelDefaults(dependencies);
  return selectCloudModel(models ?? await desktopCloudModels(dependencies), options, saved);
}

export async function setCloudModelDefaults(options, dependencies = {}) {
  if (options?.model === undefined || options?.thinking === undefined) throw failure("models set requires both --model and --thinking.");
  validateCloudModelOptions(options);
  const selected = selectCloudModel(await desktopCloudModels(dependencies), options);
  return withStoreLock(key, async () => {
    if (dependencies.signal?.aborted) throw failure("Model selection cancelled. Defaults were not changed.", "DESKTOP_CLOUD_MODEL_CANCELLED");
    await writeRecord(bucket, key, { schema: 1, model: selected.model, thinking: selected.thinking, updated_at: new Date().toISOString() }, dependencies);
    return { model: selected.model, thinking: selected.thinking, settings_path: storePath(bucket, key, dependencies.home), applies_to: "new-desktop-cloud-threads" };
  }, dependencies);
}

export async function resetCloudModelDefaults(storage = {}) {
  return withStoreLock(key, async () => {
    await writeRecord(bucket, key, { schema: 1, model: null, thinking: null, updated_at: new Date().toISOString() }, storage);
    return { model: null, thinking: null, source: "server", settings_path: storePath(bucket, key, storage.home) };
  }, storage);
}
