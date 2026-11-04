import { listManagedThreads, managedMembershipDigest } from "./project-index.mjs";
import { getSupervisor, controlSupervisor } from "./supervision.mjs";
import { normalizeTaskId } from "./task-id.mjs";
import { targetHost } from "./target.mjs";
const fail = (message, code = "PROJECT_CONTROL_INVALID") => Object.assign(new Error(message), { code });

// Snapshot the set without a project lock. Each supervisor remains the sole
// control authority; its existing task lock linearizes control with dispatch.
export async function controlProject(projectId, action, { all = false, work } = {}, storage = {}) {
  if (typeof projectId !== "string" || !projectId.trim() || !["pause", "stop", "resume"].includes(action)
    || typeof all !== "boolean" || (all === (work !== undefined))) throw fail("Use project control pause|stop|resume --project ID with exactly one of --all or --work THREAD.");
  const members = await listManagedThreads(projectId, storage);
  const selected = all ? members : members.filter(m => m.thread_id === normalizeTaskId(work));
  if (!all && !selected.length) throw fail("The work is not a member of this project.", "PROJECT_CONTROL_UNMANAGED");
  const results = [];
  for (const member of selected) {
    try {
      if (member.host_id && member.host_id !== targetHost()) throw fail("Use the membership's registered host route.", "PROJECT_CONTROL_ROUTE_MISMATCH");
      const binding = await getSupervisor(member.thread_id, storage);
      if (!binding) throw fail("The managed work has no supervisor binding.", "SUPERVISOR_NOT_REGISTERED");
      const record = await controlSupervisor(member.thread_id, action, { ...storage, expectedSession: binding.session_id, expectedConnection: member.connection, reportTransition: true });
      results.push({ thread_id: member.thread_id, status: record.changed ? "changed" : "already", state: record.state });
    } catch (error) { results.push({ thread_id: member.thread_id, status: "failed", code: error.code ?? "PROJECT_CONTROL_FAILED" }); }
  }
  const count = status => results.filter(r => r.status === status).length;
  return { project_id: projectId, action, membership_digest: managedMembershipDigest(selected), requested: selected.length,
    changed: count("changed"), already: count("already"), failed: count("failed"), complete: count("failed") === 0, results };
}
