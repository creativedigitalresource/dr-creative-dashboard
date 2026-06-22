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
    Returns {"logged": float, "estimate": float | None}
    """
    if not EH_KEY:
        return {"logged": 0.0, "estimate": None}
    r = await get_eh_http().get(f"{EH_BASE}/tasks/b3:{todo_id}")
    if r.status_code != 200:
        return {"logged": 0.0, "estimate": None}
    data = r.json()
    logged = round(((data.get("time") or {}).get("total") or 0) / 3600, 2)
    estimate_obj = data.get("estimate") or {}
    estimate_secs = estimate_obj.get("total", 0) if isinstance(estimate_obj, dict) else 0
    estimate = round(estimate_secs / 3600, 2) if estimate_secs else None
    return {"logged": logged, "estimate": estimate}


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
