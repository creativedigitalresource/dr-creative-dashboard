/* ============================================================
   Designer view — one person's week, token-scoped.
   Sees: own capacity, own tasks, own planner, own attention items.
   Never sees other designers, the delegation queue, or analytics —
   UNLESS delegate_enabled (main.py DELEGATE_ENABLED_BC_IDS) grants
   temporary delegation coverage: To Delegate, Team Pulse, Team Spotlight.
   ============================================================ */

const TOKEN = (() => {
  const m = location.pathname.match(/\/my\/([^/]+)/);
  return m ? m[1] : new URLSearchParams(location.search).get("token");
})();

// This page's reference guide — see renderGuide/toggleGuideSection in
// shared.js for the rendering mechanics. Content only lives here.
const TEAM_GUIDE_SECTIONS = [
  {
    id: "week",
    title: "My Week",
    subtitle: "Your day planner",
    body: `
      <p>Monday through Friday, drag a task card between days to reschedule it — that updates the due date in Basecamp right away. The ring in each day's header fills up as that day gets more hours scheduled into it.</p>
      <p>Tasks with a hard due date past their scheduled date get a small warning badge — that's a heads up, not a block, since sometimes life happens and it's fine, just worth noticing.</p>
      <p>"Unscheduled" on the left holds anything without a day assigned yet, plus anything back for revisions (those don't get forced onto a specific day — the deadline is set deliberately when you're ready, not automatically).</p>
    `,
  },
  {
    id: "spotlight",
    title: "Spotlight",
    subtitle: "This is your standup now — no separate posting step",
    body: `
      <p>Click the star on up to 10 tasks to pin them to the top of your page. That's it — there's no daily "post" button anymore and no timestamp to keep current. Whatever's spotlighted right now <em>is</em> what you're signaling as your current focus, both on your own page and on the manager's Team Spotlight view.</p>
      <p>Worth keeping in mind: since there's no daily reset, an old spotlighted task will just sit there looking current until you swap it out yourself — it's on you to keep it reflecting what you're actually working on.</p>
    `,
  },
  {
    id: "coverage",
    title: "To Delegate / Team Pulse (coverage access only)",
    subtitle: "Only visible if you've been given delegation coverage",
    body: `
      <p>If you see extra tabs above (To Delegate, Team Pulse) beyond My Week and Spotlight, Richard has temporarily given you visibility into the unassigned queue and everyone's capacity — usually while he's out. To Delegate works exactly like his own tab; Team Pulse is a read-only view of the whole team's load.</p>
    `,
  },
  {
    id: "qa",
    title: "QA Checklist",
    subtitle: "If enabled for you — check items off or mark N/A",
    body: `
      <p>Pick a service, work through the checklist. Each item has two buttons: <strong>✓ Done</strong> when you've actually verified it, or <strong>N/A</strong> when it just doesn't apply to this stage or this piece of creative — both count as satisfied, only a real untouched item blocks you from finishing. Tap the same button again to undo it.</p>
      <p>Finishing the checklist gives you a shareable certificate link — paste that into the Basecamp to-do as your sign-off.</p>
    `,
  },
  {
    id: "everhour",
    title: "Everhour button",
    subtitle: "One click to log time on a specific task",
    body: `<p>Next to any logged-hours number, there's a small green circular button — click it to open that exact task in Everhour, in a new tab, ready to add time. No more hunting for the right task.</p>`,
  },
  {
    id: "refresh",
    title: "Refresh",
    subtitle: "Only pulls your own data, not the whole team",
    body: `<p>Your Refresh button only re-fetches your own tasks — a couple of seconds, not the ~20 second team-wide refresh the manager dashboard sometimes needs.</p>`,
  },
];

// Designer commit hook for the shared inline editors. Own todos write
// through the token-scoped endpoint (server-validates the todo belongs to
// this designer); a delegate-enabled To Delegate edit is for a todo that
// isn't hers, so it goes through the same open endpoint the manager
// dashboard uses instead — the token endpoint would 403 it.
window.__commitField = async (todoId, field, val) => {
  const own = (_me?.todos || []).find(x => String(x.id) === String(todoId));
  const endpoint = own ? `/api/my/${TOKEN}/todos/${todoId}/fields` : `/api/todos/${todoId}/fields`;
  fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [field]: val || null }),
  });
  if (own) applyFieldLocal(own, field, val);
  for (const t of _unassignedData || []) {
    if (String(t.id) === String(todoId)) applyFieldLocal(t, field, val);
  }
  renderMe();
};

// Designer commit hook for the shared spotlight star (shared.js toggleSpotlight)
window.__commitSpotlight = async (todoId, on) => {
  const res = await fetch(`/api/my/${TOKEN}/todos/${todoId}/spotlight`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ on }),
  }).then(r => r.json()).catch(() => null);
  if (res && res.ok === false) return; // at cap — star is disabled client-side already, this is just a race guard
  const t = (_me?.todos || []).find(x => String(x.id) === String(todoId));
  if (t) t.is_spotlighted = on;
  renderMe();
};

let _me = null;
let _dragId = null;
let _mySort = { key: "hdd", dir: "asc" };
function setMySort(key) {
  _mySort = _mySort.key === key
    ? { key, dir: _mySort.dir === "asc" ? "desc" : "asc" }
    : { key, dir: "asc" };
  renderMe();
}

async function loadMe() {
  const r = await fetch(`/api/my/${TOKEN}`);
  if (!r.ok) {
    document.getElementById("my-root").innerHTML =
      `<div class="loading-card">This link isn't valid. Ask Richard for a fresh one.</div>`;
    return;
  }
  const data = await r.json();
  if (data.warming) {
    document.getElementById("my-root").innerHTML =
      `<div class="loading-card">Fetching your week from Basecamp — up to a minute after a fresh deploy…</div>`;
    setTimeout(loadMe, 10000);
    return;
  }
  _me = data;
  renderMe();
  if (_me.delegate_enabled) document.getElementById("my-tab-nav").style.display = "";
  const lu = document.getElementById("last-updated");
  if (lu && _me.last_updated) {
    lu.textContent = "Updated " + new Date(_me.last_updated * 1000)
      .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
}

/* ---- Delegation coverage tabs (delegate_enabled only) — To Delegate and
   Team Spotlight reuse the exact shared.js functions the manager dashboard
   uses (same #unassigned-list/#team-spotlight-root ids); Team Pulse reuses
   the same roster+attention renderer as the manager's Overview tab, scoped
   with ctx="delegate" so its sort/expand state never collides with the
   manager's own "manager"-ctx state (see shared.js).

   "guide" isn't delegate-gated — it's reachable by every designer via the
   header button (#my-tab-nav itself stays hidden unless delegate_enabled,
   but this function works the same regardless of which button called it). ---- */
function switchMyTab(tab) {
  document.querySelectorAll("#my-tab-nav .tab-btn").forEach(b => b.classList.toggle("active", b.dataset.mytab === tab));
  document.getElementById("my-root").style.display = tab === "week" ? "" : "none";
  ["delegate", "pulse", "spotlight", "guide"].forEach(t =>
    document.getElementById(`tab-${t}`).classList.toggle("active", tab === t));
  if (tab === "delegate") loadUnassigned();
  if (tab === "pulse") loadMyPulse();
  if (tab === "spotlight") loadTeamSpotlight();
  if (tab === "guide") renderGuide("guide-root", TEAM_GUIDE_SECTIONS);
}

let _pulseDesignerData = [];

async function loadMyPulse() {
  const designers = await fetch("/api/designers").then(r => r.json()).catch(() => []);
  _pulseDesignerData = designers;
  renderMyPulse();
}

function renderMyPulse() {
  const rowsEl = document.getElementById("my-pulse-rows");
  const gridEl = document.getElementById("my-attention-grid");
  if (!rowsEl || !gridEl || !_pulseDesignerData.length) return;
  const stats = _pulseDesignerData.map(d => ({ d, s: _overviewStats(d, 0) }));
  stats.sort((a, b) => _pulseSort.delegate === "free" ? b.s.free - a.s.free : b.s.pct - a.s.pct);
  rowsEl.innerHTML = stats.map(({ d, s }) => renderPulseItem(d, s, "delegate")).join("");
  gridEl.innerHTML = renderAttention(stats);
}

function myRefresh() {
  const btn = document.getElementById("refresh-btn");
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="refresh-spin">&#8635;</span> Refreshing…`; }
  fetch(`/api/my/${TOKEN}/refresh`, { method: "POST" })
    .then(loadMe)
    .catch(() => loadMe())
    .finally(() => {
      if (btn) { btn.disabled = false; btn.innerHTML = "&#8635; Refresh"; }
    });
}

function renderMe() {
  const d = _me;
  const root = document.getElementById("my-root");
  const egWasOpen = document.getElementById("estimate-guide-panel")?.classList.contains("open");
  document.getElementById("my-subtitle").textContent = `My Week · ${d.name}`;
  const { weekly_est, cap, pct, pto_days } = calcCapacity(d.todos, d.pto, 0);
  const free = Math.round((cap - weekly_est) * 10) / 10;
  const barCls = pct < 60 ? "low" : pct < 85 ? "mid" : "high";
  const active = (d.todos || []).filter(t => !t.is_complete && !t.is_misc);

  const kudos = d.kudos || [];
  const ticker = kudos.length ? `
    <div class="kudos-ticker" id="kudos-ticker">
      <span class="kudos-label">&#127881; Kudos</span>
      <div class="kudos-wheel" id="kudos-wheel"></div>
    </div>` : "";
  const mm = d.manager_message;
  const mmBanner = mm ? `
    <div class="mm-banner">
      <div class="mm-head">Message of the week &middot; Richard &middot; ${new Date(mm.at * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>
      <div class="mm-text">${esc(mm.text)}</div>
    </div>` : "";
  const shipped = d.shipped_week ? ` &middot; ${d.shipped_week} shipped this week` : "";
  const spotlightCount = active.filter(t => t.is_spotlighted).length;
  const sorted = sortTodos(active, _mySort.key, _mySort.dir);

  root.innerHTML = `
    ${ticker}
    ${mmBanner}
    ${buildSpotlightSection(active, d.color, d.eh_id)}
    <div class="pulse-panel">
      <div class="my-pulse">
        ${avatarHTML(d)}
        <div class="my-pulse-info">
          <div class="pulse-name">${esc(d.name)}</div>
          <div class="my-pulse-sub">${active.length} active task${active.length === 1 ? "" : "s"} this week${pto_days ? ` · ${pto_days} OOO day${pto_days > 1 ? "s" : ""}` : ""}${shipped}</div>
        </div>
        <div class="pulse-bar-wrap my-pulse-bar">
          <div class="cap-bar-outer"><div class="cap-bar-inner ${barCls}" style="width:${Math.min(100, pct)}%"></div></div>
          <span class="pulse-pct">${pct}%</span>
        </div>
        <div class="pulse-free ${free <= 2 ? "low" : free <= 8 ? "mid" : "ok"}">${free < 0 ? Math.abs(free) + "h over" : free + "h free"}</div>
      </div>
      <div class="my-table-wrap">${buildTaskTable(sorted, d.color, {
        spotlight: { atCap: spotlightCount >= SPOTLIGHT_MAX },
        sort: _mySort.key ? _mySort : null,
        sortFn: "setMySort",
        ehId: d.eh_id,
      })}</div>
    </div>
    <div class="pulse-panel">
      <div class="cap-chart-title" style="margin-bottom:4px">This Week</div>
      <div class="cap-chart-sub" style="margin-bottom:12px">Drag a task onto a day to schedule it — the due date updates in Basecamp.</div>
      <div class="my-planner" id="my-planner"></div>
    </div>
    <div class="attention-grid" id="my-attention"></div>
    <div class="pulse-panel">
      <div class="cap-chart-title" style="margin-bottom:4px">Notepad</div>
      <div class="cap-chart-sub" style="margin-bottom:10px">Yours alone — saves as you type.</div>
      <textarea id="my-notes" class="my-notes" placeholder="Scratch space: links, to-dos, reminders…">${esc(d.notes || "")}</textarea>
      <div class="my-notes-status" id="my-notes-status"></div>
    </div>
    ${estimateGuidePanelHTML(
      buildEstimateGuide(d.estimate_guide, { personal: true }),
      "How long each type of work should take, and your own pace against it. Use this when you're self-delegating or scoping a revision."
    )}
    ${d.qa_enabled ? `
    <div class="pulse-panel">
      <div class="cap-chart-title" style="margin-bottom:4px">QA Checklist</div>
      <div class="cap-chart-sub" style="margin-bottom:12px">Pick the service you're QA'ing, work through the checklist, then complete it to get a shareable certificate link for the Basecamp to-do.</div>
      <div id="qa-root">
        <div class="loading-card">Loading checklists…</div>
      </div>
    </div>` : ""}`;
  if (egWasOpen) document.getElementById("estimate-guide-panel")?.classList.add("open");
  renderMyPlanner();
  renderMyAttention(active, d.color);
  initNotes();
  initKudosWheel();
  if (d.qa_enabled) renderQaMount();
}

let _notesTimer = null;
function initNotes() {
  const ta = document.getElementById("my-notes");
  if (!ta) return;
  ta.addEventListener("input", () => {
    _me.notes = ta.value;
    clearTimeout(_notesTimer);
    document.getElementById("my-notes-status").textContent = "…";
    _notesTimer = setTimeout(async () => {
      await fetch(`/api/my/${TOKEN}/notes`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: ta.value }),
      });
      document.getElementById("my-notes-status").textContent = "Saved";
      setTimeout(() => { const s = document.getElementById("my-notes-status"); if (s) s.textContent = ""; }, 1500);
    }, 800);
  });
}

let _kudosTimer = null;
const KUDOS_HOLD_MS = 6500; // how long each shout-out sits centered before rolling on

// Watch-crown wheel: the next kudos rolls in from above, settles in the
// middle, holds, then rolls down and out as its successor arrives
function initKudosWheel() {
  const wheel = document.getElementById("kudos-wheel");
  clearInterval(_kudosTimer);
  if (!wheel) return;
  const kudos = _me.kudos || [];
  if (!kudos.length) return;

  const make = k => {
    const a = document.createElement("a");
    a.className = "kudos-item";
    a.target = "_blank";
    a.href = k.permalink || "#";
    a.textContent = `"${truncate(k.text, 140)}" — ${k.author}`;
    return a;
  };

  let idx = 0;
  let cur = make(kudos[0]);
  cur.classList.add("center");
  wheel.replaceChildren(cur);
  if (kudos.length < 2) return;

  _kudosTimer = setInterval(() => {
    idx = (idx + 1) % kudos.length;
    const next = make(kudos[idx]);
    next.classList.add("above");
    wheel.appendChild(next);
    const old = cur;
    cur = next;
    // double rAF: paint the off-screen position first, then transition
    requestAnimationFrame(() => requestAnimationFrame(() => {
      old.classList.replace("center", "below");
      next.classList.replace("above", "center");
    }));
    setTimeout(() => old.remove(), 1000);
  }, KUDOS_HOLD_MS);
}

function renderMyAttention(active, color) {
  const today = localISO(new Date());
  const soon = localISO(new Date(Date.now() + 2 * 86400000));
  const pastDue = [], atRisk = [], decisions = [];

  for (const t of active) {
    if (t.in_revisions) { decisions.push({ t, kind: "revision" }); continue; }
    if (t.hdd && t.hdd < today) {
      const days = Math.round((new Date(today) - new Date(t.hdd)) / 86400000);
      pastDue.push({ t, days });
    } else if (t.hdd && t.hdd <= soon && (t.progress || 0) < 50) {
      atRisk.push({ t });
    }
    const stepDone = t.designer_step && t.designer_step.completed;
    if (!stepDone && t.true_est == null && t.est > 0 && (t.logged || 0) >= t.est) {
      decisions.push({ t, kind: "trueest" });
    }
    if (t.est == null) decisions.push({ t, kind: "missing", what: "EST" });
    else if (!t.has_hdd && !t.in_revisions) decisions.push({ t, kind: "missing", what: "HDD" });
  }
  pastDue.sort((a, b) => b.days - a.days);
  atRisk.sort((a, b) => a.t.hdd.localeCompare(b.t.hdd));

  const row = (t, right) => {
    const inner = `<div class="attn-text">
        <div class="attn-client">${esc(cleanClient(t.bucket_name)) || "&nbsp;"}</div>
        <div class="attn-title">${esc(truncate(t.title, 52))}</div>
      </div>
      <div class="attn-right">${right}</div>`;
    return t.url ? `<a class="attn-row" href="${t.url}" target="_blank">${inner}</a>`
                 : `<div class="attn-row">${inner}</div>`;
  };
  const capList = rows => rows.slice(0, 8).join("") +
    (rows.length > 8 ? `<div class="attn-more">+${rows.length - 8} more</div>` : "");
  const panel = (label, rows, empty) => `
    <div class="attention-panel">
      <div class="attention-head">${label}${rows.length ? ` <span class="attention-count">${rows.length}</span>` : ""}</div>
      ${rows.length ? capList(rows) : `<div class="attention-empty">${empty}</div>`}
    </div>`;

  const pastRows = pastDue.map(({ t, days }) =>
    row(t, `<span class="ov-pill late">${fmtDate(t.hdd)}</span><span class="attn-days">${days}d late</span>`));
  const riskRows = atRisk.map(({ t }) =>
    row(t, `<span class="ov-pill soon">${fmtDate(t.hdd)}</span><span class="attn-days amber">${t.progress || 0}%</span>`));
  const decRows = decisions.map(item => {
    const t = item.t;
    if (item.kind === "revision") {
      let waiting = "";
      if (t.revisions_since) {
        const days = Math.max(0, Math.floor((Date.now() - new Date(t.revisions_since)) / 86400000));
        waiting = ` ${days}d`;
      }
      return row(t, `<span class="ov-pill revision">&#8617; waiting${waiting}</span>`);
    }
    if (item.kind === "trueest") return row(t, `<span class="ov-pill needed">+${t.over_by}h · True EST?</span>`);
    return row(t, `<span class="ov-pill needed">needs ${item.what}</span>`);
  });

  document.getElementById("my-attention").innerHTML =
    panel("Past Due", pastRows, "Nothing past due.") +
    panel("At Risk", riskRows, "Nothing at risk in the next two days.") +
    panel("Tidy Up", decRows, "Everything is tracked cleanly. Nice.");
}

function renderMyPlanner() {
  const d = _me;
  const mount = document.getElementById("my-planner");
  const { start } = getWeekBounds(0);
  const todayStr = localISO(new Date());
  const days = [];
  for (let i = 0; i < 5; i++) {
    const dt = new Date(start + "T12:00:00");
    dt.setDate(dt.getDate() + i);
    days.push(localISO(dt));
  }
  const active = (d.todos || []).filter(t => !t.is_complete && !t.is_misc);
  const byDay = {}; days.forEach(dt => byDay[dt] = []);
  const unscheduled = [];
  for (const t of active) {
    if (t.in_revisions) unscheduled.push(t);
    else if (t.due_on && byDay[t.due_on] !== undefined) byDay[t.due_on].push(t);
    else unscheduled.push(t);
  }
  // Apply the saved within-day order: top of the column = working on it first
  const order = d.planner_order || {};
  for (const dt of days) {
    const saved = order[dt] || [];
    byDay[dt].sort((a, b) => {
      const ia = saved.indexOf(String(a.id)), ib = saved.indexOf(String(b.id));
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
  }
  const dayHours = list => list.reduce((s, t) => s + Math.max(0, (t.est || 0) - (t.logged || 0)), 0);

  const card = t => `
    <div class="planner-card" draggable="true" id="my-card-${t.id}"
        ondragstart="myDragStart(event,'${t.id}')"
        ondragover="event.preventDefault()"
        ondrop="myDropOnCard(event,'${t.id}')">
      ${t.hdd && t.due_on && t.due_on > t.hdd ? `<div class="hdd-conflict" title="Scheduled after its hard due date — the HDD is ${fmtDate(t.hdd)}">&#9888; scheduled past HDD</div>` : ""}
      <div class="planner-card-client">${esc(cleanClient(t.bucket_name))}</div>
      <div class="planner-card-title">${esc(truncate(t.title, 52))}</div>
      <div class="planner-card-pills">
        ${t.hdd && !t.in_revisions ? `<span class="planner-pill hdd">HDD ${fmtDate(t.hdd)}</span>` : ""}
        ${t.in_revisions ? `<span class="planner-pill revision">&#8617; Revisions</span>` : ""}
        ${t.est != null ? `<span class="planner-pill est">EST ${t.est}h</span>` : ""}
        ${t.logged > 0 ? `<span class="planner-pill logged">${t.logged}h logged</span>` : ""}
      </div>
    </div>`;

  const zone = dt => `ondragover="event.preventDefault();event.currentTarget.classList.add('drag-over')"
    ondragleave="if(!event.currentTarget.contains(event.relatedTarget))event.currentTarget.classList.remove('drag-over')"
    ondrop="myDrop(event,${dt ? `'${dt}'` : "null"})"`;

  const cols = days.map(dt => {
    const date = new Date(dt + "T12:00:00");
    const hrs = Math.round(dayHours(byDay[dt]) * 10) / 10;
    return `<div class="planner-day-col${dt === todayStr ? " is-today" : ""}${dt < todayStr ? " is-past" : ""}" data-date="${dt}" ${zone(dt)}>
      <div class="planner-day-header">
        <div class="planner-day-name">${date.toLocaleDateString("en-US", { weekday: "short" })}</div>
        <div class="planner-day-date">${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>
        <div class="my-day-hours">${hrs}h</div>
      </div>
      ${byDay[dt].map(card).join("") || `<div class="planner-drop-hint">Drop here</div>`}
    </div>`;
  }).join("");

  mount.innerHTML = `
    <div class="planner-day-col my-unscheduled" ${zone(null)}>
      <div class="planner-day-header"><div class="planner-day-name">Unscheduled</div></div>
      ${unscheduled.map(card).join("") || `<div class="planner-drop-hint">Nothing waiting</div>`}
    </div>${cols}`;
}

function myDragStart(evt, id) { _dragId = id; }

function _dayOf(todo) {
  if (todo.in_revisions) return null;
  const { start } = getWeekBounds(0);
  const days = [];
  for (let i = 0; i < 5; i++) {
    const dt = new Date(start + "T12:00:00");
    dt.setDate(dt.getDate() + i);
    days.push(localISO(dt));
  }
  return days.includes(todo.due_on) ? todo.due_on : null;
}

function _columnIds(day) {
  // Current visual order of a day column, from the rendered DOM
  const cols = document.querySelectorAll(".my-planner .planner-day-col");
  for (const col of cols) {
    if (col.dataset.date === day) {
      return [...col.querySelectorAll(".planner-card")].map(c => c.id.replace("my-card-", ""));
    }
  }
  return [];
}

async function _saveOrder(day, ids) {
  _me.planner_order = _me.planner_order || {};
  _me.planner_order[day] = ids;
  await fetch(`/api/my/${TOKEN}/planner-order`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: day, ids }),
  });
}

async function _placeTask(id, targetDate, beforeId) {
  const todo = (_me.todos || []).find(t => String(t.id) === String(id));
  if (!todo || !targetDate) return;
  const fromDay = _dayOf(todo);
  const moved = todo.due_on !== targetDate;

  // Build the target day's new order
  const ids = _columnIds(targetDate).filter(x => x !== String(id));
  const at = beforeId ? ids.indexOf(String(beforeId)) : -1;
  if (at === -1) ids.push(String(id));
  else ids.splice(at, 0, String(id));

  if (moved) {
    const prev = todo.due_on;
    const wasRevision = todo.in_revisions;
    const payload = { due_on: targetDate };
    if (wasRevision) payload.hdd = targetDate; // scheduling a revision creates its Basecamp step
    todo.due_on = targetDate;
    if (wasRevision) { todo.hdd = targetDate; todo.in_revisions = false; todo.revisions_since = null; }
    try {
      const r = await fetch(`/api/my/${TOKEN}/todos/${id}/fields`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error("save failed");
    } catch {
      todo.due_on = prev;
      if (wasRevision) { todo.hdd = null; todo.in_revisions = true; }
      renderMe();
      return;
    }
  }
  await _saveOrder(targetDate, ids);
  if (moved && fromDay) await _saveOrder(fromDay, _columnIds(fromDay).filter(x => x !== String(id)));
  renderMe();
}

async function myDropOnCard(evt, targetId) {
  evt.preventDefault();
  evt.stopPropagation();
  const id = _dragId; _dragId = null;
  if (!id || String(id) === String(targetId)) return;
  const target = (_me.todos || []).find(t => String(t.id) === String(targetId));
  const day = target ? _dayOf(target) : null;
  if (!day) return; // reordering inside Unscheduled has no meaning
  await _placeTask(id, day, String(targetId));
}

async function myDrop(evt, targetDate) {
  evt.preventDefault();
  evt.currentTarget.classList.remove("drag-over");
  const id = _dragId; _dragId = null;
  if (!id || !targetDate) return;
  await _placeTask(id, targetDate, null);
}

if (!TOKEN) {
  document.getElementById("my-root").innerHTML =
    `<div class="loading-card">Missing access token.</div>`;
} else {
  loadMe();
  setInterval(loadMe, 90000);
}
