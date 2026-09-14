import { formatFetchError } from "./http.js";

const EXTRACT_URL = "https://api.parallel.ai/v1/extract";

export const COFFEE_EXTRACT_OBJECTIVE =
  "Find all information about coffee beans, bean origin, roast profiles, brew methods, espresso, filter coffee, menu items, and any other coffee-related content.";

/**
 * Call Parallel Extract API for a single cafe website.
 * Returns the full JSON response as a string for storage.
 */
export async function extractCoffeeContent(apiKey, websiteUrl) {
  let response;
  try {
    response = await fetch(EXTRACT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        urls: [websiteUrl],
        objective: COFFEE_EXTRACT_OBJECTIVE,
      }),
    });
  } catch (err) {
    throw new Error(formatFetchError(err, "Parallel API"));
  }

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Parallel API returned non-JSON (${response.status})`);
  }

  if (!response.ok) {
    const message =
      data.error?.message ||
      data.message ||
      data.detail ||
      `HTTP ${response.status}`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }

  return JSON.stringify(data);
}
