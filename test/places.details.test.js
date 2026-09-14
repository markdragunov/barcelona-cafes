/** Places collector: skip redundant Place Details calls. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { searchResultHasCoordinates, shouldFetchPlaceDetails } from "../src/places.js";

const place = {
  id: "places/ChIJabc",
  location: { latitude: 41.39, longitude: 2.16 },
  reviews: [{ rating: 5 }],
};

describe("Places details skip", () => {
  it("treats text-search hits with coordinates as complete", () => {
    assert.equal(searchResultHasCoordinates(place), true);
    assert.equal(shouldFetchPlaceDetails(place, new Set()), false);
  });

  it("does not call details for a place already stored", () => {
    const incomplete = { id: "ChIJabc", location: null };
    assert.equal(shouldFetchPlaceDetails(incomplete, new Set(["ChIJabc"])), false);
  });

  it("fetches details only when a new place has no coordinates", () => {
    const incomplete = { id: "places/ChIJnew", location: {} };
    assert.equal(shouldFetchPlaceDetails(incomplete, new Set()), true);
  });
});
