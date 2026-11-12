const api = new URL("../src/desktop-cloud-api.mjs", import.meta.url).href;
const fixture = new URL("./cloud-models-service.mjs", import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL && new URL(specifier, context.parentURL).href === api) return { url: fixture, shortCircuit: true };
  return nextResolve(specifier, context);
}
