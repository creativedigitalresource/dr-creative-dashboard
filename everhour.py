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


async def get_time_logged(todo_id: str | int) -> dict:
    """Return logged hours and Everhour estimate for a Basecamp todo.
    Returns {
      "logged": float,          # total logged across all users
      "estimate": float | None, # total estimate across all users
      "user_estimates": dict,   # {str(eh_user_id): hours} when per-user estimates are set
      "user_logged": dict,      # {str(eh_user_id): hours} per-user logged time
    }
    """
    if not EH_KEY:
        return {"logged": 0.0, "estimate": None, "user_estimates": {}, "user_logged": {}}
    r = await get_eh_http().get(f"{EH_BASE}/tasks/b3:{todo_id}")
    if r.status_code != 200:
        return {"logged": 0.0, "estimate": None, "user_estimates": {}, "user_logged": {}}
    data = r.json()

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
        "user_estimates": user_estimates,
        "user_logged": user_logged,
    }


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
