import httpx, os, time
from store import get_token, set_token

# Single persistent client — reuses TCP connections like Node's fetch
_http: httpx.AsyncClient | None = None

def get_http() -> httpx.AsyncClient:
    global _http
    if _http is None or _http.is_closed:
        _http = httpx.AsyncClient(timeout=httpx.Timeout(10.0), follow_redirects=True)
    return _http

ACCOUNT_ID = "5471057"
BC_BASE = f"https://3.basecampapi.com/{ACCOUNT_ID}"
AUTH_BASE = "https://launchpad.37signals.com"
CLIENT_ID = os.environ.get("BC_CLIENT_ID", "0ca67e8bd32156d5da352c5c75c85d5dfd20e88c")
CLIENT_SECRET = os.environ.get("BC_CLIENT_SECRET", "2c004a1b98104f5eebb8d5c1c16c85881caa012a")
REDIRECT_URI = os.environ.get("BC_REDIRECT_URI", "http://localhost:8000/auth/callback")
USER_AGENT = "DR Creative Dashboard (richard.vargas@yourdigitalresource.com)"

# 44800196 = "Creative Team" group — todos assigned here need delegation
CREATIVE_TEAM_GROUP_ID = "44800196"
RICHARD_BC_ID = 49482127

SKIP_KEYWORDS = [
    "meeting hours", "weekly overdue", "creative sales", "goals",
    "vector files", "cowork", "🔁", "🚩 weekly", "bi-weekly",
    "maternity", "check-in", "power bi",
]


def _is_skip(title: str) -> bool:
    t = title.lower()
    return any(k in t for k in SKIP_KEYWORDS) or "🚥" in title


def auth_url() -> str:
    return (
        f"{AUTH_BASE}/authorization/new"
        f"?type=web_server"
        f"&client_id={CLIENT_ID}"
        f"&redirect_uri={REDIRECT_URI}"
    )


async def exchange_code(code: str) -> bool:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            f"{AUTH_BASE}/authorization/token",
            data={
                "type": "web_server",
                "client_id": CLIENT_ID,
                "client_secret": CLIENT_SECRET,
                "redirect_uri": REDIRECT_URI,
                "code": code,
            },
        )
        if r.status_code != 200:
            return False
        data = r.json()
        set_token("access_token", data["access_token"])
        set_token("refresh_token", data["refresh_token"])
        set_token("expires_at", str(time.time() + int(data.get("expires_in", 1209600))))
        return True


async def _refresh() -> bool:
    refresh = get_token("refresh_token")
    if not refresh:
        return False
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            f"{AUTH_BASE}/authorization/token",
            data={
                "type": "refresh",
                "client_id": CLIENT_ID,
                "client_secret": CLIENT_SECRET,
                "refresh_token": refresh,
            },
        )
        if r.status_code != 200:
            print(f"[bc] refresh failed {r.status_code}: {r.text[:200]}")
            return False
        data = r.json()
        if "access_token" not in data:
            print(f"[bc] refresh response missing access_token: {data}")
            return False
        set_token("access_token", data["access_token"])
        if "refresh_token" in data:
            set_token("refresh_token", data["refresh_token"])
        set_token("expires_at", str(time.time() + int(data.get("expires_in", 1209600))))
        return True


async def _get(path: str, params: dict | None = None) -> dict | list | None:
    token = get_token("access_token")
    if not token:
        return None

    expires_at = get_token("expires_at")
    if expires_at and float(expires_at) - time.time() < 300:
        await _refresh()
        token = get_token("access_token")

    headers = {
        "Authorization": f"Bearer {token}",
        "User-Agent": USER_AGENT,
    }
    client = get_http()
    r = await client.get(f"{BC_BASE}{path}", headers=headers, params=params or {})
    if r.status_code == 401:
        refreshed = await _refresh()
        if not refreshed:
            return None
        token = get_token("access_token")
        headers["Authorization"] = f"Bearer {token}"
        r = await client.get(f"{BC_BASE}{path}", headers=headers, params=params or {})
    if r.status_code == 429:
        import asyncio
        wait = int(r.headers.get("Retry-After", "2"))
        print(f"[bc] 429 rate limit on {path}, waiting {wait}s")
        await asyncio.sleep(wait)
        r = await client.get(f"{BC_BASE}{path}", headers=headers, params=params or {})
    if r.status_code != 200:
        print(f"[bc] {r.status_code} {path} — {r.text[:200]}")
        return None
    return r.json()


async def _get_raw_status(path: str) -> tuple[int, str]:
    token = get_token("access_token")
    if not token:
        return 0, "no token"
    headers = {"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT}
    r = await get_http().get(f"{BC_BASE}{path}", headers=headers)
    return r.status_code, r.text[:300]


async def _get_reports_assigned(person_id: str | int, page: int = 1) -> list:
    """Fetch one page of the assigned-todos report for a person/group."""
    data = await _get(f"/reports/todos/assigned/{person_id}.json", {"page": page})
    if not data:
        return []
    # Response is either a list or {"todos": [...]}
    if isinstance(data, list):
        return data
    return data.get("todos", [])


async def _get_all_reports_assigned(person_id: str | int, max_pages: int = 2) -> list:
    """Fetch up to max_pages of assigned todos for a person/group."""
    results = []
    for page in range(1, max_pages + 1):
        page_data = await _get_reports_assigned(person_id, page)
        if not page_data:
            break
        results.extend(page_data)
        if len(page_data) < 50:
            break
    return results


async def get_comments(bucket_id: str, todo_id: str) -> list:
    data = await _get(f"/buckets/{bucket_id}/recordings/{todo_id}/comments.json")
    if not data:
        return []
    if isinstance(data, list):
        return data
    return data.get("comments", [])


async def get_todo_detail(bucket_id: str, todo_id: str) -> dict | None:
    """Fetch full todo detail including steps (subtasks)."""
    return await _get(f"/buckets/{bucket_id}/todos/{todo_id}.json")


async def update_step_due(bucket_id: str, step_id: str, due_on: str) -> bool:
    """Update a step's due date in Basecamp."""
    token = get_token("access_token")
    if not token:
        return False
    headers = {
        "Authorization": f"Bearer {token}",
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
    }
    import json as _json
    r = await get_http().put(
        f"{BC_BASE}/buckets/{bucket_id}/card_tables/steps/{step_id}.json",
        headers=headers,
        content=_json.dumps({"due_on": due_on}),
    )
    return r.status_code == 200


async def get_unassigned_todos() -> list:
    """Todos assigned to the Creative Team group — these need delegation.
    Fetches page 1 only (50 most recent) to avoid timeouts on large groups."""
    todos = await _get_reports_assigned(CREATIVE_TEAM_GROUP_ID, page=1)
    result = []
    for t in todos:
        if t.get("completed"):
            continue
        if _is_skip(t.get("content", "")):
            continue
        bucket = t.get("bucket", {})
        result.append({
            "id": t["id"],
            "title": t["content"],
            "due_on": t.get("due_on"),
            "created_at": t.get("created_at", ""),
            "todolist_name": t.get("parent", {}).get("title", ""),
            "bucket_id": str(bucket.get("id", "")),
            "bucket_name": bucket.get("name", ""),
            "url": t.get("app_url", ""),
        })
    return result


async def get_designer_todos(designer_bc_id: int) -> list:
    """All incomplete todos assigned to a specific designer.
    Fetches comments with a 3-request concurrency limit to get EST/REVS
    without flooding the Basecamp API.
    """
    import asyncio
    from parsers import parse_todo_fields

    raw = await _get_all_reports_assigned(designer_bc_id)
    active = [t for t in raw
              if not t.get("completed")
              and not _is_skip(t.get("content", ""))
              and t.get("type") == "Todo"]
    if not active:
        return []

    sem = asyncio.Semaphore(3)

    async def fetch_comments_limited(t):
        bucket_id = str((t.get("bucket") or {}).get("id", ""))
        if not bucket_id:
            return []
        try:
            async with sem:
                return await get_comments(bucket_id, str(t["id"]))
        except Exception:
            return []

    all_comments = await asyncio.gather(*[fetch_comments_limited(t) for t in active])

    results = []
    for t, comments in zip(active, all_comments):
        bucket = t.get("bucket", {})
        is_subtask = t.get("parent", {}).get("type") == "Todo"
        fields = parse_todo_fields(t["content"], comments)

        # Find the active step assigned to this designer — its due_on is the HDD
        steps = t.get("steps", [])
        designer_step = next(
            (s for s in steps
             if not s.get("completed")
             and any(a.get("id") == designer_bc_id for a in s.get("assignees", []))),
            None
        )

        # HDD: title-parsed date > active step due_on > todo due_on
        hdd = fields.get("hdd") or (designer_step.get("due_on") if designer_step else None) or t.get("due_on")

        results.append({
            "id": t["id"],
            "title": t["content"],
            "due_on": t.get("due_on"),
            "hdd": hdd,
            "created_at": t.get("created_at", ""),
            "bucket_id": str(bucket.get("id", "")),
            "bucket_name": bucket.get("name", ""),
            "todolist_name": t.get("parent", {}).get("title", ""),
            "url": t.get("app_url", ""),
            "designer_step": designer_step,
            "is_subtask": is_subtask,
            "is_misc": False,
            "is_complete": False,
            **fields,
        })
    return results
