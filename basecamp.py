import httpx, os, time
from store import get_token, set_token

ACCOUNT_ID = "5471057"
BC_BASE = f"https://3.basecampapi.com/{ACCOUNT_ID}"
AUTH_BASE = "https://launchpad.37signals.com"
CLIENT_ID = os.environ.get("BC_CLIENT_ID", "0ca67e8bd32156d5da352c5c75c85d5dfd20e88c")
CLIENT_SECRET = os.environ.get("BC_CLIENT_SECRET", "2c004a1b98104f5eebb8d5c1c16c85881caa012a")
REDIRECT_URI = os.environ.get("BC_REDIRECT_URI", "http://localhost:8000/auth/callback")
USER_AGENT = "DR Creative Dashboard (richard.vargas@yourdigitalresource.com)"

CREATIVE_BUCKET_ID = "44800196"
IPM_BUCKET_ID = "45215277"
RICHARD_BC_ID = 49482127

# Everhour uses b3:{todo_id} format
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
    async with httpx.AsyncClient() as client:
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
        expires_at = str(time.time() + int(data.get("expires_in", 1209600)))
        set_token("expires_at", expires_at)
        return True


async def _refresh() -> bool:
    refresh = get_token("refresh_token")
    if not refresh:
        return False
    async with httpx.AsyncClient() as client:
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
            return False
        data = r.json()
        set_token("access_token", data["access_token"])
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
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(f"{BC_BASE}{path}", headers=headers, params=params or {})
        if r.status_code == 401:
            refreshed = await _refresh()
            if not refreshed:
                return None
            token = get_token("access_token")
            headers["Authorization"] = f"Bearer {token}"
            r = await client.get(f"{BC_BASE}{path}", headers=headers, params=params or {})
        if r.status_code != 200:
            print(f"[bc] {r.status_code} {path} — {r.text[:200]}")
            return None
        return r.json()


async def _get_raw_status(path: str) -> tuple[int, str]:
    """For debugging — returns (status_code, body_snippet)."""
    token = get_token("access_token")
    if not token:
        return 0, "no token"
    headers = {"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT}
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{BC_BASE}{path}", headers=headers)
        return r.status_code, r.text[:300]


async def _get_all_pages(path: str) -> list:
    """Fetch all pages from a paginated endpoint."""
    results = []
    page = 1
    while True:
        data = await _get(path, {"page": page, "per_page": 100})
        if not data:
            break
        if isinstance(data, list):
            results.extend(data)
            if len(data) < 100:
                break
        else:
            break
        page += 1
    return results


async def get_comments(bucket_id: str, todo_id: str) -> list:
    data = await _get_all_pages(f"/buckets/{bucket_id}/recordings/{todo_id}/comments.json")
    return data or []


async def _get_todos_in_todolist(bucket_id: str, todolist_id: str) -> list:
    return await _get_all_pages(
        f"/buckets/{bucket_id}/todolists/{todolist_id}/todos.json"
    )


async def _get_todolists_in_bucket(bucket_id: str) -> list:
    """Get the todoset for a bucket, then all todolists."""
    project = await _get(f"/projects/{bucket_id}.json")
    if not project:
        return []
    todoset_url = None
    for dock_item in project.get("dock", []):
        if dock_item.get("name") == "todoset":
            todoset_url = dock_item.get("url", "")
            break
    if not todoset_url:
        return []
    path = todoset_url.replace(BC_BASE, "")
    todoset = await _get(path)
    if not todoset:
        return []
    todolists_url = todoset.get("todolists_url", "")
    if not todolists_url:
        return []
    path2 = todolists_url.replace(BC_BASE, "")
    return await _get_all_pages(path2)


async def get_unassigned_todos() -> list:
    """
    Todos in the Creative bucket that are incomplete and unassigned
    (or only assigned to Richard — meaning not yet delegated to a designer).
    """
    designer_ids = {44800252, 45896266, 46567979, 48051100, 52244353, 52471282, 46905124}

    todolists = await _get_todolists_in_bucket(CREATIVE_BUCKET_ID)
    result = []

    for tl in todolists:
        tl_id = str(tl["id"])
        todos = await _get_todos_in_todolist(CREATIVE_BUCKET_ID, tl_id)
        for t in todos:
            if t.get("completed"):
                continue
            if _is_skip(t.get("content", "")):
                continue
            assignee_ids = {a["id"] for a in t.get("assignees", [])}
            # Include if no assignees, or only Richard is assigned
            if not assignee_ids or assignee_ids == {RICHARD_BC_ID}:
                result.append({
                    "id": t["id"],
                    "title": t["content"],
                    "due_on": t.get("due_on"),
                    "todolist_name": tl.get("title", ""),
                    "bucket_id": CREATIVE_BUCKET_ID,
                    "url": t.get("app_url", ""),
                })

    return result


async def get_designer_todos(designer_bc_id: int) -> list:
    """All incomplete todos assigned to a specific designer across both buckets."""
    from parsers import parse_todo_fields, strip_html

    results = []
    for bucket_id in [CREATIVE_BUCKET_ID, IPM_BUCKET_ID]:
        todolists = await _get_todolists_in_bucket(bucket_id)
        for tl in todolists:
            tl_id = str(tl["id"])
            todos = await _get_todos_in_todolist(bucket_id, tl_id)
            for t in todos:
                if t.get("completed"):
                    continue
                if _is_skip(t.get("content", "")):
                    continue
                assignee_ids = {a["id"] for a in t.get("assignees", [])}
                if designer_bc_id not in assignee_ids:
                    continue

                comments = await get_comments(bucket_id, str(t["id"]))
                fields = parse_todo_fields(t["content"], comments)

                results.append({
                    "id": t["id"],
                    "title": t["content"],
                    "due_on": t.get("due_on"),
                    "bucket_id": bucket_id,
                    "todolist_name": tl.get("title", ""),
                    "url": t.get("app_url", ""),
                    **fields,
                })

    return results
