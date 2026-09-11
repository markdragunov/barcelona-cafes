/**
 * POST /api/rag/search is public and unauthenticated, so upstream failure text
 * (Google Geocoding, OpenAI, Python tracebacks, timeouts) must never reach the
 * caller — it has leaked the droplet's public IP before. Only our own
 * validation and configuration messages are passed through.
 */

const CLIENT_SAFE_PATTERNS = [
  /^Query is required/i,
  /^Set (GOOGLE_PLACES_API_KEY|GOOGLE_API_KEY|OPENAI_API_KEY)/i,
  /^(OpenAI|Google Geocoding) API key is required/i,
  /^Indexes not ready/i,
];

export const GENERIC_SEARCH_ERROR =
  "Search is temporarily unavailable. Please try again in a moment.";

/**
 * Map a thrown search error to a client-safe status + body, keeping the full
 * detail for server-side logging.
 *
 * @param {unknown} err
 * @param {string} [requestId] correlates the generic reply with the log line
 * @returns {{status: number, body: {error: string, requestId?: string}, detail: string, leaked: boolean}}
 */
export function publicSearchError(err, requestId) {
  const detail = String(err?.message || err || "").trim();
  const safe = detail !== "" && CLIENT_SAFE_PATTERNS.some((re) => re.test(detail));
  if (safe) {
    return { status: 400, body: { error: detail }, detail, leaked: true };
  }
  const body = { error: GENERIC_SEARCH_ERROR };
  if (requestId) body.requestId = requestId;
  return { status: 500, body, detail: detail || "Unknown search error", leaked: false };
}
