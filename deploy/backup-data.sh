#!/usr/bin/env bash
# Backup SQLite + Chroma + BM25 from DATA_DIR (default ./data or /data).
set -euo pipefail

DATA_DIR="${DATA_DIR:-./data}"
BACKUP_ROOT="${BACKUP_ROOT:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${BACKUP_ROOT}/${STAMP}"
mkdir -p "${OUT_DIR}"

if [[ ! -d "${DATA_DIR}" ]]; then
  echo "DATA_DIR not found: ${DATA_DIR}" >&2
  exit 1
fi

DB="${DATA_DIR}/cafes.db"
if [[ -f "${DB}" ]]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "${DB}" ".backup '${OUT_DIR}/cafes.db'"
  else
    python3 - <<PY
import sqlite3
src = sqlite3.connect("${DB}")
dst = sqlite3.connect("${OUT_DIR}/cafes.db")
src.backup(dst)
dst.close(); src.close()
print("sqlite backup ok")
PY
  fi
else
  echo "warning: no cafes.db at ${DB}" >&2
fi

if [[ -d "${DATA_DIR}/chroma" ]]; then
  tar -C "${DATA_DIR}" -czf "${OUT_DIR}/chroma.tar.gz" chroma
fi
if [[ -f "${DATA_DIR}/bm25_index.pkl" ]]; then
  cp -a "${DATA_DIR}/bm25_index.pkl" "${OUT_DIR}/"
fi

tar -C "${BACKUP_ROOT}" -czf "${BACKUP_ROOT}/barcelona-data-${STAMP}.tar.gz" "${STAMP}"
rm -rf "${OUT_DIR}"

# Retain last 7 backups
ls -1t "${BACKUP_ROOT}"/barcelona-data-*.tar.gz 2>/dev/null | tail -n +8 | xargs -r rm -f

echo "Wrote ${BACKUP_ROOT}/barcelona-data-${STAMP}.tar.gz"
