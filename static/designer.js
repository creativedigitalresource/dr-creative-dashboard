/* ============================================================
   Designer view — one person's week, token-scoped.
   Sees: own capacity, own tasks, own planner, own attention items.
   Never sees: other designers, delegation queue, analytics.
   ============================================================ */

const TOKEN = (() => {
  const m = location.pathname.match(/\/my\/([^/]+)/);
  return m ? m[1] : new URLSearchParams(location.search).get("token");
})();

let _me = null;
let _dragId = null;

async function loadMe() {
  const r = await fetch(`/api/my/${TOKEN}`);
  if (!r.ok) {
    document.getElementById("my-root").innerHTML =
      `<div class="loading-card">This link isn't valid. Ask Richard for a fresh one.</div>`;
    return;
  }
  _me = await r.json();
  renderMe();
  const lu = document.getElementById("last-updated");
  if (lu && _me.last_updated) {
    lu.textContent = "Updated " + new Date(_me.last_updated * 1000)
      .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
}

function myRefresh() {
  const btn = document.getElementById("refresh-btn");
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="refresh-spin">&#8635;</span> Refreshing…`; }
  fetch("/api/refresh", { method: "POST" }).finally(() => {
    setTimeout(async () => {
      await loadMe();
      if (btn) { btn.disabled = false; btn.innerHTML = "&#8635; Refresh"; }
    }, 20000);
  });
}

function renderMe() {
  const d = _me;
  const root = document.getElementById("my-root");
  document.getElementById("my-subtitle").textContent = `My Week · ${d.name}`;
  const { weekly_est, cap, pct, pto_days } = calcCapacity(d.todos, d.pto, 0);
  const free = Math.round((cap - weekly_est) * 10) / 10;
  const barCls = pct < 60 ? "low" : pct < 85 ? "mid" : "high";
  const today = localISO(new Date());
  const soon = localISO(new Date(Date.now() + 2 * 86400000));

  const active = (d.todos || []).filter(t => !t.is_complete && !t.is_misc);
  const pastDue = active.filter(t => !t.in_revisions && !t.hdd_stale && t.hdd && t.hdd < today);
  const dueSoon = active.filter(t => !t.in_revisions && !t.hdd_stale && t.hdd && t.hdd >= today && t.hdd <= soon && (t.progress || 0) < 50);
  const revisions = active.filter(t => t.in_revisions);
  const missingDates = active.filter(t => !t.in_revisions && (!t.has_hdd || t.est == null));

  const chip = (n, label, cls) => n
    ? `<span class="my-chip ${cls}">${n} ${label}</span>` : "";
  const chips = [
    chip(pastDue.length, "past due", "red"),
    chip(dueSoon.length, "due in 2 days", "amber"),
    chip(revisions.length, "back for revisions", "purple"),
    chip(missingDates.length, "missing EST or HDD", "amber"),
  ].filter(Boolean).join("") || `<span class="my-chip ok">All clear — nothing needs attention</span>`;

  root.innerHTML = `
    <div class="pulse-panel">
      <div class="my-pulse">
        <div class="avatar" style="background:${d.color}">${initialsOf(d.name)}</div>
        <div class="my-pulse-info">
          <div class="pulse-name">${esc(d.name)}</div>
          <div class="my-pulse-sub">${active.length} active task${active.length === 1 ? "" : "s"} this week${pto_days ? ` · ${pto_days} OOO day${pto_days > 1 ? "s" : ""}` : ""}</div>
        </div>
        <div class="pulse-bar-wrap my-pulse-bar">
          <div class="cap-bar-outer"><div class="cap-bar-inner ${barCls}" style="width:${Math.min(100, pct)}%"></div></div>
          <span class="pulse-pct">${pct}%</span>
        </div>
        <div class="pulse-free ${free <= 2 ? "low" : free <= 8 ? "mid" : "ok"}">${free < 0 ? Math.abs(free) + "h over" : free + "h free"}</div>
      </div>
      <div class="my-chips">${chips}</div>
    </div>
    <div class="pulse-panel">
      <div class="cap-chart-title" style="margin-bottom:4px">This Week</div>
      <div class="cap-chart-sub" style="margin-bottom:12px">Drag a task onto a day to schedule it — the due date updates in Basecamp.</div>
      <div class="my-planner" id="my-planner"></div>
    </div>
    <div class="pulse-panel">
      <div class="cap-chart-title" style="margin-bottom:10px">My Tasks</div>
      ${renderMyTable(active, d.color, today, soon)}
    </div>`;
  renderMyPlanner();
}

function renderMyTable(active, color, today, soon) {
  if (!active.length) return `<div class="attention-empty">No active tasks. Enjoy the quiet.</div>`;
  const rows = active.map(t => {
    let hddCell;
    if (t.in_revisions) {
      hddCell = `<span class="ov-pill revision">&#8617; Revisions — waiting on a new date</span>`;
    } else if (t.hdd_stale) {
      hddCell = `<span class="ov-pill needed">date needs a re-set</span>`;
    } else if (!t.hdd) {
      hddCell = `<span class="ov-muted">&mdash;</span>`;
    } else {
      const cls = t.hdd < today ? "late" : t.hdd <= soon ? "soon" : "";
      hddCell = `<span class="ov-pill ${cls}">${fmtDate(t.hdd)}</span>`;
    }
    const est = t.est;
    const logged = t.logged || 0;
    const overTxt = (t.over_by || 0) > 0 ? ` <span class="ov-over">+${t.over_by}h over</span>` : "";
    const barPct = t.step_complete ? 100 : (est > 0 ? Math.min(100, logged / est * 100) : 0);
    const progCell = est > 0
      ? `<div class="ov-prog"><div class="ov-prog-track"><div class="ov-prog-fill" style="width:${barPct}%;background:${color}"></div></div><span class="ov-muted">${logged}h / ${est}h</span>${overTxt}</div>`
      : `<span class="ov-muted">${logged ? logged + "h logged" : "&mdash;"}</span>`;
    return `<tr class="ov-task-row">
      <td class="ov-client">${esc(cleanClient(t.bucket_name)) || "&mdash;"}</td>
      <td class="ov-title" title="${esc(t.title)}">${esc(truncate(t.title, 64))}</td>
      <td>${hddCell}</td>
      <td class="ov-est">${est != null ? est + "h" : `<span class="ov-muted">&mdash;</span>`}</td>
      <td>${progCell}</td>
      <td>${t.url ? `<a href="${t.url}" target="_blank" class="link-btn" title="Open in Basecamp">&#8599;</a>` : ""}</td>
    </tr>`;
  }).join("");
  return `<div class="table-wrap" style="box-shadow:none;border:none"><table class="ov-table">
    <thead><tr><th>Client</th><th>Task</th><th>HDD</th><th>EST</th><th>Progress</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
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
  const dayHours = list => list.reduce((s, t) => s + Math.max(0, (t.est || 0) - (t.logged || 0)), 0);

  const card = t => `
    <div class="planner-card" draggable="true" id="my-card-${t.id}"
        ondragstart="myDragStart(event,'${t.id}')">
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
    return `<div class="planner-day-col${dt === todayStr ? " is-today" : ""}${dt < todayStr ? " is-past" : ""}" ${zone(dt)}>
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

async function myDrop(evt, targetDate) {
  evt.preventDefault();
  evt.currentTarget.classList.remove("drag-over");
  const id = _dragId; _dragId = null;
  if (!id || !targetDate) return;
  const todo = (_me.todos || []).find(t => String(t.id) === String(id));
  if (!todo || todo.due_on === targetDate) return;
  const prev = todo.due_on;
  todo.due_on = targetDate;
  renderMe();
  try {
    const r = await fetch(`/api/my/${TOKEN}/todos/${id}/due`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ due_on: targetDate }),
    });
    if (!r.ok) throw new Error("save failed");
  } catch {
    todo.due_on = prev;
    renderMe();
  }
}

if (!TOKEN) {
  document.getElementById("my-root").innerHTML =
    `<div class="loading-card">Missing access token.</div>`;
} else {
  loadMe();
  setInterval(loadMe, 90000);
}
