import asyncio, json, os, time
from collections import Counter
from datetime import date, timedelta
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import store, basecamp as bc, everhour as eh

_cached_data: dict = {}
_sse_clients: list[asyncio.Queue] = []
_refresh_running = False

DESIGNERS = [
    {"name": "Dexter",   "bc_id": 44800252, "eh_id": 1327353,  "color": "#3b82f6", "slack_id": "U01S46XJU8G"},
    {"name": "Lezly",    "bc_id": 45896266, "eh_id": 1336550,  "color": "#8b5cf6", "slack_id": "U070TFVNNSK"},
    {"name": "Gaby",     "bc_id": 46567979, "eh_id": 1422085,  "color": "#f97316", "slack_id": "U07JJEF0KCY"},
    {"name": "Odette",   "bc_id": 48051100, "eh_id": 1403017,  "color": "#eab308", "slack_id": "U08LAH3CA12"},
    {"name": "Debi",     "bc_id": 52244353, "eh_id": 1445224,  "color": "#22c55e", "slack_id": "U0B0JNXGTKQ"},
    {"name": "Maria C",  "bc_id": 52471282, "eh_id": 1451054,  "color": "#14b8a6", "slack_id": "U0B7JK64NT1"},
    {"name": "Melany",   "bc_id": 46905124, "eh_id": 1367774,  "color": "#ef4444", "slack_id": "U07RXRYNEMQ"},
]

WEEKLY_CAP = 32.5  # 6.5h/day × 5 days (1.5h/day reserved for misc/admin)
WORK_HOURS = 6.5
STALE_HDD_DAYS = 14  # comment-sourced HDDs older than this are abandoned, not late

# Service capacity groups (Everhour user ids). Departed members stay listed —
# they only count toward a month's denominator if they logged time in it.
CAPACITY_GROUPS = {
    "Design": [1327353, 1336550, 1422085, 1451054, 1004587],  # Dexter, Lezly, Gaby, Maria C, RJ (departed 4/26)
    "Multi":  [1403017],   # Odette
    "IPM":    [1367774],   # Melany
    "Email":  [1445224],   # Debi
}

# Task-title categories → service rollup for the monthly counts table
SERVICE_ROLLUP = {
    "Branding/Logo - Creation/Edits": "Design",
    "Print - Collateral/Packaging": "Design",
    "Web - Sites/Applications/UI": "Design",
    "Web - Maintenance": "Design",
    "LP - New": "Design",
    "LP - Maintenance": "Design",
    "Digital - Banner/Display Ads": "Design",
    "Multi - Photo/Video/Edits": "Multi",
    "IPM - Campaigns/Reports": "IPM",
    "SM - templates/graphics/reels": "IPM",
    "Email - Campaigns/Signatures": "Email",
    "Misc.": "Other",
    "Admin": "Other",
}
CAPACITY_HISTORY_START = (2025, 1)
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
                hdd_src = "step" if step_due else ("override" if ov.get("hdd") else t.get("hdd_source"))
                # A comment deadline weeks in the past is abandoned, not late —
                # surface it as a decision to re-set, never as days-late pressure
                stale_cutoff = (date.today() - timedelta(days=STALE_HDD_DAYS)).isoformat()
                hdd_stale = bool(hdd) and hdd_src == "comment" and hdd < stale_cutoff
                pdd    = ov.get("pdd")   or t.get("pdd")
                # EST priority: manual override > Everhour estimate > comment/title-parsed
                # When Everhour's estimate is per-user, that breakdown is authoritative:
                # a designer absent from it has no estimate — never inherit the task
                # total, which may belong to another assignee (e.g. a web dev)
                eh_uid = str(d.get("eh_id") or "")
                if eh_data.get("estimate_type") == "users":
                    eh_est = eh_data.get("user_estimates", {}).get(eh_uid) if eh_uid else None
                else:
                    eh_est = eh_data.get("estimate")
                # Everhour outranks the local override: dashboard EST edits are
                # written into Everhour, so a local copy is only a fallback for
                # tasks Everhour doesn't know — a stale one must not shadow a
                # later correction made in Everhour itself
                if eh_est is not None:
                    est = eh_est
                elif "est" in ov:
                    est = float(ov["est"])
                else:
                    est = t.get("est")

                # Logged: manual override > per-user Everhour logged. The per-user
                # breakdown is authoritative whenever anyone has logged time — a
                # designer absent from it logged 0, not the task total. Total is
                # the fallback only when no breakdown exists (or no eh_id).
                user_logged = eh_data.get("user_logged", {})
                if eh_uid and (user_logged or not eh_data.get("logged")):
                    user_log = user_logged.get(eh_uid, 0.0)
                else:
                    user_log = eh_data.get("logged", 0.0)
                logged = float(ov["logged"]) if "logged" in ov else user_log

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
                    "hdd": hdd, "hdd_stale": hdd_stale,
                    "pdd": pdd, "est": est, "true_est": true_est, "revs": revs,
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
                and not t.get("is_misc")
                and not t.get("in_revisions")
                and not t.get("hdd_stale"))
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


# ---------------------------------------------------------------------------
# Designer view — token-scoped, server-enforced. A token resolves to exactly
# one designer; the payload never contains anyone else's data, and True EST
# mechanics are folded into a single working estimate before it leaves.
# ---------------------------------------------------------------------------

def _designer_for_token(token: str):
    bc_id = store.resolve_designer_token(token)
    if not bc_id:
        return None
    for d in _cached_data.get("designers", []):
        if str(d["bc_id"]) == str(bc_id):
            return d
    return None


@app.get("/my/{token}")
async def designer_page(token: str):
    if not store.resolve_designer_token(token):
        return Response(status_code=404)
    return FileResponse("static/designer.html")


@app.get("/api/my/{token}")
async def api_my(token: str):
    # Invalid token is a hard 404; a valid token with a cold cache (fresh
    # deploy) gets a warming signal so the page can wait and retry
    if not store.resolve_designer_token(token):
        return Response(status_code=404)
    if _cache_is_stale() and not _refresh_running:
        asyncio.create_task(_refresh_all())
    d = _designer_for_token(token)
    if not d:
        return {"warming": True}
    pto = store.get_all_pto().get(str(d["bc_id"]), [])
    todos = []
    for t in d.get("todos", []):
        todos.append({
            "id": t["id"], "title": t.get("title"), "bucket_name": t.get("bucket_name"),
            "url": t.get("url"), "due_on": t.get("due_on"), "hdd": t.get("hdd"),
            "has_hdd": t.get("has_hdd"), "hdd_stale": t.get("hdd_stale"),
            "est": t.get("est"), "true_est": t.get("true_est"),
            "logged": t.get("logged", 0), "over_by": t.get("over_by", 0),
            "total_hours": t.get("total_hours", 0),
            "progress": t.get("progress", 0), "category": t.get("category"),
            "overrides": t.get("overrides", []),
            "in_revisions": t.get("in_revisions", False),
            "revisions_since": t.get("revisions_since"),
            "is_complete": t.get("is_complete", False), "is_misc": t.get("is_misc", False),
            "step_complete": bool((t.get("designer_step") or {}).get("completed")),
            "designer_step": {"completed": bool((t.get("designer_step") or {}).get("completed"))} if t.get("designer_step") else None,
        })
    today = date.today()
    week_start = (today - timedelta(days=today.weekday())).isoformat()
    msg_at = store.get_token("manager_message_at")
    msg = store.get_token("manager_message")
    manager_message = None
    if msg and msg_at:
        age_days = (time.time() - float(msg_at)) / 86400
        if age_days <= 10:  # stale messages read worse than none
            manager_message = {"text": msg, "at": float(msg_at)}
    return {"name": d["name"], "color": d["color"], "pto": pto, "todos": todos,
            "planner_order": store.get_planner_order(d["bc_id"]),
            "notes": store.get_designer_note(d["bc_id"]),
            "kudos": store.get_kudos(d["bc_id"]),
            "manager_message": manager_message,
            "shipped_week": store.count_completions_since(d["bc_id"], week_start),
            "last_updated": _cached_data.get("last_updated")}


@app.put("/api/my/{token}/todos/{todo_id}/fields")
async def api_my_set_fields(token: str, todo_id: str, request: Request):
    """Designer self-service edits — only on their own todos, same field
    rules as the manager endpoint (HDD → Basecamp step, EST → Everhour)."""
    if not store.resolve_designer_token(token):
        return Response(status_code=404)
    d = _designer_for_token(token)
    if not d:
        return Response(status_code=503)  # cache warming after a deploy
    todo = next((t for t in d.get("todos", []) if str(t["id"]) == str(todo_id)), None)
    if not todo:
        return Response(status_code=403)
    body = await request.json()
    return await _apply_todo_fields(str(todo_id), body, todo, d)


@app.put("/api/my/{token}/planner-order")
async def api_my_planner_order(token: str, request: Request):
    d = _designer_for_token(token)
    if not d:
        return Response(status_code=404 if not store.resolve_designer_token(token) else 503)
    body = await request.json()
    day, ids = body.get("date"), body.get("ids", [])
    if not day or not isinstance(ids, list):
        return {"ok": False, "error": "date and ids required"}
    store.set_planner_order(d["bc_id"], str(day), [str(i) for i in ids])
    return {"ok": True}


@app.put("/api/my/{token}/notes")
async def api_my_notes(token: str, request: Request):
    bc_id = store.resolve_designer_token(token)
    if not bc_id:
        return Response(status_code=404)
    body = await request.json()
    store.set_designer_note(bc_id, str(body.get("content", ""))[:20000])
    return {"ok": True}


@app.post("/api/kudos")
async def api_add_kudos(request: Request, pin: str = ""):
    """Fed by the daily Slack sync routine — maps mentions to designers."""
    if pin != "1868":
        return Response(status_code=403)
    body = await request.json()
    slack_map = {d.get("slack_id"): d for d in DESIGNERS if d.get("slack_id")}
    added = 0
    for item in body.get("items", []):
        d = slack_map.get(item.get("slack_id"))
        if not d:
            continue
        if store.add_kudos(d["bc_id"], str(item.get("text", ""))[:2000],
                           str(item.get("author", ""))[:120],
                           str(item.get("ts", "")), str(item.get("permalink", ""))[:400]):
            added += 1
    return {"ok": True, "added": added}


@app.post("/api/manager-message")
async def api_manager_message(request: Request, pin: str = ""):
    if pin != "1868":
        return Response(status_code=403)
    body = await request.json()
    store.set_token("manager_message", str(body.get("text", ""))[:2000])
    store.set_token("manager_message_at", str(time.time()))
    return {"ok": True}


@app.get("/api/designer-links")
async def api_designer_links(pin: str = ""):
    if pin != "1868":
        return Response(status_code=403)
    links = []
    for d in DESIGNERS:
        token = store.ensure_designer_token(d["bc_id"])
        links.append({"name": d["name"], "url": f"/my/{token}"})
    return links


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

    # Find the todo and its designer in the cache
    cached_todo = None
    cached_designer = None
    for d in _cached_data.get("designers", []):
        for t in d.get("todos", []):
            if str(t["id"]) == str(todo_id):
                cached_todo = t
                cached_designer = d
                break

    return await _apply_todo_fields(todo_id, body, cached_todo, cached_designer)


async def _apply_todo_fields(todo_id: str, body: dict, cached_todo, cached_designer):
    """Shared field-update core used by the manager and designer endpoints."""
    allowed = {"hdd", "est", "true_est", "due_on", "logged", "category"}

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
            elif bucket_id and cached_todo.get("in_revisions") and cached_designer:
                # Revision limbo: setting an HDD is the moment the revision deadline
                # is decided — create a real Revision step in Basecamp for the designer
                new_step = await bc.create_step(
                    bucket_id, todo_id, "Revision",
                    due_on=str(value),
                    assignee_ids=[int(cached_designer["bc_id"])],
                )
                if new_step:
                    cached_todo["designer_step"] = new_step
                    cached_todo["in_revisions"] = False
                    cached_todo["revisions_since"] = None
                    cached_todo["has_hdd"] = True
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
            # Write to Everhour estimate for this designer. On success Everhour
            # is the source of truth — remove any local copy so it can't go
            # stale and shadow future corrections. Local override only when
            # the Everhour write isn't possible.
            eh_id = cached_designer.get("eh_id") if cached_designer else None
            wrote = False
            if eh_id:
                wrote = await eh.set_user_estimate(todo_id, eh_id, float(value))
            if wrote:
                store.delete_override(todo_id, field)
            else:
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
        if "hdd" in body:
            cached_todo["hdd"] = body["hdd"] or cached_todo.get("hdd")
            if body.get("hdd"):
                cached_todo["hdd_stale"] = False
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


def _workdays_in_month(y: int, m: int, upto: date | None = None) -> int:
    d, n = date(y, m, 1), 0
    while d.month == m:
        if upto and d > upto:
            break
        if d.weekday() < 5:
            n += 1
        d += timedelta(days=1)
    return n


async def _compute_capacity_analytics() -> dict:
    from parsers import categorize_todo
    today = date.today()
    y, m = CAPACITY_HISTORY_START
    months = []
    while (y, m) <= (today.year, today.month):
        months.append(f"{y:04d}-{m:02d}")
        m += 1
        if m == 13:
            y, m = y + 1, 1

    all_uids = sorted({u for ids in CAPACITY_GROUPS.values() for u in ids})
    recs_by_user = {}
    for uid in all_uids:
        try:
            recs_by_user[uid] = await eh.get_user_time_records(
                uid, f"{CAPACITY_HISTORY_START[0]:04d}-{CAPACITY_HISTORY_START[1]:02d}-01",
                today.isoformat())
        except Exception as e:
            print(f"[capacity] user {uid} fetch error: {e}")
            recs_by_user[uid] = []

    hours = {g: {mo: 0.0 for mo in months} for g in CAPACITY_GROUPS}
    active = {g: {mo: set() for mo in months} for g in CAPACITY_GROUPS}
    tasks_by_month = {mo: {} for mo in months}  # task_id -> task name

    for g, ids in CAPACITY_GROUPS.items():
        for uid in ids:
            for rec in recs_by_user.get(uid, []):
                mo = (rec.get("date") or "")[:7]
                if mo not in hours[g]:
                    continue
                hrs = (rec.get("time") or 0) / 3600
                if hrs <= 0:
                    continue
                hours[g][mo] += hrs
                active[g][mo].add(uid)
                task = rec.get("task") or {}
                tid = str(task.get("id") or "")
                if tid:
                    tasks_by_month[mo][tid] = task.get("name") or ""

    def month_avail(mo: str, n_people: int) -> float:
        yy, mm = int(mo[:4]), int(mo[5:7])
        upto = today if (yy, mm) == (today.year, today.month) else None
        return _workdays_in_month(yy, mm, upto) * WORK_HOURS * n_people

    # Per-month one-person available hours — lets the frontend simulate headcount
    workhours = []
    for mo in months:
        yy, mm = int(mo[:4]), int(mo[5:7])
        upto = today if (yy, mm) == (today.year, today.month) else None
        workhours.append(round(_workdays_in_month(yy, mm, upto) * WORK_HOURS, 1))

    capacity, hours_out, people = {}, {}, {}
    for g in CAPACITY_GROUPS:
        capacity[g], hours_out[g], people[g] = [], [], []
        for mo in months:
            avail = month_avail(mo, len(active[g][mo]))
            capacity[g].append(round(hours[g][mo] / avail * 100, 1) if avail > 0 else None)
            hours_out[g].append(round(hours[g][mo], 1))
            people[g].append(len(active[g][mo]))
    capacity["All"], hours_out["All"], people["All"] = [], [], []
    for i, mo in enumerate(months):
        total_h = sum(hours[g][mo] for g in CAPACITY_GROUPS)
        n = len(set().union(*(active[g][mo] for g in CAPACITY_GROUPS)))
        avail = month_avail(mo, n)
        capacity["All"].append(round(total_h / avail * 100, 1) if avail > 0 else None)
        hours_out["All"].append(round(total_h, 1))
        people["All"].append(n)

    services = ["Design", "Multi", "IPM", "Email", "Other"]
    counts = {s: [] for s in services}
    count_totals = []
    for mo in months:
        per = {s: 0 for s in services}
        for tid, name in tasks_by_month[mo].items():
            per[SERVICE_ROLLUP.get(categorize_todo(name or ""), "Other")] += 1
        for s in services:
            counts[s].append(per[s])
        count_totals.append(sum(per.values()))

    return {"months": months, "capacity": capacity, "hours": hours_out,
            "people": people, "workhours": workhours,
            "counts": counts, "count_totals": count_totals,
            "current_month_partial": True, "generated_at": time.time()}


@app.get("/api/analytics/capacity")
async def api_capacity_analytics(refresh: int = 0):
    cached = store.cache_get("capacity_analytics_v2")
    if cached and not refresh:
        return cached
    data = await _compute_capacity_analytics()
    store.cache_set("capacity_analytics_v2", data, ttl_seconds=6 * 3600)
    return data


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
