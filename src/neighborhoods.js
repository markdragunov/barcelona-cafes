/**
 * Barcelona neighborhood map viewports for Places API locationRestriction.
 * Coordinates are southwest (low) / northeast (high) rectangle corners.
 * Do not filter by address text — geographic restriction only.
 *
 * Definitions live in shared/neighborhoods.json so the Python RAG side
 * (rag/neighborhoods.py) reads the exact same coordinates.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAZETTEER_PATH = path.join(__dirname, "..", "shared", "neighborhoods.json");

const { neighborhoods } = JSON.parse(readFileSync(GAZETTEER_PATH, "utf-8"));

export const NEIGHBORHOODS = Object.fromEntries(
  neighborhoods.map((n) => [n.id, n])
);

export const NEIGHBORHOOD_LIST = Object.values(NEIGHBORHOODS);

export function getNeighborhood(id) {
  return NEIGHBORHOODS[id] ?? null;
}

/** Individual neighborhoods used when collecting "all at once". */
export function getCollectableNeighborhoods(selectionId) {
  if (selectionId === "all-barcelona") {
    return NEIGHBORHOOD_LIST.filter((n) => n.id !== "all-barcelona");
  }
  const one = getNeighborhood(selectionId);
  return one ? [one] : [];
}
