#!/usr/bin/env bash
# Restore a backup tarball into DATA_DIR.
set -euo pipefail

ARCHIVE="${1:?usage: restore-data.sh /path/to/barcelona-data-YYYYMMDD.tar.gz}"
DATA_DIR="${DATA_DIR:-./data}"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

tar -xzf "${ARCHIVE}" -C "${TMP}"
INNER="$(find "${TMP}" -mindepth 1 -maxdepth 1 -type d | head -1)"
if [[ -z "${INNER}" ]]; then
  echo "invalid archive layout" >&2
  exit 1
fi

mkdir -p "${DATA_DIR}"
if [[ -f "${INNER}/cafes.db" ]]; then
  cp -a "${INNER}/cafes.db" "${DATA_DIR}/cafes.db"
  rm -f "${DATA_DIR}/cafes.db-wal" "${DATA_DIR}/cafes.db-shm"
fi
if [[ -f "${INNER}/chroma.tar.gz" ]]; then
  rm -rf "${DATA_DIR}/chroma"
  tar -xzf "${INNER}/chroma.tar.gz" -C "${DATA_DIR}"
fi
if [[ -f "${INNER}/bm25_index.pkl" ]]; then
  cp -a "${INNER}/bm25_index.pkl" "${DATA_DIR}/"
fi

echo "Restored into ${DATA_DIR}"
