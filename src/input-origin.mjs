// Who wrote what a task gained after an observation. A worker's own progress,
// including the end of its turn, never makes an instruction stale; input that
// codexteer did not send does. A worker never starts a turn, so a turn the
// delta adds was opened by input and belongs to whoever sent that input.
import { digest } from "./observe.mjs";
import { listRecords } from "./store.mjs";

/** @typedef {{ texts: Set<string>, turns: Set<string> }} OwnInputs */
/** @typedef {{ kind: "progress" | "own_input" | "foreign_input", event: object }} DeltaEntry */

// A history userMessage keeps codexteer's clientId on some services only, so
// the text decides: the journal stores the sha256 of every wire text it sent.
// A not_sent entry never reached the task. A new turn whose opening message is
// not listed yet (a running Desktop Cloud turn) is codexteer's when its own
// new-turn receipt names it.
/** @returns {Promise<OwnInputs>} */
export async function ownInputs(threadId, storage = {}) {
  const sent = (await listRecords("messages", storage)).filter(entry => entry?.thread_id === threadId && ["accepted", "unknown"].includes(entry.delivery_status));
  return { texts: new Set(sent.map(entry => entry.message_sha256).filter(Boolean)),
    turns: new Set(sent.filter(entry => entry.delivery_action !== "steer" && typeof entry.turn_id === "string").map(entry => entry.turn_id)) };
}

const NONE = { texts: new Set(), turns: new Set() };

/** @returns {DeltaEntry[]} */
export function classifyDelta(events, own = NONE) {
  const input = event => own.texts.has(digest(event.text ?? "")) ? "own_input" : "foreign_input", opening = new Map();
  for (const event of events) if (event.type === "userMessage" && !opening.has(event.turn_id)) opening.set(event.turn_id, input(event));
  return events.map(event => ({ event, kind: event.type === "userMessage" ? input(event)
    : event.type !== "turn" || event.change !== "added" ? "progress"
    : opening.get(event.id) ?? (own.turns.has(event.id) ? "own_input" : "foreign_input") }));
}

export const foreignInput = (events, own) => classifyDelta(events, own).find(entry => entry.kind === "foreign_input")?.event ?? null;

const stale = (message, details = {}) => Object.assign(new Error(message), { code: "STALE_OBSERVATION", ...details });

// The check a send runs against its --based-on observation, on every backend.
export function assertNoForeignInput(events, own) {
  const event = foreignInput(events, own);
  if (event) throw stale("Input that codexteer did not send reached the task after the observation. Read the task again before sending.", { events: [event] });
}

// The inputs and turns a snapshot gained after a v1 or v3 cursor, less the
// items a live read already delivered. The cursor pins the inputs it saw by
// their digest, so the snapshot's inputs must start with exactly those: an
// edited or removed input is not one the observation can vouch for.
export function snapshotDelta(s, claim, delivered = []) {
  const inputs = s.events.filter(event => event.type === "userMessage"), turns = s.events.filter(event => event.type === "turn");
  let seen = inputs.length;
  while (seen >= 0 && digest(inputs.slice(0, seen)) !== claim.user_revision) seen--;
  const latest = claim.latest_turn_id == null ? -1 : turns.findIndex(turn => turn.id === claim.latest_turn_id);
  if (seen < 0 || (claim.latest_turn_id != null && latest < 0)) throw stale("The task's inputs or turns no longer match the observation. Read the task again before sending.");
  // A v1 cursor from before latest_turn_id was recorded places new turns by its event count.
  const added = claim.latest_turn_id === undefined ? s.events.slice(claim.count).filter(event => event.type === "turn") : turns.slice(latest + 1);
  const skip = new Set(delivered);
  return [...added, ...inputs.slice(seen).filter(event => !skip.has(event.id))].map(event => ({ ...event, change: "added" }));
}
