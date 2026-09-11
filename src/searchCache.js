/**
 * Short-lived in-memory cache for public search answers. Repeated and
 * duplicated queries are served without spending OpenAI or Google credits.
 * Bounded by TTL and entry count; nothing is persisted.
 */

/** Cache key for a query, insensitive to case and surrounding whitespace. */
export function searchCacheKey(query, topN) {
  const normalized = String(query).trim().toLowerCase().replace(/\s+/g, " ");
  return `${topN}:${normalized}`;
}

/**
 * @param {{ ttlMs?: number, maxEntries?: number }} options
 *   `ttlMs` of 0 disables the cache.
 */
export function createSearchCache({ ttlMs = 300_000, maxEntries = 200 } = {}) {
  const entries = new Map();
  const enabled = ttlMs > 0;

  return {
    enabled,

    /** Cached value, or null when missing, expired or disabled. */
    get(key) {
      if (!enabled) return null;
      const entry = entries.get(key);
      if (!entry) return null;
      if (Date.now() - entry.storedAt >= ttlMs) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },

    set(key, value) {
      if (!enabled) return;
      // Re-insert so Map order stays oldest-first for eviction.
      entries.delete(key);
      entries.set(key, { storedAt: Date.now(), value });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },

    get size() {
      return entries.size;
    },

    clear() {
      entries.clear();
    },
  };
}
