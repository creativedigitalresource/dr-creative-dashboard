import asyncio, json, os, time
from datetime import date, timedelta
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import store, basecamp as bc, everhour as eh

# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------

_sse_clients: list[asyncio.Queue] = []
_cached_data: dict = {}


async def _broadcast(event: str, data: dict):
    msg = f"event: {event}\ndata: {json.dumps(data)}\n\n"
    dead = []
    for q in _sse_clients:
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        _sse_clients.remove(q)


DESIGNERS = [
    {"name": "Dexter",   "bc_id": 44800252, "eh_id": 1327353,  "color": "#3b82f6"},
    {"name": "Lezly",    "bc_id": 45896266, "eh_id": 1336550,  "color": "#8b5cf6"},
    {"name": "Gaby",     "bc_id": 46567979, "eh_id": 1422085,  "color": "#f97316"},
    {"name": "Odette",   "bc_id": 48051100, "eh_id": 1403017,  "color": "#eab308"},
    {"name": "Debi",     "bc_id": 52244353, "eh_id": 1445224,  "color": "#22c55e"},
    {"name": "Maria C",  "bc_id": 52471282, "eh_id": None,     "color": "#94a3b8"},
    {"name": "Melany",   "bc_id": 46905124, "eh_id": None,     "color": "#ef4444"},
]

DAILY_CAP = 7.0
WEEKLY_CAP = DAILY_CAP * 5  # 35h


async def _refresh_all():
    today = date.today()
    week_start = (today - timedelta(days=today.weekday())).isoformat()
    week_end = (today + timedelta(days=4 - today.weekday())).isoformat()
    start_dates = store.get_all_start_dates()

    # Unassigned todos
    unassigned = await bc.get_unassigned_todos()
    _cached_data["unassigned"] = unassigned

    # Designer data
    designers_out = []
    for d in DESIGNERS:
        todos = await bc.get_designer_todos(d["bc_id"])

        # Attach logged hours + start dates
        enriched = []
        for t in todos:
            logged = await eh.get_time_logged(t["id"])
            total = t.get("total_hours") or 0
            progress = min(100, round((logged / total * 100) if total > 0 else 0))
            sd = start_dates.get(str(t["id"]))
            enriched.append({**t, "logged": logged, "progress": progress, "start_date": sd})

        # Weekly capacity: sum EST hours for todos whose HDD falls this week
        weekly_est = sum(
            t.get("total_hours", 0)
            for t in enriched
            if t.get("hdd") and week_start <= t["hdd"] <= week_end
        )
        capacity_pct = min(100, round(weekly_est / WEEKLY_CAP * 100))

        designers_out.append({
            **d,
            "todos": enriched,
            "weekly_est": round(weekly_est, 1),
            "weekly_cap": WEEKLY_CAP,
            "capacity_pct": capacity_pct,
        })

    _cached_data["designers"] = designers_out
    _cached_data["last_updated"] = time.time()

    await _broadcast("update", {"ts": _cached_data["last_updated"]})


async def _poll_loop():
    while True:
        try:
            await _refresh_all()
        except Exception as e:
            print(f"[poll] error: {e}")
        await asyncio.sleep(int(os.environ.get("POLL_INTERVAL", 60)))


@asynccontextmanager
async def lifespan(app: FastAPI):
    store.init_db()
    asyncio.create_task(_poll_loop())
    yield


app = FastAPI(lifespan=lifespan)

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@app.get("/auth/login")
async def auth_login():
    return RedirectResponse(bc.auth_url())


@app.get("/auth/callback")
async def auth_callback(code: str):
    ok = await bc.exchange_code(code)
    if not ok:
        return HTMLResponse("<h2>Auth failed. Try again.</h2>", status_code=400)
    asyncio.create_task(_refresh_all())
    return RedirectResponse("/")


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

@app.get("/api/status")
async def api_status():
    token = store.get_token("access_token")
    return {"authenticated": bool(token), "last_updated": _cached_data.get("last_updated")}


@app.get("/api/unassigned")
async def api_unassigned():
    if "unassigned" not in _cached_data:
        await _refresh_all()
    return _cached_data.get("unassigned", [])


@app.get("/api/designers")
async def api_designers():
    if "designers" not in _cached_data:
        await _refresh_all()
    return _cached_data.get("designers", [])


@app.get("/api/calendar")
async def api_calendar():
    start_dates = store.get_all_start_dates()
    events = []
    for d in _cached_data.get("designers", []):
        for t in d.get("todos", []):
            sd = t.get("start_date") or start_dates.get(str(t["id"]))
            hdd = t.get("hdd")
            if not sd or not hdd:
                continue
            events.append({
                "id": str(t["id"]),
                "title": f"{d['name']}: {t['title'][:40]}",
                "start": sd,
                "end": hdd,
                "backgroundColor": d["color"],
                "borderColor": d["color"],
                "extendedProps": {
                    "designer": d["name"],
                    "est": t.get("est"),
                    "revs": t.get("revs"),
                    "logged": t.get("logged"),
                    "progress": t.get("progress"),
                    "url": t.get("url"),
                },
            })
    return events


@app.put("/api/todos/{todo_id}/start-date")
async def set_start_date(todo_id: str, request: Request):
    body = await request.json()
    sd = body.get("start_date", "")
    if sd:
        store.set_start_date(todo_id, sd)
    return {"ok": True}


@app.post("/api/refresh")
async def manual_refresh():
    asyncio.create_task(_refresh_all())
    return {"ok": True}


@app.get("/api/debug")
async def api_debug():
    """Diagnostic endpoint — returns raw Basecamp data to check connectivity."""
    token_present = bool(store.get_token("access_token"))

    # Check raw status on the project endpoint
    proj_status, proj_body = await bc._get_raw_status(f"/projects/{bc.CREATIVE_BUCKET_ID}.json")

    # Also try listing all projects (first page) to confirm token works
    all_projects = await bc._get("/projects.json")
    project_names = [p.get("name") for p in (all_projects or [])[:10]] if isinstance(all_projects, list) else []

    # Try the project fetch
    project = await bc._get(f"/projects/{bc.CREATIVE_BUCKET_ID}.json")
    dock_names = [d.get("name") for d in (project or {}).get("dock", [])] if project else []

    # Get todolists
    todolists = await bc._get_todolists_in_bucket(bc.CREATIVE_BUCKET_ID)
    tl_sample = [{"id": t["id"], "title": t.get("title")} for t in (todolists or [])[:5]]

    # First todolist todos
    todos_sample = []
    if todolists:
        todos = await bc._get_todos_in_todolist(bc.CREATIVE_BUCKET_ID, str(todolists[0]["id"]))
        todos_sample = [
            {"id": t["id"], "content": t["content"][:60], "assignees": [a["id"] for a in t.get("assignees", [])]}
            for t in (todos or [])[:5]
        ]

    return {
        "token_present": token_present,
        "project_endpoint_status": proj_status,
        "project_endpoint_body": proj_body,
        "accessible_projects": project_names,
        "project_found": bool(project),
        "project_name": (project or {}).get("name"),
        "dock_names": dock_names,
        "todolist_count": len(todolists or []),
        "todolist_sample": tl_sample,
        "first_todolist_todos_sample": todos_sample,
    }


# ---------------------------------------------------------------------------
# SSE
# ---------------------------------------------------------------------------

@app.get("/api/stream")
async def sse_stream():
    q: asyncio.Queue = asyncio.Queue(maxsize=20)
    _sse_clients.append(q)

    async def generator():
        # Send current state immediately on connect
        yield f"event: init\ndata: {json.dumps({'ts': _cached_data.get('last_updated', 0)})}\n\n"
        try:
            while True:
                msg = await asyncio.wait_for(q.get(), timeout=30)
                yield msg
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass
        finally:
            if q in _sse_clients:
                _sse_clients.remove(q)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Serve frontend
# ---------------------------------------------------------------------------

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/", response_class=HTMLResponse)
async def root():
    with open("static/index.html") as f:
        return f.read()
