import { SEARCH_QUERIES } from "./queries.js";
import { upsertCafeWithReviews, listKnownPlaceIds } from "./db.js";
import { formatFetchError } from "./http.js";

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
  "places.businessStatus",
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
  "businessStatus",
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

export function searchResultHasCoordinates(place) {
  const lat = Number(place?.location?.latitude);
  const lng = Number(place?.location?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng);
}

/**
 * Details is only needed when Text Search did not already return coordinates
 * and the place is not already in the local database.
 */
export function shouldFetchPlaceDetails(place, knownPlaceIds = new Set()) {
  const placeId = normalizePlaceId(place?.id);
  if (!placeId) return false;
  if (knownPlaceIds.has(placeId)) return false;
  if (searchResultHasCoordinates(place)) return false;
  return true;
}

export function isOperationalPlace(place) {
  const status = place?.businessStatus;
  if (!status) return true;
  return status === "OPERATIONAL";
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatPlacesFetchError(err) {
  const message = formatFetchError(err, "Places API");
  if (err?.cause?.code === "ENOTFOUND") {
    return `${message} Check internet access and restart the server outside a restricted environment.`;
  }
  return message;
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
    throw new Error(formatPlacesFetchError(err));
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

async function collectForQuery(
  apiKey,
  textQuery,
  neighborhood,
  onProgress,
  seenPlaceIds,
  knownPlaceIds
) {
  let pageToken = null;
  let pages = 0;
  let found = 0;
  let saved = 0;
  let created = 0;
  let updated = 0;
  let skippedDuplicate = 0;
  let skippedClosed = 0;
  let detailsCalls = 0;
  let detailsAttempts = 0;
  let detailsFallbacks = 0;

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
      if (!isOperationalPlace(place)) {
        skippedClosed += 1;
        continue;
      }

      const placeId = normalizePlaceId(place.id);
      if (!placeId) continue;
      if (seenPlaceIds.has(placeId)) {
        skippedDuplicate += 1;
        continue;
      }
      seenPlaceIds.add(placeId);

      const wasKnown = knownPlaceIds.has(placeId);
      let enriched = place;
      if (shouldFetchPlaceDetails(place, knownPlaceIds)) {
        detailsAttempts += 1;
        try {
          enriched = await fetchPlaceDetails(apiKey, placeId);
          detailsCalls += 1;
          if (!hasCafeType(enriched.types)) continue;
          if (!isOperationalPlace(enriched)) {
            skippedClosed += 1;
            continue;
          }
          await sleep(50);
        } catch (err) {
          detailsFallbacks += 1;
          console.error(
            JSON.stringify({
              msg: "place_details_fallback",
              placeId,
              error: err?.message || String(err),
            })
          );
          enriched = place;
        }
      }

      const cafe = mapCafe(enriched, neighborhood);
      const reviews = mapReviews(cafe.place_id, enriched.reviews);
      await upsertCafeWithReviews(cafe, reviews);
      knownPlaceIds.add(placeId);
      saved += 1;
      if (wasKnown) updated += 1;
      else created += 1;
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
      skippedDuplicate,
      skippedClosed,
      detailsCalls,
      detailsAttempts,
      detailsFallbacks,
      created,
      updated,
    });
  } while (pageToken);

  return {
    found,
    saved,
    created,
    updated,
    pages,
    skippedDuplicate,
    skippedClosed,
    detailsCalls,
    detailsAttempts,
    detailsFallbacks,
  };
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
    skippedDuplicate: 0,
    skippedClosed: 0,
    detailsCalls: 0,
    detailsAttempts: 0,
    detailsFallbacks: 0,
    created: 0,
    updated: 0,
    uniquePlaces: 0,
  };

  const seenPlaceIds = new Set();
  const knownPlaceIds = new Set(await listKnownPlaceIds());

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
        onProgress,
        seenPlaceIds,
        knownPlaceIds
      );
      totals.found += result.found;
      totals.saved += result.saved;
      totals.created += result.created;
      totals.updated += result.updated;
      totals.skippedDuplicate += result.skippedDuplicate;
      totals.skippedClosed += result.skippedClosed;
      totals.detailsCalls += result.detailsCalls;
      totals.detailsAttempts += result.detailsAttempts;
      totals.detailsFallbacks += result.detailsFallbacks;
      totals.apiCallsEstimate += result.pages + result.detailsCalls;

      await sleep(150);
    }

    onProgress?.({
      stage: "neighborhood_done",
      neighborhood: neighborhood.name,
      message: `Finished ${neighborhood.name}`,
    });
  }

  totals.uniquePlaces = seenPlaceIds.size;

  if (
    totals.detailsAttempts >= 5 &&
    totals.detailsFallbacks / totals.detailsAttempts > 0.5
  ) {
    throw new Error(
      `Place Details failed for ${totals.detailsFallbacks}/${totals.detailsAttempts} calls; aborting so a bad key or quota is not silent.`
    );
  }

  return totals;
}
