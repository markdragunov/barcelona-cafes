import { SEARCH_QUERIES } from "./queries.js";
import { upsertCafeWithReviews } from "./db.js";

const TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const PLACE_DETAILS_URL = "https://places.googleapis.com/v1/places";

const SEARCH_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.rating",
  "places.userRatingCount",
  "places.websiteUri",
  "places.types",
  "places.location",
  "places.reviews",
  "nextPageToken",
].join(",");

const DETAILS_FIELD_MASK = [
  "id",
  "displayName",
  "formattedAddress",
  "rating",
  "userRatingCount",
  "websiteUri",
  "types",
  "location",
  "reviews",
].join(",");

function normalizePlaceId(id) {
  if (!id) return null;
  return id.startsWith("places/") ? id.slice("places/".length) : id;
}

function hasCafeType(types) {
  return Array.isArray(types) && types.includes("cafe");
}

function mapReviews(placeId, reviews) {
  if (!Array.isArray(reviews)) return [];
  return reviews.map((r) => ({
    place_id: placeId,
    author_name: r.authorAttribution?.displayName ?? null,
    rating: r.rating ?? null,
    text: r.text?.text ?? r.originalText?.text ?? null,
    publish_time: r.publishTime ?? null,
    relative_publish_time_description: r.relativePublishTimeDescription ?? null,
    language_code: r.text?.languageCode ?? r.originalText?.languageCode ?? null,
  }));
}

function mapCafe(place, neighborhood) {
  const placeId = normalizePlaceId(place.id);
  return {
    place_id: placeId,
    name: place.displayName?.text ?? "Unknown",
    address: place.formattedAddress ?? null,
    rating: place.rating ?? null,
    user_rating_count: place.userRatingCount ?? null,
    website: place.websiteUri ?? null,
    place_types: JSON.stringify(place.types ?? []),
    latitude: place.location?.latitude ?? null,
    longitude: place.location?.longitude ?? null,
    neighborhood_id: neighborhood.id,
    neighborhood_name: neighborhood.name,
  };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatFetchError(err) {
  const cause = err?.cause;
  if (cause?.code === "ENOTFOUND") {
    return `Network/DNS failed reaching Places API (${cause.hostname}). Check internet access and restart the server outside a restricted environment.`;
  }
  if (cause?.code === "ECONNREFUSED" || cause?.code === "ETIMEDOUT") {
    return `Network error talking to Places API (${cause.code}).`;
  }
  return cause?.message || err?.message || String(err);
}

async function placesFetch(url, { apiKey, method = "GET", body, fieldMask }) {
  const headers = {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": apiKey,
    "X-Goog-FieldMask": fieldMask,
  };

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(formatFetchError(err));
  }

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Places API returned non-JSON (${response.status})`);
  }

  if (!response.ok) {
    const message =
      data.error?.message || data.message || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return data;
}

async function searchTextPage(apiKey, textQuery, viewport, pageToken) {
  const body = {
    textQuery,
    pageSize: 20,
    languageCode: "en",
    regionCode: "ES",
    locationRestriction: {
      rectangle: {
        low: viewport.low,
        high: viewport.high,
      },
    },
  };
  if (pageToken) body.pageToken = pageToken;

  return placesFetch(TEXT_SEARCH_URL, {
    apiKey,
    method: "POST",
    body,
    fieldMask: SEARCH_FIELD_MASK,
  });
}

async function fetchPlaceDetails(apiKey, placeId) {
  const url = `${PLACE_DETAILS_URL}/${encodeURIComponent(placeId)}`;
  return placesFetch(url, {
    apiKey,
    method: "GET",
    fieldMask: DETAILS_FIELD_MASK,
  });
}

async function collectForQuery(apiKey, textQuery, neighborhood, onProgress) {
  let pageToken = null;
  let pages = 0;
  let found = 0;
  let saved = 0;
  const seenThisQuery = new Set();

  do {
    const data = await searchTextPage(
      apiKey,
      textQuery,
      neighborhood.viewport,
      pageToken
    );
    pages += 1;
    const places = data.places ?? [];

    for (const place of places) {
      found += 1;
      if (!hasCafeType(place.types)) continue;

      const placeId = normalizePlaceId(place.id);
      if (!placeId || seenThisQuery.has(placeId)) continue;
      seenThisQuery.add(placeId);

      // Prefer details for full review set and freshest fields.
      let enriched = place;
      try {
        enriched = await fetchPlaceDetails(apiKey, placeId);
        if (!hasCafeType(enriched.types)) continue;
        await sleep(50);
      } catch {
        // Fall back to search result if details fail.
        enriched = place;
      }

      const cafe = mapCafe(enriched, neighborhood);
      const reviews = mapReviews(cafe.place_id, enriched.reviews);
      upsertCafeWithReviews(cafe, reviews);
      saved += 1;
    }

    pageToken = data.nextPageToken ?? null;
    if (pageToken) await sleep(200);

    onProgress?.({
      stage: "query",
      neighborhood: neighborhood.name,
      query: textQuery,
      pages,
      found,
      saved,
    });
  } while (pageToken);

  return { found, saved, pages };
}

/**
 * Run collection for one or more neighborhoods across all search queries.
 * Deduplicates by Places ID in SQLite.
 */
export async function collectCafes({
  apiKey,
  neighborhoods,
  onProgress,
  signal,
}) {
  const totals = {
    neighborhoods: neighborhoods.length,
    queries: SEARCH_QUERIES.length,
    apiCallsEstimate: 0,
    found: 0,
    saved: 0,
    skippedNonCafe: 0,
  };

  for (const neighborhood of neighborhoods) {
    if (signal?.aborted) throw new Error("Collection cancelled");

    onProgress?.({
      stage: "neighborhood_start",
      neighborhood: neighborhood.name,
      message: `Starting ${neighborhood.name}`,
    });

    for (let i = 0; i < SEARCH_QUERIES.length; i++) {
      if (signal?.aborted) throw new Error("Collection cancelled");
      const query = SEARCH_QUERIES[i];

      onProgress?.({
        stage: "query_start",
        neighborhood: neighborhood.name,
        query,
        queryIndex: i + 1,
        queryTotal: SEARCH_QUERIES.length,
        message: `[${neighborhood.name}] ${i + 1}/${SEARCH_QUERIES.length}: ${query}`,
      });

      const result = await collectForQuery(
        apiKey,
        query,
        neighborhood,
        onProgress
      );
      totals.found += result.found;
      totals.saved += result.saved;
      totals.apiCallsEstimate += result.pages;

      await sleep(150);
    }

    onProgress?.({
      stage: "neighborhood_done",
      neighborhood: neighborhood.name,
      message: `Finished ${neighborhood.name}`,
    });
  }

  return totals;
}
