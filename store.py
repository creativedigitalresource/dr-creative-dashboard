import sqlite3, json, os, time
from contextlib import contextmanager

DB_PATH = os.environ.get("DB_PATH", "dashboard.db")


def _conn():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


@contextmanager
def get_db():
    c = _conn()
    try:
        yield c
        c.commit()
    finally:
        c.close()


def init_db():
    with get_db() as c:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS tokens (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at REAL DEFAULT (unixepoch())
            );
            CREATE TABLE IF NOT EXISTS start_dates (
                todo_id TEXT PRIMARY KEY,
                start_date TEXT NOT NULL,
                updated_at REAL DEFAULT (unixepoch())
            );
            CREATE TABLE IF NOT EXISTS cache (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                expires_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS overrides (
                todo_id TEXT NOT NULL,
                field TEXT NOT NULL,
                value TEXT NOT NULL,
                updated_at REAL DEFAULT (unixepoch()),
                PRIMARY KEY (todo_id, field)
            );
            CREATE TABLE IF NOT EXISTS pto (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                designer_bc_id TEXT NOT NULL,
                date TEXT NOT NULL,
                note TEXT DEFAULT '',
                created_at REAL DEFAULT (unixepoch()),
                UNIQUE(designer_bc_id, date)
            );
        """)


def set_token(key: str, value: str):
    with get_db() as c:
        c.execute(
            "INSERT OR REPLACE INTO tokens (key, value, updated_at) VALUES (?, ?, unixepoch())",
            (key, value),
        )


def get_token(key: str) -> str | None:
    with get_db() as c:
        row = c.execute("SELECT value FROM tokens WHERE key=?", (key,)).fetchone()
        return row["value"] if row else None


def set_start_date(todo_id: str, start_date: str):
    with get_db() as c:
        c.execute(
            "INSERT OR REPLACE INTO start_dates (todo_id, start_date, updated_at) VALUES (?, ?, unixepoch())",
            (str(todo_id), start_date),
        )


def get_start_date(todo_id: str) -> str | None:
    with get_db() as c:
        row = c.execute(
            "SELECT start_date FROM start_dates WHERE todo_id=?", (str(todo_id),)
        ).fetchone()
        return row["start_date"] if row else None


def get_all_start_dates() -> dict:
    with get_db() as c:
        rows = c.execute("SELECT todo_id, start_date FROM start_dates").fetchall()
        return {r["todo_id"]: r["start_date"] for r in rows}


def set_override(todo_id: str, field: str, value: str):
    with get_db() as c:
        c.execute(
            "INSERT OR REPLACE INTO overrides (todo_id, field, value, updated_at) VALUES (?, ?, ?, unixepoch())",
            (str(todo_id), field, value),
        )


def delete_override(todo_id: str, field: str):
    with get_db() as c:
        c.execute("DELETE FROM overrides WHERE todo_id=? AND field=?", (str(todo_id), field))


def get_all_overrides() -> dict:
    """Returns {todo_id: {field: value, ...}, ...}"""
    with get_db() as c:
        rows = c.execute("SELECT todo_id, field, value FROM overrides").fetchall()
    result = {}
    for r in rows:
        result.setdefault(r["todo_id"], {})[r["field"]] = r["value"]
    return result


def add_pto(designer_bc_id: str, date: str, note: str = ""):
    with get_db() as c:
        c.execute(
            "INSERT OR REPLACE INTO pto (designer_bc_id, date, note, created_at) VALUES (?, ?, ?, unixepoch())",
            (str(designer_bc_id), date, note),
        )


def delete_pto(pto_id: int):
    with get_db() as c:
        c.execute("DELETE FROM pto WHERE id=?", (pto_id,))


def get_all_pto() -> dict:
    """Returns {designer_bc_id: [{id, date, note}, ...], ...}"""
    with get_db() as c:
        rows = c.execute("SELECT id, designer_bc_id, date, note FROM pto ORDER BY date").fetchall()
    result = {}
    for r in rows:
        result.setdefault(str(r["designer_bc_id"]), []).append(
            {"id": r["id"], "date": r["date"], "note": r["note"]}
        )
    return result


def cache_set(key: str, value, ttl_seconds: int = 60):
    with get_db() as c:
        c.execute(
            "INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)",
            (key, json.dumps(value), time.time() + ttl_seconds),
        )


def cache_get(key: str):
    with get_db() as c:
        row = c.execute(
            "SELECT value, expires_at FROM cache WHERE key=?", (key,)
        ).fetchone()
        if row and row["expires_at"] > time.time():
            return json.loads(row["value"])
        return None
