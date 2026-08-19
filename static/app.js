/* ============================================================
   DR Creative Dashboard — Frontend
   ============================================================ */

// PIN gate
(function() {
  const CORRECT = "1868";
  const KEY = "dr_dash_auth";
  function setupPin() {
    if (sessionStorage.getItem(KEY) === "1") return;
    const gate = document.getElementById("pin-gate");
    gate.classList.remove("hidden");
    const digits = gate.querySelectorAll(".pin-digit");
    digits.forEach((d, i) => {
      d.addEventListener("input", () => {
        d.value = d.value.replace(/\D/g, "").slice(-1);
        if (d.value && i < digits.length - 1) digits[i + 1].focus();
        const pin = Array.from(digits).map(x => x.value).join("");
        if (pin.length === 4) {
          if (pin === CORRECT) {
            sessionStorage.setItem(KEY, "1");
            gate.classList.add("hidden");
          } else {
            document.getElementById("pin-error").classList.remove("hidden");
            setTimeout(() => {
              digits.forEach(x => x.value = "");
              document.getElementById("pin-error").classList.add("hidden");
              digits[0].focus();
            }, 1200);
          }
        }
      });
      d.addEventListener("keydown", e => {
        if (e.key === "Backspace" && !d.value && i > 0) digits[i - 1].focus();
      });
    });
    digits[0].focus();
  }
  document.addEventListener("DOMContentLoaded", setupPin);
})();

let calendar = null;
let _modalTodoId = null;
let _weekOffset = 0;
let _lastClockHour = null;

function startClock() {
  const tick = () => {
    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true
    });
    const el = document.getElementById("est-clock");
    if (el) el.textContent = timeStr + " EST";

    const h = getESTHour();
    if (_lastClockHour !== null && _lastClockHour !== h) {
      // Hour flipped — re-render so 5 PM cutoff takes effect immediately
      renderDesignerGrid(_designerData);
    }
    _lastClockHour = h;
  };
  tick();
  setInterval(tick, 1000);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let _pollTimer = null;

async function boot() {
  try {
    const status = await fetch("/api/status").then(r => r.json()).catch(() => null);
    if (!status || !status.authenticated) {
      show("login-screen");
      hide("main-content");
      return;
    }
    hide("login-screen");
    show("main-content");
    startClock();
    initTabs();
    initCalendar();
    connectSSE();
    await loadAll();
    if (!status.last_updated || status.stale) {
      startPolling();
    }
  } catch (e) {
    const grid = document.getElementById("designer-grid");
    if (grid) grid.innerHTML = `<div class="loading-card" style="color:red;font-size:13px">
      <strong>Boot error:</strong> ${e.message || e}<br>
      <pre style="white-space:pre-wrap;font-size:11px">${e.stack || ""}</pre>
    </div>`;
    console.error("[boot]", e);
  }
}

function startPolling() {
  if (_pollTimer) return;
  const pollStart = Date.now();
  _pollTimer = setInterval(async () => {
    const s = await fetchWithTimeout("/api/status").then(r => r.json()).catch(() => null);
    if (!s) return;
    const done = !s.refreshing && s.last_updated;
    const timedOut = Date.now() - pollStart > 90000; // force reload after 90s
    if (done || timedOut) {
      clearInterval(_pollTimer);
      _pollTimer = null;
      await loadAll();
    }
  }, 3000);
}

// ---------------------------------------------------------------------------
// SSE — only used to push update notifications when refresh completes
// ---------------------------------------------------------------------------

function connectSSE() {
  const es = new EventSource("/api/stream");
  es.addEventListener("update", async () => {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    await loadAll();
  });
  es.onerror = () => { setTimeout(connectSSE, 10000); es.close(); };
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadAll() {
  await Promise.all([loadUnassigned(), loadDesigners(), loadMyStuff(), loadEstimateGuide()]);
  await loadCalendar();
  updateLastUpdated();
  resetRefreshBtn();
}

// ---------------------------------------------------------------------------
// Estimate Guide — company medians + Richard's per-category goals
// ---------------------------------------------------------------------------

let _estimateGuide = null;

async function loadEstimateGuide() {
  try {
    _estimateGuide = await fetchWithTimeout("/api/estimate-guide").then(r => r.json());
  } catch {
    _estimateGuide = null;
  }
  renderEstimateGuidePanel();
}

function renderEstimateGuidePanel() {
  const mount = document.getElementById("estimate-guide-mount");
  if (!mount || !_estimateGuide) return;
  const wasOpen = document.getElementById("estimate-guide-panel")?.classList.contains("open");
  mount.innerHTML = estimateGuidePanelHTML(
    buildEstimateGuide(_estimateGuide, { editable: true }),
    "Company-wide medians and the goal you set per category. Designers see their own pace measured against these goals — never against each other."
  );
  if (wasOpen) document.getElementById("estimate-guide-panel")?.classList.add("open");
}

async function commitEstimateGoal(category, value, inputEl) {
  const num = value === "" ? null : parseFloat(value);
  if (num == null || isNaN(num)) return; // leave the field as typed rather than guessing
  if (_estimateGuide[category]) {
    _estimateGuide[category].goal = num;
    _estimateGuide[category].goal_stored = true;
  }
  try {
    await fetch("/api/estimate-goals?pin=1868", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, goal_hours: num }),
    });
    if (inputEl) inputEl.value = num;
  } catch {
    // leave the input as typed; next load will reconcile with the server
  }
}

let _designerData = [];
let _workloadFilter = "all";
let _splitViewActive = false;
let _splitCalendar = null;

async function loadDesigners() {
  const designers = await fetchWithTimeout("/api/designers").then(r => r.json()).catch(() => []);
  if (!designers.length) {
    document.getElementById("designer-grid").innerHTML =
      `<div class="loading-card">Fetching from Basecamp — may take up to 60s on first load…</div>`;
    return;
  }
  _designerData = designers;
  renderDesignerGrid(designers);
  renderOverview();
}

function renderDesignerGrid(designers) {
  const filtered = _workloadFilter === "all"
    ? designers
    : designers.filter(d => String(d.bc_id) === _workloadFilter);

  // Single designer + current week → split: card left, day planner right
  if (filtered.length === 1 && _weekOffset === 0) {
    hide("designer-grid");
    show("split-view");
    document.getElementById("split-card-wrap").innerHTML =
      renderDesignerCard(filtered[0], !!_completedToggleState[filtered[0].bc_id]);
    renderDayPlanner(filtered[0]);
    populateDesignerDropdown();
    populateWorkloadDropdown();
    return;
  }

  if (_splitViewActive && filtered.length === 1) {
    renderSplitView(filtered[0]);
  } else {
    hide("split-view");
    show("designer-grid");
    document.getElementById("designer-grid").innerHTML =
      filtered.map(d => renderDesignerCard(d, !!_completedToggleState[d.bc_id])).join("");
  }

  populateDesignerDropdown();
  populateWorkloadDropdown();
}

// ---------------------------------------------------------------------------
// Day Planner — shown when a single designer is selected on the current week
// ---------------------------------------------------------------------------

let _draggedTodoId = null;

function renderDayPlanner(d) {
  const { start } = getWeekBounds(0);
  const todayStr  = localISO(new Date());

  // Build Mon–Fri date strings
  const days = [];
  const startD = new Date(start + "T12:00:00");
  for (let i = 0; i < 5; i++) {
    const day = new Date(startD);
    day.setDate(startD.getDate() + i);
    days.push(localISO(day));
  }

  const allActive = (d.todos || []).filter(t => !t.is_complete);

  // Bucket todos: assigned day or unscheduled
  const byDay = {};
  days.forEach(dt => (byDay[dt] = []));
  const unscheduled = [];
  for (const t of allActive) {
    if (t.in_revisions) unscheduled.push(t); // stale due_on is not a revision deadline
    else if (t.due_on && byDay[t.due_on] !== undefined) byDay[t.due_on].push(t);
    else unscheduled.push(t);
  }

  function dayHours(list) {
    return list.reduce((s, t) => s + Math.max(0, (t.total_hours || 0) - (t.logged || 0)), 0);
  }

  function capRing(hours, color) {
    const pct    = Math.min(100, hours / 6.5 * 100);
    const stroke = pct > 100 ? "var(--danger)" : pct >= 85 ? "var(--warning)" : pct >= 50 ? color : "var(--success)";
    const dash   = pct.toFixed(1);
    const gap    = (100 - Math.min(100, pct)).toFixed(1);
    return `<div class="planner-ring-wrap">
      <svg viewBox="0 0 36 36" class="planner-ring-svg">
        <circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--border)" stroke-width="3.8"/>
        <circle cx="18" cy="18" r="15.9" fill="none" stroke="${stroke}" stroke-width="3.8"
          stroke-dasharray="${dash} ${gap}" stroke-dashoffset="25"
          transform="rotate(-90 18 18)" style="transition:stroke-dasharray .3s"/>
      </svg>
      <div class="planner-ring-label">${Math.round(hours * 10) / 10}h</div>
    </div>`;
  }

  function plannerCard(t) {
    const client = (t.bucket_name || "")
      .replace(/\s*\(\d+\+?\)\([A-Z]+\)\s*$/, "").replace(/\s*\(\d+\+?\)\s*$/, "").trim();
    const hddBadge = t.hdd ? `<span class="planner-pill hdd">HDD ${fmtDate(t.hdd)}</span>` : "";
    const revBadge = t.in_revisions ? `<span class="planner-pill revision">↩ Revisions</span>` : "";
    const estBadge = t.est != null ? `<span class="planner-pill est">EST ${t.est}h</span>` : "";
    const logBadge = t.logged > 0 ? `<span class="planner-pill logged">${t.logged}h logged</span>` : "";
    return `<div class="planner-card" draggable="true"
        ondragstart="onPlannerDragStart(event,'${t.id}')"
        ondragend="onPlannerDragEnd(event)"
        id="planner-card-${t.id}"
        style="border-left:3px solid ${d.color}">
      ${client ? `<div class="planner-card-client">${esc(client)}</div>` : ""}
      <div class="planner-card-title">${esc(truncate(t.title, 52))}</div>
      <div class="planner-card-pills">${hddBadge}${revBadge}${estBadge}${logBadge}</div>
    </div>`;
  }

  function dropZoneAttrs(dt) {
    const dateArg = dt ? `'${dt}'` : "null";
    return `ondragover="onPlannerDragOver(event)" ondragleave="onPlannerDragLeave(event)" ondrop="onPlannerDrop(event,${dateArg})"`;
  }

  const dayColsHtml = days.map(dt => {
    const date     = new Date(dt + "T12:00:00");
    const dayName  = date.toLocaleDateString("en-US", { weekday: "short" });
    const dayLabel = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const isToday  = dt === todayStr;
    const isPast   = dt < todayStr;
    const hours    = dayHours(byDay[dt]);
    const todosHtml = byDay[dt].map(plannerCard).join("") ||
      `<div class="planner-drop-hint">Drop here</div>`;
    return `<div class="planner-day-col${isToday ? " is-today" : ""}${isPast ? " is-past" : ""}"
        data-date="${dt}" ${dropZoneAttrs(dt)}>
      <div class="planner-day-header">
        <div class="planner-day-name">${dayName}</div>
        <div class="planner-day-date">${dayLabel}</div>
        ${capRing(hours, d.color)}
      </div>
      <div class="planner-day-todos">${todosHtml}</div>
    </div>`;
  }).join("");

  const unschHtml = `<div class="planner-unscheduled" ${dropZoneAttrs(null)}>
    <div class="planner-unsched-header">Unscheduled · ${unscheduled.length}</div>
    <div class="planner-unsched-todos">${unscheduled.map(plannerCard).join("") || '<div class="planner-drop-hint">All tasks scheduled</div>'}</div>
  </div>`;

  const splitRight = document.querySelector("#split-view .split-right");
  if (splitRight) {
    splitRight.innerHTML = `<div class="day-planner" data-bc-id="${d.bc_id}">
      ${unschHtml}
      <div class="planner-day-cols">${dayColsHtml}</div>
    </div>`;
  }
}

function onPlannerDragStart(event, todoId) {
  _draggedTodoId = String(todoId);
  event.dataTransfer.effectAllowed = "move";
  setTimeout(() => event.target.classList.add("is-dragging"), 0);
}

function onPlannerDragEnd(event) {
  event.target.classList.remove("is-dragging");
  document.querySelectorAll(".planner-day-col.drag-over, .planner-unscheduled.drag-over")
    .forEach(el => el.classList.remove("drag-over"));
}

function onPlannerDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const zone = event.currentTarget;
  zone.classList.add("drag-over");
}

function onPlannerDragLeave(event) {
  // Only remove if leaving the zone itself, not a child
  if (!event.currentTarget.contains(event.relatedTarget)) {
    event.currentTarget.classList.remove("drag-over");
  }
}

async function onPlannerDrop(event, targetDate) {
  event.preventDefault();
  event.currentTarget.classList.remove("drag-over");

  const todoId = _draggedTodoId;
  _draggedTodoId = null;
  if (!todoId) return;

  const designer = (_designerData || []).find(d => String(d.bc_id) === _workloadFilter);
  if (!designer) return;
  const todo = designer.todos.find(t => String(t.id) === todoId);
  if (!todo || todo.due_on === targetDate) return;

  const prevDate = todo.due_on;
  const wasRevision = todo.in_revisions;
  todo.due_on = targetDate; // optimistic
  // Scheduling a revision-limbo task is the deadline decision — send hdd too,
  // which creates a Revision step in Basecamp for this designer
  const payload = { due_on: targetDate || "" };
  if (wasRevision && targetDate) {
    payload.hdd = targetDate;
    todo.hdd = targetDate;
    todo.in_revisions = false;
    todo.revisions_since = null;
  }
  renderDayPlanner(designer);

  try {
    const r = await fetch(`/api/todos/${todoId}/fields`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error("API error");
  } catch {
    todo.due_on = prevDate; // revert
    if (wasRevision) { todo.hdd = null; todo.in_revisions = true; }
    renderDayPlanner(designer);
  }
  renderOverview();
}

function populateWorkloadDropdown() {
  const sel = document.getElementById("workload-filter");
  if (!sel) return;
  const cur = sel.value;
  while (sel.options.length > 1) sel.remove(1);
  for (const d of _designerData || []) {
    const opt = document.createElement("option");
    opt.value = d.bc_id;
    opt.textContent = d.name;
    sel.appendChild(opt);
  }
  sel.value = cur || "all";
}

function onWorkloadFilterChange() {
  const sel = document.getElementById("workload-filter");
  _workloadFilter = sel ? sel.value : "all";
  const splitBtn = document.getElementById("split-btn");
  if (_workloadFilter !== "all") {
    splitBtn.classList.remove("hidden");
  } else {
    splitBtn.classList.add("hidden");
    _splitViewActive = false;
  }
  renderDesignerGrid(_designerData);
}

function toggleSplitView() {
  _splitViewActive = !_splitViewActive;
  const btn = document.getElementById("split-btn");
  btn.textContent = _splitViewActive ? "⊡ Single View" : "⊟ Split View";
  renderDesignerGrid(_designerData);
}

// ---------------------------------------------------------------------------
// Split view
// ---------------------------------------------------------------------------

function renderSplitView(d) {
  hide("designer-grid");
  show("split-view");

  // Left: designer card
  document.getElementById("split-card-wrap").innerHTML =
    renderDesignerCard(d, !!_completedToggleState[d.bc_id]);

  // Right: calendar
  if (!_splitCalendar) {
    _splitCalendar = new FullCalendar.Calendar(document.getElementById("split-calendar"), {
      initialView: "timeGridWeek",
      headerToolbar: { left: "prev,next today", center: "title", right: "" },
      height: "calc(100vh - 220px)",
      slotMinTime: "08:00:00",
      slotMaxTime: "18:00:00",
      slotDuration: "00:30:00",
      nowIndicator: true,
      eventClick(info) {
        const p = info.event.extendedProps;
        if (p.url) window.open(p.url, "_blank");
      },
      eventDidMount(info) {
        const p = info.event.extendedProps;
        if (!p.fullTitle) return;
        info.el.title = [p.fullTitle, p.hdd ? `HDD: ${fmtDate(p.hdd)}` : "",
          p.est ? `EST: ${p.est}h` : "", p.logged ? `Logged: ${p.logged}h` : ""].filter(Boolean).join("\n");
      },
      datesSet(info) {
        // Sync week offset from calendar navigation (use mid-week day to avoid Sun/Mon edge case)
        const mid = new Date(info.start);
        mid.setDate(mid.getDate() + 3);
        const newOffset = getOffsetFromDate(mid.toISOString().split("T")[0]);
        if (newOffset !== _weekOffset) {
          _weekOffset = newOffset;
          updateWeekNavUI();
          // Refresh the left-panel card with the new week's filtered todos
          const cardWrap = document.getElementById("split-card-wrap");
          if (cardWrap) cardWrap.innerHTML = renderDesignerCard(d);
          renderDesignerGrid(_designerData);
        }
        updateSplitCapBar(d);
      },
    });
    _splitCalendar.render();
  }

  _splitCalendar.removeAllEvents();
  _splitCalendar.addEventSource(scheduleDesignerEvents(d));
  updateSplitCapBar(d);
}

function updateSplitCapBar(d) {
  const wrap = document.getElementById("split-cap-bar");
  if (!wrap || !_splitCalendar) return;
  const view = _splitCalendar.view;
  if (!view) return;

  const viewStart = view.currentStart.toISOString().split("T")[0];
  const viewEndDate = new Date(view.currentEnd);
  viewEndDate.setDate(viewEndDate.getDate() - 1);
  const viewEnd = viewEndDate.toISOString().split("T")[0];

  const ptoDatesInView = (d.pto || []).filter(p => p.date >= viewStart && p.date <= viewEnd).length;
  const cap = Math.max(0, (5 - ptoDatesInView) * 7);

  const scheduled = (d.todos || []).reduce((sum, t) => {
    if (!t.hdd || !t.total_hours) return sum;
    const anchor = t.due_on || t.hdd;
    if (anchor >= viewStart && anchor <= viewEnd) return sum + t.total_hours;
    return sum;
  }, 0);

  const pct = cap > 0 ? Math.min(100, Math.round(scheduled / cap * 100)) : 100;
  const barCls = pct < 60 ? "low" : pct < 85 ? "mid" : "high";
  wrap.innerHTML = `
    <div class="cal-cap-label">${d.name} &middot; ${Math.round(scheduled*10)/10}h / ${cap}h available${ptoDatesInView ? ` (${ptoDatesInView} OOO)` : ""}</div>
    <div class="cap-bar-outer" style="width:260px"><div class="cap-bar-inner ${barCls}" style="width:${pct}%"></div></div>
    <span style="font-size:12px;color:var(--text-muted)">${pct}% booked</span>
  `;
}

// loadCalendar — defined below in the calendar section

// ---------------------------------------------------------------------------
// Designer card rendering
// ---------------------------------------------------------------------------

function updateWeekNavUI() {
  const fmt = s => new Date(s + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const label = _weekOffset === 0 ? "Current Week"
    : (() => { const { start, end } = getWeekBounds(_weekOffset); return `${fmt(start)} – ${fmt(end)}`; })();
  // Designer Workload tab and Overview tab each have their own week-nav
  // controls (distinct ids) but share the one _weekOffset — kept in sync here.
  for (const [prevId, labelId] of [["week-prev-btn", "week-label"], ["ov-week-prev-btn", "ov-week-label"]]) {
    const prevBtn = document.getElementById(prevId);
    const labelEl = document.getElementById(labelId);
    if (prevBtn) prevBtn.disabled = (_weekOffset === 0);
    if (labelEl) labelEl.textContent = label;
  }
}

// Compute week offset from any date string — finds the Monday of that week
function getOffsetFromDate(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  const dow = d.getDay(); // 0=Sun … 6=Sat
  d.setDate(d.getDate() + (dow === 0 ? 1 : 1 - dow)); // shift to Monday
  const monStr = d.toISOString().split("T")[0];
  const currentMon = getWeekBounds(0).start;
  const diff = Math.round((new Date(monStr) - new Date(currentMon)) / (7 * 24 * 60 * 60 * 1000));
  return Math.max(0, diff);
}

function setWeekOffset(newOffset) {
  if (newOffset < 0) return;
  _weekOffset = newOffset;
  updateWeekNavUI();
  renderDesignerGrid(_designerData);
  renderOverview();
  // Sync split calendar if it's open
  const splitView = document.getElementById("split-view");
  if (_splitCalendar && splitView && !splitView.classList.contains("hidden")) {
    _splitCalendar.gotoDate(getWeekBounds(_weekOffset).start + "T12:00:00");
  }
}

function renderDesignerCard(d, showCompleted = false) {
  const { weekly_est, cap, pct, pto_days, scheduledIds } = calcCapacity(d.todos, d.pto, _weekOffset);
  const barCls = pct < 60 ? "low" : pct < 85 ? "mid" : "high";
  const ptoBadge = pto_days > 0
    ? `<span class="pto-badge">${pto_days} OOO day${pto_days > 1 ? "s" : ""} this wk</span>`
    : "";

  // Filter todo list by due_on for current window, plus any future tasks pulled
  // forward by the scheduled fill algorithm (they have remaining capacity this week).
  const allTodos = d.todos || [];
  const { start: wStart, end: wEnd } = getWeekBounds(_weekOffset);
  const weekTodos = allTodos.filter(t => {
    if (!t.due_on) return _weekOffset === 0;
    const inWindow = _weekOffset === 0 ? t.due_on <= wEnd : (t.due_on >= wStart && t.due_on <= wEnd);
    return inWindow || scheduledIds.has(t.id);
  });

  // Pulled-forward tasks: scheduled this week by the fill algorithm but HDD is outside this week.
  // Use HDD (not due_on) — same anchor the fill algorithm uses — so the badge matches the logic.
  const pulledForward = new Set(weekTodos.filter(t => {
    const hddInWindow = _weekOffset === 0
      ? (t.hdd && t.hdd <= wEnd)
      : (t.hdd && t.hdd >= wStart && t.hdd <= wEnd);
    return !hddInWindow && scheduledIds.has(t.id);
  }).map(t => t.id));

  const activeTodos    = weekTodos.filter(t => !t.is_complete);
  const completedTodos = weekTodos.filter(t =>  t.is_complete);

  const completedFooter = completedTodos.length ? `
    <div class="completed-toggle" onclick="toggleCompleted('${d.bc_id}')">
      ${showCompleted ? "▲ Hide" : "▼ Show"} ${completedTodos.length} completed task${completedTodos.length !== 1 ? "s" : ""}
    </div>
    ${showCompleted ? `<ul class="designer-todos completed-section">${completedTodos.map(t => renderTodoItem(t, d.color, true)).join("")}</ul>` : ""}
  ` : "";

  const todosHtml = activeTodos.length
    ? `<ul class="designer-todos">${activeTodos.map(t => renderTodoItem(t, d.color, false, pulledForward.has(t.id))).join("")}</ul>${completedFooter}`
    : `<div class="no-todos">No active tasks</div>${completedFooter}`;

  return `
  <div class="designer-card">
    <div class="designer-card-header">
      <div class="designer-name-wrap">
        ${avatarHTML(d, { cls: "designer-avatar" })}
        <div>
          <div class="designer-name" style="display:flex;align-items:center;gap:8px">
            ${esc(d.name)}
            ${ptoBadge}
          </div>
          <div style="font-size:11px;color:var(--text-muted)">${d.todos ? d.todos.length : 0} task${d.todos?.length !== 1 ? "s" : ""}</div>
        </div>
      </div>
      <div class="designer-cap-wrap">
        <div style="display:flex;align-items:center;gap:8px">
          <div class="cap-label">${_weekOffset === 0 ? "Remaining" : "Week capacity"} &middot; ${weekly_est}h / ${cap}h</div>
          <button class="btn btn-ghost btn-sm" onclick="openPtoModal('${d.bc_id}','${esc(d.name)}')" title="Mark OOO days">OOO</button>
        </div>
        <div class="cap-bar-outer">
          <div class="cap-bar-inner ${barCls}" style="width:${pct}%"></div>
        </div>
        <div style="font-size:11px;color:var(--text-muted);text-align:right">${pct}% booked</div>
      </div>
    </div>
    ${todosHtml}
  </div>`;
}

const _completedToggleState = {}; // {bc_id: bool}

function toggleCompleted(bcId) {
  _completedToggleState[bcId] = !_completedToggleState[bcId];
  renderDesignerGrid(_designerData);
}


// Manager commit hook for the shared inline editors (shared.js editField/saveCategory)
window.__commitField = async (todoId, field, val) => {
  fetch(`/api/todos/${todoId}/fields`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [field]: val || null }),
  });
  for (const d of _designerData || []) {
    for (const t of d.todos || []) {
      if (String(t.id) !== String(todoId)) continue;
      applyFieldLocal(t, field, val);
      if (field === "due_on") {
        d.todos.sort((a, b) => (a.due_on || "9999-99-99").localeCompare(b.due_on || "9999-99-99"));
      }
    }
  }
  for (const t of _meData?.todos || []) {
    if (String(t.id) === String(todoId)) applyFieldLocal(t, field, val);
  }
  for (const t of _unassignedData || []) {
    if (String(t.id) === String(todoId)) applyFieldLocal(t, field, val);
  }
  if (field === "category") { renderOverview(); renderMyStuff(); return; }
  renderDesignerGrid(_designerData);
  renderOverview();
  renderMyStuff();
  await loadCalendar();
  updateLastUpdated();
};

// Manager commit hook for the shared spotlight star (shared.js toggleSpotlight)
window.__commitSpotlight = async (todoId, on) => {
  const res = await fetch(`/api/todos/${todoId}/spotlight`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ on }),
  }).then(r => r.json()).catch(() => null);
  if (res && res.ok === false) return; // at cap — star is disabled client-side already, this is just a race guard
  for (const t of _meData?.todos || []) {
    if (String(t.id) === String(todoId)) t.is_spotlighted = on;
  }
  renderMyStuff();
};

// ---------------------------------------------------------------------------
// Calendar scheduling
// ---------------------------------------------------------------------------


function isWorkDay(dateObj, ptoDates) {
  if (dateObj.getDay() === 0 || dateObj.getDay() === 6) return false;
  return !ptoDates.includes(dateObj.toISOString().split("T")[0]);
}

function nextWorkDay(dateObj, ptoDates) {
  const d = new Date(dateObj);
  d.setDate(d.getDate() + 1);
  while (!isWorkDay(d, ptoDates)) d.setDate(d.getDate() + 1);
  return d;
}

function toTimeStr(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours % 1) * 60);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}

function scheduleDesignerEvents(designer) {
  const ptoDates = (designer.pto || []).map(p => p.date);
  const dayUsed = {};

  // Active tasks first (scheduled normally), then completed tasks (shown faded)
  const tasks = designer.todos
    .filter(t => (t.due_on || t.hdd) && (t.total_hours || 0) > 0)
    .sort((a, b) => {
      const ad = a.due_on || a.hdd;
      const bd = b.due_on || b.hdd;
      return ad < bd ? -1 : ad > bd ? 1 : 0;
    });

  const events = [];

  for (const t of tasks) {

    // Active tasks: schedule with rollover
    let remaining = t.total_hours;
    let day = new Date((t.due_on || t.hdd) + "T12:00:00");
    while (!isWorkDay(day, ptoDates)) day = nextWorkDay(day, ptoDates);

    while (remaining > 0.01) {
      const ds = day.toISOString().split("T")[0];
      const used = dayUsed[ds] || 0;
      const avail = WORK_HOURS - used;

      if (avail <= 0.01) { day = nextWorkDay(day, ptoDates); continue; }

      const chunk = Math.min(remaining, avail);
      const startH = WORK_START + used;
      events.push({
        id: `t-${t.id}-${ds}`,
        title: truncate(t.title, 40),
        start: `${ds}T${toTimeStr(startH)}`,
        end:   `${ds}T${toTimeStr(startH + chunk)}`,
        backgroundColor: designer.color,
        borderColor: designer.color,
        extendedProps: { url: t.url, designer: designer.name, hdd: t.hdd,
                         est: t.est, logged: t.logged, chunk, total: t.total_hours,
                         fullTitle: t.title },
      });

      dayUsed[ds] = used + chunk;
      remaining -= chunk;
      if (remaining > 0.01) day = nextWorkDay(day, ptoDates);
    }
  }

  // OOO background blocks
  for (const p of designer.pto || []) {
    events.push({
      id: `pto-${designer.bc_id}-${p.date}`,
      title: `OOO${p.note ? ": " + p.note : ""}`,
      start: p.date, allDay: true, display: "background",
      backgroundColor: "#ef444430", borderColor: "#ef4444",
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Calendar init + render
// ---------------------------------------------------------------------------

function initCalendar() {
  const el = document.getElementById("calendar");
  calendar = new FullCalendar.Calendar(el, {
    initialView: "dayGridMonth",
    headerToolbar: { left: "prev,next today", center: "title", right: "dayGridMonth,timeGridWeek" },
    height: "calc(100vh - 230px)",
    slotMinTime: "08:00:00",
    slotMaxTime: "18:00:00",
    slotDuration: "00:30:00",
    nowIndicator: true,
    eventClick(info) {
      const p = info.event.extendedProps;
      if (p.url) window.open(p.url, "_blank");
    },
    eventDidMount(info) {
      const p = info.event.extendedProps;
      if (!p.designer) return;
      info.el.title = [
        p.fullTitle || "",
        p.designer ? `Designer: ${p.designer}` : "",
        p.hdd ? `HDD: ${fmtDate(p.hdd)}` : "",
        p.est != null ? `EST: ${p.est}h` : "",
        p.logged ? `Logged: ${p.logged}h` : "",
        p.chunk && p.total && p.chunk < p.total ? `(${p.chunk}h of ${p.total}h — continues)` : "",
      ].filter(Boolean).join("\n");
    },
    datesSet() { updateCalCapacityBar(); },
  });
  calendar.render();
}

function populateDesignerDropdown() {
  const sel = document.getElementById("cal-designer-filter");
  // Keep "All Designers" option, remove old designer options
  while (sel.options.length > 1) sel.remove(1);
  for (const d of _designerData || []) {
    const opt = document.createElement("option");
    opt.value = d.bc_id;
    opt.textContent = d.name;
    sel.appendChild(opt);
  }
}

function onCalFilterChange() {
  loadCalendar();
}

function updateCalCapacityBar() {
  const wrap = document.getElementById("cal-capacity-bar");
  const sel = document.getElementById("cal-designer-filter");
  if (!sel || sel.value === "all") { wrap.classList.add("hidden"); return; }

  const d = (_designerData || []).find(x => String(x.bc_id) === sel.value);
  if (!d) { wrap.classList.add("hidden"); return; }

  // Get the currently visible week range from the calendar
  const view = calendar?.view;
  if (!view) return;
  const viewStart = view.currentStart.toISOString().split("T")[0];
  const viewEnd = new Date(view.currentEnd);
  viewEnd.setDate(viewEnd.getDate() - 1);
  const viewEndStr = viewEnd.toISOString().split("T")[0];

  const ptoDates = (d.pto || []).map(p => p.date);
  const ptoDaysInView = (d.pto || []).filter(p => p.date >= viewStart && p.date <= viewEndStr).length;
  const workDaysInView = 5 - ptoDaysInView;
  const cap = Math.max(0, workDaysInView * 7);

  // Sum hours scheduled in this view
  const scheduled = (d.todos || []).reduce((sum, t) => {
    if (!t.hdd || !t.total_hours) return sum;
    if ((t.due_on || t.hdd) <= viewEndStr && t.hdd >= viewStart) return sum + t.total_hours;
    return sum;
  }, 0);

  const pct = cap > 0 ? Math.min(100, Math.round(scheduled / cap * 100)) : 100;
  const barCls = pct < 60 ? "low" : pct < 85 ? "mid" : "high";

  wrap.classList.remove("hidden");
  wrap.innerHTML = `
    <div class="cal-cap-label">${d.name} &middot; ${Math.round(scheduled * 10) / 10}h scheduled / ${cap}h available${ptoDaysInView ? ` (${ptoDaysInView} OOO day${ptoDaysInView > 1 ? "s" : ""})` : ""}</div>
    <div class="cap-bar-outer" style="width:300px">
      <div class="cap-bar-inner ${barCls}" style="width:${pct}%"></div>
    </div>
    <span style="font-size:12px;color:var(--text-muted)">${pct}% booked</span>
  `;
}

// ---------------------------------------------------------------------------
// Inline field editing (HDD, PDD, EST)
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// Overview tab — expandable Team Pulse roster + Needs Attention panel.
// setPulseSort/togglePulseRow/_overviewStats/_barCls/renderPulseItem/
// renderPulseDetail/renderAttention/gotoDesigner live in shared.js — a
// delegate-enabled designer's own Team Pulse tab reuses the exact same
// implementation (ctx="delegate" instead of the default "manager").
// ---------------------------------------------------------------------------

function renderOverview() {
  const rowsEl = document.getElementById("pulse-rows");
  const gridEl = document.getElementById("attention-grid");
  if (!rowsEl || !gridEl || !_designerData.length) return;

  const stats = _designerData.map(d => ({ d, s: _overviewStats(d, _weekOffset) }));
  stats.sort((a, b) => _pulseSort.manager === "free" ? b.s.free - a.s.free : b.s.pct - a.s.pct);

  rowsEl.innerHTML = stats.map(({ d, s }) => renderPulseItem(d, s)).join("");
  gridEl.innerHTML = renderAttention(stats);
}

// ---------------------------------------------------------------------------
// My Stuff — Richard's own todos, same anatomy as a designer page:
// personal pulse + editable table, then Past Due / At Risk / Needs a Decision
// ---------------------------------------------------------------------------

let _meData = null;

async function loadMyStuff() {
  const data = await fetchWithTimeout("/api/me").then(r => r.json()).catch(() => null);
  if (!data || data.warming) return; // loadAll re-runs when the refresh lands
  _meData = data;
  renderMyStuff();
}

let _myStuffSort = { key: "hdd", dir: "asc" };
function setMyStuffSort(key) {
  _myStuffSort = _myStuffSort.key === key
    ? { key, dir: _myStuffSort.dir === "asc" ? "desc" : "asc" }
    : { key, dir: "asc" };
  renderMyStuff();
}

// Priority sections for My Stuff — fixed display order, must match the
// labels main.py's PRIORITY_TIERS assigns server-side (priority_label).
// Two labels share tier 3 (Managers/HR, Sales) but render as separate
// sections at equal priority. Confirmed with Richard 2026-08-19.
const PRIORITY_SECTION_ORDER = [
  "Shay Berman", "Nate Mendenhall", "Managers / HR", "Sales",
  "Account Management", "Everyone Else",
];

// Buckets an already-sorted todo list by priority_label, preserving each
// group's relative order (a stable partition of `sorted`) so whatever
// column sort is active still governs the order within each section —
// priority grouping decides WHICH section, not the row order inside it.
function _groupByPriority(sortedTodos) {
  const buckets = new Map(PRIORITY_SECTION_ORDER.map(label => [label, []]));
  sortedTodos.forEach(t => {
    const label = PRIORITY_SECTION_ORDER.includes(t.priority_label) ? t.priority_label : "Everyone Else";
    buckets.get(label).push(t);
  });
  return PRIORITY_SECTION_ORDER
    .map(label => ({ label, todos: buckets.get(label) }))
    .filter(g => g.todos.length);
}

function renderMyStuff() {
  const root = document.getElementById("my-stuff-root");
  if (!root) return;
  if (!_meData) {
    root.innerHTML = `<div class="loading-card">Fetching your tasks from Basecamp — may take up to 60s on first load…</div>`;
    return;
  }
  const d = _meData;
  const { weekly_est, cap, pct, pto_days } = calcCapacity(d.todos, d.pto, 0);
  const free = Math.round((cap - weekly_est) * 10) / 10;
  const active = (d.todos || []).filter(t => !t.is_complete && !t.is_misc);
  const spotlightCount = active.filter(t => t.is_spotlighted).length;
  const sorted = sortTodos(active, _myStuffSort.key, _myStuffSort.dir);
  const sections = _groupByPriority(sorted);

  const tableOpts = {
    spotlight: { atCap: spotlightCount >= 4 },
    sort: _myStuffSort.key ? _myStuffSort : null,
    sortFn: "setMyStuffSort",
    showSender: true,
  };
  const sectionsHTML = sections.length
    ? sections.map(g => `
      <div class="priority-section">
        <div class="priority-section-head">${esc(g.label)} <span class="attention-count">${g.todos.length}</span></div>
        <div class="my-table-wrap">${buildTaskTable(g.todos, d.color, tableOpts)}</div>
      </div>`).join("")
    : `<div class="my-table-wrap"><div class="attention-empty">No active tasks this week.</div></div>`;

  root.innerHTML = `
    ${buildSpotlightSection(active, d.color)}
    <div class="pulse-panel">
      <div class="my-pulse">
        ${avatarHTML(d)}
        <div class="my-pulse-info">
          <div class="pulse-name">${esc(d.name)}</div>
          <div class="my-pulse-sub">${active.length} active task${active.length === 1 ? "" : "s"} this week${pto_days ? ` · ${pto_days} OOO day${pto_days > 1 ? "s" : ""}` : ""}</div>
        </div>
        <div class="pulse-bar-wrap my-pulse-bar">
          <div class="cap-bar-outer"><div class="cap-bar-inner ${_barCls(pct)}" style="width:${Math.min(100, pct)}%"></div></div>
          <span class="pulse-pct">${pct}%</span>
        </div>
        <div class="pulse-free ${free <= 2 ? "low" : free <= 8 ? "mid" : "ok"}">${free < 0 ? Math.abs(free) + "h over" : free + "h free"}</div>
      </div>
      ${sectionsHTML}
    </div>
    <div class="attention-grid">${renderMyStuffAttention(active)}</div>`;
}

function renderMyStuffAttention(active) {
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

  return panel("Past Due", pastRows, "Nothing past due.")
       + panel("At Risk", riskRows, "Nothing at risk in the next two days.")
       + panel("Needs a Decision", decRows, "No pending decisions.");
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function initTabs() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${tab}`).classList.add("active");
      if (tab === "calendar" && calendar) {
        calendar.updateSize();
      }
      if (tab === "analytics") {
        loadAnalytics();
      }
      if (tab === "standups") {
        loadStandups();
      }
      if (tab === "priorities") {
        loadPriorityTodos();
      }
      if (tab === "qa") {
        renderQaMount();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Priorities — Richard's own freeform, drag-sortable checklist
// ---------------------------------------------------------------------------

let _priorityActive = [];
let _priorityCompleted = [];
let _priorityCompletedOpen = false;
let _priorityDragId = null;

async function loadPriorityTodos() {
  const data = await fetchWithTimeout("/api/priority-todos").then(r => r.json()).catch(() => null);
  if (!data) return;
  _priorityActive = data.active || [];
  _priorityCompleted = data.completed || [];
  renderPriorityTodos();
}

async function addPriorityTodo() {
  const input = document.getElementById("priority-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  const item = await fetch("/api/priority-todos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).then(r => r.json()).catch(() => null);
  if (!item || !item.id) return;
  _priorityActive.push(item);
  renderPriorityTodos();
  input.focus();
}

async function togglePriorityDone(id, done) {
  if (done) {
    const idx = _priorityActive.findIndex(t => t.id === id);
    if (idx === -1) return;
    const [item] = _priorityActive.splice(idx, 1);
    item.done = true;
    _priorityCompleted.unshift(item);
  } else {
    const idx = _priorityCompleted.findIndex(t => t.id === id);
    if (idx === -1) return;
    const [item] = _priorityCompleted.splice(idx, 1);
    item.done = false;
    _priorityActive.push(item);
  }
  renderPriorityTodos();
  await fetch(`/api/priority-todos/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ done }),
  });
}

async function deletePriorityTodo(id) {
  _priorityActive = _priorityActive.filter(t => t.id !== id);
  _priorityCompleted = _priorityCompleted.filter(t => t.id !== id);
  renderPriorityTodos();
  await fetch(`/api/priority-todos/${id}`, { method: "DELETE" });
}

function togglePriorityCompleted() {
  _priorityCompletedOpen = !_priorityCompletedOpen;
  renderPriorityTodos();
}

// Touch-friendly reordering — native HTML5 drag-and-drop doesn't work on
// mobile, so these buttons are the fallback (and work fine on desktop too).
function movePriorityTodo(id, dir) {
  const idx = _priorityActive.findIndex(t => t.id === id);
  if (idx === -1) return;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= _priorityActive.length) return;
  const [item] = _priorityActive.splice(idx, 1);
  _priorityActive.splice(newIdx, 0, item);
  renderPriorityTodos();
  savePriorityOrder();
}

function priorityDragStart(evt, id) {
  _priorityDragId = id;
  setTimeout(() => evt.target.classList.add("is-dragging"), 0);
}

function priorityDrop(evt, targetId) {
  evt.preventDefault();
  evt.currentTarget.classList.remove("drag-over");
  const dragId = _priorityDragId; _priorityDragId = null;
  if (dragId == null || dragId === targetId) return;
  const fromIdx = _priorityActive.findIndex(t => t.id === dragId);
  const toIdx = _priorityActive.findIndex(t => t.id === targetId);
  if (fromIdx === -1 || toIdx === -1) return;
  const [item] = _priorityActive.splice(fromIdx, 1);
  _priorityActive.splice(toIdx, 0, item);
  renderPriorityTodos();
  savePriorityOrder();
}

async function savePriorityOrder() {
  await fetch("/api/priority-todos/order", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: _priorityActive.map(t => t.id) }),
  });
}

function renderPriorityTodos() {
  const activeList = document.getElementById("priority-active-list");
  const completedList = document.getElementById("priority-completed-list");
  const countEl = document.getElementById("priority-completed-count");
  const chevron = document.getElementById("priority-completed-chevron");
  if (!activeList) return;

  activeList.innerHTML = _priorityActive.length
    ? _priorityActive.map((t, idx) => `
      <li class="priority-item" draggable="true" id="priority-item-${t.id}"
          ondragstart="priorityDragStart(event, ${t.id})"
          ondragend="event.currentTarget.classList.remove('is-dragging')"
          ondragover="event.preventDefault();event.currentTarget.classList.add('drag-over')"
          ondragleave="event.currentTarget.classList.remove('drag-over')"
          ondrop="priorityDrop(event, ${t.id})">
        <button class="priority-check" onclick="togglePriorityDone(${t.id}, true)" title="Mark complete"></button>
        <span class="priority-text" ondblclick="editPriorityTodo(${t.id})" title="Double-click to edit">${esc(t.text)}</span>
        <div class="priority-item-actions">
          <button class="priority-move" onclick="movePriorityTodo(${t.id}, -1)" title="Move up"${idx === 0 ? " disabled" : ""}>&#9650;</button>
          <button class="priority-move" onclick="movePriorityTodo(${t.id}, 1)" title="Move down"${idx === _priorityActive.length - 1 ? " disabled" : ""}>&#9660;</button>
          <button class="priority-delete" onclick="deletePriorityTodo(${t.id})" title="Delete">&times;</button>
        </div>
      </li>`).join("")
    : `<li class="priority-empty">Nothing here — add your first priority above.</li>`;

  if (countEl) countEl.textContent = _priorityCompleted.length;
  if (chevron) chevron.classList.toggle("open", _priorityCompletedOpen);
  if (completedList) {
    completedList.classList.toggle("hidden", !_priorityCompletedOpen);
    completedList.innerHTML = _priorityCompleted.map(t => `
      <li class="priority-item done" id="priority-item-${t.id}">
        <button class="priority-check checked" onclick="togglePriorityDone(${t.id}, false)" title="Mark incomplete">&#10003;</button>
        <span class="priority-text" ondblclick="editPriorityTodo(${t.id})" title="Double-click to edit">${esc(t.text)}</span>
        <div class="priority-item-actions">
          <button class="priority-delete" onclick="deletePriorityTodo(${t.id})" title="Delete">&times;</button>
        </div>
      </li>`).join("");
  }
}

function editPriorityTodo(id) {
  const item = _priorityActive.find(t => t.id === id) || _priorityCompleted.find(t => t.id === id);
  const li = document.getElementById(`priority-item-${id}`);
  const textEl = li?.querySelector(".priority-text");
  if (!item || !textEl) return;
  const orig = item.text;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "priority-edit-input";
  input.value = orig;
  textEl.replaceWith(input);
  input.focus();
  input.select();

  // Same idempotency guard as the shared editField() — a blur can fire
  // more than once (e.g. Enter triggers blur, which then blurs again).
  let settled = false;
  const commit = async () => {
    if (settled) return;
    settled = true;
    const val = input.value.trim();
    if (val && val !== orig) {
      item.text = val;
      renderPriorityTodos();
      await fetch(`/api/priority-todos/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: val }),
      });
    } else {
      renderPriorityTodos();
    }
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    renderPriorityTodos();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { cancel(); }
  });
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

function triggerRefresh() {
  const btn = document.getElementById("refresh-btn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="refresh-spin">&#8635;</span> Refreshing…`;
  }
  fetch("/api/refresh", { method: "POST" });
  startPolling(); // poll until refresh completes, then reload UI
}

function resetRefreshBtn() {
  const btn = document.getElementById("refresh-btn");
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = "&#8635; Refresh";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function show(id) { document.getElementById(id)?.classList.remove("hidden"); }
function hide(id) { document.getElementById(id)?.classList.add("hidden"); }

function updateLastUpdated() {
  const el = document.getElementById("last-updated");
  el.textContent = "Updated " + new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// ---------------------------------------------------------------------------
// PTO modal
// ---------------------------------------------------------------------------

let _ptoDesignerId = null;
let _ptoDesignerName = "";

function openPtoModal(bcId, name) {
  _ptoDesignerId = bcId;
  _ptoDesignerName = name;
  const d = (_designerData || []).find(x => String(x.bc_id) === String(bcId));
  const pto = d ? (d.pto || []) : [];

  document.getElementById("pto-modal-title").textContent = `OOO Days — ${name}`;
  renderPtoList(pto);
  document.getElementById("pto-date-input").value = "";
  document.getElementById("pto-note-input").value = "";
  show("pto-modal");
}

function renderPtoList(pto) {
  const el = document.getElementById("pto-existing");
  if (!pto.length) { el.innerHTML = `<div style="color:var(--text-muted);font-size:12px">No OOO days set</div>`; return; }
  el.innerHTML = pto.map(p => `
    <div class="pto-entry">
      <span>${fmtDateISO(p.date)}${p.note ? " — " + esc(p.note) : ""}</span>
      <button class="pto-delete" onclick="deletePto(${p.id})">✕</button>
    </div>`).join("");
}

async function savePto() {
  const dateVal = document.getElementById("pto-date-input").value;
  const endVal  = document.getElementById("pto-end-input").value;
  const note    = document.getElementById("pto-note-input").value.trim();
  if (!dateVal) return;

  // Build array of dates (single or range)
  const dates = [];
  const start = new Date(dateVal + "T12:00:00");
  const end   = endVal ? new Date(endVal + "T12:00:00") : start;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 0 && d.getDay() !== 6) // skip weekends
      dates.push(d.toISOString().split("T")[0]);
  }

  await fetch("/api/pto", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ designer_bc_id: _ptoDesignerId, dates, note }),
  });
  await refreshAfterPto();
}

async function deletePto(ptoId) {
  await fetch(`/api/pto/${ptoId}`, { method: "DELETE" });
  await refreshAfterPto();
}

async function refreshAfterPto() {
  await loadDesigners();
  await loadCalendar();
  // Reopen modal with fresh data
  const d = (_designerData || []).find(x => String(x.bc_id) === String(_ptoDesignerId));
  if (d) renderPtoList(d.pto || []);
}

function closePtoModal() { hide("pto-modal"); }

function fmtDateISO(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

async function loadCalendar() {
  if (!calendar) return;
  const sel = document.getElementById("cal-designer-filter");
  const filterVal = sel ? sel.value : "all";

  calendar.removeAllEvents();

  if (filterVal === "all") {
    // Month view — simple start/end blocks per task
    calendar.changeView("dayGridMonth");
    const events = await fetch("/api/calendar").then(r => r.json()).catch(() => []);
    // Also add all OOO as background
    const ptoEvents = [];
    for (const d of _designerData || []) {
      for (const p of d.pto || []) {
        ptoEvents.push({ id: `pto-${d.bc_id}-${p.date}`, title: `${d.name} OOO`,
          start: p.date, allDay: true, display: "background",
          backgroundColor: d.color + "33", borderColor: d.color });
      }
    }
    calendar.addEventSource([...events, ...ptoEvents]);
    document.getElementById("cal-capacity-bar").classList.add("hidden");
  } else {
    // Week view — scheduled time blocks with rollover
    calendar.changeView("timeGridWeek");
    const d = (_designerData || []).find(x => String(x.bc_id) === filterVal);
    if (d) {
      const events = scheduleDesignerEvents(d);
      calendar.addEventSource(events);
    }
    updateCalCapacityBar();
  }

  populateDesignerDropdown();
  // Restore selection after repopulate
  if (sel && filterVal !== "all") sel.value = filterVal;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

let _analyticsData = null;
let _analyticsSection = "capacity";
let _capacityData = null;

// Analytics filters — apply to Completions / Weekly Capacity / Queue /
// Categories. Capacity has its own controls and ignores these.
const _anFilters = { designer: "", category: "", client: "", status: "", month: "", year: "", from: "", to: "" };
const _AN_MONTHS = ["January","February","March","April","May","June",
                    "July","August","September","October","November","December"];

function _anFilterActive() { return Object.values(_anFilters).some(v => v !== ""); }

// Completion day = when the dashboard detected the task as done
function _completionDay(c) {
  return c.recorded_at ? localISO(new Date(c.recorded_at * 1000)) : (c.week_start || "");
}

function _anDateMatch(iso) {
  const f = _anFilters;
  if (!iso) return !f.month && !f.year && !f.from && !f.to;
  if (f.year  && iso.slice(0, 4) !== f.year)  return false;
  if (f.month && iso.slice(5, 7) !== f.month) return false;
  if (f.from  && iso < f.from) return false;
  if (f.to    && iso > f.to)   return false;
  return true;
}

function _filteredCompletions() {
  const f = _anFilters;
  return (_analyticsData?.completions || []).filter(c =>
    (!f.designer || c.designer_name === f.designer) &&
    (!f.category || c.category === f.category) &&
    (!f.client   || c.client_name === f.client) &&
    (!f.status   || (f.status === "late") === !!c.was_hdd_miss) &&
    _anDateMatch(_completionDay(c))
  );
}

function renderAnalyticsFilters() {
  const bar = document.getElementById("analytics-filters");
  if (!bar || !_analyticsData) return;
  const comps = _analyticsData.completions || [];
  const uniq = arr => [...new Set(arr.filter(Boolean))].sort();

  const sel = (key, label, opts) => `
    <label class="an-filter"><span>${label}</span>
      <select class="cal-filter-select" data-anfilter="${key}">
        <option value="">All</option>
        ${opts.map(o => {
          const v = String(o.v ?? o), t = String(o.t ?? o);
          return `<option value="${esc(v)}"${v === _anFilters[key] ? " selected" : ""}>${esc(t)}</option>`;
        }).join("")}
      </select>
    </label>`;

  bar.innerHTML = `
    ${sel("designer", "Designer", uniq(comps.map(c => c.designer_name)))}
    ${sel("category", "Category", uniq(comps.map(c => c.category)))}
    ${sel("client",   "Client",   uniq(comps.map(c => c.client_name)))}
    ${sel("status",   "Status",   [{ v: "ontime", t: "On time" }, { v: "late", t: "Late" }])}
    ${sel("month",    "Month",    _AN_MONTHS.map((m, i) => ({ v: String(i + 1).padStart(2, "0"), t: m })))}
    ${sel("year",     "Year",     uniq(comps.map(c => _completionDay(c).slice(0, 4))))}
    <label class="an-filter"><span>From</span>
      <input type="date" class="cal-filter-select" data-anfilter="from" value="${_anFilters.from}"></label>
    <label class="an-filter"><span>To</span>
      <input type="date" class="cal-filter-select" data-anfilter="to" value="${_anFilters.to}"></label>
    <button id="an-filter-clear" class="section-btn an-filter-clear${_anFilterActive() ? "" : " hidden"}">Clear ✕</button>
  `;

  bar.querySelectorAll("[data-anfilter]").forEach(el => {
    el.onchange = () => {
      _anFilters[el.dataset.anfilter] = el.value;
      renderAnalyticsFilters();
      renderAnalyticsSection(_analyticsSection);
    };
  });
  document.getElementById("an-filter-clear").onclick = () => {
    for (const k of Object.keys(_anFilters)) _anFilters[k] = "";
    renderAnalyticsFilters();
    renderAnalyticsSection(_analyticsSection);
  };
}

// Service capacity — series colors validated against white surface
// (dataviz palette; All is the aggregate and wears neutral ink, not a slot)
const CAP_SERIES = [
  { key: "Design", color: "#2a78d6", label: "Designer" },
  { key: "Multi",  color: "#1baf7a", label: "Multi" },
  { key: "IPM",    color: "#eda100", label: "IPM" },
  { key: "Email",  color: "#008300", label: "Email" },
  { key: "All",    color: "#1a2240", width: 3 },
];

// Headcount what-if simulator: delta people per group.
// IPM has one person, so only +1 is allowed there.
const _capSim = { Design: 0, Multi: 0, IPM: 0, Email: 0 };
const CAP_SIM_MIN = { Design: -1, Multi: -1, IPM: 0, Email: -1 };

function capSimTotal() { return Object.values(_capSim).reduce((a, b) => a + b, 0); }
function capSimDelta(g) { return g === "All" ? capSimTotal() : (_capSim[g] || 0); }

// Simulated (or actual, when the group's delta is 0) capacity % for month i
function capSimPct(d, g, i) {
  const delta = capSimDelta(g);
  if (!delta) return d.capacity[g][i];
  const n = (d.people[g][i] || 0) + delta;
  const wh = d.workhours[i];
  if (n <= 0 || !wh) return null;
  return Math.round((d.hours[g][i] || 0) / (wh * n) * 1000) / 10;
}

function adjCapSim(g, dir) {
  _capSim[g] = Math.max(CAP_SIM_MIN[g], Math.min(1, (_capSim[g] || 0) + dir));
  renderCapacitySection(document.getElementById("analytics-content"));
}

function resetCapSim() {
  for (const g of Object.keys(_capSim)) _capSim[g] = 0;
  renderCapacitySection(document.getElementById("analytics-content"));
}

async function loadAnalytics() {
  const content = document.getElementById("analytics-content");
  const stats   = document.getElementById("analytics-stats");
  content.innerHTML = `<div class="loading-cell" style="padding:40px;text-align:center">Loading analytics…</div>`;
  try {
    const r = await fetch("/api/analytics");
    _analyticsData = await r.json();
    renderAnalyticsFilters();
    renderAnalyticsSection(_analyticsSection);
    initAnalyticsSectionBtns();
  } catch (e) {
    content.innerHTML = `<div class="loading-cell" style="padding:40px;text-align:center;color:var(--text-muted)">Failed to load analytics.</div>`;
  }
}

function initAnalyticsSectionBtns() {
  document.querySelectorAll(".section-btn").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll(".section-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      _analyticsSection = btn.dataset.section;
      renderAnalyticsSection(_analyticsSection);
    };
  });
}

function renderAnalyticsStats(completions, queue) {
  const total = completions.length;
  const withBoth = completions.filter(c => c.est_hours > 0 && c.logged_hours > 0);
  const avgAccuracy = withBoth.length
    ? Math.round(withBoth.reduce((s, c) => s + (c.logged_hours / c.est_hours), 0) / withBoth.length * 100)
    : null;
  const misses = completions.filter(c => c.was_hdd_miss).length;
  const missRate = total ? Math.round(misses / total * 100) : null;
  const avgQueue = queue.length
    ? (queue.reduce((s, q) => s + q.hours_in_queue, 0) / queue.length).toFixed(1)
    : null;

  const stat = (label, value, sub = "") => `
    <div class="analytics-stat-card">
      <div class="stat-value">${value}</div>
      <div class="stat-label">${label}</div>
      ${sub ? `<div class="stat-sub">${sub}</div>` : ""}
    </div>`;

  document.getElementById("analytics-stats").innerHTML = `
    ${stat("Tasks Completed", total, _anFilterActive() ? "filtered" : "all time")}
    ${stat("EST Accuracy", avgAccuracy !== null ? avgAccuracy + "%" : "—", "avg logged vs est")}
    ${stat("HDD Miss Rate", missRate !== null ? missRate + "%" : "—", "completed after deadline")}
    ${stat("Avg Queue Time", avgQueue !== null ? avgQueue + "h" : "—", "unassigned → claimed")}
  `;
}

async function renderCapacitySection(el) {
  if (!_capacityData) {
    el.innerHTML = `<div class="loading-cell" style="padding:40px;text-align:center">Computing capacity from Everhour history — first load can take ~30s…</div>`;
    try {
      const r = await fetch("/api/analytics/capacity");
      _capacityData = await r.json();
    } catch {
      el.innerHTML = _noData("Failed to load capacity data.");
      return;
    }
    if (_analyticsSection !== "capacity") return; // user moved on while loading
  }
  const d = _capacityData;
  const last = d.months.length - 1;
  const moLabel = iso => {
    const [y, m] = iso.split("-");
    return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short" }) + " '" + y.slice(2);
  };

  const simOn = capSimTotal() !== 0 || Object.values(_capSim).some(v => v !== 0);

  const order = [CAP_SERIES[4], ...CAP_SERIES.slice(0, 4)]; // Overall first, then slot order
  const statCards = order.map(s => {
    const affected = capSimDelta(s.key) !== 0;
    const v = capSimPct(d, s.key, last);
    const actual = d.capacity[s.key][last];
    const sub = affected
      ? `actual ${actual != null ? actual + "%" : "—"} · ${moLabel(d.months[last])} MTD`
      : `${moLabel(d.months[last])} month-to-date`;
    return `<div class="analytics-stat-card${affected ? " simmed-card" : ""}">
      <div class="stat-value" style="display:flex;align-items:center;gap:8px">
        <span class="cap-dot" style="background:${s.color}"></span>${v != null ? v + "%" : "—"}
      </div>
      <div class="stat-label">${s.key === "All" ? "Overall Capacity" : s.key + " Capacity"}</div>
      <div class="stat-sub">${sub}</div>
    </div>`;
  }).join("");

  const legend = CAP_SERIES.map(s =>
    `<span class="cap-legend-item"><span class="cap-dot" style="background:${s.color}"></span>${s.key}</span>`
  ).join("");

  const simGroups = CAP_SERIES.slice(0, 4).map(s => {
    const v = _capSim[s.key];
    return `<div class="cap-sim-group${v !== 0 ? " on" : ""}">
      <span class="cap-dot" style="background:${s.color}"></span>
      <span class="cap-sim-name">${s.label}</span>
      <button class="cap-sim-btn" onclick="adjCapSim('${s.key}',-1)" ${v <= CAP_SIM_MIN[s.key] ? "disabled" : ""}>&minus;</button>
      <span class="cap-sim-val">${v > 0 ? "+" + v : v}</span>
      <button class="cap-sim-btn" onclick="adjCapSim('${s.key}',1)" ${v >= 1 ? "disabled" : ""}>+</button>
    </div>`;
  }).join("");
  const simDesc = CAP_SERIES.slice(0, 4)
    .filter(s => _capSim[s.key] !== 0)
    .map(s => `${_capSim[s.key] > 0 ? "+" : ""}${_capSim[s.key]} ${s.label}`).join(", ");
  const simBar = `<div class="cap-sim${simOn ? " active" : ""}">
    <span class="cap-sim-label">Simulate headcount</span>
    ${simGroups}
    ${simOn ? `<button class="btn btn-ghost btn-sm" onclick="resetCapSim()">Reset</button>
      <span class="cap-sim-note">Simulating ${simDesc} — hypothetical numbers, dashed lines show actuals</span>` : ""}
  </div>`;

  const capRow = (mo, i) => {
    const mtd = i === last ? ` <span class="cap-mtd">MTD</span>` : "";
    const cells = CAP_SERIES.map(s => {
      const affected = capSimDelta(s.key) !== 0;
      const v = capSimPct(d, s.key, i);
      return `<td style="text-align:right"${affected ? ` class="simmed"` : ""}>${v != null ? v.toFixed(1) + "%" : "—"}</td>`;
    }).join("");
    return `<tr><td>${moLabel(mo)}${mtd}</td>${cells}</tr>`;
  };
  const cntRow = (mo, i) => {
    const cells = ["Design", "Multi", "IPM", "Email", "Other"].map(s =>
      `<td style="text-align:right">${d.counts[s][i]}</td>`).join("");
    return `<tr><td>${moLabel(mo)}${i === last ? ` <span class="cap-mtd">MTD</span>` : ""}</td>${cells}<td style="text-align:right;font-weight:700">${d.count_totals[i]}</td></tr>`;
  };
  const idxDesc = d.months.map((_, i) => i).reverse();

  el.innerHTML = `
    <div class="analytics-stats" style="margin-bottom:18px">${statCards}</div>
    ${simBar}
    <div class="cap-chart-panel">
      <div class="cap-chart-head">
        <div>
          <div class="cap-chart-title">Capacity by service, month over month</div>
          <div class="cap-chart-sub">Hours logged ÷ available hours (workdays × 6.5h × people active that month). History reflects the current roster plus RJ; groups start when their people started logging.</div>
        </div>
        <div class="cap-legend">${legend}</div>
      </div>
      <div id="cap-chart" class="cap-chart-wrap"></div>
    </div>
    <div class="cap-tables">
      <div class="cap-table-block">
        <div class="cap-chart-title">Capacity % by month</div>
        <div class="table-wrap"><table class="data-table cap-table">
          <thead><tr><th>Month</th>${CAP_SERIES.map(s => `<th style="text-align:right">${s.key}</th>`).join("")}</tr></thead>
          <tbody>${idxDesc.map(i => capRow(d.months[i], i)).join("")}</tbody>
        </table></div>
      </div>
      <div class="cap-table-block">
        <div class="cap-chart-title">Tasks worked by service category</div>
        <div class="table-wrap"><table class="data-table cap-table">
          <thead><tr><th>Month</th><th style="text-align:right">Design</th><th style="text-align:right">Multi</th><th style="text-align:right">IPM</th><th style="text-align:right">Email</th><th style="text-align:right">Other</th><th style="text-align:right">All</th></tr></thead>
          <tbody>${idxDesc.map(i => cntRow(d.months[i], i)).join("")}</tbody>
        </table></div>
      </div>
    </div>`;
  drawCapacityChart(document.getElementById("cap-chart"), d, moLabel);
}

function drawCapacityChart(mount, d, moLabel) {
  const W = 920, H = 320, L = 46, R = 16, T = 14, B = 30;
  const n = d.months.length;
  const seriesVals = {};
  for (const s of CAP_SERIES) seriesVals[s.key] = d.months.map((_, i) => capSimPct(d, s.key, i));
  const maxVal = Math.max(120, ...CAP_SERIES.flatMap(s =>
    [...seriesVals[s.key], ...d.capacity[s.key]].filter(v => v != null)));
  const yMax = Math.ceil(maxVal / 20) * 20;
  const x = i => L + (n === 1 ? 0 : i * (W - L - R) / (n - 1));
  const y = v => T + (H - T - B) * (1 - v / yMax);

  let grid = "";
  for (let g = 0; g <= yMax; g += 20) {
    const ref = g === 100;
    grid += `<line x1="${L}" y1="${y(g)}" x2="${W - R}" y2="${y(g)}" stroke="${ref ? "#c3c2b7" : "#e9e8f3"}" stroke-width="1"${ref ? ` stroke-dasharray="4 3"` : ""}/>` +
            `<text x="${L - 8}" y="${y(g) + 3.5}" text-anchor="end" class="cap-axis">${g}%</text>`;
  }
  const step = n > 14 ? 2 : 1;
  let xlabels = "";
  for (let i = 0; i < n; i += step) {
    xlabels += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="cap-axis">${moLabel(d.months[i])}</text>`;
  }

  const linePath = vals => {
    let path = "", pen = false;
    vals.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      path += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(Math.min(v, yMax)).toFixed(1)}`;
      pen = true;
    });
    return path;
  };

  let paths = "";
  for (const s of CAP_SERIES) {
    // Affected by an active simulation: actual stays visible as a dashed ghost
    if (capSimDelta(s.key) !== 0) {
      paths += `<path d="${linePath(d.capacity[s.key])}" fill="none" stroke="${s.color}" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.4"/>`;
    }
    paths += `<path d="${linePath(seriesVals[s.key])}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" stroke-linejoin="round" stroke-linecap="round"/>`;
  }

  mount.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="cap-svg" preserveAspectRatio="xMidYMid meet">
      ${grid}${xlabels}${paths}
      <line id="cap-cross" x1="0" y1="${T}" x2="0" y2="${H - B}" stroke="#7b8db8" stroke-width="1" opacity="0"/>
      <g id="cap-hover-dots"></g>
      <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" id="cap-hit"/>
    </svg>
    <div id="cap-tip" class="cap-tip hidden"></div>`;

  const svg = mount.querySelector("svg");
  const hit = mount.querySelector("#cap-hit");
  const cross = mount.querySelector("#cap-cross");
  const dotsG = mount.querySelector("#cap-hover-dots");
  const tip = mount.querySelector("#cap-tip");

  hit.addEventListener("mousemove", e => {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
    const i = Math.max(0, Math.min(n - 1, Math.round((loc.x - L) / ((W - L - R) / (n - 1)))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i));
    cross.setAttribute("opacity", "0.6");
    dotsG.innerHTML = CAP_SERIES.map(s => {
      const v = seriesVals[s.key][i];
      return v == null ? "" : `<circle cx="${x(i)}" cy="${y(Math.min(v, yMax))}" r="4" fill="${s.color}" stroke="#fff" stroke-width="2"/>`;
    }).join("");
    tip.innerHTML = `<div class="cap-tip-title">${moLabel(d.months[i])}</div>` +
      CAP_SERIES.map(s => {
        const v = seriesVals[s.key][i];
        const actual = d.capacity[s.key][i];
        const affected = capSimDelta(s.key) !== 0;
        const h = d.hours[s.key][i];
        const extra = affected
          ? `<span class="cap-tip-hrs">actual ${actual != null ? actual + "%" : "—"}</span>`
          : `<span class="cap-tip-hrs">${h ? h + "h" : ""}</span>`;
        return `<div class="cap-tip-row"><span class="cap-dot" style="background:${s.color}"></span><span>${s.key}</span><b>${v != null ? v + "%" : "—"}</b>${extra}</div>`;
      }).join("");
    tip.classList.remove("hidden");
    const rect = mount.getBoundingClientRect();
    const px = (x(i) / W) * rect.width;
    tip.style.left = Math.min(rect.width - 190, Math.max(0, px + 14)) + "px";
    tip.style.top = "16px";
  });
  hit.addEventListener("mouseleave", () => {
    cross.setAttribute("opacity", "0");
    dotsG.innerHTML = "";
    tip.classList.add("hidden");
  });
}

function renderAnalyticsSection(section) {
  const el = document.getElementById("analytics-content");
  // The completions-based stat strip and filters are noise on the capacity section
  document.getElementById("analytics-stats")?.classList.toggle("hidden", section === "capacity");
  document.getElementById("analytics-filters")?.classList.toggle("hidden", section === "capacity");
  if (section === "capacity") { renderCapacitySection(el); return; }
  if (!_analyticsData) return;

  const f = _anFilters;
  const completions = _filteredCompletions();
  const weekly_snapshots = (_analyticsData.weekly_snapshots || []).filter(x =>
    (!f.designer || x.designer_name === f.designer) && _anDateMatch(x.week_start));
  const queue_time = (_analyticsData.queue_time || []).filter(x =>
    (!f.client || x.client_name === f.client) &&
    _anDateMatch(x.recorded_at ? localISO(new Date(x.recorded_at * 1000)) : ""));
  const category_volume = (_analyticsData.category_volume || []).filter(x =>
    (!f.designer || x.designer_name === f.designer) &&
    (!f.category || x.category === f.category) &&
    _anDateMatch(x.week_start));

  renderAnalyticsStats(completions, queue_time);
  const empty = base => _noData(_anFilterActive() ? "Nothing matches the current filters." : base);

  if (section === "completions") {
    if (!completions.length) { el.innerHTML = empty("No completions recorded yet."); return; }
    const rows = completions.map(c => {
      const variance = (c.est_hours > 0 && c.logged_hours > 0)
        ? (c.logged_hours - c.est_hours).toFixed(1)
        : "—";
      const varCls = variance !== "—" ? (parseFloat(variance) > 0 ? "style='color:var(--danger)'" : "style='color:var(--success)'") : "";
      return `<tr>
        <td>${fmtDate(_completionDay(c))}</td>
        <td>${esc(c.designer_name)}</td>
        <td class="text-muted">${esc(truncate(c.client_name, 28))}</td>
        <td>${esc(truncate(c.title, 48))}</td>
        <td><span class="category-badge">${esc(c.category)}</span></td>
        <td>${c.est_hours != null ? c.est_hours + "h" : "—"}</td>
        <td>${c.logged_hours > 0 ? c.logged_hours + "h" : "—"}</td>
        <td ${varCls}>${variance !== "—" ? (parseFloat(variance) > 0 ? "+" : "") + variance + "h" : "—"}</td>
        <td>${c.was_hdd_miss ? '<span class="badge-miss">Late</span>' : '<span class="badge-ok">On time</span>'}</td>
      </tr>`;
    }).join("");
    el.innerHTML = `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Designer</th><th>Client</th><th>Task</th><th>Category</th><th>EST</th><th>Logged</th><th>Variance</th><th>HDD</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;

  } else if (section === "snapshots") {
    if (!weekly_snapshots.length) { el.innerHTML = empty("No weekly snapshots yet."); return; }
    const rows = weekly_snapshots.map(s => {
      const pct = s.capacity_pct;
      const barCls = pct >= 90 ? "bar-danger" : pct >= 70 ? "bar-warn" : "bar-ok";
      return `<tr>
        <td>${fmtDate(s.week_start)}</td>
        <td>${esc(s.designer_name)}</td>
        <td>${s.weekly_est}h</td>
        <td>${s.weekly_cap}h</td>
        <td>
          <div class="mini-bar-wrap">
            <div class="mini-bar ${barCls}" style="width:${Math.min(100, pct)}%"></div>
          </div>
          <span class="pct-label">${pct}%</span>
        </td>
        <td>${s.active_todo_count}</td>
      </tr>`;
    }).join("");
    el.innerHTML = `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Week</th><th>Designer</th><th>Est Hrs</th><th>Cap</th><th>Utilization</th><th>Tasks</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;

  } else if (section === "queue") {
    if (!queue_time.length) { el.innerHTML = empty("No queue time recorded yet."); return; }
    const sorted = [...queue_time].sort((a, b) => b.hours_in_queue - a.hours_in_queue);
    const rows = sorted.map(q => `<tr>
      <td>${esc(truncate(q.title, 56))}</td>
      <td class="text-muted">${esc(truncate(q.client_name, 30))}</td>
      <td>${q.hours_in_queue}h</td>
    </tr>`).join("");
    el.innerHTML = `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Task</th><th>Client</th><th>Hours in Queue</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;

  } else if (section === "categories") {
    if (!category_volume.length) { el.innerHTML = empty("No category data yet."); return; }
    const rows = category_volume.map(v => `<tr>
      <td>${fmtDate(v.week_start)}</td>
      <td>${esc(v.designer_name)}</td>
      <td><span class="category-badge">${esc(v.category)}</span></td>
      <td>${v.task_count}</td>
    </tr>`).join("");
    el.innerHTML = `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Week</th><th>Designer</th><th>Category</th><th>Tasks</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }
}

function _noData(msg) {
  return `<div style="padding:48px;text-align:center;color:var(--text-muted);font-size:14px">${msg}<br><span style="font-size:12px;opacity:.6">Data will appear automatically after the next dashboard refresh.</span></div>`;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", boot);


// ---------------------------------------------------------------------------
// Weekly manager message (shown on designer pages)
// ---------------------------------------------------------------------------

function toggleMM() {
  document.getElementById("mm-editor")?.classList.toggle("hidden");
}

async function saveMM() {
  const text = document.getElementById("mm-text").value.trim();
  const status = document.getElementById("mm-status");
  if (!text) { status.textContent = "Write something first."; return; }
  const r = await fetch("/api/manager-message?pin=1868", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  status.textContent = r.ok ? "Posted — designers will see it for 10 days." : "Failed to post.";
  if (r.ok) setTimeout(toggleMM, 1200);
}
