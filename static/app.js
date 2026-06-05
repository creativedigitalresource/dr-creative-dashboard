/* ============================================================
   DR Creative Dashboard — Frontend
   ============================================================ */

let calendar = null;
let _modalTodoId = null;
let _modalTodoTitle = "";

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let _pollTimer = null;

async function boot() {
  const status = await fetch("/api/status").then(r => r.json()).catch(() => null);
  if (!status || !status.authenticated) {
    show("login-screen");
    hide("main-content");
    return;
  }
  hide("login-screen");
  show("main-content");
  initTabs();
  initCalendar();
  connectSSE();
  // If data is stale or missing, hitting /api/unassigned will auto-trigger a refresh
  await loadAll();
  // If still loading, start polling until data arrives
  if (!status.last_updated || status.stale) {
    startPolling();
  }
}

function startPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(async () => {
    const s = await fetch("/api/status").then(r => r.json()).catch(() => null);
    if (!s) return;
    if (!s.refreshing && s.last_updated) {
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
  await Promise.all([loadUnassigned(), loadDesigners()]);
  await loadCalendar();
  updateLastUpdated();
}

async function loadUnassigned() {
  const todos = await fetch("/api/unassigned").then(r => r.json()).catch(() => []);
  document.getElementById("unassigned-count").textContent = todos.length || "";
  const tbody = document.getElementById("unassigned-tbody");
  if (!todos.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="loading-cell">Fetching from Basecamp — may take up to 60s on first load…</td></tr>`;
    return;
  }
  tbody.innerHTML = todos.map(t => {
    const due = t.due_on ? formatDue(t.due_on) : "";
    return `<tr>
      <td>
        <div class="todo-title">${esc(t.title)}</div>
      </td>
      <td><span class="todolist-name">${esc(t.todolist_name)}</span></td>
      <td><span class="due-date ${dueCls(t.due_on)}">${due}</span></td>
      <td>
        ${t.url ? `<a href="${t.url}" target="_blank" class="link-btn" title="Open in Basecamp">↗</a>` : ""}
      </td>
    </tr>`;
  }).join("");
}

async function loadDesigners() {
  const designers = await fetch("/api/designers").then(r => r.json()).catch(() => []);
  const grid = document.getElementById("designer-grid");
  if (!designers.length) {
    grid.innerHTML = `<div class="loading-card">Fetching from Basecamp — may take up to 60s on first load…</div>`;
    return;
  }
  grid.innerHTML = designers.map(d => renderDesignerCard(d)).join("");
}

async function loadCalendar() {
  const events = await fetch("/api/calendar").then(r => r.json()).catch(() => []);
  if (calendar) {
    calendar.removeAllEvents();
    calendar.addEventSource(events);
  }
}

// ---------------------------------------------------------------------------
// Designer card rendering
// ---------------------------------------------------------------------------

function renderDesignerCard(d) {
  const pct = d.capacity_pct || 0;
  const barCls = pct < 60 ? "low" : pct < 85 ? "mid" : "high";
  const initials = d.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();

  const todosHtml = d.todos && d.todos.length
    ? `<ul class="designer-todos">${d.todos.map(t => renderTodoItem(t, d.color)).join("")}</ul>`
    : `<div class="no-todos">No active tasks</div>`;

  return `
  <div class="designer-card">
    <div class="designer-card-header">
      <div class="designer-name-wrap">
        <div class="designer-avatar" style="background:${d.color}">${initials}</div>
        <div>
          <div class="designer-name">${esc(d.name)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${d.todos ? d.todos.length : 0} task${d.todos?.length !== 1 ? "s" : ""}</div>
        </div>
      </div>
      <div class="designer-cap-wrap">
        <div class="cap-label">Week capacity &middot; ${d.weekly_est}h / ${d.weekly_cap}h</div>
        <div class="cap-bar-outer">
          <div class="cap-bar-inner ${barCls}" style="width:${pct}%"></div>
        </div>
        <div style="font-size:11px;color:var(--text-muted);text-align:right">${pct}% booked</div>
      </div>
    </div>
    ${todosHtml}
  </div>`;
}

function renderTodoItem(t, color) {
  const ov = t.overrides || [];
  const hddCls = ov.includes("hdd") ? "hdd overridden" : "hdd";
  const pddCls = ov.includes("pdd") ? "pdd overridden" : "pdd";
  const estCls = ov.includes("est") ? "est overridden" : "est";
  const revsCls = ov.includes("revs") ? "overridden" : "";

  const hddStr = `<span class="meta-pill ${hddCls} editable" onclick="editField(event,'${t.id}','hdd','date','${t.hdd||''}')" title="Click to edit HDD">${t.hdd ? "HDD " + fmtDate(t.hdd) : "+ HDD"}</span>`;
  const pddStr = `<span class="meta-pill ${pddCls} editable" onclick="editField(event,'${t.id}','pdd','date','${t.pdd||''}')" title="Click to edit PDD">${t.pdd ? "PDD " + fmtDate(t.pdd) : "+ PDD"}</span>`;
  const estStr = `<span class="meta-pill ${estCls} editable" onclick="editField(event,'${t.id}','est','number','${t.est??''}')" title="Click to edit EST">${t.est != null ? "EST " + t.est + "h" : "+ EST"}</span>`;
  const revsStr = `<span class="meta-pill ${revsCls} editable" onclick="editField(event,'${t.id}','revs','number','${t.revs||0}')" title="Click to edit REVS">${t.revs ? "REVS " + t.revs + "h" : "+ REVS"}</span>`;

  const total = t.total_hours || 0;
  const logged = t.logged || 0;
  const pct = t.progress || 0;
  let progressHtml = "";
  if (total > 0) {
    progressHtml = `<div class="progress-wrap">
      <div class="progress-bar-outer"><div class="progress-bar-inner" style="width:${pct}%;background:${color}"></div></div>
      <span class="progress-label">${logged}h / ${total}h</span>
    </div>`;
  } else if (logged > 0) {
    progressHtml = `<div class="progress-wrap">
      <span class="progress-label" style="color:var(--text-muted)">${logged}h logged</span>
    </div>`;
  }

  const sdLabel = t.start_date ? `Start: ${fmtDate(t.start_date)}` : `+ Set start date`;
  const sdCls2 = t.start_date ? "set" : "";

  return `
  <li class="todo-item" id="todo-${t.id}">
    <div class="todo-item-left">
      <div class="todo-item-title" title="${esc(t.title)}">${esc(truncate(t.title, 60))}</div>
      <div class="todo-meta">${hddStr}${pddStr}${estStr}${revsStr}</div>
      ${progressHtml}
    </div>
    <div class="todo-item-actions">
      ${t.url ? `<a href="${t.url}" target="_blank" class="link-btn" title="Open in Basecamp">↗</a>` : ""}
      <span class="start-date-badge ${sdCls2}" onclick="openModal('${t.id}', '${esc(t.title.replace(/'/g, "\\'"))}', '${t.start_date || ""}')">${sdLabel}</span>
    </div>
  </li>`;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

function initCalendar() {
  const el = document.getElementById("calendar");
  calendar = new FullCalendar.Calendar(el, {
    initialView: "dayGridMonth",
    headerToolbar: {
      left: "prev,next today",
      center: "title",
      right: "dayGridMonth,timeGridWeek",
    },
    height: "calc(100vh - 180px)",
    eventClick: function(info) {
      const props = info.event.extendedProps;
      if (props.url) window.open(props.url, "_blank");
    },
    eventDidMount: function(info) {
      const props = info.event.extendedProps;
      const tip = [
        `Designer: ${props.designer}`,
        props.est ? `EST: ${props.est}h` : "",
        props.revs ? `REVS: ${props.revs}h` : "",
        props.logged ? `Logged: ${props.logged}h` : "",
        props.progress ? `Progress: ${props.progress}%` : "",
      ].filter(Boolean).join("\n");
      info.el.title = tip;
    },
  });
  calendar.render();
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
      await fetch(`/api/todos/${todoId}/fields`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: val || null }),
      });
      // Reload designers to reflect new capacity
      await loadDesigners();
      await loadCalendar();
    } else {
      // No change — restore pill from DOM
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
// Start date modal
// ---------------------------------------------------------------------------

function openModal(todoId, title, existingDate) {
  _modalTodoId = todoId;
  _modalTodoTitle = title;
  document.getElementById("modal-title").textContent = "Set Start Date";
  document.getElementById("modal-task-name").textContent = title;
  document.getElementById("modal-date-input").value = existingDate || "";
  show("date-modal");
}

function closeModal() {
  hide("date-modal");
  _modalTodoId = null;
}

async function saveStartDate() {
  if (!_modalTodoId) return;
  const date = document.getElementById("modal-date-input").value;
  if (!date) { closeModal(); return; }
  await fetch(`/api/todos/${_modalTodoId}/start-date`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start_date: date }),
  });
  closeModal();
  await loadAll();
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
// Init
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", boot);
