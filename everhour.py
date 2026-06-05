import httpx, os

EH_KEY = os.environ.get("EVERHOUR_API_KEY", "")
EH_BASE = "https://api.everhour.com"


async def get_time_logged(todo_id: str | int) -> float:
    """Return hours logged for a Basecamp todo via Everhour."""
    if not EH_KEY:
        return 0.0
    task_ref = f"b3:{todo_id}"
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            f"{EH_BASE}/tasks/{task_ref}",
            headers={"X-Api-Key": EH_KEY},
        )
        if r.status_code != 200:
            return 0.0
        data = r.json()
        total_seconds = (data.get("time") or {}).get("total") or 0
        return round(total_seconds / 3600, 2)


async def get_user_weekly_logged(everhour_user_id: int, from_date: str, to_date: str) -> float:
    """Return total hours logged by a user in a date range."""
    if not EH_KEY or not everhour_user_id:
        return 0.0
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{EH_BASE}/users/{everhour_user_id}/time",
            headers={"X-Api-Key": EH_KEY},
            params={"from": from_date, "to": to_date},
        )
        if r.status_code != 200:
            return 0.0
        records = r.json() if isinstance(r.json(), list) else []
        return round(sum(rec.get("time", 0) for rec in records) / 3600, 2)
