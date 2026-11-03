// Sanitized shape of a complete Desktop Cloud thread: rg found no files,
// subsequent work succeeded, and the delegated turn reported completion.
export const completedCloudThread = () => ({
  id: "durable_aaaaaaaa-aaaa-4aaa-8aaa-000000000007", name: "verification", status: { type: "idle", activeFlags: [] },
  environments: [{ environmentId: "ccarenv_fixture", environmentConfigId: "fixture-config" }],
  turns: [{ id: "turn-fixture", status: "completed", items: [
    { id: "order", type: "userMessage", content: [{ type: "text", text: "Inspect the checkout and report the result." }] },
    { id: "search", type: "commandExecution", command: "rg --files -g '*.optional'", status: "completed", exitCode: 1, aggregatedOutput: "" },
    { id: "probe", type: "commandExecution", command: "rg --files missing-directory", status: "failed", exitCode: 2, aggregatedOutput: "missing-directory: No such file or directory" },
    { id: "check", type: "commandExecution", command: "node --version", status: "completed", exitCode: 0, aggregatedOutput: "v24.19.0" },
    { id: "report", type: "agentMessage", phase: "final_answer", text: "Verification completed successfully; no optional files were present." },
  ] }],
});
