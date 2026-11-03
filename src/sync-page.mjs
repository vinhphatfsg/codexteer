const failure = (message, code) => Object.assign(new Error(message), { code });

export function validateSyncPage(page, threadId, cursor, seen = new Set()) {
  if (!page || page.thread_id !== threadId || typeof page.cursor !== "string" || !page.cursor
    || (page.latest_turn_id !== undefined && page.latest_turn_id !== null && (typeof page.latest_turn_id !== "string" || !page.latest_turn_id))
    || (page.latest_turn_status !== undefined && page.latest_turn_status !== null && (typeof page.latest_turn_status !== "string" || !page.latest_turn_status))
    || (page.active_turn_count !== undefined && page.active_turn_count !== null && (!Number.isSafeInteger(page.active_turn_count) || page.active_turn_count < 0))
    || typeof page.has_more !== "boolean" || !Array.isArray(page.events)
    || page.events.some(e => !e || typeof e !== "object" || Array.isArray(e) || typeof e.id !== "string" || !e.id || typeof e.type !== "string" || !e.type
      || (e.questions !== undefined && !Array.isArray(e.questions)))
    || (page.attention !== undefined && page.attention !== null && (!Array.isArray(page.attention) || page.attention.some(f => typeof f !== "string")))
    || (page.attention_snapshot !== undefined && (!page.attention_snapshot || page.attention_snapshot.complete !== true || !Array.isArray(page.attention_snapshot.attention) || page.attention_snapshot.attention.some(f => typeof f !== "string")))
    || (page.attention_resolutions !== undefined && (!Array.isArray(page.attention_resolutions) || page.attention_resolutions.some(id => typeof id !== "string")))) throw failure("Invalid project observation page.", "PROJECT_SYNC_PAGE_INVALID");
  // A stable cursor is valid only for an empty final head verification.
  if ((page.cursor === cursor && (page.has_more || page.events.length)) || (page.cursor !== cursor && seen.has(page.cursor))) throw failure("Project observation cursor did not progress.", "PROJECT_SYNC_CURSOR_STALLED");
  return page;
}
