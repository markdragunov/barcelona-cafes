/**
 * Facade: CafeRepository selected by STORAGE_BACKEND.
 * Callers keep importing from ./db.js.
 */
import { getRepository } from "./storage/factory.js";

function repo() {
  return getRepository();
}

export async function upsertCafeWithReviews(cafe, reviews) {
  return repo().upsertCafeWithReviews(cafe, reviews);
}

export async function getSummary(neighborhoodId) {
  return repo().getSummary(neighborhoodId);
}

export async function getCafesForExport(neighborhoodId) {
  return repo().getCafesForExport(neighborhoodId);
}

export async function getCafesNeedingCoffeeContent(neighborhoodId) {
  return repo().getCafesNeedingCoffeeContent(neighborhoodId);
}

export async function countCafesWithCoffeeContent(neighborhoodId) {
  return repo().countCafesWithCoffeeContent(neighborhoodId);
}

export async function updateCoffeeContent(placeId, coffeeContent) {
  return repo().updateCoffeeContent(placeId, coffeeContent);
}

export async function getCafeCount() {
  return repo().getCafeCount();
}

export async function listCafeCoordinates() {
  return repo().listCafeCoordinates();
}
