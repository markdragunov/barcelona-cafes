/**
 * Secrets and runtime config from environment (.env via dotenv).
 * Never hardcode API keys here.
 */

function env(...names) {
  for (const name of names) {
    const value = String(process.env[name] ?? "").trim();
    if (value) return value;
  }
  return "";
}

export function getGoogleApiKey() {
  return env("GOOGLE_PLACES_API_KEY", "GOOGLE_API_KEY");
}

export function getParallelApiKey() {
  return env("PARALLEL_API_KEY");
}

export function getOpenAiApiKey() {
  return env("OPENAI_API_KEY");
}

/** @deprecated Use getGoogleApiKey */
export function getApiKey() {
  return getGoogleApiKey();
}
