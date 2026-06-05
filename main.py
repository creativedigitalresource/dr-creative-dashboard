import asyncio, json, os, time
from datetime import date, timedelta
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import store, basecamp as bc, everhour as eh

_cached_data: dict = {}
_sse_clients: list[asyncio.Queue] = []
_refresh_running = False

DESIGNERS = [
    {"name": "Dexter",   "bc_id": 44800252, "eh_id": 1327353,  "color": "#3b82f6"},
    {"name": "Lezly",    "bc_id": 45896266, "eh_id": 1336550,  "color": "#8b5cf6"},
    {"name": "Gaby",     "bc_id": 46567979, "eh_id": 1422085,  "color": "#f97316"},
    {"name": "Odette",   "bc_id": 48051100, "eh_id": 1403017,  "color": "#eab308"},
    {"name": "Debi",     "bc_id": 52244353, "eh_id": 1445224,  "color": "#22c55e"},
    {"name": "Maria C",  "bc_id": 52471282, "eh_id": None,     "color": "#94a3b8"},
    {"name": "Melany",   "bc_id": 46905124, "eh_id": None,     "color": "#ef4444"},
]

WEEKLY_CAP = 35.0
CACHE_TTL = 300  # 5 minutes


# ---------------------------------------------------------------------------
# Data refresh — runs once per manual trigger, not in a loop
# ---------------------------------------------------------------------------

async def _refresh_all():
    global _refresh_running
    if _refresh_running:
        print("[refresh] already running, skipping")
        return
    _refresh_running = True
    try:
        await _do_refresh()
    finally:
        _refresh_running = False


async def _do_refresh():
    today = date.today()
    week_start = (today - timedelta(days=today.weekday())).isoformat()
    week_end = (today + timedelta(days=4 - today.weekday())).isoformat()
    start_dates = store.get_all_start_dates()

    overrides = store.get_all_overrides()

    print("[refresh] fetching unassigned...")
    try:
        unassigned = await asyncio.wait_for(bc.get_unassigned_todos(), timeout=25.0)
        print(f"[refresh] unassigned: {len(unassigned)}")
    except asyncio.TimeoutError:
        print("[refresh] unassigned timed out")
        unassigned = _cached_data.get("unassigned", [])
    except Exception as e:
        print(f"[refresh] unassigned error: {type(e).__name__}: {e}")
        unassigned = _cached_data.get("unassigned", [])

    designers_out = []
    for d in DESIGNERS:
        print(f"[refresh] fetching {d['name']}...")
        try:
            todos = await asyncio.wait_for(bc.get_designer_todos(d["bc_id"]), timeout=60.0)
            # Fetch Everhour time for all todos concurrently (max 3 at once)
            eh_sem = asyncio.Semaphore(3)
            async def _eh(tid):
                async with eh_sem:
                    try:
                        return await asyncio.wait_for(eh.get_time_logged(tid), timeout=6.0)
                    except Exception:
                        return 0.0
            logged_list = await asyncio.gather(*[_eh(t["id"]) for t in todos]) if eh.EH_KEY else [0.0] * len(todos)

            enriched = []
            for t, logged in zip(todos, logged_list):
                ov = overrides.get(str(t["id"]), {})
                # Apply local overrides on top of Basecamp-parsed fields
                hdd    = ov.get("hdd")   or t.get("hdd")
                pdd    = ov.get("pdd")   or t.get("pdd")
                est    = float(ov["est"])   if "est"  in ov else t.get("est")
                revs   = float(ov["revs"])  if "revs" in ov else (t.get("revs") or 0)
                sd     = ov.get("start_date") or start_dates.get(str(t["id"]))
                # Manual logged override takes priority over Everhour
                logged = float(ov["logged"]) if "logged" in ov else logged
                total  = (est or 0) + revs
                progress = min(100, round((logged / total * 100) if total > 0 else 0))
                enriched.append({
                    **t,
                    "hdd": hdd, "pdd": pdd, "est": est, "revs": revs,
                    "total_hours": total,
                    "logged": logged, "progress": progress,
                    "start_date": sd,
                    "overrides": list(ov.keys()),
                })
            # Overdue tasks (HDD in the past) still count — they're unfinished work
            weekly_est = sum(t.get("total_hours", 0) for t in enriched
                             if t.get("hdd") and t["hdd"] <= week_end)
            capacity_pct = min(100, round(weekly_est / WEEKLY_CAP * 100))
            designers_out.append({**d, "todos": enriched,
                                   "weekly_est": round(weekly_est, 1),
                                   "weekly_cap": WEEKLY_CAP,
                                   "capacity_pct": capacity_pct})
            print(f"[refresh] {d['name']}: {len(enriched)} todos")
        except asyncio.TimeoutError:
            print(f"[refresh] {d['name']} timed out")
            designers_out.append({**d, "todos": [], "weekly_est": 0,
                                   "weekly_cap": WEEKLY_CAP, "capacity_pct": 0})
        except Exception as e:
            print(f"[refresh] {d['name']} error: {type(e).__name__}: {e}")
            designers_out.append({**d, "todos": [], "weekly_est": 0,
                                   "weekly_cap": WEEKLY_CAP, "capacity_pct": 0})

    _cached_data["unassigned"] = unassigned
    _cached_data["designers"] = designers_out
    _cached_data["last_updated"] = time.time()
    print(f"[refresh] done — {len(unassigned)} unassigned, {len(designers_out)} designers")

    msg = f"event: update\ndata: {json.dumps({'ts': _cached_data['last_updated']})}\n\n"
    dead = []
    for q in _sse_clients:
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        _sse_clients.remove(q)


def _cache_is_stale() -> bool:
    last = _cached_data.get("last_updated")
    return not last or (time.time() - last) > CACHE_TTL


# ---------------------------------------------------------------------------
# App lifecycle — no background loop
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    store.init_db()
    print("[startup] ready")
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
    return {
        "authenticated": bool(token),
        "last_updated": _cached_data.get("last_updated"),
        "refreshing": _refresh_running,
        "stale": _cache_is_stale(),
    }


@app.get("/api/unassigned")
async def api_unassigned():
    if _cache_is_stale() and not _refresh_running:
        asyncio.create_task(_refresh_all())
    return _cached_data.get("unassigned", [])


@app.get("/api/designers")
async def api_designers():
    designers = _cached_data.get("designers", [])
    pto_map = store.get_all_pto()
    # Attach PTO to each designer so client can calculate real capacity
    for d in designers:
        d["pto"] = pto_map.get(str(d["bc_id"]), [])
    return designers


@app.get("/api/pto")
async def get_pto():
    return store.get_all_pto()


@app.post("/api/pto")
async def add_pto(request: Request):
    body = await request.json()
    designer_bc_id = str(body.get("designer_bc_id", ""))
    dates = body.get("dates", [])  # list of ISO date strings
    note = body.get("note", "")
    if not designer_bc_id or not dates:
        return {"ok": False, "error": "missing fields"}
    for date in dates:
        store.add_pto(designer_bc_id, date, note)
    return {"ok": True, "added": len(dates)}


@app.delete("/api/pto/{pto_id}")
async def delete_pto(pto_id: int):
    store.delete_pto(pto_id)
    return {"ok": True}


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


@app.put("/api/todos/{todo_id}/fields")
async def set_todo_fields(todo_id: str, request: Request):
    """Save local overrides for hdd, pdd, est, revs, start_date."""
    body = await request.json()
    allowed = {"hdd", "pdd", "est", "revs", "start_date", "logged"}
    for field, value in body.items():
        if field not in allowed:
            continue
        if value is None or value == "":
            store.delete_override(todo_id, field)
        else:
            store.set_override(todo_id, field, str(value))
            if field == "start_date":
                store.set_start_date(todo_id, str(value))
    # Patch live cache so UI updates without a full refresh
    for d in _cached_data.get("designers", []):
        for t in d.get("todos", []):
            if str(t["id"]) == str(todo_id):
                ov = store.get_all_overrides().get(str(todo_id), {})
                if "hdd" in body:        t["hdd"]        = ov.get("hdd") or t.get("hdd")
                if "pdd" in body:        t["pdd"]        = ov.get("pdd") or t.get("pdd")
                if "est" in body:        t["est"]        = float(ov["est"]) if "est" in ov else t.get("est")
                if "revs" in body:       t["revs"]       = float(ov["revs"]) if "revs" in ov else t.get("revs")
                if "logged" in body:     t["logged"]     = float(ov["logged"]) if "logged" in ov else t.get("logged", 0)
                if "start_date" in body: t["start_date"] = ov.get("start_date") or t.get("start_date")
                t["total_hours"] = (t.get("est") or 0) + (t.get("revs") or 0)
                total = t["total_hours"]
                t["progress"] = min(100, round((t.get("logged",0) / total * 100) if total > 0 else 0))
                t["overrides"] = list(ov.keys())
    return {"ok": True}


@app.put("/api/todos/{todo_id}/start-date")
async def set_start_date(todo_id: str, request: Request):
    body = await request.json()
    sd = body.get("start_date", "")
    if sd:
        store.set_start_date(todo_id, sd)
        store.set_override(todo_id, "start_date", sd)
    return {"ok": True}


@app.post("/api/refresh")
async def manual_refresh():
    asyncio.create_task(_refresh_all())
    return {"ok": True, "refreshing": True}


@app.get("/api/test")
async def api_test():
    import sys
    token = store.get_token("access_token")
    if not token:
        return {"error": "no token", "python": sys.version}
    status, body = await bc._get_raw_status("/reports/todos/assigned/44800252.json")
    return {
        "python": sys.version,
        "token_present": True,
        "dexter_status": status,
        "dexter_body_snippet": body[:200],
        "data_loaded": "designers" in _cached_data,
        "designer_count": len(_cached_data.get("designers", [])),
        "unassigned_count": len(_cached_data.get("unassigned", [])),
        "refreshing": _refresh_running,
        "stale": _cache_is_stale(),
    }


# ---------------------------------------------------------------------------
# SSE — push notification when refresh completes
# ---------------------------------------------------------------------------

@app.get("/api/stream")
async def sse_stream():
    q: asyncio.Queue = asyncio.Queue(maxsize=10)
    _sse_clients.append(q)

    async def generator():
        yield f"event: init\ndata: {json.dumps({'ts': _cached_data.get('last_updated', 0), 'refreshing': _refresh_running})}\n\n"
        try:
            while True:
                msg = await asyncio.wait_for(q.get(), timeout=30)
                yield msg
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass
        finally:
            if q in _sse_clients:
                _sse_clients.remove(q)

    return StreamingResponse(generator(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------------------
# Frontend
# ---------------------------------------------------------------------------

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/", response_class=HTMLResponse)
async def root():
    with open("static/index.html") as f:
        return f.read()
