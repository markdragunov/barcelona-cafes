/**
 * Barcelona neighborhood map viewports for Places API locationRestriction.
 * Coordinates are southwest (low) / northeast (high) rectangle corners.
 * Do not filter by address text — geographic restriction only.
 */
export const NEIGHBORHOODS = {
  "el-born": {
    id: "el-born",
    name: "El Born",
    viewport: {
      low: { latitude: 41.3825, longitude: 2.178 },
      high: { latitude: 41.3885, longitude: 2.1865 },
    },
  },
  eixample: {
    id: "eixample",
    name: "Eixample",
    viewport: {
      low: { latitude: 41.385, longitude: 2.145 },
      high: { latitude: 41.405, longitude: 2.175 },
    },
  },
  poblenou: {
    id: "poblenou",
    name: "Poblenou",
    viewport: {
      low: { latitude: 41.39, longitude: 2.185 },
      high: { latitude: 41.415, longitude: 2.215 },
    },
  },
  gracia: {
    id: "gracia",
    name: "Gràcia",
    viewport: {
      low: { latitude: 41.4, longitude: 2.145 },
      high: { latitude: 41.415, longitude: 2.165 },
    },
  },
  "gothic-quarter": {
    id: "gothic-quarter",
    name: "Gothic Quarter",
    viewport: {
      low: { latitude: 41.379, longitude: 2.173 },
      high: { latitude: 41.3855, longitude: 2.181 },
    },
  },
  "all-barcelona": {
    id: "all-barcelona",
    name: "All Barcelona",
    viewport: {
      low: { latitude: 41.32, longitude: 2.07 },
      high: { latitude: 41.47, longitude: 2.23 },
    },
  },
};

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
