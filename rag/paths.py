from pathlib import Path
import os

ROOT = Path(__file__).resolve().parent.parent
EMBEDDING_MODEL = "text-embedding-3-small"
CHAT_MODEL = "gpt-4o-mini"
EMBEDDING_DIMS = 1536
COLLECTION_NAME = "barcelona_cafes"


def data_dir() -> Path:
    configured = (os.environ.get("DATA_DIR") or "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return ROOT / "data"


def chroma_dir() -> Path:
    return data_dir() / "chroma"


def sqlite_path() -> Path:
    explicit = (os.environ.get("SQLITE_PATH") or "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    return data_dir() / "cafes.db"


# Legacy aliases (evaluate lazily via property-like call sites preferring functions)
DATA_DIR = data_dir()
CHROMA_DIR = chroma_dir()
DB_PATH = sqlite_path()
