import sqlite3, json, os, re, time, statistics
from collections import defaultdict
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

            -- QA: in-progress checklists, auto-saved as someone works through
            -- them so a refresh or closed tab never loses progress. One
            -- person (identified by person_key — "manager" for Richard, a
            -- designer's own /my/{token} token for everyone else) can have
            -- several open at once, browsable in the Drafts section.
            -- Submitting deletes the draft and creates a real certificate.
            CREATE TABLE IF NOT EXISTS qa_drafts (
                id TEXT PRIMARY KEY,
                person_key TEXT NOT NULL,
                service TEXT NOT NULL,
                task_title TEXT NOT NULL DEFAULT '',
                client_name TEXT NOT NULL DEFAULT '',
                completed_by TEXT NOT NULL DEFAULT '',
                items TEXT NOT NULL,
                notes TEXT NOT NULL DEFAULT '',
                feedback TEXT NOT NULL DEFAULT '',
                created_at REAL DEFAULT (unixepoch()),
                updated_at REAL DEFAULT (unixepoch())
            );

            -- At Risk Slack nudge: one row per todo per day it was surfaced,
            -- so the daily routine never re-pings the same task twice in a day
            -- even if it calls the endpoint more than once.
            CREATE TABLE IF NOT EXISTS at_risk_notified (
                todo_id TEXT NOT NULL,
                date TEXT NOT NULL,
                notified_at REAL DEFAULT (unixepoch()),
                PRIMARY KEY (todo_id, date)
            );

            -- Richard-only Slack alerts (spotlight/hours-logged, HDD today,
            -- past due, needs a decision): one row per todo per alert type
            -- per day, so the polling routine never re-sends the same
            -- alert twice in a day even if it checks every 15 minutes.
            CREATE TABLE IF NOT EXISTS richard_alert_notified (
                todo_id TEXT NOT NULL,
                alert_type TEXT NOT NULL,
                date TEXT NOT NULL,
                notified_at REAL DEFAULT (unixepoch()),
                PRIMARY KEY (todo_id, alert_type, date)
            );

            -- To Delegate learning (confirmed with Richard 2026-09-21:
            -- automatic, no approval step). Every raw correction is kept
            -- forever as the audit trail; the "learned_*" tables are the
            -- derived, currently-active values the suggestion engine
            -- actually reads — always recomputed from the full correction
            -- history, never hand-edited.

            -- Every time a category is changed on a still-unassigned to-do,
            -- away from what the app guessed/last suggested.
            CREATE TABLE IF NOT EXISTS category_corrections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                from_category TEXT NOT NULL,
                to_category TEXT NOT NULL,
                corrected_at REAL DEFAULT (unixepoch())
            );

            -- Exact-title memory — one correction is enough to trust this,
            -- since an identical title recurring (common for templated
            -- to-dos like recurring ad-platform tasks) is an unambiguous
            -- signal, not a pattern needing repetition to confirm.
            CREATE TABLE IF NOT EXISTS learned_category_titles (
                title_normalized TEXT PRIMARY KEY,
                category TEXT NOT NULL,
                learned_at REAL DEFAULT (unixepoch())
            );

            -- Word-level memory — promoted only once a word has shown up in
            -- 2+ distinct corrected titles that all agree on the same
            -- category (see store.record_category_correction), so one
            -- unusual correction can't mislabel every future to-do sharing
            -- one common word.
            CREATE TABLE IF NOT EXISTS learned_category_keywords (
                keyword TEXT PRIMARY KEY,
                category TEXT NOT NULL,
                support_count INTEGER NOT NULL DEFAULT 1,
                learned_at REAL DEFAULT (unixepoch())
            );

            -- Every time an EST or HDD is changed away from its suggestion,
            -- logged at Auto Assign (the moment the value is actually
            -- used) rather than on every keystroke while still editing.
            -- field is 'est_hours' or 'timeline_days' (business days from
            -- today to the HDD, so it's comparable/averageable the same
            -- way EST hours are).
            CREATE TABLE IF NOT EXISTS delegation_corrections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                todo_id TEXT NOT NULL,
                category TEXT NOT NULL,
                field TEXT NOT NULL,
                suggested_value REAL,
                chosen_value REAL NOT NULL,
                corrected_at REAL DEFAULT (unixepoch())
            );

            -- The currently-active learned default per category+field —
            -- the median of every chosen_value in delegation_corrections
            -- for that category, recomputed on every new correction.
            -- Read by the suggestion engine only once sample_count meets
            -- DELEGATION_LEARNING_MIN_N (main.py) — a couple of corrections
            -- shouldn't overrule the confirmed static default yet.
            CREATE TABLE IF NOT EXISTS learned_category_defaults (
                category TEXT NOT NULL,
                field TEXT NOT NULL,
                value REAL NOT NULL,
                sample_count INTEGER NOT NULL,
                updated_at REAL DEFAULT (unixepoch()),
                PRIMARY KEY (category, field)
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

        # Migration: url was added to analytics_completions so a completed
        # task's title can link straight to Basecamp — Everhour's own task
        # response already carries the exact URL, no construction needed.
        # Existing rows get backfilled by the reconcile endpoint, not here.
        try:
            c.execute("ALTER TABLE analytics_completions ADD COLUMN url TEXT")
        except sqlite3.OperationalError:
            pass  # column already exists

        # Migration: feedback + feedback_seen_at were added to qa_certificates
        # for the internal-only "notes to Richard" field — separate from the
        # existing `notes` column, which is shown on the public certificate
        # page. feedback_seen_at is NULL until Richard clicks Mark as Seen.
        try:
            c.execute("ALTER TABLE qa_certificates ADD COLUMN feedback TEXT NOT NULL DEFAULT ''")
        except sqlite3.OperationalError:
            pass  # column already exists
        try:
            c.execute("ALTER TABLE qa_certificates ADD COLUMN feedback_seen_at REAL")
        except sqlite3.OperationalError:
            pass  # column already exists

        # Migration: archived_at — Richard can archive a piece of feedback
        # once seen to get it out of the main QA Activity list, without
        # deleting it. NULL means active; set means it lives in the
        # collapsed Archived section instead.
        try:
            c.execute("ALTER TABLE qa_certificates ADD COLUMN archived_at REAL")
        except sqlite3.OperationalError:
            pass  # column already exists

        # Migration: person_key — who actually submitted this certificate,
        # captured automatically from their session/token rather than the
        # free-typed "completed_by" name (typo/nickname-prone). Powers "My
        # QA History" reliably; only populated going forward, so history
        # for certificates created before this ships won't show up in it.
        try:
            c.execute("ALTER TABLE qa_certificates ADD COLUMN person_key TEXT")
        except sqlite3.OperationalError:
            pass  # column already exists


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
                      week_start, was_hdd_miss, had_revision, url=None):
    """Upsert, not insert-or-ignore. A task can leave a designer's active
    list, come back for another round (AM review → more revisions →
    designer again — a normal workflow, not an edge case), and leave
    again; each time that happens this fires again for the same
    (todo_id, designer_bc_id). The old INSERT OR IGNORE meant only the
    FIRST detection ever stuck — confirmed live 2026-08-27: a task with
    3 review rounds over 2 weeks got permanently recorded with a stale
    in-progress EST/logged snapshot from the first time it briefly left
    the designer's list for AM review, and its real final numbers a week
    later were silently dropped. Upserting means each re-detection
    corrects the record to the latest, most-accurate snapshot.

    url is only set on conflict when a real value is provided — a retry
    that couldn't reach Everhour (url=None) shouldn't blank out a url a
    previous successful detection already captured."""
    with get_db() as c:
        c.execute("""
            INSERT INTO analytics_completions
              (todo_id, designer_bc_id, designer_name, title, category, client_name,
               est_hours, logged_hours, hdd, due_on, week_start, was_hdd_miss, had_revision, url)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(todo_id, designer_bc_id) DO UPDATE SET
                designer_name = excluded.designer_name,
                title = excluded.title,
                category = excluded.category,
                client_name = excluded.client_name,
                est_hours = excluded.est_hours,
                logged_hours = excluded.logged_hours,
                hdd = excluded.hdd,
                due_on = excluded.due_on,
                week_start = excluded.week_start,
                was_hdd_miss = excluded.was_hdd_miss,
                had_revision = excluded.had_revision,
                url = COALESCE(excluded.url, analytics_completions.url),
                recorded_at = unixepoch()
        """, (str(todo_id), str(designer_bc_id), designer_name, title, category,
              client_name, est_hours, logged_hours, hdd, due_on,
              week_start, was_hdd_miss, had_revision, url))


def update_completion_logged_hours(todo_id, designer_bc_id, logged_hours) -> bool:
    """Reconcile a historical completion's logged_hours against a fresh
    Everhour read. Returns True if the stored value actually changed."""
    with get_db() as c:
        cur = c.execute(
            "UPDATE analytics_completions SET logged_hours=? WHERE todo_id=? AND designer_bc_id=? AND logged_hours!=?",
            (logged_hours, str(todo_id), str(designer_bc_id), logged_hours))
        return cur.rowcount > 0


def update_completion_est_hours(todo_id, designer_bc_id, est_hours) -> bool:
    """Same as update_completion_logged_hours, for est_hours — the other
    field that was never fresh-refetched at completion time (see
    main.py's _fresh_est_hours) and so could equally be stale."""
    with get_db() as c:
        cur = c.execute(
            "UPDATE analytics_completions SET est_hours=? WHERE todo_id=? AND designer_bc_id=? AND (est_hours IS NULL OR est_hours!=?)",
            (est_hours, str(todo_id), str(designer_bc_id), est_hours))
        return cur.rowcount > 0


def update_completion_url(todo_id, designer_bc_id, url) -> bool:
    """Backfill a historical completion's Basecamp url — added after
    completions had already been recording without one. Only ever fills
    a NULL, never overwrites (a url doesn't change once set)."""
    with get_db() as c:
        cur = c.execute(
            "UPDATE analytics_completions SET url=? WHERE todo_id=? AND designer_bc_id=? AND url IS NULL",
            (url, str(todo_id), str(designer_bc_id)))
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
# Spotlight — each designer (and Richard, for My Stuff) can pin up to 10 of
# their own tasks to a dedicated section at the top of their page.
# ---------------------------------------------------------------------------

SPOTLIGHT_MAX = 10


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


# Standups feature (designer's daily "what I'm working on today" post) was
# removed 2026-08-20 in favor of Spotlight as the standup signal — the
# `standups` table and its migration below are left in place as inert
# history rather than dropped, but nothing in the app writes or reads it
# anymore.


def claim_at_risk_notifications(todo_ids: list, day: str) -> list:
    """Atomically filters todo_ids down to the ones not already notified
    today, and inserts them as claimed in the same breath — so a caller
    that fetches once and DMs each result can't double-send on a retry,
    even if two calls land close together."""
    with get_db() as c:
        claimed = []
        for tid in todo_ids:
            try:
                c.execute(
                    "INSERT INTO at_risk_notified (todo_id, date) VALUES (?, ?)",
                    (str(tid), day))
                claimed.append(str(tid))
            except sqlite3.IntegrityError:
                pass  # already notified today
    return claimed


def claim_richard_alerts(todo_ids: list, alert_type: str, day: str) -> list:
    """Same dedupe pattern as claim_at_risk_notifications, generalized
    across Richard's five alert conditions (spotlight_midday,
    spotlight_eod, hdd_today, past_due, needs_decision) so each gets its
    own once-per-day-per-todo claim even though the routine polling
    needs_decision runs every 15-30 minutes."""
    with get_db() as c:
        claimed = []
        for tid in todo_ids:
            try:
                c.execute(
                    "INSERT INTO richard_alert_notified (todo_id, alert_type, date) VALUES (?, ?, ?)",
                    (str(tid), alert_type, day))
                claimed.append(str(tid))
            except sqlite3.IntegrityError:
                pass  # already notified today for this alert type
    return claimed


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


def set_priority_todo_text(todo_id: int, text: str) -> dict | None:
    with get_db() as c:
        c.execute("UPDATE priority_todos SET text=? WHERE id=?", (text, todo_id))
        row = c.execute(
            "SELECT id, text, done, position, created_at, completed_at FROM priority_todos WHERE id=?",
            (todo_id,)).fetchone()
    return dict(row) if row else None


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


def add_qa_template_item(service: str, item: str) -> list:
    """Appends one item to a service's checklist — the lightweight,
    no-PIN counterpart to set_qa_template's full-list replace. Anyone
    (designer or Richard) can use this the moment they notice a gap;
    the heavier PIN-gated rewrite still exists for reorganizing or
    removing items. Silently no-ops a duplicate rather than erroring —
    whoever clicked Add just wanted the item present."""
    with get_db() as c:
        row = c.execute("SELECT items FROM qa_templates WHERE service=?", (service,)).fetchone()
        items = json.loads(row["items"]) if row else []
        if item not in items:
            items.append(item)
        c.execute(
            "INSERT OR REPLACE INTO qa_templates (service, items, updated_at) VALUES (?, ?, unixepoch())",
            (service, json.dumps(items)))
    return items


def remove_qa_template_item(service: str, item: str) -> list:
    """Removes one item by exact text — the lightweight, single-item
    counterpart to set_qa_template's full-list replace, for deleting a
    stray or no-longer-relevant item (whether Richard added it, a
    designer added it via add_qa_template_item, or it's an original
    default) without retyping the whole checklist. PIN-gated at the API
    layer, same as the full rewrite. Refuses to empty a checklist
    entirely — every service needs at least one item."""
    with get_db() as c:
        row = c.execute("SELECT items FROM qa_templates WHERE service=?", (service,)).fetchone()
        items = json.loads(row["items"]) if row else []
        if item in items and len(items) > 1:
            items.remove(item)
            c.execute(
                "INSERT OR REPLACE INTO qa_templates (service, items, updated_at) VALUES (?, ?, unixepoch())",
                (service, json.dumps(items)))
    return items


def create_qa_certificate(cert_id: str, service: str, task_title: str, client_name: str,
                           completed_by: str, items: list, notes: str, feedback: str = "",
                           person_key: str | None = None) -> dict:
    with get_db() as c:
        c.execute("""
            INSERT INTO qa_certificates (id, service, task_title, client_name, completed_by, items, notes, feedback, person_key)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (cert_id, service, task_title, client_name, completed_by, json.dumps(items), notes, feedback, person_key))
    return get_qa_certificate(cert_id)


def get_qa_certificates_for_person(person_key: str, limit: int = 50) -> list:
    """Powers "My QA History" — only certificates created after person_key
    tracking shipped will show up; older ones only have the free-typed
    completed_by name, which isn't reliable enough to match on."""
    with get_db() as c:
        rows = c.execute(
            "SELECT * FROM qa_certificates WHERE person_key=? ORDER BY created_at DESC LIMIT ?",
            (person_key, limit)
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["items"] = json.loads(d["items"])
        out.append(d)
    return out


def mark_qa_feedback_seen(cert_id: str) -> dict | None:
    with get_db() as c:
        c.execute(
            "UPDATE qa_certificates SET feedback_seen_at = unixepoch() WHERE id=?",
            (cert_id,))
    return get_qa_certificate(cert_id)


def archive_qa_feedback(cert_id: str) -> dict | None:
    # Also stamps feedback_seen_at if it's somehow still unset, so an
    # archived item can never still count toward the unseen badge.
    with get_db() as c:
        c.execute("""
            UPDATE qa_certificates
            SET archived_at = unixepoch(),
                feedback_seen_at = COALESCE(feedback_seen_at, unixepoch())
            WHERE id=?
        """, (cert_id,))
    return get_qa_certificate(cert_id)


def unarchive_qa_feedback(cert_id: str) -> dict | None:
    with get_db() as c:
        c.execute("UPDATE qa_certificates SET archived_at = NULL WHERE id=?", (cert_id,))
    return get_qa_certificate(cert_id)


def count_unseen_qa_feedback() -> int:
    with get_db() as c:
        row = c.execute(
            "SELECT COUNT(*) AS n FROM qa_certificates WHERE feedback != '' AND feedback_seen_at IS NULL"
        ).fetchone()
    return row["n"] if row else 0


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


# ---------------------------------------------------------------------------
# QA drafts — auto-saved in-progress checklists, so a refresh or closed tab
# never loses progress. One row per in-progress checklist; deleted once its
# certificate is submitted (or explicitly discarded).
# ---------------------------------------------------------------------------

def create_qa_draft(draft_id: str, person_key: str, service: str, items: list,
                     task_title: str = "", client_name: str = "", completed_by: str = "",
                     notes: str = "", feedback: str = "") -> dict:
    with get_db() as c:
        c.execute("""
            INSERT INTO qa_drafts (id, person_key, service, task_title, client_name, completed_by, items, notes, feedback)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (draft_id, person_key, service, task_title, client_name, completed_by, json.dumps(items), notes, feedback))
    return get_qa_draft(draft_id)


def update_qa_draft(draft_id: str, items: list, task_title: str = "", client_name: str = "",
                     completed_by: str = "", notes: str = "", feedback: str = "") -> dict | None:
    with get_db() as c:
        c.execute("""
            UPDATE qa_drafts
            SET items=?, task_title=?, client_name=?, completed_by=?, notes=?, feedback=?, updated_at=unixepoch()
            WHERE id=?
        """, (json.dumps(items), task_title, client_name, completed_by, notes, feedback, draft_id))
    return get_qa_draft(draft_id)


def get_qa_draft(draft_id: str) -> dict | None:
    with get_db() as c:
        row = c.execute("SELECT * FROM qa_drafts WHERE id=?", (draft_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["items"] = json.loads(d["items"])
    return d


def get_qa_drafts_for_person(person_key: str) -> list:
    with get_db() as c:
        rows = c.execute(
            "SELECT * FROM qa_drafts WHERE person_key=? ORDER BY updated_at DESC", (person_key,)
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["items"] = json.loads(d["items"])
        out.append(d)
    return out


def delete_qa_draft(draft_id: str):
    with get_db() as c:
        c.execute("DELETE FROM qa_drafts WHERE id=?", (draft_id,))


# ---------------------------------------------------------------------------
# To Delegate learning — see the category_corrections/delegation_corrections
# schema comments in init_db for the overall design. Automatic, no approval
# step (confirmed with Richard 2026-09-21).
# ---------------------------------------------------------------------------

_CATEGORY_LEARNING_STOPWORDS = {
    "assets", "needed", "write", "design", "edit", "edits", "editing",
    "create", "created", "update", "updated", "review", "adding", "page",
    "pages", "with", "from", "this", "that", "your", "team", "have", "will",
}


def _significant_words(title: str) -> set:
    words = re.findall(r"[a-z]+", (title or "").lower())
    return {w for w in words if len(w) >= 4 and w not in _CATEGORY_LEARNING_STOPWORDS}


def record_category_correction(title: str, from_category: str, to_category: str):
    """Logs the correction, then re-derives both learned lookups from the
    full history. Cheap enough to recompute from scratch every time given
    the expected data volume (a handful of corrections per category, not
    thousands of rows)."""
    if not title or from_category == to_category:
        return
    with get_db() as c:
        c.execute(
            "INSERT INTO category_corrections (title, from_category, to_category) VALUES (?, ?, ?)",
            (title, from_category, to_category))

        # Exact title — one correction is enough (see schema comment).
        c.execute(
            "INSERT OR REPLACE INTO learned_category_titles (title_normalized, category, learned_at) "
            "VALUES (?, ?, unixepoch())",
            (title.strip().lower(), to_category))

        # Word-level — only once a word agrees across 2+ distinct titles
        # corrected to the SAME category, and has never been corrected to
        # a different one (an ambiguous word is left alone).
        rows = c.execute("SELECT title, to_category FROM category_corrections").fetchall()
        word_categories = defaultdict(set)
        word_titles = defaultdict(set)
        for r in rows:
            for w in _significant_words(r["title"]):
                word_categories[w].add(r["to_category"])
                word_titles[w].add(r["title"].strip().lower())
        for w, cats in word_categories.items():
            if len(cats) != 1:
                continue
            support = len(word_titles[w])
            if support >= 2:
                c.execute(
                    "INSERT OR REPLACE INTO learned_category_keywords (keyword, category, support_count, learned_at) "
                    "VALUES (?, ?, ?, unixepoch())",
                    (w, next(iter(cats)), support))


def get_learned_category(title: str) -> str | None:
    """Exact-title memory wins; otherwise the first learned keyword found
    in the title. None means "no learned override — use the static
    categorize_todo() guess."""
    if not title:
        return None
    with get_db() as c:
        row = c.execute(
            "SELECT category FROM learned_category_titles WHERE title_normalized=?",
            (title.strip().lower(),)
        ).fetchone()
        if row:
            return row["category"]
        words = _significant_words(title)
        if not words:
            return None
        placeholders = ",".join("?" * len(words))
        row = c.execute(
            f"SELECT category FROM learned_category_keywords WHERE keyword IN ({placeholders}) LIMIT 1",
            tuple(words)
        ).fetchone()
        return row["category"] if row else None


def record_delegation_correction(todo_id: str, category: str, field: str,
                                  suggested_value, chosen_value: float):
    """Logs an EST/HDD correction and recomputes that category+field's
    learned default as the median of every chosen_value on record."""
    if suggested_value is not None and abs(float(suggested_value) - float(chosen_value)) < 1e-9:
        return  # not actually a correction
    with get_db() as c:
        c.execute(
            "INSERT INTO delegation_corrections (todo_id, category, field, suggested_value, chosen_value) "
            "VALUES (?, ?, ?, ?, ?)",
            (todo_id, category, field,
             float(suggested_value) if suggested_value is not None else None, float(chosen_value)))
        rows = c.execute(
            "SELECT chosen_value FROM delegation_corrections WHERE category=? AND field=?",
            (category, field)
        ).fetchall()
        values = [r["chosen_value"] for r in rows]
        median = statistics.median(values)
        c.execute(
            "INSERT OR REPLACE INTO learned_category_defaults (category, field, value, sample_count, updated_at) "
            "VALUES (?, ?, ?, ?, unixepoch())",
            (category, field, median, len(values)))


def get_learned_category_default(category: str, field: str, min_n: int) -> dict | None:
    """None if there isn't at least min_n corrections behind it yet — a
    couple of one-off edits shouldn't overrule the confirmed static
    default."""
    with get_db() as c:
        row = c.execute(
            "SELECT value, sample_count FROM learned_category_defaults WHERE category=? AND field=?",
            (category, field)
        ).fetchone()
    if not row or row["sample_count"] < min_n:
        return None
    return {"value": row["value"], "sample_count": row["sample_count"]}
