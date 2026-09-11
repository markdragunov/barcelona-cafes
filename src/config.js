/**
 * Secrets and runtime config from environment (.env via dotenv).
 * Never hardcode API keys here.
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

export function getDataDir() {
  const configured = env("DATA_DIR");
  if (configured) return path.resolve(configured);
  return path.join(ROOT, "data");
}

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
