/**
 * Shared fetch error formatting so Places and Parallel failures stay consistent.
 */

export function formatFetchError(err, service) {
  const cause = err?.cause;
  if (cause?.code === "ENOTFOUND") {
    return `Network/DNS failed reaching ${service} (${cause.hostname}).`;
  }
  if (cause?.code === "ECONNREFUSED" || cause?.code === "ETIMEDOUT") {
    return `Network error talking to ${service} (${cause.code}).`;
  }
  return cause?.message || err?.message || String(err);
}
