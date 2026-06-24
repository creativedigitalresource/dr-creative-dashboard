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

function getESTHour() {
  return parseInt(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", hour12: false
  }).format(new Date()));
}

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
}

function renderDesignerGrid(designers) {
  const filtered = _workloadFilter === "all"
    ? designers
    : designers.filter(d => String(d.bc_id) === _workloadFilter);

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

function getWeekBounds(offset = 0) {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7) + offset * 7);
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  return {
    start: monday.toISOString().split("T")[0],
    end: friday.toISOString().split("T")[0],
  };
}

function calcCapacity(todos, pto, offset = 0) {
  const { start, end } = getWeekBounds(offset);

  let cap;
  if (offset === 0) {
    // Current week: remaining workdays from today (inclusive)
    // Mon=5, Tue=4, Wed=3, Thu=2, Fri=1, Sat/Sun=0
    const today = new Date();
    const dow = today.getDay();
    const rawRemaining = (dow === 0 || dow === 6) ? 0 : 6 - dow;
    // After 5 PM EST, today's work day is done — shift to next day's remaining count
    const past5pm = getESTHour() >= 17;
    const remainingDays = past5pm ? Math.max(0, rawRemaining - 1) : rawRemaining;
    const todayStr = today.toISOString().split("T")[0];
    const ptoDaysLeft = (pto || []).filter(p => p.date >= todayStr && p.date <= end).length;
    cap = Math.max(0, (remainingDays - ptoDaysLeft) * 7);
  } else {
    // Future weeks: full 5-day week
    const ptoDays = (pto || []).filter(p => p.date >= start && p.date <= end).length;
    cap = Math.max(0, (5 - ptoDays) * 7);
  }
  const ptoDayCount = offset === 0
    ? (pto || []).filter(p => { const t = new Date().toISOString().split("T")[0]; return p.date >= t && p.date <= end; }).length
    : (pto || []).filter(p => p.date >= start && p.date <= end).length;
  const weekly_est = (todos || []).reduce((sum, t) => {
    if (t.is_complete || t.is_misc || !t.hdd) return sum;
    const inWindow = offset === 0 ? t.hdd <= end : (t.hdd >= start && t.hdd <= end);
    const remaining = Math.max(0, (t.total_hours || 0) - (t.logged || 0));
    return inWindow ? sum + remaining : sum;
  }, 0);
  return {
    weekly_est: Math.round(weekly_est * 10) / 10,
    cap,
    pct: cap > 0 ? Math.min(100, Math.round(weekly_est / cap * 100)) : 100,
    pto_days: ptoDayCount,
  };
}

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
  const { weekly_est, cap, pct, pto_days } = calcCapacity(d.todos, d.pto, _weekOffset);
  const barCls = pct < 60 ? "low" : pct < 85 ? "mid" : "high";
  const initials = d.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
  const ptoBadge = pto_days > 0
    ? `<span class="pto-badge">${pto_days} OOO day${pto_days > 1 ? "s" : ""} this wk</span>`
    : "";

  // Filter todo list by due_on (not hdd)
  // Current week: show all todos with due_on <= this Friday (overdue rolls forward)
  // Future weeks: only todos with due_on falling in that Mon–Fri window
  const allTodos = d.todos || [];
  const { start: wStart, end: wEnd } = getWeekBounds(_weekOffset);
  const weekTodos = allTodos.filter(t => {
    if (!t.due_on) return _weekOffset === 0;
    return _weekOffset === 0 ? t.due_on <= wEnd : (t.due_on >= wStart && t.due_on <= wEnd);
  });
  const activeTodos    = weekTodos.filter(t => !t.is_complete);
  const completedTodos = weekTodos.filter(t =>  t.is_complete);

  const completedFooter = completedTodos.length ? `
    <div class="completed-toggle" onclick="toggleCompleted('${d.bc_id}')">
      ${showCompleted ? "▲ Hide" : "▼ Show"} ${completedTodos.length} completed task${completedTodos.length !== 1 ? "s" : ""}
    </div>
    ${showCompleted ? `<ul class="designer-todos completed-section">${completedTodos.map(t => renderTodoItem(t, d.color, true)).join("")}</ul>` : ""}
  ` : "";

  const todosHtml = activeTodos.length
    ? `<ul class="designer-todos">${activeTodos.map(t => renderTodoItem(t, d.color)).join("")}</ul>${completedFooter}`
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

function renderTodoItem(t, color, isCompleted = false) {
  const ov = t.overrides || [];
  const hddCls = ov.includes("hdd") ? "hdd overridden" : "hdd";
  const estCls = ov.includes("est") ? "est overridden" : "est";
  const catOverridden = ov.includes("category");

  const dateStr = `<span class="meta-pill date-pill editable" onclick="editField(event,'${t.id}','due_on','date','${t.due_on||''}')" title="Click to change date — re-sorts the list">${t.due_on ? fmtDate(t.due_on) : "+ Date"}</span>`;
  const hddStr = `<span class="meta-pill ${hddCls} editable" onclick="editField(event,'${t.id}','hdd','date','${t.hdd||''}')" title="Click to edit — updates Basecamp step due date">${t.hdd ? "HDD " + fmtDate(t.hdd) : "+ HDD"}</span>`;
  const estStr = `<span class="meta-pill ${estCls} editable" onclick="editField(event,'${t.id}','est','number','${t.est??''}')" title="Click to edit — updates Everhour estimate">${t.est != null ? "EST " + t.est + "h" : "+ EST"}</span>`;

  const total = t.total_hours || 0;
  const logged = t.logged || 0;
  const pct = t.progress || 0;
  const overBy = t.over_by || 0;
  const loggedCls = (t.overrides||[]).includes("logged") ? "overridden" : "";
  const loggedEl  = `<span class="meta-pill ${loggedCls} editable" onclick="editField(event,'${t.id}','logged','number','${logged}')" title="Click to log hours">${logged > 0 ? logged + "h" : "+ Log"}</span>`;

  let progressHtml = "";
  if (total > 0) {
    const barColor = overBy > 0 ? "var(--danger)" : color;
    const overBadge = overBy > 0 ? `<span class="over-budget-badge">+${overBy}h over</span>` : "";
    progressHtml = `<div class="progress-wrap">
      <div class="progress-bar-outer"><div class="progress-bar-inner" style="width:${pct}%;background:${barColor}"></div></div>
      <span class="progress-label">${logged}h / ${total}h ${overBadge}</span>
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

  return `
  <li class="todo-item${isCompleted ? " todo-done" : ""}" id="todo-${t.id}">
    <div class="todo-item-left">
      <div class="todo-item-title" title="${esc(t.title)}">${isCompleted ? `<s>${esc(truncate(t.title, 60))}</s>` : esc(truncate(t.title, 60))}</div>
      <div class="todo-meta">${dateStr}${hddStr}${estStr}</div>
      <div class="todo-category">${catStr}</div>
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

const WORK_START = 9;   // 9 AM
const WORK_HOURS = 6.5; // hours per day (1.5h reserved for misc/admin)

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
// Inline field editing (HDD, PDD, EST, REVS)
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
            if (field === "est")    { t.est = val ? parseFloat(val) : null; }
            if (field === "logged") { t.logged = val ? parseFloat(val) : 0; }
            if (field === "hdd")    { t.hdd = val || null; }
            if (field === "due_on") {
              t.due_on = val || null;
              // Re-sort this designer's list by due_on so it auto-moves
              d.todos.sort((a, b) => (a.due_on || "9999-99-99").localeCompare(b.due_on || "9999-99-99"));
            }
            t.total_hours = t.est || 0;
            const stepComplete = t.designer_step && t.designer_step.completed;
            t.progress = stepComplete ? 100 : (t.total_hours > 0 ? Math.min(100, Math.round(t.logged / t.total_hours * 100)) : 0);
            if (!t.overrides) t.overrides = [];
            if (!t.overrides.includes(field)) t.overrides.push(field);
          }
        }
      }
      // Re-render from updated in-memory data (preserve pto)
      renderDesignerGrid(_designerData);
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
    });
  });
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

function triggerRefresh() {
  fetch("/api/refresh", { method: "POST" });
  startPolling(); // poll until refresh completes, then reload UI
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function show(id) { document.getElementById(id)?.classList.remove("hidden"); }
function hide(id) { document.getElementById(id)?.classList.add("hidden"); }

function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(str, n) {
  return str && str.length > n ? str.slice(0, n) + "…" : str;
}

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${parseInt(m)}/${parseInt(d)}`;
}

function formatDue(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function dueCls(iso) {
  if (!iso) return "";
  const today = new Date(); today.setHours(0,0,0,0);
  const due = new Date(iso + "T00:00:00");
  const diff = (due - today) / 86400000;
  if (diff < 0) return "overdue";
  if (diff <= 2) return "due-soon";
  return "";
}

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
// Init
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", boot);
