import { createInterface } from "node:readline/promises";
import { stripVTControlCharacters } from "node:util";
import { desktopCloudModels, readCloudModelDefaults, setCloudModelDefaults } from "./desktop-cloud-models.mjs";

const failure = (message, code) => Object.assign(new Error(message), { code, execution_environment: "cloud" });
const label = value => stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 160);

export async function pickCloudModel({ input = process.stdin, output = process.stdout, ask, ...dependencies } = {}) {
  if (!ask && (!input.isTTY || !output.isTTY)) throw failure("models select requires a terminal. Use models list --json, then models set --model MODEL --thinking EFFORT.", "DESKTOP_CLOUD_MODEL_TTY_REQUIRED");
  const models = await desktopCloudModels(dependencies), saved = await readCloudModelDefaults(dependencies);
  let rl; const abort = new AbortController();
  const cancel = () => abort.abort();
  if (!ask) {
    rl = createInterface({ input, output });
    rl.on("SIGINT", cancel); rl.on("close", cancel);
    ask = question => rl.question(question, { signal: abort.signal });
  }
  const choose = async (question, rows, current) => {
    rows.forEach((row, i) => output.write(`  ${i + 1}. ${label(row)}${i === current ? " [現在の選択]" : ""}\n`));
    while (true) {
      const answer = await ask(`${question}（番号${current >= 0 ? `、Enter = ${current + 1}` : ""}、q = 中止）: `);
      if (answer == null || /^(q|quit)$/i.test(answer.trim())) throw failure("Model selection cancelled. Defaults were not changed.", "DESKTOP_CLOUD_MODEL_CANCELLED");
      const value = answer.trim(), index = value === "" && current >= 0 ? current : /^\d+$/.test(value) ? Number(value) - 1 : -1;
      if (Number.isSafeInteger(index) && index >= 0 && index < rows.length) return index;
      output.write("表示されている番号を選んでください。\n");
    }
  };
  try {
    output.write("Cloud の既定モデルを選択します。保存後、新しいスレッドの作成に反映されます。\n");
    const current = models.findIndex(row => saved ? row.model === saved.model : row.is_default);
    const selected = models[await choose("モデル", models.map(row => `${row.name} (${row.model})${row.is_default ? " [Cloud 既定]" : ""}`), current)];
    const thinking = selected.efforts[await choose("エフォート", selected.efforts, selected.efforts.indexOf(saved?.model === selected.model ? saved.thinking : selected.default_thinking))];
    // Revalidate after the user has chosen: the catalog can change while the prompt is open.
    const result = await setCloudModelDefaults({ model: selected.model, thinking }, { ...dependencies, signal: abort.signal });
    output.write(`保存しました: ${result.model} / ${result.thinking}\n`);
    return result;
  } catch (error) {
    if (error.code === "ABORT_ERR" || error.code === "ERR_USE_AFTER_CLOSE") throw failure("Model selection cancelled. Defaults were not changed.", "DESKTOP_CLOUD_MODEL_CANCELLED");
    throw error;
  } finally { rl?.close(); }
}
