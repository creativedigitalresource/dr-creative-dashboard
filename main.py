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
    {"name": "Maria C",  "bc_id": 52471282, "eh_id": 1451054,  "color": "#14b8a6"},
    {"name": "Melany",   "bc_id": 46905124, "eh_id": None,     "color": "#ef4444"},
]

WEEKLY_CAP = 32.5  # 6.5h/day × 5 days (1.5h/day reserved for misc/admin)
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
                        return {"logged": 0.0, "estimate": None}
            eh_data_list = await asyncio.gather(*[_eh(t["id"]) for t in todos]) if eh.EH_KEY else [{"logged": 0.0, "estimate": None}] * len(todos)

            enriched = []
            for t, eh_data in zip(todos, eh_data_list):
                ov = overrides.get(str(t["id"]), {})
                # Apply local overrides on top of Basecamp-parsed fields
                hdd    = ov.get("hdd")   or t.get("hdd")
                pdd    = ov.get("pdd")   or t.get("pdd")
                revs   = float(ov["revs"]) if "revs" in ov else (t.get("revs") or 0)

                # EST: manual override > per-user Everhour estimate > total estimate > title-parsed
                eh_uid = str(d.get("eh_id") or "")
                user_est = eh_data.get("user_estimates", {}).get(eh_uid) if eh_uid else None
                eh_est = user_est if user_est is not None else eh_data.get("estimate")
                est = float(ov["est"]) if "est" in ov else (eh_est or t.get("est"))

                # Logged: manual override > per-user Everhour logged > total logged
                user_log = eh_data.get("user_logged", {}).get(eh_uid) if eh_uid else None
                logged = float(ov["logged"]) if "logged" in ov else (user_log if user_log is not None else eh_data.get("logged", 0.0))

                total = (est or 0) + revs
                over_by = round(max(0, logged - total), 2) if total > 0 else 0

                # Progress: 100% if designer's step is complete, else hours-based
                designer_step = t.get("designer_step")
                step_complete = designer_step.get("completed", False) if designer_step else False
                if step_complete:
                    progress = 100
                else:
                    progress = min(100, round((logged / total * 100) if total > 0 else 0))

                # Use step due_on as HDD if available
                step_due = designer_step.get("due_on") if designer_step else None
                effective_hdd = hdd or step_due

                enriched.append({
                    **t,
                    "hdd": effective_hdd, "pdd": pdd, "est": est, "revs": revs,
                    "total_hours": total,
                    "logged": logged, "progress": progress,
                    "over_by": over_by,
                    "is_misc": t.get("is_misc", False),
                    "is_complete": t.get("is_complete", False),
                    "overrides": list(ov.keys()),
                })
            # Weekly est: sum tasks due within this week
            weekly_est = sum(t.get("total_hours", 0) for t in enriched
                             if t.get("hdd") and t["hdd"] <= week_end
                             and not t.get("is_complete")
                             and not t.get("is_misc"))
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

    # Sort by due_on asc — oldest date first, undated items last
    for d in designers_out:
        d["todos"].sort(key=lambda t: t.get("due_on") or "9999-99-99")
    unassigned.sort(key=lambda t: t.get("created_at") or "")

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
    """Update todo fields — HDD writes to Basecamp step, EST writes to Everhour."""
    body = await request.json()
    allowed = {"hdd", "est", "due_on", "logged"}

    # Find the todo and its designer in the cache
    cached_todo = None
    cached_designer = None
    for d in _cached_data.get("designers", []):
        for t in d.get("todos", []):
            if str(t["id"]) == str(todo_id):
                cached_todo = t
                cached_designer = d
                break

    for field, value in body.items():
        if field not in allowed:
            continue

        if field == "hdd" and value:
            # Write to Basecamp step due_on
            designer_step = cached_todo.get("designer_step") if cached_todo else None
            bucket_id = cached_todo.get("bucket_id") if cached_todo else None
            if designer_step and bucket_id:
                step_id = str(designer_step["id"])
                await bc.update_step_due(bucket_id, step_id, str(value))
            # Also save locally as fallback
            store.set_override(todo_id, field, str(value))

        elif field == "due_on" and value:
            # Write due_on directly to Basecamp todo (content required by BC API)
            bucket_id = cached_todo.get("bucket_id") if cached_todo else None
            title = cached_todo.get("title", "") if cached_todo else ""
            if bucket_id:
                await bc.update_todo_due(bucket_id, todo_id, str(value), title)
            # Update cache and re-sort this designer's list
            if cached_todo:
                cached_todo["due_on"] = str(value)
            if cached_designer:
                cached_designer["todos"].sort(key=lambda t: t.get("due_on") or "9999-99-99")

        elif field == "est" and value is not None and value != "":
            # Write to Everhour estimate for this designer
            eh_id = cached_designer.get("eh_id") if cached_designer else None
            if eh_id:
                await eh.set_user_estimate(todo_id, eh_id, float(value))
            store.set_override(todo_id, field, str(value))

        elif value is None or value == "":
            store.delete_override(todo_id, field)
        else:
            store.set_override(todo_id, field, str(value))
            if field == "start_date":
                store.set_start_date(todo_id, str(value))

    # Patch live cache so UI updates without a full refresh
    if cached_todo:
        ov = store.get_all_overrides().get(str(todo_id), {})
        if "hdd" in body:          cached_todo["hdd"]          = body["hdd"] or cached_todo.get("hdd")
        if "est" in body:          cached_todo["est"]          = float(body["est"]) if body.get("est") else cached_todo.get("est")
        if "logged" in body:       cached_todo["logged"]       = float(body["logged"]) if body.get("logged") else cached_todo.get("logged", 0)
        total = cached_todo.get("est") or 0
        designer_step = cached_todo.get("designer_step")
        step_complete = designer_step.get("completed", False) if designer_step else False
        cached_todo["total_hours"] = total
        cached_todo["progress"] = 100 if step_complete else min(100, round((cached_todo.get("logged", 0) / total * 100) if total > 0 else 0))
        cached_todo["overrides"] = list(ov.keys())

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
    try:
        parsed = await bc._get("/reports/todos/assigned/44800252.json")
        if parsed is None:
            top_keys = ["_get returned None"]
            todos_count = 0
            first_todo_title = "n/a"
            first_todo_keys = []
        else:
            top_keys = list(parsed.keys()) if isinstance(parsed, dict) else ["array"]
            todos_list = parsed.get("todos", parsed) if isinstance(parsed, dict) else parsed
            todos_count = len(todos_list) if isinstance(todos_list, list) else str(type(todos_list))
            first_todo = todos_list[0] if isinstance(todos_list, list) and todos_list else {}
            first_todo_title = first_todo.get("content", first_todo.get("title", "n/a"))
            first_todo_keys = list(first_todo.keys()) if first_todo else []
    except Exception as e:
        top_keys = [f"error: {e}"]
        todos_count = 0
        first_todo_title = "n/a"
        first_todo_keys = []
    return {
        "python": sys.version,
        "token_present": True,
        "response_top_keys": top_keys,
        "todos_in_response": todos_count,
        "first_todo_keys": first_todo_keys,
        "first_todo_title": first_todo_title,
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
