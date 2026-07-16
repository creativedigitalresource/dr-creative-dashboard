/* ============================================================
   Designer view — one person's week, token-scoped.
   Sees: own capacity, own tasks, own planner, own attention items.
   Never sees: other designers, delegation queue, analytics.
   ============================================================ */

const TOKEN = (() => {
  const m = location.pathname.match(/\/my\/([^/]+)/);
  return m ? m[1] : new URLSearchParams(location.search).get("token");
})();

// Designer commit hook for the shared inline editors — writes go through
// the token-scoped endpoint, which validates the todo belongs to this designer
window.__commitField = async (todoId, field, val) => {
  fetch(`/api/my/${TOKEN}/todos/${todoId}/fields`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [field]: val || null }),
  });
  const t = (_me?.todos || []).find(x => String(x.id) === String(todoId));
  if (t) applyFieldLocal(t, field, val);
  renderMe();
};

let _me = null;
let _dragId = null;

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
  const active = (d.todos || []).filter(t => !t.is_complete && !t.is_misc);

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
      <div class="my-table-wrap">${buildTaskTable(active, d.color)}</div>
    </div>
    <div class="pulse-panel">
      <div class="cap-chart-title" style="margin-bottom:4px">This Week</div>
      <div class="cap-chart-sub" style="margin-bottom:12px">Drag a task onto a day to schedule it — the due date updates in Basecamp.</div>
      <div class="my-planner" id="my-planner"></div>
    </div>
    <div class="attention-grid" id="my-attention"></div>`;
  renderMyPlanner();
  renderMyAttention(active, d.color);
}

function renderMyAttention(active, color) {
  const today = localISO(new Date());
  const soon = localISO(new Date(Date.now() + 2 * 86400000));
  const pastDue = [], atRisk = [], decisions = [];

  for (const t of active) {
    if (t.in_revisions) { decisions.push({ t, kind: "revision" }); continue; }
    if (t.hdd_stale) { decisions.push({ t, kind: "stale" }); continue; }
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
    if (item.kind === "stale") return row(t, `<span class="ov-pill needed">stale HDD ${fmtDate(t.hdd)} · re-set?</span>`);
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
    const r = await fetch(`/api/my/${TOKEN}/todos/${id}/fields`, {
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
