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


async def _build_designer(d: dict, start_dates: dict, week_start: str, week_end: str) -> dict:
    todos = await bc.get_designer_todos(d["bc_id"])
    # Fetch Everhour time for all todos concurrently
    logged_list = await asyncio.gather(*[eh.get_time_logged(t["id"]) for t in todos])
    enriched = []
    for t, logged in zip(todos, logged_list):
        total = t.get("total_hours") or 0
        progress = min(100, round((logged / total * 100) if total > 0 else 0))
        sd = start_dates.get(str(t["id"]))
        enriched.append({**t, "logged": logged, "progress": progress, "start_date": sd})

    weekly_est = sum(
        t.get("total_hours", 0)
        for t in enriched
        if t.get("hdd") and week_start <= t["hdd"] <= week_end
    )
    capacity_pct = min(100, round(weekly_est / WEEKLY_CAP * 100))
    return {
        **d,
        "todos": enriched,
        "weekly_est": round(weekly_est, 1),
        "weekly_cap": WEEKLY_CAP,
        "capacity_pct": capacity_pct,
    }


async def _refresh_all():
    today = date.today()
    week_start = (today - timedelta(days=today.weekday())).isoformat()
    week_end = (today + timedelta(days=4 - today.weekday())).isoformat()
    start_dates = store.get_all_start_dates()

    # Fetch unassigned + all designers concurrently
    results = await asyncio.gather(
        bc.get_unassigned_todos(),
        *[_build_designer(d, start_dates, week_start, week_end) for d in DESIGNERS],
        return_exceptions=True,
    )

    unassigned = results[0] if not isinstance(results[0], Exception) else []
    designers_out = [r for r in results[1:] if not isinstance(r, Exception)]

    _cached_data["unassigned"] = unassigned
    _cached_data["designers"] = designers_out
    _cached_data["last_updated"] = time.time()

    await _broadcast("update", {"ts": _cached_data["last_updated"]})


async def _poll_loop():
    while True:
        try:
            print("[poll] starting refresh...")
            await _refresh_all()
            print(f"[poll] done — {len(_cached_data.get('designers', []))} designers, {len(_cached_data.get('unassigned', []))} unassigned")
        except Exception as e:
            import traceback
            print(f"[poll] ERROR: {e}")
            traceback.print_exc()
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
    return _cached_data.get("unassigned", [])


@app.get("/api/designers")
async def api_designers():
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


@app.get("/api/test")
async def api_test():
    """Lightweight test — one API call, immediate result."""
    import sys
    token = store.get_token("access_token")
    if not token:
        return {"error": "no token — need to login first", "python": sys.version}
    # One direct call, no parsing
    status, body = await bc._get_raw_status("/reports/todos/assigned/44800252.json")
    return {
        "python": sys.version,
        "token_present": True,
        "dexter_status": status,
        "dexter_body_snippet": body[:200],
        "poll_ran": "designers" in _cached_data,
        "designer_count": len(_cached_data.get("designers", [])),
        "unassigned_count": len(_cached_data.get("unassigned", [])),
    }


@app.get("/api/debug")
async def api_debug():
    """Diagnostic endpoint — returns raw Basecamp connectivity info."""
    token_present = bool(store.get_token("access_token"))

    # Test reports endpoint for Creative Team group
    reports_status, reports_body = await bc._get_raw_status(
        f"/reports/todos/assigned/{bc.CREATIVE_TEAM_GROUP_ID}.json"
    )
    unassigned = await bc.get_unassigned_todos()

    # Test one designer
    dexter_todos = await bc.get_designer_todos(44800252)

    return {
        "token_present": token_present,
        "creative_team_reports_status": reports_status,
        "unassigned_count": len(unassigned),
        "unassigned_sample": unassigned[:3],
        "dexter_todo_count": len(dexter_todos),
        "dexter_sample": dexter_todos[:2],
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
