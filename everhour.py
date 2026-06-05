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


async def get_time_logged(todo_id: str | int) -> float:
    """Return hours logged for a Basecamp todo via Everhour."""
    if not EH_KEY:
        return 0.0
    r = await get_eh_http().get(f"{EH_BASE}/tasks/b3:{todo_id}")
    if r.status_code != 200:
        return 0.0
    data = r.json()
    total_seconds = (data.get("time") or {}).get("total") or 0
    return round(total_seconds / 3600, 2)


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
