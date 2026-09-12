// Versions here describe wire contracts, not package releases. Additive changes
// keep their contract version; incompatible changes get a new feature version.
export const RUNTIME_PROTOCOL = 1;
export const RUNTIME_CAPABILITIES = Object.freeze(Object.fromEntries(
  ["thread_read", "history_pagination", "turn_steer", "turn_start", "desktop_subscribe"].map(name => [name, Object.freeze([1])]),
));

const operations = {
  read: ["thread_read"], watch: ["thread_read"], monitor: ["thread_read"], history_check: ["thread_read"],
  send: ["thread_read", "turn_steer"], send_new_turn: ["thread_read", "turn_start", "desktop_subscribe"],
};
const readOperations = new Set(["read", "watch", "monitor", "history_check"]);
const methods = {
  "thread/read": "thread_read", "thread/turns/list": "history_pagination", "thread/items/list": "history_pagination",
  "turn/steer": "turn_steer", "turn/start": "turn_start",
};
const readMethods = new Set(["thread/read", "thread/turns/list", "thread/items/list", "thread/loaded/list"]);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const wireVersion = value => Number.isSafeInteger(value) && value > 0;

function legacySource(state) {
  // v0.13 advertised one aggregate v1 contract. Explicit capability declarations
  // always take precedence, including empty/invalid ones; never fall back around them.
  if (state?.codex_steer_capabilities !== undefined) return null;
  if (state?.codex_steer_protocol === 1) return "legacy-v1";
  // Pre-version wrapper from 83af51d, verified with this bundled CLI by the
  // protocol fixture. Do not infer mutation support for arbitrary older servers.
  if (state?.codex_steer_protocol === undefined && state?.codex_steer_package === undefined
    && state?.codex_steer_version === undefined && state?.schema === 1 && state?.cli_version === "0.153.4"
    && state?.node_path === "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node") return "legacy-0.153.4";
  return null;
}

export function runtimeCompatibility(state, { verifiedMethods = [], unsupportedMethods = [] } = {}) {
  const legacy = legacySource(state), declared = state?.codex_steer_protocol;
  const protocol = {
    status: wireVersion(declared) ? declared === RUNTIME_PROTOCOL ? "supported" : "unsupported" : legacy ? "supported" : "unverified",
    client: RUNTIME_PROTOCOL, runtime: wireVersion(declared) ? declared : legacy ? 1 : null,
    source: declared !== undefined ? wireVersion(declared) ? "declared" : "invalid" : legacy ?? "probe",
  };
  if (protocol.source === "probe") {
    if (unsupportedMethods.includes("initialize")) {
      protocol.status = "unsupported"; protocol.source = "probe-unsupported";
    } else if (verifiedMethods.includes("initialize")) {
      protocol.status = "supported"; protocol.runtime = 1; protocol.source = "probe-verified";
    }
  }
  const declaredFeatures = state?.codex_steer_capabilities;
  const features = Object.fromEntries(Object.entries(RUNTIME_CAPABILITIES).map(([name, supported]) => {
    let versions = null, source = "probe", status = "unverified";
    if (legacy) { versions = [1]; source = legacy; status = "supported"; }
    else if (declaredFeatures !== undefined) {
      source = "invalid";
      if (record(declaredFeatures)) {
        if (!Object.hasOwn(declaredFeatures, name)) { versions = []; source = "declared"; status = "unsupported"; }
        else {
          const value = declaredFeatures[name];
          if (Array.isArray(value) && value.length <= 16 && value.every(wireVersion)) {
            versions = [...new Set(value)]; source = "declared";
            status = versions.some(version => supported.includes(version)) ? "supported" : "unsupported";
          }
        }
      }
    }
    const probes = name === "thread_read" ? ["thread/read"] : name === "history_pagination" ? ["thread/turns/list", "thread/items/list"] : [];
    if (source === "probe" && probes.length) {
      // One missing required API disproves support even if another probe succeeded.
      if (probes.some(method => unsupportedMethods.includes(method))) {
        status = "unsupported"; source = "probe-unsupported";
      } else if (probes.every(method => verifiedMethods.includes(method))) {
        status = "supported"; versions = [1]; source = "probe-verified";
      }
    }
    return [name, { status, client: [...supported], runtime: versions, source }];
  }));
  const result = { protocol, features };
  result.operations = Object.fromEntries(Object.entries(operations).map(([name, required]) => {
    const entries = [protocol, ...required.map(feature => features[feature])];
    return [name, { status: entries.some(x => x.status === "unsupported") ? "unsupported"
      : entries.some(x => x.status !== "supported") ? "unverified" : "supported", requires: required }];
  }));
  return result;
}

function assertContract(contract, { operation, capability, allowProbe }) {
  if (contract.status === "supported" || (allowProbe && contract.source === "probe")) return;
  const prefix = capability === "protocol" ? "RUNTIME_PROTOCOL" : "CAPABILITY";
  const suffix = contract.status === "unsupported" ? "UNSUPPORTED" : "UNVERIFIED";
  throw Object.assign(new Error(`${operation} requires a compatible ${capability} contract. Check codexteer doctor --json for supported operations; use a compatible CLI or update the wrapper after finishing current tasks.`), {
    code: `${prefix}_${suffix}`, operation, capability,
  });
}

export function assertRuntimeOperation(state, operation) {
  if (!Object.hasOwn(operations, operation)) throw new Error("Unknown runtime operation.");
  const report = runtimeCompatibility(state), allowProbe = readOperations.has(operation);
  assertContract(report.protocol, { operation, capability: "protocol", allowProbe });
  for (const capability of operations[operation]) assertContract(report.features[capability], { operation, capability, allowProbe });
  return report;
}

// Guard optional read paths when they are actually used (pagination/freshness),
// rather than making a new API a requirement of every observation or send.
export function compatibleClient(client, state) {
  const report = runtimeCompatibility(state);
  return {
    close: () => client.close(),
    request(method, ...args) {
      const allowProbe = readMethods.has(method), capability = methods[method];
      assertContract(report.protocol, { operation: method, capability: "protocol", allowProbe });
      if (capability) assertContract(report.features[capability], { operation: method, capability, allowProbe });
      return client.request(method, ...args);
    },
  };
}
