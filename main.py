import asyncio, json, os, time
from collections import Counter
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


_REVISION_KEYWORDS = ["round 2", "round2", " r2 ", "revision", "revisions", "re-do", "redo"]


def _week_start(d: date = None) -> str:
    d = d or date.today()
    return (d - timedelta(days=d.weekday())).isoformat()


def _is_revision(title: str, step_title: str = "") -> bool:
    t = (title + " " + step_title).lower()
    return any(k in t for k in _REVISION_KEYWORDS)


def _record_analytics(designers_out: list, unassigned: list, refresh_ts: float):
    today = date.today()
    week = _week_start(today)
    today_str = today.isoformat()

    # Upsert active todo state and build current ID set
    current_ids: set = set()
    for d in designers_out:
        bc_id = str(d["bc_id"])
        for t in d.get("todos", []):
            tid = str(t["id"])
            current_ids.add((tid, bc_id))
            step = t.get("designer_step") or {}
            store.upsert_todo_tracking(
                todo_id=tid,
                designer_bc_id=bc_id,
                designer_name=d["name"],
                title=t.get("title", ""),
                category=t.get("category", "Misc."),
                client_name=t.get("bucket_name", ""),
                est_hours=t.get("est"),
                logged_hours=t.get("logged", 0),
                hdd=t.get("hdd"),
                due_on=t.get("due_on"),
                had_revision=1 if _is_revision(t.get("title", ""), step.get("title", "")) else 0,
                ts=refresh_ts,
            )

    # Detect completions — tracked todos that didn't appear in this refresh
    for key, row in store.get_all_todo_tracking().items():
        if key not in current_ids:
            hdd = row.get("hdd")
            store.record_completion(
                todo_id=row["todo_id"],
                designer_bc_id=row["designer_bc_id"],
                designer_name=row["designer_name"],
                title=row["title"],
                category=row["category"],
                client_name=row["client_name"],
                est_hours=row.get("est_hours"),
                logged_hours=row.get("logged_hours", 0),
                hdd=hdd,
                due_on=row.get("due_on"),
                week_start=week,
                was_hdd_miss=1 if (hdd and hdd < today_str) else 0,
                had_revision=row.get("had_revision", 0),
            )
            store.delete_todo_tracking(row["todo_id"], row["designer_bc_id"])
            print(f"[analytics] completion recorded: {row['designer_name']} — {row['title'][:50]}")

    # Weekly snapshots and category volumes
    for d in designers_out:
        store.record_weekly_snapshot(
            designer_bc_id=str(d["bc_id"]),
            designer_name=d["name"],
            week_start=week,
            weekly_est=d.get("weekly_est", 0),
            weekly_cap=d.get("weekly_cap", WEEKLY_CAP),
            capacity_pct=d.get("capacity_pct", 0),
            active_todo_count=len(d.get("todos", [])),
        )
        counts = Counter(t.get("category", "Misc.") for t in d.get("todos", []))
        for cat, cnt in counts.items():
            store.record_category_volume(
                designer_bc_id=str(d["bc_id"]),
                designer_name=d["name"],
                week_start=week,
                category=cat,
                task_count=cnt,
            )

    # Unassigned queue tracking
    current_queue_ids = {str(t["id"]) for t in unassigned}
    for todo_id, row in store.get_all_queue_tracking().items():
        if todo_id not in current_queue_ids:
            store.record_queue_exit(todo_id, row["title"], row["client_name"],
                                    row["first_seen_at"], row["last_seen_at"])
            store.delete_queue_tracking(todo_id)
    for t in unassigned:
        store.upsert_queue_tracking(
            todo_id=str(t["id"]),
            title=t.get("title", ""),
            client_name=t.get("bucket_name", ""),
            ts=refresh_ts,
        )


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
                # Step due_on is authoritative — always wins over SQLite overrides and comment-parsed HDD
                designer_step = t.get("designer_step")
                step_due = designer_step.get("due_on") if designer_step else None
                # Priority: step due_on → manual override → comment/title HDD → todo due_on
                hdd    = step_due or ov.get("hdd") or t.get("hdd")
                pdd    = ov.get("pdd")   or t.get("pdd")
                # EST priority: manual override > Everhour estimate > comment/title-parsed
                # Uses explicit None check so a 0.0 Everhour estimate doesn't fall through
                eh_uid = str(d.get("eh_id") or "")
                user_est = eh_data.get("user_estimates", {}).get(eh_uid) if eh_uid else None
                eh_est = user_est if user_est is not None else eh_data.get("estimate")
                est = float(ov["est"]) if "est" in ov else (eh_est if eh_est is not None else t.get("est"))

                # Logged: manual override > per-user Everhour logged > total logged
                user_log = eh_data.get("user_logged", {}).get(eh_uid) if eh_uid else None
                logged = float(ov["logged"]) if "logged" in ov else (user_log if user_log is not None else eh_data.get("logged", 0.0))

                revs = 0
                # true_est: manual corrected estimate for capacity math only —
                # never written to Everhour, so EST-vs-actual analytics stay honest
                true_est = float(ov["true_est"]) if "true_est" in ov else None
                eff_est = true_est if true_est is not None else (est or 0)
                # Floor: an estimated task's footprint is never less than hours already logged
                total = max(eff_est, logged) if eff_est > 0 else 0
                over_by = round(max(0, logged - eff_est), 2) if eff_est > 0 else 0

                # Progress: 100% if designer's step is complete, else hours-based
                step_complete = designer_step.get("completed", False) if designer_step else False
                if step_complete:
                    progress = 100
                else:
                    progress = min(100, round((logged / total * 100) if total > 0 else 0))

                # has_hdd: True only when HDD comes from a real source (step, override, comment)
                has_hdd = bool(step_due or ov.get("hdd"))
                # Category: manual override > auto-detected
                category = ov.get("category") or t.get("category", "Misc.")

                enriched.append({
                    **t,
                    "hdd": hdd, "pdd": pdd, "est": est, "true_est": true_est, "revs": revs,
                    "total_hours": total,
                    "logged": logged, "progress": progress,
                    "over_by": over_by,
                    "has_hdd": has_hdd,
                    "category": category,
                    "is_misc": t.get("is_misc", False),
                    "is_complete": t.get("is_complete", False),
                    "overrides": list(ov.keys()),
                })
            # Weekly est: sum tasks due within this week
            weekly_est = sum(
                max(0, t.get("total_hours", 0) - t.get("logged", 0))
                for t in enriched
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

    def _is_dr_internal(bucket_name: str) -> bool:
        bn = (bucket_name or "").lower()
        return "digital resource" in bn or "dr team" in bn

    # Sort: client work first → due_on → has_hdd → hdd value
    for d in designers_out:
        d["todos"].sort(key=lambda t: (
            1 if _is_dr_internal(t.get("bucket_name", "")) else 0,
            t.get("due_on") or "9999-99-99",
            0 if t.get("has_hdd") else 1,
            t.get("hdd") or "9999-99-99"
        ))
    unassigned.sort(key=lambda t: t.get("created_at") or "")

    refresh_ts = time.time()
    try:
        _record_analytics(designers_out, unassigned, refresh_ts)
    except Exception as e:
        print(f"[analytics] error: {type(e).__name__}: {e}")

    _cached_data["unassigned"] = unassigned
    _cached_data["designers"] = designers_out
    _cached_data["last_updated"] = refresh_ts
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
    allowed = {"hdd", "est", "true_est", "due_on", "logged", "category"}

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
                await bc.update_step_due(bucket_id, step_id, str(value), step=designer_step)
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
                cached_designer["todos"].sort(key=lambda t: (
                t.get("due_on") or "9999-99-99",
                0 if t.get("has_hdd") else 1,
                t.get("hdd") or "9999-99-99"
            ))

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
        if "true_est" in body:     cached_todo["true_est"]     = float(body["true_est"]) if body.get("true_est") else None
        if "logged" in body:       cached_todo["logged"]       = float(body["logged"]) if body.get("logged") else cached_todo.get("logged", 0)
        true_est = cached_todo.get("true_est")
        eff_est = true_est if true_est is not None else (cached_todo.get("est") or 0)
        logged = cached_todo.get("logged", 0) or 0
        total = max(eff_est, logged) if eff_est > 0 else 0
        designer_step = cached_todo.get("designer_step")
        step_complete = designer_step.get("completed", False) if designer_step else False
        cached_todo["total_hours"] = total
        cached_todo["over_by"] = round(max(0, logged - eff_est), 2) if eff_est > 0 else 0
        cached_todo["progress"] = 100 if step_complete else min(100, round((logged / total * 100) if total > 0 else 0))
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


@app.get("/api/analytics")
async def api_analytics():
    return {
        "completions":       store.get_analytics_completions(),
        "weekly_snapshots":  store.get_analytics_weekly_snapshots(),
        "queue_time":        store.get_analytics_queue_time(),
        "category_volume":   store.get_analytics_category_volume(),
    }


@app.get("/api/test")
async def api_test():
    return {
        "authenticated": bool(store.get_token("access_token")),
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
