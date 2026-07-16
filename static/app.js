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

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(timer);
    return r;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function loadAll() {
  await Promise.all([loadUnassigned(), loadDesigners()]);
  await loadCalendar();
  updateLastUpdated();
  resetRefreshBtn();
}

async function loadUnassigned() {
  const todos = await fetchWithTimeout("/api/unassigned").then(r => r.json()).catch(() => []);
  document.getElementById("unassigned-count").textContent = todos.length || "";
  const tbody = document.getElementById("unassigned-tbody");
  if (!todos.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="loading-cell">Fetching from Basecamp — may take up to 60s on first load…</td></tr>`;
    return;
  }
  tbody.innerHTML = todos.map(t => {
    const due = t.due_on ? formatDue(t.due_on) : "";
    const assigned = t.created_at
      ? new Date(t.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : "";
    return `<tr>
      <td><div class="todo-title">${esc(t.title)}</div></td>
      <td><span class="todolist-name">${esc(t.todolist_name)}</span></td>
      <td><span class="due-date">${assigned}</span></td>
      <td><span class="due-date ${dueCls(t.due_on)}">${due}</span></td>
      <td>${t.url ? `<a href="${t.url}" target="_blank" class="link-btn" title="Open in Basecamp">↗</a>` : ""}</td>
    </tr>`;
  }).join("");
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
  const prevBtn = document.getElementById("week-prev-btn");
  const label   = document.getElementById("week-label");
  if (prevBtn) prevBtn.disabled = (_weekOffset === 0);
  if (label) {
    if (_weekOffset === 0) {
      label.textContent = "Current Week";
    } else {
      const { start, end } = getWeekBounds(_weekOffset);
      const fmt = s => new Date(s + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
      label.textContent = `${fmt(start)} – ${fmt(end)}`;
    }
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
  // Sync split calendar if it's open
  const splitView = document.getElementById("split-view");
  if (_splitCalendar && splitView && !splitView.classList.contains("hidden")) {
    _splitCalendar.gotoDate(getWeekBounds(_weekOffset).start + "T12:00:00");
  }
}

function renderDesignerCard(d, showCompleted = false) {
  const { weekly_est, cap, pct, pto_days, scheduledIds } = calcCapacity(d.todos, d.pto, _weekOffset);
  const barCls = pct < 60 ? "low" : pct < 85 ? "mid" : "high";
  const initials = d.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
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
        <div class="designer-avatar" style="background:${d.color}">${initials}</div>
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

const CATEGORIES = [
  "Branding/Logo - Creation/Edits",
  "Print - Collateral/Packaging",
  "Web - Sites/Applications/UI",
  "Web - Maintenance",
  "Email - Campaigns/Signatures",
  "LP - New",
  "LP - Maintenance",
  "Digital - Banner/Display Ads",
  "Multi - Photo/Video/Edits",
  "IPM - Campaigns/Reports",
  "SM - templates/graphics/reels",
  "Misc.",
  "Admin",
];

async function saveCategory(todoId, value) {
  // Update in-memory data immediately
  for (const d of _designerData || []) {
    for (const t of d.todos || []) {
      if (String(t.id) === String(todoId)) {
        t.category = value;
        if (!t.overrides) t.overrides = [];
        if (!t.overrides.includes("category")) t.overrides.push("category");
      }
    }
  }
  await fetch(`/api/todos/${todoId}/fields`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category: value }),
  });
}

function renderTodoItem(t, color, isCompleted = false, pulledForward = false) {
  const ov = t.overrides || [];
  const hddCls = ov.includes("hdd") ? "hdd overridden" : "hdd";
  const estCls = ov.includes("est") ? "est overridden" : "est";
  const catOverridden = ov.includes("category");

  const dateStr = `<span class="meta-pill date-pill editable" onclick="editField(event,'${t.id}','due_on','date','${t.due_on||''}')" title="Click to change date — re-sorts the list">${t.due_on ? fmtDate(t.due_on) : "+ Date"}</span>`;
  let hddStr;
  if (t.in_revisions && !t.hdd) {
    hddStr = `<span class="meta-pill revision-hdd editable" onclick="editField(event,'${t.id}','hdd','date','')" title="Task is back for revisions with no deadline yet — picking a date creates a Revision step in Basecamp">+ Revision HDD</span>`;
  } else if (t.hdd_stale) {
    hddStr = `<span class="meta-pill hdd stale editable" onclick="editField(event,'${t.id}','hdd','date','')" title="Comment deadline over 14 days old — abandoned, not late. Click to set a new HDD">HDD ${fmtDate(t.hdd)} · stale</span>`;
  } else {
    hddStr = `<span class="meta-pill ${hddCls} editable" onclick="editField(event,'${t.id}','hdd','date','${t.hdd||''}')" title="Click to edit — updates Basecamp step due date">${t.hdd ? "HDD " + fmtDate(t.hdd) : "+ HDD"}</span>`;
  }
  const estStr = `<span class="meta-pill ${estCls} editable" onclick="editField(event,'${t.id}','est','number','${t.est??''}')" title="Click to edit — updates Everhour estimate">${t.est != null ? "EST " + t.est + "h" : "+ EST"}</span>`;

  // True EST: corrected estimate for capacity math (local only, never touches Everhour).
  // Prompt for one when an active task has logged past its EST — otherwise it consumes 0 capacity.
  const stepDone = t.designer_step && t.designer_step.completed;
  let trueEstStr = "";
  if (t.true_est != null) {
    trueEstStr = `<span class="meta-pill true-est editable" onclick="editField(event,'${t.id}','true_est','number','${t.true_est}')" title="Corrected estimate used for capacity — clear to revert to EST">TRUE ${t.true_est}h</span>`;
  } else if (!isCompleted && !stepDone && t.est > 0 && (t.logged || 0) >= t.est) {
    trueEstStr = `<span class="meta-pill true-est needed editable" onclick="editField(event,'${t.id}','true_est','number','')" title="Logged hours reached EST but the task is still active, so it counts 0 toward capacity — set a true estimate">+ True EST</span>`;
  }

  // Progress runs against the stable allocation window max(est, true_est),
  // never the moving max(est, logged) floor (that one is for capacity math)
  const allocTotal = Math.max(t.est ?? 0, t.true_est ?? 0);
  const logged = t.logged || 0;
  const overBy = t.over_by || 0;
  const stepComplete = t.designer_step && t.designer_step.completed;
  const barPct = stepComplete ? 100 : (allocTotal > 0 ? Math.min(100, logged / allocTotal * 100) : 0);
  const loggedCls = (t.overrides||[]).includes("logged") ? "overridden" : "";
  const loggedEl  = `<span class="meta-pill ${loggedCls} editable" onclick="editField(event,'${t.id}','logged','number','${logged}')" title="Click to log hours">${logged > 0 ? logged + "h" : "+ Log"}</span>`;

  let progressHtml = "";
  if (allocTotal > 0) {
    const barColor = overBy > 0 ? "var(--danger)" : color;
    const overBadge = overBy > 0 ? `<span class="over-budget-badge">+${overBy}h over</span>` : "";
    progressHtml = `<div class="progress-wrap">
      <div class="progress-bar-outer"><div class="progress-bar-inner" style="width:${barPct}%;background:${barColor}"></div></div>
      <span class="progress-label">${logged}h / ${allocTotal}h ${overBadge}</span>
      ${loggedEl}
    </div>`;
  } else {
    progressHtml = `<div class="progress-wrap">${loggedEl}</div>`;
  }

  const catOptions = CATEGORIES.map(c =>
    `<option value="${c}"${c === (t.category || "") ? " selected" : ""}>${c}</option>`
  ).join("");
  const catCls = catOverridden ? "category-select overridden" : "category-select";
  const catStr = `<select class="${catCls}" onchange="saveCategory('${t.id}', this.value)" title="Task category">${catOptions}</select>`;

  // Clean client name — strip tier/AM suffixes like "(2)(BW)" or "(1+)(TS)"
  const clientName = (t.bucket_name || "")
    .replace(/\s*\(\d+\+?\)\([A-Z]+\)\s*$/, "")
    .replace(/\s*\(\d+\+?\)\s*$/, "")
    .trim();
  const clientLabel = clientName
    ? `<div class="todo-client">${esc(clientName)}</div>`
    : "";

  const pulledBadge = pulledForward
    ? `<div class="pulled-forward-badge">↓ starting this week</div>`
    : "";

  let revisionBadge = "";
  if (t.in_revisions) {
    let waiting = "";
    if (t.revisions_since) {
      const days = Math.max(0, Math.floor((Date.now() - new Date(t.revisions_since)) / 86400000));
      waiting = ` · waiting ${days}d`;
    }
    revisionBadge = `<div class="revision-badge" title="Designer finished their step but the task was sent back — no revision deadline set yet">↩ Revisions${waiting}</div>`;
  }

  return `
  <li class="todo-item${isCompleted ? " todo-done" : ""}${pulledForward ? " pulled-forward" : ""}" id="todo-${t.id}">
    <div class="todo-item-left">
      ${clientLabel}
      <div class="todo-item-title" title="${esc(t.title)}">${isCompleted ? `<s>${esc(truncate(t.title, 60))}</s>` : esc(truncate(t.title, 60))}</div>
      <div class="todo-meta">${dateStr}${hddStr}${estStr}${trueEstStr}</div>
      <div class="todo-category">${catStr}${pulledBadge}${revisionBadge}</div>
      ${progressHtml}
    </div>
    <div class="todo-item-actions">
      ${t.url ? `<a href="${t.url}" target="_blank" class="link-btn" title="Open in Basecamp">↗</a>` : ""}
    </div>
  </li>`;
}

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

function editField(evt, todoId, field, inputType, currentValue) {
  evt.stopPropagation();
  const pill = evt.currentTarget;
  const orig = pill.outerHTML;

  // Build inline input
  const input = document.createElement("input");
  input.type = inputType;
  input.className = "inline-field-input";
  if (inputType === "number") {
    input.step = "0.5"; input.min = "0"; input.style.width = "70px";
  } else {
    input.style.width = "110px";
  }
  input.value = currentValue;

  pill.replaceWith(input);
  input.focus();
  if (inputType === "date" && currentValue) input.value = currentValue;

  const commit = async () => {
    const val = input.value.trim();
    if (val !== currentValue) {
      // Save to server (fire and forget — don't await)
      fetch(`/api/todos/${todoId}/fields`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: val || null }),
      });
      // Update in-memory designer data immediately for instant UI response
      for (const d of _designerData || []) {
        for (const t of d.todos || []) {
          if (String(t.id) === String(todoId)) {
            if (field === "est")      { t.est = val ? parseFloat(val) : null; }
            if (field === "true_est") { t.true_est = val ? parseFloat(val) : null; }
            if (field === "logged")   { t.logged = val ? parseFloat(val) : 0; }
            if (field === "hdd")    {
              t.hdd = val || null;
              if (val) t.hdd_stale = false;
              if (val && t.in_revisions) { t.in_revisions = false; t.revisions_since = null; }
            }
            if (field === "due_on") {
              t.due_on = val || null;
              // Re-sort this designer's list by due_on so it auto-moves
              d.todos.sort((a, b) => (a.due_on || "9999-99-99").localeCompare(b.due_on || "9999-99-99"));
            }
            const effEst = (t.true_est != null ? t.true_est : t.est) || 0;
            t.total_hours = effEst > 0 ? Math.max(effEst, t.logged || 0) : 0;
            t.over_by = effEst > 0 ? Math.max(0, Math.round(((t.logged || 0) - effEst) * 100) / 100) : 0;
            const stepComplete = t.designer_step && t.designer_step.completed;
            t.progress = stepComplete ? 100 : (t.total_hours > 0 ? Math.min(100, Math.round(t.logged / t.total_hours * 100)) : 0);
            if (!t.overrides) t.overrides = [];
            if (val && !t.overrides.includes(field)) t.overrides.push(field);
            if (!val) t.overrides = t.overrides.filter(f => f !== field);
          }
        }
      }
      // Re-render from updated in-memory data (preserve pto)
      renderDesignerGrid(_designerData);
      renderOverview();
      await loadCalendar();
      updateLastUpdated();
    } else {
      input.insertAdjacentHTML("afterend", orig);
      input.remove();
    }
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { input.insertAdjacentHTML("afterend", orig); input.remove(); }
  });
}


// ---------------------------------------------------------------------------
// Overview tab — expandable Team Pulse roster + Needs Attention panel
// ---------------------------------------------------------------------------

let _pulseSort = "load";
const _pulseExpanded = new Set();

function setPulseSort(mode) {
  _pulseSort = mode;
  document.querySelectorAll("#pulse-sort .sort-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.sort === mode));
  renderOverview();
}

function togglePulseRow(bcId) {
  const key = String(bcId);
  if (_pulseExpanded.has(key)) _pulseExpanded.delete(key);
  else _pulseExpanded.add(key);
  renderOverview();
}

function gotoDesigner(bcId) {
  const sel = document.getElementById("workload-filter");
  if (sel) sel.value = String(bcId);
  document.querySelector('.tab-btn[data-tab="designers"]')?.click();
  onWorkloadFilterChange();
}

function _overviewStats(d) {
  const { weekly_est, cap, pct } = calcCapacity(d.todos, d.pto, 0);
  const today = localISO(new Date());
  const active = (d.todos || []).filter(t => !t.is_complete && !t.is_misc);
  const pastDue = active.filter(t => !t.in_revisions && !t.hdd_stale && t.hdd && t.hdd < today);
  const free = Math.round((cap - weekly_est) * 10) / 10;
  return { weekly_est, cap, pct, active, pastDue, free };
}

function _barCls(pct) { return pct < 60 ? "low" : pct < 85 ? "mid" : "high"; }

function renderOverview() {
  const rowsEl = document.getElementById("pulse-rows");
  const gridEl = document.getElementById("attention-grid");
  if (!rowsEl || !gridEl || !_designerData.length) return;

  const stats = _designerData.map(d => ({ d, s: _overviewStats(d) }));
  stats.sort((a, b) => _pulseSort === "free" ? b.s.free - a.s.free : b.s.pct - a.s.pct);

  rowsEl.innerHTML = stats.map(({ d, s }) => renderPulseItem(d, s)).join("");
  gridEl.innerHTML = renderAttention(stats);
}

function renderPulseItem(d, s) {
  const expanded = _pulseExpanded.has(String(d.bc_id));
  const freeCls = s.free <= 2 ? "low" : s.free <= 8 ? "mid" : "ok";
  const freeLabel = s.free < 0 ? `${Math.abs(s.free)}h over` : `${s.free}h free`;
  const overdue = s.pastDue.length
    ? `<span class="pulse-overdue">${s.pastDue.length} past due</span>`
    : `<span class="pulse-overdue none">&mdash;</span>`;
  return `
  <div class="pulse-item${expanded ? " open" : ""}">
    <div class="pulse-row" onclick="togglePulseRow('${d.bc_id}')">
      <div class="avatar" style="background:${d.color}">${initialsOf(d.name)}</div>
      <div class="pulse-name">${esc(d.name)}</div>
      <div class="pulse-bar-wrap">
        <div class="cap-bar-outer"><div class="cap-bar-inner ${_barCls(s.pct)}" style="width:${Math.min(100, s.pct)}%"></div></div>
        <span class="pulse-pct">${s.pct}%</span>
      </div>
      <div class="pulse-tasks">${s.active.length} task${s.active.length === 1 ? "" : "s"}</div>
      <div class="pulse-overdue-cell">${overdue}</div>
      <div class="pulse-free ${freeCls}">${freeLabel}</div>
      <div class="pulse-chevron">&#9662;</div>
    </div>
    ${expanded ? renderPulseDetail(d, s) : ""}
  </div>`;
}

function renderPulseDetail(d, s) {
  const today = localISO(new Date());
  const soon = localISO(new Date(Date.now() + 2 * 86400000));
  if (!s.active.length) {
    return `<div class="pulse-detail"><div class="attention-empty">No active tasks this week.</div></div>`;
  }
  const rows = s.active.map(t => {
    let hddCell;
    if (t.in_revisions) {
      let waiting = "";
      if (t.revisions_since) {
        const days = Math.max(0, Math.floor((Date.now() - new Date(t.revisions_since)) / 86400000));
        waiting = ` · ${days}d`;
      }
      hddCell = `<span class="ov-pill revision">&#8617; Revisions${waiting}</span>`;
    } else if (!t.hdd) {
      hddCell = `<span class="ov-muted">&mdash;</span>`;
    } else if (t.hdd_stale) {
      hddCell = `<span class="ov-pill needed" title="Comment deadline over 14 days old — set a new HDD">stale ${fmtDate(t.hdd)}</span>`;
    } else {
      const cls = t.hdd < today ? "late" : t.hdd <= soon ? "soon" : "";
      hddCell = `<span class="ov-pill ${cls}">${fmtDate(t.hdd)}</span>`;
    }
    // Working estimate (TRUE when set) in the EST column; progress runs against
    // the stable allocation window max(est, true_est) — never the moving logged floor
    const estCell = t.true_est != null
      ? `<span class="ov-pill true-est" title="True estimate — Everhour allocation is ${t.est != null ? t.est + "h" : "unset"}">TRUE ${t.true_est}h</span>`
      : (t.est != null ? `${t.est}h` : `<span class="ov-muted">&mdash;</span>`);
    const allocTotal = Math.max(t.est ?? 0, t.true_est ?? 0);
    const stepDone = t.designer_step && t.designer_step.completed;
    const overTxt = (t.over_by || 0) > 0 ? ` <span class="ov-over">+${t.over_by}h over</span>` : "";
    const barPct = stepDone ? 100 : (allocTotal > 0 ? Math.min(100, (t.logged || 0) / allocTotal * 100) : 0);
    const progCell = allocTotal > 0
      ? `<div class="ov-prog"><div class="ov-prog-track"><div class="ov-prog-fill" style="width:${barPct}%;background:${d.color}"></div></div><span class="ov-muted">${t.logged || 0}h / ${allocTotal}h</span>${overTxt}</div>`
      : `<span class="ov-muted">${t.logged ? t.logged + "h logged" : "&mdash;"}</span>`;
    return `<tr class="ov-task-row">
      <td class="ov-client">${esc(cleanClient(t.bucket_name)) || "&mdash;"}</td>
      <td class="ov-title" title="${esc(t.title)}">${esc(truncate(t.title, 64))}</td>
      <td>${hddCell}</td>
      <td class="ov-est">${estCell}</td>
      <td>${progCell}</td>
      <td>${t.url ? `<a href="${t.url}" target="_blank" class="link-btn" title="Open in Basecamp" onclick="event.stopPropagation()">&#8599;</a>` : ""}</td>
    </tr>`;
  }).join("");
  return `<div class="pulse-detail">
    <table class="ov-table">
      <thead><tr><th>Client</th><th>Task</th><th>HDD</th><th>EST</th><th>Progress</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <button class="btn btn-ghost btn-sm ov-edit-link" onclick="gotoDesigner('${d.bc_id}')">Edit in Designer Workload &rarr;</button>
  </div>`;
}

function renderAttention(stats) {
  const today = localISO(new Date());
  const soon = localISO(new Date(Date.now() + 2 * 86400000));
  const pastDue = [], atRisk = [], decisions = [];

  for (const { d, s } of stats) {
    let missEst = 0, missHdd = 0;
    for (const t of s.active) {
      if (t.in_revisions) { decisions.push({ d, t, kind: "revision" }); continue; }
      if (t.hdd_stale) { decisions.push({ d, t, kind: "stale" }); continue; }
      if (t.est == null) missEst++;
      if (!t.has_hdd) missHdd++;
      if (t.hdd && t.hdd < today) {
        const days = Math.round((new Date(today) - new Date(t.hdd)) / 86400000);
        pastDue.push({ d, t, days });
      } else if (t.hdd && t.hdd <= soon && (t.progress || 0) < 50) {
        atRisk.push({ d, t });
      }
      // Orthogonal to lateness: an active task logged past its EST is invisible to capacity
      const stepDone = t.designer_step && t.designer_step.completed;
      if (!stepDone && t.true_est == null && t.est > 0 && (t.logged || 0) >= t.est) {
        decisions.push({ d, t, kind: "trueest" });
      }
    }
    if (missEst || missHdd) decisions.push({ d, kind: "missing", missEst, missHdd });
  }

  pastDue.sort((a, b) => b.days - a.days);
  atRisk.sort((a, b) => a.t.hdd.localeCompare(b.t.hdd));

  const mini = d => `<div class="avatar mini" style="background:${d.color}" title="${esc(d.name)}">${initialsOf(d.name)}</div>`;
  const taskRow = (d, t, right) => {
    const inner = `${mini(d)}
      <div class="attn-text">
        <div class="attn-client">${esc(cleanClient(t.bucket_name)) || "&nbsp;"}</div>
        <div class="attn-title">${esc(truncate(t.title, 52))}</div>
      </div>
      <div class="attn-right">${right}</div>`;
    return t.url
      ? `<a class="attn-row" href="${t.url}" target="_blank">${inner}</a>`
      : `<div class="attn-row">${inner}</div>`;
  };

  const capList = (rows, cap = 8) => {
    const shown = rows.slice(0, cap).join("");
    const more = rows.length > cap ? `<div class="attn-more">+${rows.length - cap} more</div>` : "";
    return shown + more;
  };

  const pastDueRows = pastDue.map(({ d, t, days }) =>
    taskRow(d, t, `<span class="ov-pill late">${fmtDate(t.hdd)}</span><span class="attn-days">${days}d late</span>`));
  const atRiskRows = atRisk.map(({ d, t }) =>
    taskRow(d, t, `<span class="ov-pill soon">${fmtDate(t.hdd)}</span><span class="attn-days amber">${t.progress || 0}%</span>`));
  const decisionRows = decisions.map(item => {
    if (item.kind === "revision") {
      const t = item.t;
      let waiting = "";
      if (t.revisions_since) {
        const days = Math.max(0, Math.floor((Date.now() - new Date(t.revisions_since)) / 86400000));
        waiting = ` ${days}d`;
      }
      return taskRow(item.d, t, `<span class="ov-pill revision">&#8617; waiting${waiting}</span>`);
    }
    if (item.kind === "stale") {
      return taskRow(item.d, item.t, `<span class="ov-pill needed">stale HDD ${fmtDate(item.t.hdd)} · re-set?</span>`);
    }
    if (item.kind === "trueest") {
      return taskRow(item.d, item.t, `<span class="ov-pill needed">+${item.t.over_by}h · True EST?</span>`);
    }
    const parts = [];
    if (item.missEst) parts.push(`${item.missEst} missing EST`);
    if (item.missHdd) parts.push(`${item.missHdd} missing HDD`);
    return `<div class="attn-row clickable" onclick="gotoDesigner('${item.d.bc_id}')">
      ${mini(item.d)}
      <div class="attn-text">
        <div class="attn-client">${esc(item.d.name)}</div>
        <div class="attn-title">${parts.join(" · ")}</div>
      </div>
      <div class="attn-right"><span class="attn-days amber">fix &rarr;</span></div>
    </div>`;
  });

  const panel = (label, rows, empty) => `
    <div class="attention-panel">
      <div class="attention-head">${label}${rows.length ? ` <span class="attention-count">${rows.length}</span>` : ""}</div>
      ${rows.length ? capList(rows) : `<div class="attention-empty">${empty}</div>`}
    </div>`;

  return panel("Past Due", pastDueRows, "Nothing past due.")
       + panel("At Risk", atRiskRows, "Nothing at risk in the next two days.")
       + panel("Needs a Decision", decisionRows, "No pending decisions.");
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
    });
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
    renderAnalyticsStats(_analyticsData);
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

function renderAnalyticsStats(data) {
  const completions = data.completions || [];
  const snapshots   = data.weekly_snapshots || [];
  const queue       = data.queue_time || [];

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
    ${stat("Tasks Completed", total, "all time")}
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
  // The completions-based stat strip is noise on the capacity section
  document.getElementById("analytics-stats")?.classList.toggle("hidden", section === "capacity");
  if (section === "capacity") { renderCapacitySection(el); return; }
  if (!_analyticsData) return;
  const { completions, weekly_snapshots, queue_time, category_volume } = _analyticsData;

  if (section === "completions") {
    if (!completions.length) { el.innerHTML = _noData("No completions recorded yet."); return; }
    const rows = completions.map(c => {
      const variance = (c.est_hours > 0 && c.logged_hours > 0)
        ? (c.logged_hours - c.est_hours).toFixed(1)
        : "—";
      const varCls = variance !== "—" ? (parseFloat(variance) > 0 ? "style='color:var(--danger)'" : "style='color:var(--success)'") : "";
      return `<tr>
        <td>${fmtDate(c.week_start)}</td>
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
      <thead><tr><th>Week</th><th>Designer</th><th>Client</th><th>Task</th><th>Category</th><th>EST</th><th>Logged</th><th>Variance</th><th>HDD</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;

  } else if (section === "snapshots") {
    if (!weekly_snapshots.length) { el.innerHTML = _noData("No weekly snapshots yet."); return; }
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
    if (!queue_time.length) { el.innerHTML = _noData("No queue time recorded yet."); return; }
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
    if (!category_volume.length) { el.innerHTML = _noData("No category data yet."); return; }
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
