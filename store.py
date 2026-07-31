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
            CREATE TABLE IF NOT EXISTS planner_order (
                designer_bc_id TEXT NOT NULL,
                date TEXT NOT NULL,
                todo_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                PRIMARY KEY (designer_bc_id, date, todo_id)
            );
            CREATE TABLE IF NOT EXISTS designer_notes (
                designer_bc_id TEXT PRIMARY KEY,
                content TEXT NOT NULL DEFAULT '',
                updated_at REAL DEFAULT (unixepoch())
            );
            CREATE TABLE IF NOT EXISTS kudos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                designer_bc_id TEXT NOT NULL,
                text TEXT NOT NULL,
                author TEXT NOT NULL DEFAULT '',
                slack_ts TEXT NOT NULL,
                permalink TEXT DEFAULT '',
                created_at REAL DEFAULT (unixepoch()),
                UNIQUE (designer_bc_id, slack_ts)
            );
            CREATE TABLE IF NOT EXISTS estimate_goals (
                category TEXT PRIMARY KEY,
                goal_hours REAL NOT NULL,
                updated_at REAL DEFAULT (unixepoch())
            );
            CREATE TABLE IF NOT EXISTS designer_tokens (
                designer_bc_id TEXT PRIMARY KEY,
                token TEXT NOT NULL UNIQUE,
                created_at REAL DEFAULT (unixepoch())
            );
            CREATE TABLE IF NOT EXISTS pto (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                designer_bc_id TEXT NOT NULL,
                date TEXT NOT NULL,
                note TEXT DEFAULT '',
                created_at REAL DEFAULT (unixepoch()),
                UNIQUE(designer_bc_id, date)
            );
            CREATE TABLE IF NOT EXISTS spotlight (
                designer_bc_id TEXT NOT NULL,
                todo_id TEXT NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                created_at REAL DEFAULT (unixepoch()),
                PRIMARY KEY (designer_bc_id, todo_id)
            );
            CREATE TABLE IF NOT EXISTS standups (
                designer_bc_id TEXT NOT NULL,
                date TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                todo_ids TEXT NOT NULL DEFAULT '[]',
                posted_at REAL NOT NULL DEFAULT (unixepoch()),
                first_posted_at REAL NOT NULL DEFAULT (unixepoch()),
                PRIMARY KEY (designer_bc_id, date)
            );
            -- Richard's own freeform priority list — not tied to Basecamp
            CREATE TABLE IF NOT EXISTS priority_todos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                text TEXT NOT NULL,
                done INTEGER NOT NULL DEFAULT 0,
                position INTEGER NOT NULL DEFAULT 0,
                created_at REAL DEFAULT (unixepoch()),
                completed_at REAL
            );

            -- Operational: active todo state, persists across server restarts
            CREATE TABLE IF NOT EXISTS todo_tracking (
                todo_id TEXT NOT NULL,
                designer_bc_id TEXT NOT NULL,
                designer_name TEXT NOT NULL,
                title TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'Misc.',
                client_name TEXT NOT NULL DEFAULT '',
                est_hours REAL,
                logged_hours REAL NOT NULL DEFAULT 0,
                hdd TEXT,
                due_on TEXT,
                had_revision INTEGER NOT NULL DEFAULT 0,
                first_seen_at REAL NOT NULL,
                last_seen_at REAL NOT NULL,
                PRIMARY KEY (todo_id, designer_bc_id)
            );

            -- Operational: tracks when each unassigned todo entered the queue
            CREATE TABLE IF NOT EXISTS queue_tracking (
                todo_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                client_name TEXT NOT NULL DEFAULT '',
                first_seen_at REAL NOT NULL,
                last_seen_at REAL NOT NULL
            );

            -- Analytics: permanent record of each completed task
            CREATE TABLE IF NOT EXISTS analytics_completions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                todo_id TEXT NOT NULL,
                designer_bc_id TEXT NOT NULL,
                designer_name TEXT NOT NULL,
                title TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'Misc.',
                client_name TEXT NOT NULL DEFAULT '',
                est_hours REAL,
                logged_hours REAL NOT NULL DEFAULT 0,
                hdd TEXT,
                due_on TEXT,
                week_start TEXT NOT NULL,
                was_hdd_miss INTEGER NOT NULL DEFAULT 0,
                had_revision INTEGER NOT NULL DEFAULT 0,
                recorded_at REAL DEFAULT (unixepoch()),
                UNIQUE(todo_id, designer_bc_id)
            );

            -- Analytics: weekly capacity snapshot per designer
            CREATE TABLE IF NOT EXISTS analytics_weekly_snapshots (
                designer_bc_id TEXT NOT NULL,
                designer_name TEXT NOT NULL,
                week_start TEXT NOT NULL,
                weekly_est REAL NOT NULL DEFAULT 0,
                weekly_cap REAL NOT NULL DEFAULT 32.5,
                capacity_pct INTEGER NOT NULL DEFAULT 0,
                active_todo_count INTEGER NOT NULL DEFAULT 0,
                recorded_at REAL DEFAULT (unixepoch()),
                PRIMARY KEY (designer_bc_id, week_start)
            );

            -- Analytics: how long each task sat in the unassigned queue
            CREATE TABLE IF NOT EXISTS analytics_queue_time (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                todo_id TEXT NOT NULL,
                title TEXT NOT NULL,
                client_name TEXT NOT NULL DEFAULT '',
                hours_in_queue REAL NOT NULL,
                recorded_at REAL DEFAULT (unixepoch()),
                UNIQUE(todo_id)
            );

            -- Analytics: weekly task count by category per designer
            CREATE TABLE IF NOT EXISTS analytics_category_volume (
                designer_bc_id TEXT NOT NULL,
                designer_name TEXT NOT NULL,
                week_start TEXT NOT NULL,
                category TEXT NOT NULL,
                task_count INTEGER NOT NULL DEFAULT 0,
                recorded_at REAL DEFAULT (unixepoch()),
                PRIMARY KEY (designer_bc_id, week_start, category)
            );

            -- QA: per-service checklist templates (editable, seeded with defaults)
            CREATE TABLE IF NOT EXISTS qa_templates (
                service TEXT PRIMARY KEY,
                items TEXT NOT NULL,
                updated_at REAL DEFAULT (unixepoch())
            );

            -- QA: completed checklists, each one a shareable certificate
            CREATE TABLE IF NOT EXISTS qa_certificates (
                id TEXT PRIMARY KEY,
                service TEXT NOT NULL,
                task_title TEXT NOT NULL DEFAULT '',
                client_name TEXT NOT NULL DEFAULT '',
                completed_by TEXT NOT NULL DEFAULT '',
                items TEXT NOT NULL,
                notes TEXT NOT NULL DEFAULT '',
                created_at REAL DEFAULT (unixepoch())
            );
        """)
        # Migration: first_posted_at was added after standups shipped, so an
        # already-deployed DB has the table without it. Nullable add + backfill
        # from posted_at (best available guess at the original post time for
        # rows that predate this column) avoids any ADD COLUMN NOT NULL
        # default-expression version quirks.
        try:
            c.execute("ALTER TABLE standups ADD COLUMN first_posted_at REAL")
        except sqlite3.OperationalError:
            pass  # column already exists
        c.execute("UPDATE standups SET first_posted_at = posted_at WHERE first_posted_at IS NULL")


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


def ensure_designer_token(designer_bc_id: str) -> str:
    """Return the designer's access token, creating one if missing."""
    import secrets
    with get_db() as c:
        row = c.execute(
            "SELECT token FROM designer_tokens WHERE designer_bc_id=?",
            (str(designer_bc_id),)).fetchone()
        if row:
            return row["token"]
        token = secrets.token_urlsafe(12)
        c.execute(
            "INSERT INTO designer_tokens (designer_bc_id, token) VALUES (?, ?)",
            (str(designer_bc_id), token))
        return token


def resolve_designer_token(token: str) -> str | None:
    """Return the designer_bc_id for a token, or None."""
    with get_db() as c:
        row = c.execute(
            "SELECT designer_bc_id FROM designer_tokens WHERE token=?",
            (token,)).fetchone()
        return row["designer_bc_id"] if row else None


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


# ---------------------------------------------------------------------------
# Todo tracking (operational — persists active task state across restarts)
# ---------------------------------------------------------------------------

def upsert_todo_tracking(todo_id, designer_bc_id, designer_name, title, category,
                          client_name, est_hours, logged_hours, hdd, due_on,
                          had_revision, ts):
    with get_db() as c:
        existing = c.execute(
            "SELECT first_seen_at FROM todo_tracking WHERE todo_id=? AND designer_bc_id=?",
            (str(todo_id), str(designer_bc_id)),
        ).fetchone()
        first = existing["first_seen_at"] if existing else ts
        c.execute("""
            INSERT OR REPLACE INTO todo_tracking
              (todo_id, designer_bc_id, designer_name, title, category, client_name,
               est_hours, logged_hours, hdd, due_on, had_revision, first_seen_at, last_seen_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (str(todo_id), str(designer_bc_id), designer_name, title, category,
              client_name, est_hours, logged_hours, hdd, due_on, had_revision, first, ts))


def get_all_todo_tracking() -> dict:
    """Returns {(todo_id, designer_bc_id): row_dict}"""
    with get_db() as c:
        rows = c.execute("SELECT * FROM todo_tracking").fetchall()
    return {(r["todo_id"], r["designer_bc_id"]): dict(r) for r in rows}


def delete_todo_tracking(todo_id, designer_bc_id):
    with get_db() as c:
        c.execute("DELETE FROM todo_tracking WHERE todo_id=? AND designer_bc_id=?",
                  (str(todo_id), str(designer_bc_id)))


# ---------------------------------------------------------------------------
# Queue tracking (operational)
# ---------------------------------------------------------------------------

def upsert_queue_tracking(todo_id, title, client_name, ts):
    with get_db() as c:
        existing = c.execute(
            "SELECT first_seen_at FROM queue_tracking WHERE todo_id=?", (str(todo_id),)
        ).fetchone()
        first = existing["first_seen_at"] if existing else ts
        c.execute("""
            INSERT OR REPLACE INTO queue_tracking (todo_id, title, client_name, first_seen_at, last_seen_at)
            VALUES (?,?,?,?,?)
        """, (str(todo_id), title, client_name, first, ts))


def get_all_queue_tracking() -> dict:
    """Returns {todo_id: row_dict}"""
    with get_db() as c:
        rows = c.execute("SELECT * FROM queue_tracking").fetchall()
    return {r["todo_id"]: dict(r) for r in rows}


def delete_queue_tracking(todo_id):
    with get_db() as c:
        c.execute("DELETE FROM queue_tracking WHERE todo_id=?", (str(todo_id),))


# ---------------------------------------------------------------------------
# Analytics writers (append-only)
# ---------------------------------------------------------------------------

def record_completion(todo_id, designer_bc_id, designer_name, title, category,
                      client_name, est_hours, logged_hours, hdd, due_on,
                      week_start, was_hdd_miss, had_revision):
    with get_db() as c:
        c.execute("""
            INSERT OR IGNORE INTO analytics_completions
              (todo_id, designer_bc_id, designer_name, title, category, client_name,
               est_hours, logged_hours, hdd, due_on, week_start, was_hdd_miss, had_revision)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (str(todo_id), str(designer_bc_id), designer_name, title, category,
              client_name, est_hours, logged_hours, hdd, due_on,
              week_start, was_hdd_miss, had_revision))


def update_completion_logged_hours(todo_id, designer_bc_id, logged_hours) -> bool:
    """Reconcile a historical completion's logged_hours against a fresh
    Everhour read. Returns True if the stored value actually changed."""
    with get_db() as c:
        cur = c.execute(
            "UPDATE analytics_completions SET logged_hours=? WHERE todo_id=? AND designer_bc_id=? AND logged_hours!=?",
            (logged_hours, str(todo_id), str(designer_bc_id), logged_hours))
        return cur.rowcount > 0


def delete_completion(todo_id, designer_bc_id) -> bool:
    """Remove a completion that was recorded in error — e.g. the designer was
    unassigned/reassigned but the actual deliverable wasn't finished (our
    'unassigned = complete' heuristic can misfire on a handoff mid-project)."""
    with get_db() as c:
        cur = c.execute(
            "DELETE FROM analytics_completions WHERE todo_id=? AND designer_bc_id=?",
            (str(todo_id), str(designer_bc_id)))
        return cur.rowcount > 0


def update_completion_category(todo_id, designer_bc_id, category) -> bool:
    """Correct a completion's category — the automatic title-keyword matcher
    can mistag a task whose title mentions a category's keywords without
    actually being that kind of work (e.g. a landing page ABOUT a branding
    service getting tagged as Branding/Logo creative work itself)."""
    with get_db() as c:
        cur = c.execute(
            "UPDATE analytics_completions SET category=? WHERE todo_id=? AND designer_bc_id=?",
            (category, str(todo_id), str(designer_bc_id)))
        return cur.rowcount > 0


def record_weekly_snapshot(designer_bc_id, designer_name, week_start,
                            weekly_est, weekly_cap, capacity_pct, active_todo_count):
    with get_db() as c:
        c.execute("""
            INSERT OR REPLACE INTO analytics_weekly_snapshots
              (designer_bc_id, designer_name, week_start, weekly_est, weekly_cap,
               capacity_pct, active_todo_count, recorded_at)
            VALUES (?,?,?,?,?,?,?,unixepoch())
        """, (str(designer_bc_id), designer_name, week_start, weekly_est,
              weekly_cap, capacity_pct, active_todo_count))


def record_queue_exit(todo_id, title, client_name, first_seen_at, last_seen_at):
    hours = round((last_seen_at - first_seen_at) / 3600, 2)
    with get_db() as c:
        c.execute("""
            INSERT OR IGNORE INTO analytics_queue_time (todo_id, title, client_name, hours_in_queue)
            VALUES (?,?,?,?)
        """, (str(todo_id), title, client_name, hours))


def record_category_volume(designer_bc_id, designer_name, week_start, category, task_count):
    with get_db() as c:
        c.execute("""
            INSERT OR REPLACE INTO analytics_category_volume
              (designer_bc_id, designer_name, week_start, category, task_count, recorded_at)
            VALUES (?,?,?,?,?,unixepoch())
        """, (str(designer_bc_id), designer_name, week_start, category, task_count))


# ---------------------------------------------------------------------------
# Analytics readers
# ---------------------------------------------------------------------------

def get_analytics_completions() -> list:
    with get_db() as c:
        rows = c.execute(
            "SELECT * FROM analytics_completions ORDER BY recorded_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_analytics_weekly_snapshots() -> list:
    with get_db() as c:
        rows = c.execute(
            "SELECT * FROM analytics_weekly_snapshots ORDER BY week_start DESC, designer_name"
        ).fetchall()
    return [dict(r) for r in rows]


def get_analytics_queue_time() -> list:
    with get_db() as c:
        rows = c.execute(
            "SELECT * FROM analytics_queue_time ORDER BY recorded_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_analytics_category_volume() -> list:
    with get_db() as c:
        rows = c.execute(
            "SELECT * FROM analytics_category_volume ORDER BY week_start DESC, designer_name, category"
        ).fetchall()
    return [dict(r) for r in rows]


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


# ---------------------------------------------------------------------------
# Designer page extras: planner order, notes, kudos
# ---------------------------------------------------------------------------

def set_planner_order(designer_bc_id: str, date: str, todo_ids: list):
    with get_db() as c:
        c.execute("DELETE FROM planner_order WHERE designer_bc_id=? AND date=?",
                  (str(designer_bc_id), date))
        for i, tid in enumerate(todo_ids):
            c.execute("INSERT OR REPLACE INTO planner_order (designer_bc_id, date, todo_id, position) VALUES (?,?,?,?)",
                      (str(designer_bc_id), date, str(tid), i))


def get_planner_order(designer_bc_id: str) -> dict:
    """Returns {date: [todo_id, ...]} sorted by position."""
    with get_db() as c:
        rows = c.execute(
            "SELECT date, todo_id FROM planner_order WHERE designer_bc_id=? ORDER BY date, position",
            (str(designer_bc_id),)).fetchall()
    out = {}
    for r in rows:
        out.setdefault(r["date"], []).append(r["todo_id"])
    return out


def set_designer_note(designer_bc_id: str, content: str):
    with get_db() as c:
        c.execute("INSERT OR REPLACE INTO designer_notes (designer_bc_id, content, updated_at) VALUES (?,?,unixepoch())",
                  (str(designer_bc_id), content))


def get_designer_note(designer_bc_id: str) -> str:
    with get_db() as c:
        row = c.execute("SELECT content FROM designer_notes WHERE designer_bc_id=?",
                        (str(designer_bc_id),)).fetchone()
        return row["content"] if row else ""


def add_kudos(designer_bc_id: str, text: str, author: str, slack_ts: str, permalink: str = "") -> bool:
    with get_db() as c:
        cur = c.execute(
            "INSERT OR IGNORE INTO kudos (designer_bc_id, text, author, slack_ts, permalink) VALUES (?,?,?,?,?)",
            (str(designer_bc_id), text, author, slack_ts, permalink))
        return cur.rowcount > 0


def get_kudos(designer_bc_id: str, since_ts: str = "", limit: int = 200) -> list:
    # slack_ts is an epoch-seconds string; lexicographic >= works until year 2286
    with get_db() as c:
        rows = c.execute(
            "SELECT text, author, slack_ts, permalink FROM kudos WHERE designer_bc_id=? AND slack_ts >= ? ORDER BY slack_ts DESC LIMIT ?",
            (str(designer_bc_id), since_ts, limit)).fetchall()
    return [dict(r) for r in rows]


def count_completions_since(designer_bc_id: str, week_start: str) -> int:
    with get_db() as c:
        row = c.execute(
            "SELECT COUNT(*) AS n FROM analytics_completions WHERE designer_bc_id=? AND week_start>=?",
            (str(designer_bc_id), week_start)).fetchone()
        return row["n"] if row else 0


# ---------------------------------------------------------------------------
# Estimate goals — Richard's per-category standard, shown against each
# designer's own historical pace. Only Richard writes these.
# ---------------------------------------------------------------------------

def set_estimate_goal(category: str, goal_hours: float):
    with get_db() as c:
        c.execute(
            "INSERT OR REPLACE INTO estimate_goals (category, goal_hours, updated_at) VALUES (?,?,unixepoch())",
            (category, goal_hours))


def get_estimate_goals() -> dict:
    """Returns {category: goal_hours}."""
    with get_db() as c:
        rows = c.execute("SELECT category, goal_hours FROM estimate_goals").fetchall()
    return {r["category"]: r["goal_hours"] for r in rows}


# ---------------------------------------------------------------------------
# Spotlight — each designer (and Richard, for My Stuff) can pin up to 4 of
# their own tasks to a dedicated section at the top of their page.
# ---------------------------------------------------------------------------

SPOTLIGHT_MAX = 4


def set_spotlight(designer_bc_id: str, todo_id: str, on: bool) -> dict:
    with get_db() as c:
        if on:
            exists = c.execute(
                "SELECT 1 FROM spotlight WHERE designer_bc_id=? AND todo_id=?",
                (str(designer_bc_id), str(todo_id))).fetchone()
            if not exists:
                n = c.execute(
                    "SELECT COUNT(*) AS n FROM spotlight WHERE designer_bc_id=?",
                    (str(designer_bc_id),)).fetchone()["n"]
                if n >= SPOTLIGHT_MAX:
                    return {"ok": False, "error": f"You can only spotlight up to {SPOTLIGHT_MAX} tasks at a time."}
                pos = c.execute(
                    "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM spotlight WHERE designer_bc_id=?",
                    (str(designer_bc_id),)).fetchone()["p"]
                c.execute(
                    "INSERT INTO spotlight (designer_bc_id, todo_id, position) VALUES (?,?,?)",
                    (str(designer_bc_id), str(todo_id), pos))
        else:
            c.execute("DELETE FROM spotlight WHERE designer_bc_id=? AND todo_id=?",
                      (str(designer_bc_id), str(todo_id)))
    return {"ok": True}


def get_spotlight_ids(designer_bc_id: str) -> list:
    with get_db() as c:
        rows = c.execute(
            "SELECT todo_id FROM spotlight WHERE designer_bc_id=? ORDER BY position",
            (str(designer_bc_id),)).fetchall()
    return [r["todo_id"] for r in rows]


# ---------------------------------------------------------------------------
# Standups — a designer's daily "what I'm working on today" post, built from
# their own My Week planner. Re-postable: posting again the same day replaces
# the note/task list and bumps posted_at, rather than creating a new entry.
# ---------------------------------------------------------------------------

def set_standup(designer_bc_id: str, day: str, note: str, todo_ids: list) -> dict:
    """Upsert, not replace — a repost updates note/todo_ids/posted_at but
    leaves first_posted_at untouched, so Richard can see when it was first
    posted vs. last updated."""
    with get_db() as c:
        c.execute("""
            INSERT INTO standups (designer_bc_id, date, note, todo_ids, posted_at, first_posted_at)
            VALUES (?, ?, ?, ?, unixepoch(), unixepoch())
            ON CONFLICT(designer_bc_id, date) DO UPDATE SET
                note = excluded.note,
                todo_ids = excluded.todo_ids,
                posted_at = unixepoch()
        """, (str(designer_bc_id), day, note, json.dumps([str(i) for i in todo_ids])))
        row = c.execute(
            "SELECT posted_at, first_posted_at FROM standups WHERE designer_bc_id=? AND date=?",
            (str(designer_bc_id), day)).fetchone()
    return {"ok": True, "posted_at": row["posted_at"], "first_posted_at": row["first_posted_at"]}


def get_standup(designer_bc_id: str, day: str) -> dict | None:
    with get_db() as c:
        row = c.execute(
            "SELECT note, todo_ids, posted_at, first_posted_at FROM standups WHERE designer_bc_id=? AND date=?",
            (str(designer_bc_id), day)).fetchone()
    if not row:
        return None
    return {"note": row["note"], "todo_ids": json.loads(row["todo_ids"]),
            "posted_at": row["posted_at"], "first_posted_at": row["first_posted_at"]}


# ---------------------------------------------------------------------------
# Priority to-dos — Richard's own freeform drag-sortable checklist. Single
# list, not per-designer (this is a personal tool on the manager dashboard).
# ---------------------------------------------------------------------------

def add_priority_todo(text: str) -> dict:
    with get_db() as c:
        pos = c.execute("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM priority_todos").fetchone()["p"]
        cur = c.execute(
            "INSERT INTO priority_todos (text, position) VALUES (?, ?)", (text, pos))
        row = c.execute(
            "SELECT id, text, done, position, created_at, completed_at FROM priority_todos WHERE id=?",
            (cur.lastrowid,)).fetchone()
    return dict(row)


def get_priority_todos() -> dict:
    """Returns {active: [...], completed: [...]} — active ordered by
    position (drag order), completed ordered most-recently-done first."""
    with get_db() as c:
        active = c.execute(
            "SELECT id, text, done, position, created_at, completed_at FROM priority_todos "
            "WHERE done=0 ORDER BY position").fetchall()
        completed = c.execute(
            "SELECT id, text, done, position, created_at, completed_at FROM priority_todos "
            "WHERE done=1 ORDER BY completed_at DESC").fetchall()
    return {"active": [dict(r) for r in active], "completed": [dict(r) for r in completed]}


def set_priority_todo_order(ids: list):
    with get_db() as c:
        for i, tid in enumerate(ids):
            c.execute("UPDATE priority_todos SET position=? WHERE id=?", (i, int(tid)))


def set_priority_todo_done(todo_id: int, done: bool) -> dict:
    """Marking done just flips the flag — position stops mattering once an
    item leaves the active list. Un-completing sends it back to the bottom
    of the active list (a fresh position) rather than restoring its old
    spot, since whatever was around it may have moved or been completed."""
    with get_db() as c:
        if done:
            c.execute(
                "UPDATE priority_todos SET done=1, completed_at=unixepoch() WHERE id=?",
                (todo_id,))
        else:
            pos = c.execute("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM priority_todos").fetchone()["p"]
            c.execute(
                "UPDATE priority_todos SET done=0, completed_at=NULL, position=? WHERE id=?",
                (pos, todo_id))
        row = c.execute(
            "SELECT id, text, done, position, created_at, completed_at FROM priority_todos WHERE id=?",
            (todo_id,)).fetchone()
    return dict(row) if row else None


def delete_priority_todo(todo_id: int):
    with get_db() as c:
        c.execute("DELETE FROM priority_todos WHERE id=?", (todo_id,))


# ---------------------------------------------------------------------------
# QA checklists — per-service templates and completed certificates
# ---------------------------------------------------------------------------

def seed_qa_templates(defaults: dict):
    """Insert each default template only if that service has none yet, so
    edits made in the dashboard are never overwritten by a redeploy."""
    with get_db() as c:
        for service, items in defaults.items():
            c.execute(
                "INSERT OR IGNORE INTO qa_templates (service, items) VALUES (?, ?)",
                (service, json.dumps(items)))


def get_qa_templates() -> dict:
    """Returns {service: [item, ...]}."""
    with get_db() as c:
        rows = c.execute("SELECT service, items FROM qa_templates").fetchall()
    return {r["service"]: json.loads(r["items"]) for r in rows}


def set_qa_template(service: str, items: list):
    with get_db() as c:
        c.execute(
            "INSERT OR REPLACE INTO qa_templates (service, items, updated_at) VALUES (?, ?, unixepoch())",
            (service, json.dumps(items)))


def create_qa_certificate(cert_id: str, service: str, task_title: str, client_name: str,
                           completed_by: str, items: list, notes: str) -> dict:
    with get_db() as c:
        c.execute("""
            INSERT INTO qa_certificates (id, service, task_title, client_name, completed_by, items, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (cert_id, service, task_title, client_name, completed_by, json.dumps(items), notes))
    return get_qa_certificate(cert_id)


def get_qa_certificate(cert_id: str) -> dict | None:
    with get_db() as c:
        row = c.execute("SELECT * FROM qa_certificates WHERE id=?", (cert_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["items"] = json.loads(d["items"])
    return d


def get_recent_qa_certificates(limit: int = 30) -> list:
    with get_db() as c:
        rows = c.execute(
            "SELECT * FROM qa_certificates ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["items"] = json.loads(d["items"])
        out.append(d)
    return out
