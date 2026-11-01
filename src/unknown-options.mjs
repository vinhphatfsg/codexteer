const SHOWN = 3, MAX_CHARS = 40;

// Reported tokens may hold the start of an instruction body that was meant to
// follow --, so only the option-like word before the first whitespace is echoed.
const shown = token => {
  const [word] = token.split(/\s/, 1);
  return word.length > MAX_CHARS ? `${word.slice(0, MAX_CHARS - 1)}…` : word;
};

export function rejectUnknownOptions(tokens, subject, hint, toError) {
  const found = tokens.filter(token => token.startsWith("--"));
  if (found.length === 0) return;
  const unknown = found.slice(0, SHOWN).map(shown);
  const more = found.length > SHOWN ? ` and ${found.length - SHOWN} more` : "";
  const message = `Unknown ${subject} option${found.length > 1 ? "s" : ""}: ${unknown.join(", ")}${more}.${hint ? ` ${hint}` : ""}`;
  throw Object.assign(toError(message), { unknown_options: unknown });
}
