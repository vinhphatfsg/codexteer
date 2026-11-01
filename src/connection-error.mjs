// Diagnostics only: callers retain their existing routing and rejection rules.
export function connectionMismatch(expected, selected, code = "CLOUD_TARGET_CONFLICT") {
  const message = expected === "shared"
    ? `For a local task, use --connection shared (the default local connection; got ${selected}).`
    : `This task requires --connection ${expected} (got ${selected}).`;
  return Object.assign(new Error(message), { code, expected_connection: expected, connection: selected });
}
