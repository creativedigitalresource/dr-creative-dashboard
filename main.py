import asyncio, json, os, re, time, statistics
from collections import Counter, defaultdict
from datetime import date, timedelta
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import store, basecamp as bc, everhour as eh
from parsers import CATEGORIES, CATEGORY_TIMELINE, categorize_todo

_cached_data: dict = {}
_sse_clients: list[asyncio.Queue] = []
_refresh_running = False

DESIGNERS = [
    {"name": "Dexter",   "bc_id": 44800252, "eh_id": 1327353,  "color": "#7dcbed", "slack_id": "U01S46XJU8G", "avatar": "/static/img/avatars/44800252.jpg"},
    {"name": "Lezly",    "bc_id": 45896266, "eh_id": 1336550,  "color": "#26a9e1", "slack_id": "U070TFVNNSK", "avatar": "/static/img/avatars/45896266.jpg"},
    {"name": "Gaby",     "bc_id": 46567979, "eh_id": 1422085,  "color": "#f6931e", "slack_id": "U07JJEF0KCY", "avatar": "/static/img/avatars/46567979.jpg"},
    {"name": "Odette",   "bc_id": 48051100, "eh_id": 1403017,  "color": "#eab308", "slack_id": "U08LAH3CA12", "avatar": "/static/img/avatars/48051100.jpg"},
    {"name": "Debi",     "bc_id": 52244353, "eh_id": 1445224,  "color": "#d5de23", "slack_id": "U0B0JNXGTKQ", "avatar": "/static/img/avatars/52244353.jpg"},
    {"name": "Maria C",  "bc_id": 52471282, "eh_id": 1451054,  "color": "#14b8a6", "slack_id": "U0B7JK64NT1", "avatar": "/static/img/avatars/52471282.jpg"},
    {"name": "Melany",   "bc_id": 46905124, "eh_id": 1367774,  "color": "#ef4444", "slack_id": "U07RXRYNEMQ", "avatar": "/static/img/avatars/46905124.jpg"},
]

# QA checklist rollout — Gaby only for now, testing before the team-wide
# turn-on. Add more bc_ids here (or swap the membership check for "always
# True") when Richard's ready to activate it for everyone else.
QA_ENABLED_BC_IDS = {46567979}  # Gaby

# Richard's own todos — fetched through the same pipeline as designers for the
# My Stuff tab, but kept out of designers_out so team analytics stay clean
ME = {"name": "Richard", "bc_id": 49482127, "eh_id": 1415584, "color": "#6366f1",
      "avatar": "/static/img/avatars/49482127.jpg"}

# Logged-time-to-Everhour sync rollout — same staged pattern as
# QA_ENABLED_BC_IDS above. Confirmed working for Richard; adding Maria C
# next. Add more bc_ids here as each person's confirmed before turning it
# on for the rest of the team.
LOGGED_SYNC_BC_IDS = {ME["bc_id"], 52471282}  # Richard, Maria C

# Delegation coverage — lets a designer see the To Delegate queue, everyone's
# capacity, and Team Spotlight on their own page while Richard is out. Remove
# a bc_id here to revoke access at any time.
DELEGATE_ENABLED_BC_IDS = {46567979}  # Gaby

# My Stuff priority roster (2026-08-19, Richard-confirmed) — who a todo is
# "from" groups it for display. Keyed by Basecamp person id, not name
# strings: two different people can have near-identical names (e.g. the
# CMO named "Genesis Suarez" vs "COMGenesis Suarez," the Client Operations
# Manager who actually shows up in Richard's threads — the roster points at
# the latter's id), and matching on id sidesteps that ambiguity entirely.
# Tier 3 has two labeled sub-groups (Managers/HR and Sales) at equal
# priority, shown as separate sections in the UI. Only ever consulted for
# Richard's own todos (see is_me in _fetch_person) — never touches a
# designer's data.
PRIORITY_TIERS = [
    (1, "Shay Berman", {44588291}),
    (2, "Nate Mendenhall", {44609658}),
    (3, "Managers / HR", {
        44415656,  # Melanie Greene
        44609659,  # LeTrice Baugh
        42789152,  # Indiana Montero
        44800237,  # COMGenesis Suarez (Client Operations Manager)
        44609678,  # Candace Antezana
        43893941,  # Jose Diaz
        44800194,  # Julieta Lauria
        44609710,  # Mike Demyan
        44609671,  # Nicole Marasco
    }),
    (3, "Sales", {
        44609674,  # Brice Sullivan
        50021867,  # Anny Kautzky
    }),
    (4, "Account Management", {
        44609675,  # Brooke Winkelmann
        44800193,  # Tiffany Bretana
        45188843,  # Karinna Schultz
        46752532,  # Jackie O'Neill
        46082379,  # Lindsay Berger
        45532726,  # Marcelo Salvatore
        45196786,  # Heidi Klein
        49225846,  # Marisol Draughon
        46677379,  # Jared Uy
        51255199,  # Matteo Richard Schietromo
        52754982,  # Sydney Linthicum
        52886397,  # Jessica Morgan
        49246425,  # Daniel Hernandez Arcila
        49352347,  # Mary Joy Cabanig
        49352010,  # Alejandra Rodriguez
        51537021,  # Yinnel Gonzalez
        51537296,  # Andrea Ebiteh
        45178968,  # Maria Espitia Diaz
        44609679,  # Jacob Rosuck
        44609660,  # Taylor Stobie
    }),
]


def _priority_group_for(sender_id):
    """(tier, label) for a Basecamp person id. Anyone not in the roster —
    or a todo with no other participant at all — lands in tier 5."""
    if sender_id:
        for tier, label, ids in PRIORITY_TIERS:
            if sender_id in ids:
                return tier, label
    return 5, "Everyone Else"


def _resolve_sender(t: dict, self_id: int):
    """Who a todo is really from, walking its comments newest-first and
    skipping self_id's own comments — that's who's actually being waited
    on, whether self_id owes them a reply or vice versa. Falls back to the
    todo's creator when no one else has ever commented. Returns
    (sender_id, sender_name, sender_at, last_author_is_self); the last
    element tells the caller whether self_id already has the most recent
    word (so nothing is currently owed) or someone else does.
    """
    authors = t.get("comment_authors") or []
    last_author_is_self = bool(authors) and authors[-1].get("id") == self_id
    for c in reversed(authors):
        if c.get("id") and c["id"] != self_id:
            return c["id"], c.get("name"), c.get("at"), last_author_is_self
    creator_id, creator_name = t.get("creator_id"), t.get("creator_name")
    if creator_id and creator_id != self_id:
        return creator_id, creator_name, t.get("created_at"), last_author_is_self
    return None, None, None, last_author_is_self


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

# QA checklist templates, one per deliverable service (mirrors CATEGORIES,
# minus Misc./Admin which aren't QA'd). Seeded into the DB once; after that
# the DB copy is authoritative and editable from the QA tab.
DEFAULT_QA_TEMPLATES = {
    "Branding/Logo - Creation/Edits": [
        "Logo is legible and scales cleanly from favicon size to billboard size",
        "Vector source provided (AI/EPS/SVG), no pixelation or artifacts",
        "Files delivered in required formats (SVG, transparent PNG, PDF/EPS as applicable)",
        "Correct color values used, matching approved brand palette / hex codes",
        "Color and single-color (black/white) versions provided if scoped",
        "Clear space and minimum size respected per brand rules",
        "Wordmark spelled correctly, correct font weight/kerning",
        "Matches approved concept/direction from client sign-off",
        "No leftover guides, artboards, or hidden layers in the source file",
    ],
    "Print - Collateral/Packaging": [
        "Correct trim size, bleed (0.125\"), and safe margins set up",
        "Colors set to CMYK, not RGB, for the print-ready file",
        "All images are 300dpi minimum at final size",
        "No spelling or grammar errors in the final copy",
        "Contact info, URLs, and QR codes verified accurate (QR tested to scan)",
        "Fonts outlined or embedded in the final print file",
        "Bleed/crop marks included in the press-ready export",
        "Matches approved layout/design from client sign-off",
        "Required legal/disclaimer text present",
    ],
    "Web - Sites/Applications/UI": [
        "Matches approved mockup/wireframe (spacing, colors, typography)",
        "Responsive check passes on desktop, tablet, and mobile breakpoints",
        "All links, buttons, and CTAs work and point to the correct destination",
        "Forms submit correctly and required-field validation works",
        "No console errors in browser dev tools",
        "Images optimized and have alt text",
        "Cross-browser check done (Chrome + Safari minimum)",
        "Favicon and meta title/description set correctly",
        "No placeholder or lorem ipsum text remaining",
    ],
    "Web - Maintenance": [
        "Requested change implemented exactly as described in the task",
        "No unrelated content or styling broken by the change (spot-check nearby pages)",
        "Change verified live on the actual URL, not just in the CMS editor",
        "Mobile view checked after the change",
        "Links/buttons touched by the change still work",
        "Cache/CDN cleared if needed so the live site reflects the update",
        "No console errors introduced",
    ],
    "Email - Campaigns/Signatures": [
        "Subject line and preview text match approved copy",
        "All links tested and pointing to correct, tracked URLs (UTMs if required)",
        "Personalization/merge tags render correctly on a test send",
        "Renders correctly in Gmail, Outlook, and on mobile",
        "Images have alt text and aren't broken when images are blocked by default",
        "Unsubscribe link and required compliance footer present",
        "No spelling or grammar errors in subject, preheader, or body",
        "Sender name and reply-to address correct",
        "Test email sent and reviewed before scheduling/send",
    ],
    "LP - New": [
        "Design matches the approved mockup",
        "Headline, copy, and CTAs match the approved final copy doc",
        "Form submits successfully and leads route to the correct destination",
        "Thank-you page/redirect works after form submission",
        "Mobile responsive check passes",
        "Phone numbers, click-to-call, and tracking numbers are correct",
        "No broken images, and page loads at a reasonable speed",
        "Meta title/description and favicon set",
        "Tracking pixels/analytics firing correctly",
        "No placeholder text remaining",
    ],
    "LP - Maintenance": [
        "Requested edit implemented exactly as described",
        "Form still submits and routes to the right destination after the edit",
        "Tracking/pixels still firing after the change",
        "Mobile view checked after the change",
        "No unrelated content broken by the edit",
        "Live URL verified post-publish, not just staging/editor",
    ],
    "Digital - Banner/Display Ads": [
        "Correct dimensions/specs for each requested ad size",
        "File size within the target platform's limits",
        "Copy matches approved final copy, no spelling errors",
        "CTA is present and legible at the smallest required size",
        "Brand logo and colors correct",
        "Required legal/disclaimer text included if applicable",
        "Static and/or animated versions delivered as scoped",
        "Correct file format for the platform (JPG/PNG/HTML5/GIF)",
        "Click-through URL verified correct",
    ],
    "Multi - Photo/Video/Edits": [
        "Final export matches requested aspect ratio/resolution/format",
        "Color correction/grading is consistent across clips or photos",
        "Audio levels balanced, no clipping or background noise issues",
        "Captions/subtitles accurate and correctly synced, if included",
        "Branding elements (logo, lower thirds, end card) correct and on-brand",
        "No visible watermarks, stray frames, or export artifacts",
        "File delivered in the requested format/codec",
        "Matches approved storyboard/direction from client sign-off",
    ],
    "IPM - Campaigns/Reports": [
        "Data pulled from the correct date range and correct source/account",
        "Numbers cross-checked against the source platform, no manual entry errors",
        "Charts/graphs labeled correctly and match the underlying data",
        "Client-facing language free of internal jargon and typos",
        "Branding/template matches the current approved report format",
        "Insights/recommendations are specific to this client's data, not generic",
        "File/link shared in the correct, accessible format",
    ],
    "SM - templates/graphics/reels": [
        "Correct dimensions/specs for the target platform (feed, story, reel)",
        "Copy/caption matches approved content, no spelling errors",
        "Branding (logo, colors, fonts) consistent with brand guidelines",
        "Hashtags/mentions correct, if included in the graphic",
        "Video/reel audio levels checked, captions accurate if included",
        "File exported in the requested format and delivered to the correct location",
    ],
}

CAPACITY_HISTORY_START = (2025, 1)
ESTIMATE_GUIDE_MIN_N = 5  # fewer samples than this = "not enough data yet"
CACHE_TTL = 300  # 5 minutes


_REVISION_KEYWORDS = ["round 2", "round2", " r2 ", "revision", "revisions", "re-do", "redo"]


def _week_start(d: date = None) -> str:
    d = d or date.today()
    return (d - timedelta(days=d.weekday())).isoformat()


def _is_revision(title: str, step_title: str = "") -> bool:
    t = (title + " " + step_title).lower()
    return any(k in t for k in _REVISION_KEYWORDS)


async def _fresh_logged_hours(designer_bc_id: str, todo_id: str, fallback: float) -> float:
    """Refetch Everhour at the moment a completion is detected, rather than
    trusting the last tracked snapshot — that snapshot is only as fresh as
    the previous refresh, and a designer can log real time right up until
    they're reassigned, between refreshes. (Confirmed live: a completion
    recorded 0.0h for a designer who Everhour showed had logged 1.18h.)"""
    if not eh.EH_KEY:
        return fallback
    designer = next((d for d in DESIGNERS if str(d["bc_id"]) == str(designer_bc_id)), None)
    if not designer or not designer.get("eh_id"):
        return fallback
    try:
        fresh = await asyncio.wait_for(eh.get_time_logged(todo_id), timeout=6.0)
        fresh_val = fresh.get("user_logged", {}).get(str(designer["eh_id"]))
        return fresh_val if fresh_val is not None else fallback
    except Exception as e:
        print(f"[analytics] fresh logged-hours refetch failed for {todo_id}: {e}")
        return fallback


async def _record_analytics(designers_out: list, unassigned: list, refresh_ts: float):
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
            logged_hours = await _fresh_logged_hours(row["designer_bc_id"], row["todo_id"], row.get("logged_hours", 0))
            store.record_completion(
                todo_id=row["todo_id"],
                designer_bc_id=row["designer_bc_id"],
                designer_name=row["designer_name"],
                title=row["title"],
                category=row["category"],
                client_name=row["client_name"],
                est_hours=row.get("est_hours"),
                logged_hours=logged_hours,
                hdd=hdd,
                due_on=row.get("due_on"),
                week_start=week,
                was_hdd_miss=1 if (hdd and hdd < today_str) else 0,
                had_revision=row.get("had_revision", 0),
            )
            store.delete_todo_tracking(row["todo_id"], row["designer_bc_id"])
            print(f"[analytics] completion recorded: {row['designer_name']} — {row['title'][:50]} ({logged_hours}h)")

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

    _record_queue_tracking(unassigned, refresh_ts)


def _record_queue_tracking(unassigned: list, ts: float):
    """Split out from _record_analytics: unlike completion detection, this
    only ever compares `unassigned` against itself (queue entries/exits),
    never against a designer roster — so it's safe to call standalone from
    a scoped refresh (e.g. the To Delegate tab's own refresh) without the
    incomplete-roster risk completion detection has."""
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
            ts=ts,
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


async def _fetch_person(d: dict, overrides: dict, week_end: str) -> dict:
    """Fetch and enrich one person's assigned todos. Used for every designer
    and for Richard's My Stuff view — one pipeline, so the numbers never drift."""
    is_me = d.get("bc_id") == ME["bc_id"]
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
        # A comment deadline weeks in the past is abandoned, not late.
        # Worse, it's often not a real per-task deadline at all — a comment
        # mentioning a date is frequently a shared broadcast action item
        # (e.g. "everyone join this call on X") tagging several people, not
        # a personal HDD for this specific task. Showing it as if it were
        # a real (if overdue) HDD is actively misleading, so once it's
        # stale, treat it exactly like no HDD ever existed rather than a
        # fixable date — the designer sees "HDD needed," not an old date.
        stale_cutoff = (date.today() - timedelta(days=STALE_HDD_DAYS)).isoformat()
        hdd_stale = bool(hdd) and hdd_src == "comment" and hdd < stale_cutoff
        if hdd_stale:
            hdd = None
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

        # has_hdd: True only when HDD comes from a real, task-specific source
        # (step due date or a manual override) — never a comment-parsed
        # guess, which is too unreliable to treat as a confirmed deadline
        has_hdd = bool(step_due or ov.get("hdd"))
        # Category: manual override > auto-detected
        category = ov.get("category") or t.get("category", "Misc.")

        # Sender / priority tier: only meaningful for Richard's own My Stuff
        # view ("who's this from"). is_me gates this completely — a
        # designer's todos never run through _resolve_sender, so their
        # data is untouched by this addition.
        sender_id = sender_name = sender_at = priority_tier = priority_label = None
        last_author_is_self = False
        if is_me:
            sender_id, sender_name, sender_at, last_author_is_self = _resolve_sender(t, d["bc_id"])
            priority_tier, priority_label = _priority_group_for(sender_id)

        # Reply Needed: manual override > auto-detected, same precedence
        # pattern as category above. The original manual-only behavior is
        # preserved exactly for designers (auto-detection only ever runs
        # when is_me, so their toggle/capacity behavior can't change).
        # For Richard: someone else holds the last word and hasn't been
        # replied to yet → default on; he can always toggle it off if the
        # guess is wrong, same as any other override.
        if "reply_needed" in ov:
            reply_needed = bool(ov["reply_needed"])
        elif is_me:
            reply_needed = bool(sender_id) and not last_author_is_self
        else:
            reply_needed = False

        enriched.append({
            **t,
            "hdd": hdd, "hdd_stale": hdd_stale,
            "pdd": pdd, "est": est, "true_est": true_est, "revs": revs,
            "total_hours": total,
            "logged": logged, "progress": progress,
            "over_by": over_by,
            "has_hdd": has_hdd,
            "category": category,
            "reply_needed": reply_needed,
            "sender_id": sender_id, "sender_name": sender_name, "sender_at": sender_at,
            "priority_tier": priority_tier, "priority_label": priority_label,
            "is_misc": t.get("is_misc", False),
            "is_complete": t.get("is_complete", False),
            "overrides": list(ov.keys()),
        })
    # Weekly est: sum tasks due within this week. A stale comment-parsed HDD
    # is already nulled out above, so it's naturally excluded here too —
    # no separate hdd_stale check needed.
    weekly_est = sum(
        max(0, t.get("total_hours", 0) - t.get("logged", 0))
        for t in enriched
        if t.get("hdd") and t["hdd"] <= week_end
        and not t.get("is_complete")
        and not t.get("is_misc")
        and not t.get("in_revisions")
        and not t.get("reply_needed"))
    capacity_pct = min(100, round(weekly_est / WEEKLY_CAP * 100))
    return {**d, "todos": enriched,
            "weekly_est": round(weekly_est, 1),
            "weekly_cap": WEEKLY_CAP,
            "capacity_pct": capacity_pct}


def _is_dr_internal(bucket_name: str) -> bool:
    bn = (bucket_name or "").lower()
    return "digital resource" in bn or "dr team" in bn


def _todo_sort_key(t: dict):
    return (
        1 if _is_dr_internal(t.get("bucket_name", "")) else 0,
        t.get("due_on") or "9999-99-99",
        0 if t.get("has_hdd") else 1,
        t.get("hdd") or "9999-99-99",
    )


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

    for t in unassigned:
        ov = overrides.get(str(t["id"]), {})
        t["category"] = ov.get("category") or categorize_todo(t.get("title", ""))
        t["overrides"] = list(ov.keys())

    designers_out = []
    for d in DESIGNERS:
        print(f"[refresh] fetching {d['name']}...")
        try:
            person = await _fetch_person(d, overrides, week_end)
            designers_out.append(person)
            print(f"[refresh] {d['name']}: {len(person['todos'])} todos")
        except asyncio.TimeoutError:
            print(f"[refresh] {d['name']} timed out")
            designers_out.append({**d, "todos": [], "weekly_est": 0,
                                   "weekly_cap": WEEKLY_CAP, "capacity_pct": 0})
        except Exception as e:
            print(f"[refresh] {d['name']} error: {type(e).__name__}: {e}")
            designers_out.append({**d, "todos": [], "weekly_est": 0,
                                   "weekly_cap": WEEKLY_CAP, "capacity_pct": 0})

    # Richard's own todos — same pipeline, never in designers_out
    print("[refresh] fetching Richard (My Stuff)...")
    try:
        me_out = await _fetch_person(ME, overrides, week_end)
        print(f"[refresh] Richard: {len(me_out['todos'])} todos")
    except Exception as e:
        print(f"[refresh] Richard error: {type(e).__name__}: {e}")
        me_out = _cached_data.get("me") or {**ME, "todos": [], "weekly_est": 0,
                                            "weekly_cap": WEEKLY_CAP, "capacity_pct": 0}

    # Sort: client work first → due_on → has_hdd → hdd value
    for d in designers_out + [me_out]:
        d["todos"].sort(key=_todo_sort_key)
    unassigned.sort(key=lambda t: t.get("created_at") or "")

    refresh_ts = time.time()
    try:
        await _record_analytics(designers_out, unassigned, refresh_ts)
    except Exception as e:
        print(f"[analytics] error: {type(e).__name__}: {e}")

    _cached_data["unassigned"] = unassigned
    _cached_data["designers"] = designers_out
    _cached_data["me"] = me_out
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
    store.seed_qa_templates(DEFAULT_QA_TEMPLATES)
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


@app.post("/api/unassigned/refresh")
async def api_unassigned_refresh():
    """Refresh just the To Delegate queue — one independent Basecamp call,
    no Everhour and no designer data involved, so it doesn't need the full
    team-wide refresh to serve this tab."""
    overrides = store.get_all_overrides()
    try:
        unassigned = await asyncio.wait_for(bc.get_unassigned_todos(), timeout=25.0)
    except asyncio.TimeoutError:
        return {"ok": False, "error": "timeout"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    for t in unassigned:
        ov = overrides.get(str(t["id"]), {})
        t["category"] = ov.get("category") or categorize_todo(t.get("title", ""))
        t["overrides"] = list(ov.keys())
    unassigned.sort(key=lambda t: t.get("created_at") or "")

    _cached_data["unassigned"] = unassigned
    _record_queue_tracking(unassigned, time.time())
    return {"ok": True}


@app.get("/api/designers")
async def api_designers():
    designers = _cached_data.get("designers", [])
    pto_map = store.get_all_pto()
    for d in designers:
        # Attach PTO so client can calculate real capacity
        d["pto"] = pto_map.get(str(d["bc_id"]), [])
        # Attach spotlight state so the manager's Team Spotlight tab (and
        # any other manager-side view) can read it straight off this same
        # designer list, same as _public_todos() already does for a
        # designer's own token-scoped page.
        spotlight_ids = set(store.get_spotlight_ids(d["bc_id"]))
        for t in d.get("todos", []):
            t["is_spotlighted"] = str(t["id"]) in spotlight_ids
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
    return FileResponse("static/designer.html", headers={"Cache-Control": "no-cache, must-revalidate"})


def _public_todos(d: dict) -> list:
    """Client-safe todo projection shared by the designer page and My Stuff."""
    spotlight_ids = set(store.get_spotlight_ids(d["bc_id"]))
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
            "reply_needed": t.get("reply_needed", False),
            "sender_name": t.get("sender_name"), "sender_at": t.get("sender_at"),
            "priority_tier": t.get("priority_tier"), "priority_label": t.get("priority_label"),
            "overrides": t.get("overrides", []),
            "in_revisions": t.get("in_revisions", False),
            "revisions_since": t.get("revisions_since"),
            "is_complete": t.get("is_complete", False), "is_misc": t.get("is_misc", False),
            "step_complete": bool((t.get("designer_step") or {}).get("completed")),
            "designer_step": {"completed": bool((t.get("designer_step") or {}).get("completed"))} if t.get("designer_step") else None,
            "is_spotlighted": str(t["id"]) in spotlight_ids,
        })
    return todos


@app.get("/api/me")
async def api_me():
    """Richard's own assigned todos — feeds the My Stuff tab on the main dashboard."""
    if _cache_is_stale() and not _refresh_running:
        asyncio.create_task(_refresh_all())
    me = _cached_data.get("me")
    if not me:
        return {"warming": True}
    pto = store.get_all_pto().get(str(ME["bc_id"]), [])
    return {"name": me["name"], "color": me["color"], "avatar": me.get("avatar"), "pto": pto,
            "eh_id": ME.get("eh_id"),
            "todos": _public_todos(me),
            "last_updated": max(_cached_data.get("last_updated") or 0, _cached_data.get("me_last_updated") or 0)}


@app.post("/api/me/refresh")
async def api_me_refresh():
    """Refresh just Richard's own data — used by the My Stuff tab's refresh.
    Same shape as POST /api/my/{token}/refresh: fetch only this one person,
    never run completion-detection analytics on a partial roster (see that
    endpoint's comment for why — this is the same bug class, avoided the
    same way)."""
    today = date.today()
    week_end = (today + timedelta(days=4 - today.weekday())).isoformat()
    overrides = store.get_all_overrides()
    me = await _fetch_person(ME, overrides, week_end)
    me["todos"].sort(key=_todo_sort_key)
    _cached_data["me"] = me
    _cached_data["me_last_updated"] = time.time()
    return {"ok": True}


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
    todos = _public_todos(d)
    today = date.today()
    week_start = (today - timedelta(days=today.weekday())).isoformat()
    msg_at = store.get_token("manager_message_at")
    msg = store.get_token("manager_message")
    manager_message = None
    if msg and msg_at:
        age_days = (time.time() - float(msg_at)) / 86400
        if age_days <= 10:  # stale messages read worse than none
            manager_message = {"text": msg, "at": float(msg_at)}
    return {"name": d["name"], "color": d["color"], "avatar": d.get("avatar"), "pto": pto, "todos": todos,
            "eh_id": d.get("eh_id"),
            "planner_order": store.get_planner_order(d["bc_id"]),
            "notes": store.get_designer_note(d["bc_id"]),
            "kudos": store.get_kudos(d["bc_id"], since_ts=str(int(time.time() - 183 * 86400))),
            "manager_message": manager_message,
            "shipped_week": store.count_completions_since(d["bc_id"], week_start),
            "estimate_guide": _compute_estimate_guide(d["bc_id"]),
            "qa_enabled": d["bc_id"] in QA_ENABLED_BC_IDS,
            "delegate_enabled": d["bc_id"] in DELEGATE_ENABLED_BC_IDS,
            "last_updated": max(
                _cached_data.get("last_updated") or 0,
                _cached_data.get("designer_last_updated", {}).get(str(d["bc_id"])) or 0,
            )}


@app.post("/api/my/{token}/refresh")
async def api_my_refresh(token: str):
    """Refresh just this one designer's own data — used by the Refresh
    button on their personal page. Fetches only their Basecamp/Everhour
    data (a couple seconds) instead of running the full team-wide
    sequential refresh (~20s), which nobody but this one person needs
    right now."""
    bc_id = store.resolve_designer_token(token)
    if not bc_id:
        return Response(status_code=404)
    d = next((x for x in DESIGNERS if str(x["bc_id"]) == str(bc_id)), None)
    if not d:
        return Response(status_code=404)

    today = date.today()
    week_end = (today + timedelta(days=4 - today.weekday())).isoformat()
    overrides = store.get_all_overrides()
    person = await _fetch_person(d, overrides, week_end)
    person["todos"].sort(key=_todo_sort_key)

    # Only splice into the shared cache if it already holds a full roster —
    # never append/shrink it. A cold cache (fresh deploy, first request ever)
    # means _cached_data["designers"] isn't the full team yet; leave it alone
    # and let the normal _cache_is_stale() lazy full-refresh populate it.
    designers_out = _cached_data.get("designers", [])
    idx = next((i for i, x in enumerate(designers_out) if str(x["bc_id"]) == str(bc_id)), None)
    if idx is not None:
        designers_out[idx] = person
        _cached_data.setdefault("designer_last_updated", {})[str(bc_id)] = time.time()

    # Deliberately NOT running _record_analytics here. Completion detection
    # compares a full current-roster snapshot against all persisted
    # todo_tracking rows — anyone missing from the snapshot reads as
    # "completed". Running it from a single-person fetch (even with the
    # cache spliced above) risks that snapshot being incomplete and mass-
    # marking every OTHER designer's active work as done. Learned this live:
    # an early version of this endpoint did call it, and during a cold-cache
    # window it wrote 76 false completions in one shot. Completion detection
    # stays exclusively _do_refresh's job (full refresh runs automatically
    # whenever the cache goes stale, at most every 5 min).
    return {"ok": True}


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


@app.put("/api/my/{token}/todos/{todo_id}/spotlight")
async def api_my_set_spotlight(token: str, todo_id: str, request: Request):
    d = _designer_for_token(token)
    if not d:
        return Response(status_code=404 if not store.resolve_designer_token(token) else 503)
    if not any(str(t["id"]) == str(todo_id) for t in d.get("todos", [])):
        return Response(status_code=403)
    body = await request.json()
    return store.set_spotlight(str(d["bc_id"]), str(todo_id), bool(body.get("on")))


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


@app.get("/api/estimate-guide")
async def api_estimate_guide():
    """Company-wide medians + Richard's goals — no per-designer data, safe
    for the manager Overview panel."""
    return _compute_estimate_guide()


@app.get("/api/at-risk")
async def api_at_risk():
    """Server-side twin of the Overview tab's At Risk rule (shared.js
    _overviewStats/renderAttention: due within 2 days, <50% progress,
    not already caught by a separate 'needs a decision' bucket) — the
    daily Slack-nudge routine can't run the browser's JS, so this mirrors
    it in Python. Returns only items not yet notified today, and claims
    them in the same call so a retry can't double-send.

    Kept intentionally in sync by hand with shared.js rather than shared
    code, since the two run in different languages — if the rule there
    changes, update it here too."""
    today = date.today().isoformat()
    soon = (date.today() + timedelta(days=2)).isoformat()
    candidates = []
    for d in _cached_data.get("designers", []):
        for t in d.get("todos", []):
            if t.get("is_complete") or t.get("is_misc") or t.get("reply_needed"):
                continue
            if t.get("in_revisions") or t.get("hdd_stale"):
                continue
            hdd = t.get("hdd")
            if not hdd or hdd < today or hdd > soon:
                continue
            if (t.get("progress") or 0) >= 50:
                continue
            candidates.append({
                "todo_id": str(t["id"]), "title": t.get("title"), "url": t.get("url"),
                "bucket_name": t.get("bucket_name"), "hdd": hdd,
                "est": t.get("est"), "logged": t.get("logged", 0), "progress": t.get("progress", 0),
                "designer_bc_id": d["bc_id"], "designer_name": d["name"],
                "designer_slack_id": d.get("slack_id"),
            })
    claimed = set(store.claim_at_risk_notifications([c["todo_id"] for c in candidates], today))
    return [c for c in candidates if c["todo_id"] in claimed]


@app.get("/api/priority-todos")
async def api_get_priority_todos():
    return store.get_priority_todos()


@app.post("/api/priority-todos")
async def api_add_priority_todo(request: Request):
    body = await request.json()
    text = str(body.get("text", "")).strip()[:500]
    if not text:
        return Response(status_code=400)
    return store.add_priority_todo(text)


@app.put("/api/priority-todos/order")
async def api_set_priority_todo_order(request: Request):
    body = await request.json()
    ids = body.get("ids", [])
    if not isinstance(ids, list):
        return {"ok": False, "error": "ids required"}
    store.set_priority_todo_order([int(i) for i in ids])
    return {"ok": True}


@app.put("/api/priority-todos/{todo_id}")
async def api_update_priority_todo(todo_id: int, request: Request):
    body = await request.json()
    if "text" in body:
        text = str(body["text"]).strip()[:500]
        if not text:
            return Response(status_code=400)
        row = store.set_priority_todo_text(todo_id, text)
    elif "done" in body:
        row = store.set_priority_todo_done(todo_id, bool(body["done"]))
    else:
        return Response(status_code=400)
    if not row:
        return Response(status_code=404)
    return row


@app.delete("/api/priority-todos/{todo_id}")
async def api_delete_priority_todo(todo_id: int):
    store.delete_priority_todo(todo_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# QA checklists — per-service templates and completed certificates
# ---------------------------------------------------------------------------

@app.get("/api/qa/templates")
async def api_get_qa_templates():
    templates = store.get_qa_templates()
    # Keep a stable, sensible order in the response (insertion order of
    # DEFAULT_QA_TEMPLATES) rather than whatever SQLite returns.
    ordered = {k: templates[k] for k in DEFAULT_QA_TEMPLATES if k in templates}
    for k, v in templates.items():
        if k not in ordered:
            ordered[k] = v
    return ordered


@app.put("/api/qa/templates/{service}")
async def api_set_qa_template(service: str, request: Request, pin: str = ""):
    if pin != "1868":
        return Response(status_code=403)
    body = await request.json()
    items = [str(i).strip() for i in body.get("items", []) if str(i).strip()]
    if not items:
        return {"ok": False, "error": "At least one checklist item is required"}
    store.set_qa_template(service, items)
    return {"ok": True, "items": items}


@app.get("/api/qa/certificates")
async def api_get_recent_qa_certificates(limit: int = 30):
    return store.get_recent_qa_certificates(limit)


@app.post("/api/qa/certificates")
async def api_create_qa_certificate(request: Request):
    import secrets
    body = await request.json()
    service = str(body.get("service", "")).strip()
    items = body.get("items", [])
    if not service or not isinstance(items, list) or not items:
        return Response(status_code=400)
    # "na" (not applicable to this stage/creative) satisfies the gate the
    # same as "checked" — only a real "unchecked" item blocks completion.
    if not all(isinstance(i, dict) and i.get("state") in ("checked", "na") for i in items):
        return {"ok": False, "error": "Every checklist item must be checked or marked N/A before completing QA"}
    cert_id = secrets.token_urlsafe(8)
    cert = store.create_qa_certificate(
        cert_id=cert_id,
        service=service,
        task_title=str(body.get("task_title", "")).strip()[:300],
        client_name=str(body.get("client_name", "")).strip()[:200],
        completed_by=str(body.get("completed_by", "")).strip()[:100],
        # Preserve the real per-item state (checked vs na) rather than
        # collapsing everything to checked — the gate above already
        # guarantees only those two values ever reach here.
        items=[{"text": str(i.get("text", "")), "state": i.get("state")} for i in items],
        notes=str(body.get("notes", "")).strip()[:2000],
    )
    return {"ok": True, "id": cert_id, "url": f"/qa/cert/{cert_id}"}


@app.get("/api/qa/certificates/{cert_id}")
async def api_get_qa_certificate(cert_id: str):
    cert = store.get_qa_certificate(cert_id)
    if not cert:
        return Response(status_code=404)
    return cert


@app.get("/qa/cert/{cert_id}")
async def qa_cert_page(cert_id: str):
    # Public, unauthenticated — this is the shareable link posted into Basecamp.
    return FileResponse("static/qa-cert.html", headers={"Cache-Control": "no-cache, must-revalidate"})


@app.put("/api/estimate-goals")
async def api_set_estimate_goal(request: Request, pin: str = ""):
    if pin != "1868":
        return Response(status_code=403)
    body = await request.json()
    category = body.get("category")
    goal = body.get("goal_hours")
    if category not in CATEGORIES or goal is None:
        return {"ok": False, "error": "category and goal_hours required"}
    try:
        goal = float(goal)
    except (TypeError, ValueError):
        return {"ok": False, "error": "goal_hours must be a number"}
    store.set_estimate_goal(category, goal)
    return {"ok": True, "category": category, "goal": goal}


@app.post("/api/analytics/reconcile-logged-hours")
async def api_reconcile_logged_hours(pin: str = "", debug_todo_id: str = ""):
    """One-time-or-repeatable fix for historical completions whose logged_hours
    were captured from a stale todo_tracking snapshot (see _fresh_logged_hours) —
    re-reads Everhour's current total per (todo, designer) and corrects any
    completion record that no longer matches. Rate-limited against Everhour."""
    if pin != "1868":
        return Response(status_code=403)
    completions = store.get_analytics_completions()

    if debug_todo_id:
        rows = [r for r in completions if r["todo_id"] == debug_todo_id]
        if not rows:
            return {"ok": False, "error": "no completion row for that todo_id"}
        row = rows[0]
        designer = next((d for d in DESIGNERS if str(d["bc_id"]) == str(row["designer_bc_id"])), None)
        out = {"row": row, "designer_match": designer}
        if designer and designer.get("eh_id") and eh.EH_KEY:
            try:
                fresh = await asyncio.wait_for(eh.get_time_logged(debug_todo_id), timeout=10.0)
                out["fresh_everhour_result"] = fresh
                out["fresh_val_for_this_designer"] = fresh.get("user_logged", {}).get(str(designer["eh_id"]))
            except Exception as e:
                out["fetch_error"] = f"{type(e).__name__}: {e}"
        return out
    # Confirmed live: at concurrency 3 Everhour rate-limited most of a 348-row
    # sweep, and get_time_logged() swallows non-200s as "no data" rather than
    # raising — 281/348 rows silently came back empty, not actually unchanged.
    # get_time_logged_strict() raises instead, so slower + real retries here
    # actually work.
    sem = asyncio.Semaphore(2)

    async def _fetch_with_retry(todo_id, attempts=4):
        last_err = None
        for i in range(attempts):
            try:
                return await asyncio.wait_for(eh.get_time_logged_strict(todo_id), timeout=10.0)
            except Exception as e:
                last_err = e
                if i < attempts - 1:
                    await asyncio.sleep(1.5 * (i + 1))
        raise last_err

    async def _check(row):
        designer = next((d for d in DESIGNERS if str(d["bc_id"]) == str(row["designer_bc_id"])), None)
        if not designer or not designer.get("eh_id") or not eh.EH_KEY:
            return {"skipped": True}
        async with sem:
            try:
                fresh = await _fetch_with_retry(row["todo_id"])
            except Exception as e:
                return {"error": True, "todo_id": row["todo_id"], "designer_name": row["designer_name"],
                        "category": row["category"], "reason": f"{type(e).__name__}: {e}"}
        fresh_val = fresh.get("user_logged", {}).get(str(designer["eh_id"]))
        if fresh_val is None:
            return {"skipped": True}
        old_val = row.get("logged_hours") or 0
        if abs(fresh_val - old_val) < 0.01:
            return {"unchanged": True}
        changed = store.update_completion_logged_hours(row["todo_id"], row["designer_bc_id"], fresh_val)
        return {
            "updated": True, "todo_id": row["todo_id"], "designer_name": row["designer_name"],
            "category": row["category"], "title": row["title"][:60],
            "old": old_val, "new": fresh_val,
        } if changed else {"unchanged": True}

    checked = await asyncio.gather(*[_check(r) for r in completions])
    changes = [c for c in checked if c.get("updated")]
    errors = [c for c in checked if c.get("error")]
    unchanged = [c for c in checked if c.get("unchanged")]
    skipped = [c for c in checked if c.get("skipped")]
    by_category = defaultdict(lambda: {"count": 0, "delta": 0.0})
    for c in changes:
        by_category[c["category"]]["count"] += 1
        by_category[c["category"]]["delta"] += c["new"] - c["old"]

    return {
        "ok": True, "total_completions": len(completions), "updated": len(changes),
        "errored": len(errors), "unchanged": len(unchanged), "skipped": len(skipped),
        "by_category": dict(by_category),
        "changes": changes, "errors": errors,
    }


@app.delete("/api/analytics/completions/{todo_id}/{designer_bc_id}")
async def api_delete_completion(todo_id: str, designer_bc_id: str, pin: str = ""):
    """Remove a historical completion recorded in error — the designer was
    unassigned/reassigned but the real deliverable wasn't actually finished."""
    if pin != "1868":
        return Response(status_code=403)
    return {"ok": store.delete_completion(todo_id, designer_bc_id)}


@app.put("/api/analytics/completions/{todo_id}/{designer_bc_id}/category")
async def api_recategorize_completion(todo_id: str, designer_bc_id: str, request: Request, pin: str = ""):
    """Fix a completion's category when the automatic title-keyword matcher
    mistagged it (e.g. a landing page ABOUT a branding service, not actual
    logo/branding creative work)."""
    if pin != "1868":
        return Response(status_code=403)
    body = await request.json()
    category = body.get("category")
    if category not in CATEGORIES:
        return {"ok": False, "error": "invalid category"}
    return {"ok": store.update_completion_category(todo_id, designer_bc_id, category)}


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

    # Find the todo and its person in the cache — designers plus Richard (My Stuff)
    cached_todo = None
    cached_designer = None
    people = list(_cached_data.get("designers", []))
    if _cached_data.get("me"):
        people.append(_cached_data["me"])
    for d in people:
        for t in d.get("todos", []):
            if str(t["id"]) == str(todo_id):
                cached_todo = t
                cached_designer = d
                break

    # Not assigned to anyone yet (To Delegate tab) — only category edits
    # reach here, but still patch the live cache so it doesn't get
    # clobbered by the auto-guessed category until the next full refresh.
    if cached_todo is None:
        for t in _cached_data.get("unassigned", []):
            if str(t["id"]) == str(todo_id):
                cached_todo = t
                break

    return await _apply_todo_fields(todo_id, body, cached_todo, cached_designer)


@app.put("/api/todos/{todo_id}/spotlight")
async def set_todo_spotlight(todo_id: str, request: Request):
    """Toggle spotlight on Richard's own My Stuff todos (same cache lookup
    as set_todo_fields, but only 'me' has a spotlight list here — other
    designers' spotlights are only ever touched via their own token page)."""
    body = await request.json()
    me = _cached_data.get("me")
    if not me or not any(str(t["id"]) == str(todo_id) for t in me.get("todos", [])):
        return Response(status_code=404)
    return store.set_spotlight(str(me["bc_id"]), str(todo_id), bool(body.get("on")))


async def _apply_todo_fields(todo_id: str, body: dict, cached_todo, cached_designer):
    """Shared field-update core used by the manager and designer endpoints."""
    allowed = {"hdd", "est", "true_est", "due_on", "logged", "category", "reply_needed"}

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

        elif (field == "logged" and value is not None and value != ""
              and cached_designer and cached_designer.get("bc_id") in LOGGED_SYNC_BC_IDS):
            # Same source-of-truth pattern as est: on a successful Everhour
            # write, drop the local override so the real synced value takes
            # over on the next refresh instead of shadowing it. The typed
            # value is the person's new TOTAL on this task, not a delta —
            # log_user_time() does the current-vs-new diffing against
            # Everhour itself, since Everhour's API only adds/removes.
            eh_id = cached_designer.get("eh_id")
            wrote = False
            if eh_id:
                # Everhour rate-limits under load (already hit this exact
                # 429 live — see commit eabe3c9) and log_user_time() always
                # re-reads current state fresh before deciding what to
                # write, so retrying the whole call from scratch is safe
                # even if a prior attempt got partway through.
                last_err = None
                for attempt in range(3):
                    try:
                        wrote = await eh.log_user_time(todo_id, eh_id, float(value))
                        break
                    except Exception as e:
                        last_err = e
                        if attempt < 2:
                            await asyncio.sleep(1.5 * (attempt + 1))
                if not wrote and last_err:
                    print(f"[logged-sync] Everhour write failed for todo {todo_id} after retries: {type(last_err).__name__}: {last_err}")
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


def _compute_estimate_guide(personal_bc_id: str | None = None) -> dict:
    """Per-category estimate guide: company-wide median + Richard's goal,
    plus one designer's own personal median when personal_bc_id is given."""
    completions = store.get_analytics_completions()
    by_cat = defaultdict(list)
    personal_by_cat = defaultdict(list)
    for c in completions:
        hours = c.get("logged_hours")
        if not hours or hours <= 0:
            continue
        cat = c.get("category") or "Misc."
        by_cat[cat].append(hours)
        if personal_bc_id and str(c.get("designer_bc_id")) == str(personal_bc_id):
            personal_by_cat[cat].append(hours)

    goals = store.get_estimate_goals()
    out = {}
    for cat in CATEGORIES:
        vals = by_cat.get(cat, [])
        n = len(vals)
        company_median = round(statistics.median(vals), 1) if n else None
        stored_goal = goals.get(cat)
        goal_stored = stored_goal is not None
        # No explicit goal yet: suggest the company median as a starting
        # point once there's enough history to trust it; otherwise blank —
        # Richard sets the standard himself for a thin-data category
        goal = stored_goal if goal_stored else (
            company_median if n >= ESTIMATE_GUIDE_MIN_N else None)
        entry = {
            "goal": goal, "goal_stored": goal_stored,
            "company_median": company_median, "company_n": n,
            "timeline": CATEGORY_TIMELINE.get(cat),
        }
        if personal_bc_id is not None:
            pvals = personal_by_cat.get(cat, [])
            entry["personal_median"] = round(statistics.median(pvals), 1) if pvals else None
            entry["personal_n"] = len(pvals)
        out[cat] = entry
    return out


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


# Basecamp project names already carry "(tier)(AM initials)" as a suffix —
# e.g. "Franklin Family Dental-TN(1)(BW)" — the same tagging cleanClient()
# in shared.js strips for display. This is a search, not an end anchor, so
# it still finds the tag on the rare name with something trailing after it
# (e.g. "Mirror Lake - GDP (1)(TS) (WF)"). Internal/personal buckets (DR
# Team: Creative, Teammate: X, Marketing: Digital Resource) never match,
# which is exactly how "is this a real client" gets decided below — no
# separate exclusion list needed.
_TIER_AM_RE = re.compile(r"\((\d+\+?)\)\(([A-Z]+)\)")
_CLIENT_SUFFIX_RE1 = re.compile(r"\s*\(\d+\+?\)\([A-Z]+\)\s*$")
_CLIENT_SUFFIX_RE2 = re.compile(r"\s*\(\d+\+?\)\s*$")


def _clean_client_name(bucket_name: str) -> str:
    s = bucket_name or ""
    s = _CLIENT_SUFFIX_RE1.sub("", s)
    s = _CLIENT_SUFFIX_RE2.sub("", s)
    return s.strip()


_BC_URL_PREFIX_RE = re.compile(r"^(.+/buckets/\d+)/todos/\d+")


@app.get("/api/analytics/clients")
async def api_analytics_clients():
    """Per-client rollup for the Analytics tab: tier + AM (parsed from the
    Basecamp project name), total hours logged, distinct project count,
    and the list of project titles themselves (for the expand-per-client
    view). Spend isn't tracked anywhere in Basecamp or this app's own data
    — it lives in Salesforce/DR Pulse. Richard's call (2026-08-24): ship
    this without it for now and wire spend in later once that's reachable
    again; the column is included as null so the frontend can render it as
    "pending" rather than needing a shape change later.

    Sources one todo-level map first (historical completions, then live
    active/unassigned data overwriting by id) so a task is never counted
    or hour-summed twice even if it briefly appears in both.

    Historical completions never had a Basecamp URL stored (only the live
    active/unassigned data does), so a completed task from a client with
    no currently active work has no way to construct one — those render
    as plain text on the frontend rather than a broken link. For a client
    that DOES still have live work, its bucket_id doesn't change over
    time, so the URL prefix from any one live task is reused to build a
    real, correct link for that client's other, otherwise URL-less,
    completed tasks too."""
    todos_by_id: dict[str, dict] = {}
    for row in store.get_analytics_completions():
        todos_by_id[str(row.get("todo_id"))] = {
            "bucket_name": row.get("client_name"),
            "title": row.get("title"),
            "url": None,
            "hours": row.get("logged_hours") or 0,
        }
    for d in _cached_data.get("designers", []):
        for t in d.get("todos", []):
            todos_by_id[str(t["id"])] = {
                "bucket_name": t.get("bucket_name"),
                "title": t.get("title"),
                "url": t.get("url"),
                "hours": t.get("logged") or 0,
            }
    for t in _cached_data.get("unassigned", []):
        todos_by_id.setdefault(str(t["id"]), {
            "bucket_name": t.get("bucket_name"),
            "title": t.get("title"),
            "url": t.get("url"),
            "hours": 0,
        })

    clients: dict[str, dict] = {}
    for tid, info in todos_by_id.items():
        bn = info["bucket_name"]
        m = _TIER_AM_RE.search(bn or "")
        if not m:
            continue
        name = _clean_client_name(bn)
        c = clients.setdefault(name, {
            "name": name, "tier": m.group(1), "am": m.group(2),
            "hours": 0.0, "project_count": 0, "todos": [],
        })
        c["hours"] += info["hours"] or 0
        c["project_count"] += 1
        c["todos"].append({"id": tid, "title": info["title"], "url": info["url"]})

    out = []
    for c in clients.values():
        prefix = next((_BC_URL_PREFIX_RE.match(t["url"]).group(1)
                        for t in c["todos"] if t["url"] and _BC_URL_PREFIX_RE.match(t["url"])), None)
        if prefix:
            for t in c["todos"]:
                if not t["url"]:
                    t["url"] = f"{prefix}/todos/{t['id']}"
        c["todos"].sort(key=lambda t: (t["title"] or "").lower())
        out.append({**c, "hours": round(c["hours"], 1), "spend": None})

    out.sort(key=lambda c: c["hours"], reverse=True)
    return out


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

class NoCacheStaticFiles(StaticFiles):
    """Force revalidation on every request. Without this, browsers apply
    heuristic caching to JS/CSS with no explicit Cache-Control header —
    a tab left open across a deploy silently keeps running stale code
    (this bit us: a shipped feature was invisible until a hard refresh)."""
    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
        return resp


app.mount("/static", NoCacheStaticFiles(directory="static"), name="static")


@app.get("/", response_class=HTMLResponse)
async def root():
    with open("static/index.html") as f:
        return HTMLResponse(f.read(), headers={"Cache-Control": "no-cache, must-revalidate"})
