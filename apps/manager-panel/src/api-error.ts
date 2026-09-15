/**
 * What a failure says, in the reader's language where the manager wrote it.
 *
 * Every refusal the manager makes carries a code as well as a sentence, and
 * the sentence is English because English is this repository's canonical
 * locale. The panel was showing that sentence: a console otherwise entirely in
 * Vietnamese would answer a failed install with a line of English.
 *
 * So the code is looked up first. What is not in the catalogue - a line git
 * printed, whatever npm said on its way out, an error from SillyTavern itself -
 * is shown exactly as it arrived, because translating another project's output
 * makes it impossible to search for and is not this project's to reword.
 */

export interface ServerFailure {
  readonly code: string | null;
  readonly message: string | null;
}

/** Read `{ error: { code, message } }` out of whatever the server actually sent. */
export function readFailure(payload: unknown): ServerFailure {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
  return {
    code: typeof error?.code === 'string' ? error.code : null,
    message: typeof error?.message === 'string' && error.message !== '' ? error.message : null,
  };
}

/**
 * The best sentence available for a failure: the catalogue, then the server's
 * own words, then what the caller would have said if the server said nothing.
 */
export function failureText(failure: ServerFailure, catalog: Record<string, unknown>, fallback: string): string {
  const translated = failure.code === null ? undefined : catalog[failure.code];
  if (typeof translated === 'string') return translated;
  return failure.message ?? fallback;
}

/** The same, for a code and message that did not arrive as an API error body. */
export function errorText(code: string | null | undefined, message: string | null, catalog: Record<string, unknown>, fallback: string): string {
  return failureText({ code: code ?? null, message }, catalog, fallback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
