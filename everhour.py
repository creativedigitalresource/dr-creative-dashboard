import httpx, os

EH_KEY = os.environ.get("EVERHOUR_API_KEY", "")
EH_BASE = "https://api.everhour.com"

# Persistent client — same fix as basecamp.py
_eh_http: httpx.AsyncClient | None = None


def get_eh_http() -> httpx.AsyncClient:
    global _eh_http
    if _eh_http is None or _eh_http.is_closed:
        _eh_http = httpx.AsyncClient(
            timeout=httpx.Timeout(8.0),
            headers={"X-Api-Key": EH_KEY},
        )
    return _eh_http


_EMPTY_TIME_LOGGED = {"logged": 0.0, "estimate": None, "estimate_type": None, "user_estimates": {}, "user_logged": {}}


def _parse_time_logged(data: dict) -> dict:
    time_obj = data.get("time") or {}
    logged = round((time_obj.get("total") or 0) / 3600, 2)
    # Per-user logged: time.users = {str(eh_user_id): seconds}
    user_logged = {
        uid: round(secs / 3600, 2)
        for uid, secs in (time_obj.get("users") or {}).items()
        if secs
    }

    estimate_obj = data.get("estimate") or {}
    estimate_secs = estimate_obj.get("total", 0) if isinstance(estimate_obj, dict) else 0
    estimate = round(estimate_secs / 3600, 2) if estimate_secs else None
    # Per-user estimates when type == "users"
    user_estimates = {}
    if isinstance(estimate_obj, dict) and estimate_obj.get("type") == "users":
        user_estimates = {
            uid: round(secs / 3600, 2)
            for uid, secs in (estimate_obj.get("users") or {}).items()
            if secs
        }

    return {
        "logged": logged,
        "estimate": estimate,
        "estimate_type": estimate_obj.get("type") if isinstance(estimate_obj, dict) else None,
        "user_estimates": user_estimates,
        "user_logged": user_logged,
    }


async def get_time_logged(todo_id: str | int) -> dict:
    """Return logged hours and Everhour estimate for a Basecamp todo.
    Returns {
      "logged": float,          # total logged across all users
      "estimate": float | None, # total estimate across all users
      "user_estimates": dict,   # {str(eh_user_id): hours} when per-user estimates are set
      "user_logged": dict,      # {str(eh_user_id): hours} per-user logged time
    }
    Swallows errors (including rate-limiting) as empty data — fine for a
    dashboard refresh, where a transient hiccup shouldn't break the UI.
    Do NOT use this for reconciliation/backfill work that needs to tell
    'genuinely no data' apart from 'the request failed' — use
    get_time_logged_strict for that.
    """
    if not EH_KEY:
        return dict(_EMPTY_TIME_LOGGED)
    r = await get_eh_http().get(f"{EH_BASE}/tasks/b3:{todo_id}")
    if r.status_code != 200:
        return dict(_EMPTY_TIME_LOGGED)
    return _parse_time_logged(r.json())


async def get_time_logged_strict(todo_id: str | int) -> dict:
    """Same as get_time_logged, but RAISES on a non-200 response (rate limits,
    timeouts, etc.) instead of silently returning empty data — so a caller
    doing bulk reconciliation can retry/back off instead of mistaking
    'Everhour said no' for '429, try again.'"""
    if not EH_KEY:
        return dict(_EMPTY_TIME_LOGGED)
    r = await get_eh_http().get(f"{EH_BASE}/tasks/b3:{todo_id}")
    if r.status_code != 200:
        raise RuntimeError(f"Everhour {r.status_code} for task b3:{todo_id}: {r.text[:200]}")
    return _parse_time_logged(r.json())


async def set_user_estimate(todo_id: str | int, eh_user_id: int, hours: float) -> bool:
    """Set per-user Everhour estimate on a Basecamp todo."""
    if not EH_KEY or not eh_user_id:
        return False
    seconds = int(hours * 3600)
    r = await get_eh_http().put(
        f"{EH_BASE}/tasks/b3:{todo_id}/estimate",
        json={"type": "users", "users": {str(eh_user_id): seconds}},
    )
    return r.status_code == 200


async def get_user_time_records(everhour_user_id: int, from_date: str, to_date: str) -> list:
    """All of a user's time records in a range, paged. Each record has
    time (seconds), date, and task {id, name}."""
    if not EH_KEY or not everhour_user_id:
        return []
    out, page = [], 1
    while True:
        r = await get_eh_http().get(
            f"{EH_BASE}/users/{everhour_user_id}/time",
            params={"from": from_date, "to": to_date, "limit": 1000, "page": page},
            timeout=30.0,
        )
        if r.status_code != 200:
            break
        batch = r.json()
        if not isinstance(batch, list) or not batch:
            break
        out.extend(batch)
        if len(batch) < 1000:
            break
        page += 1
    return out


async def get_user_weekly_logged(everhour_user_id: int, from_date: str, to_date: str) -> float:
    """Return total hours logged by a user in a date range."""
    if not EH_KEY or not everhour_user_id:
        return 0.0
    r = await get_eh_http().get(
        f"{EH_BASE}/users/{everhour_user_id}/time",
        params={"from": from_date, "to": to_date},
    )
    if r.status_code != 200:
        return 0.0
    records = r.json() if isinstance(r.json(), list) else []
    return round(sum(rec.get("time", 0) for rec in records) / 3600, 2)
