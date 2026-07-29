/* ============================================================
   Shared helpers — loaded by both the manager dashboard (app.js)
   and the designer view (designer.js). Keep capacity logic here
   so the two views can never drift apart.
   ============================================================ */

const WORK_START = 9;   // 9 AM
const WORK_HOURS = 6.5; // hours per day (1.5h reserved for misc/admin)

function getESTHour() {
  return parseInt(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", hour12: false
  }).format(new Date()));
}

function localISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getWeekBounds(offset = 0) {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7) + offset * 7);
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  return {
    start: localISO(monday),
    end: localISO(friday),
  };
}

function calcCapacity(todos, pto, offset = 0) {
  const { start, end } = getWeekBounds(offset);

  let cap;
  if (offset === 0) {
    const today = new Date();
    const dow = today.getDay();
    const rawRemaining = (dow === 0 || dow === 6) ? 0 : 6 - dow;
    const past5pm = getESTHour() >= 17;
    const remainingDays = past5pm ? Math.max(0, rawRemaining - 1) : rawRemaining;
    const todayStr = localISO(today);
    const ptoDaysLeft = (pto || []).filter(p => p.date >= todayStr && p.date <= end).length;
    cap = Math.max(0, (remainingDays - ptoDaysLeft) * WORK_HOURS);
  } else {
    const ptoDays = (pto || []).filter(p => p.date >= start && p.date <= end).length;
    cap = Math.max(0, (5 - ptoDays) * WORK_HOURS);
  }

  const ptoDayCount = offset === 0
    ? (pto || []).filter(p => { const t = localISO(new Date()); return p.date >= t && p.date <= end; }).length
    : (pto || []).filter(p => p.date >= start && p.date <= end).length;

  // Scheduled fill: sort all active todos by priority, fill this week's hours bucket.
  // Tasks due this week always count. Tasks due later fill any remaining capacity,
  // so a designer's free hours are never shown as empty when real work is queued.
  const activeTodos = (todos || []).filter(t => !t.is_complete && !t.is_misc);
  const _isDRInternal = bn => { const s = (bn || "").toLowerCase(); return s.includes("digital resource") || s.includes("dr team"); };
  const sorted = [...activeTodos].sort((a, b) => {
    const ia = _isDRInternal(a.bucket_name) ? 1 : 0, ib = _isDRInternal(b.bucket_name) ? 1 : 0;
    if (ia !== ib) return ia - ib;
    const da = (a.due_on || "9999-99-99").localeCompare(b.due_on || "9999-99-99");
    if (da !== 0) return da;
    const ha = a.has_hdd ? 0 : 1, hb = b.has_hdd ? 0 : 1;
    if (ha !== hb) return ha - hb;
    return (a.hdd || "9999-99-99").localeCompare(b.hdd || "9999-99-99");
  });

  let bucket = cap;
  let weekly_est = 0;
  const scheduledIds = new Set();

  for (const t of sorted) {
    if (t.in_revisions) continue; // unscheduled revisions: no deadline decided yet, 0 capacity
    if (t.hdd_stale) continue;    // abandoned comment deadline: needs a re-set, not scheduling
    if (!t.total_hours) continue;
    const remaining = Math.max(0, t.total_hours - (t.logged || 0));
    if (remaining <= 0) continue;

    const inThisWeek = offset === 0
      ? (t.hdd && t.hdd <= end)
      : (t.hdd && t.hdd >= start && t.hdd <= end);

    if (inThisWeek) {
      weekly_est += remaining;
      bucket = Math.max(0, bucket - remaining);
      scheduledIds.add(t.id);
    } else if (offset === 0 && bucket > 0) {
      // Pull future task forward to fill remaining capacity
      const fill = Math.min(remaining, bucket);
      weekly_est += fill;
      bucket -= fill;
      scheduledIds.add(t.id);
    }
  }

  return {
    weekly_est: Math.round(weekly_est * 10) / 10,
    cap,
    pct: cap > 0 ? Math.min(100, Math.round(weekly_est / cap * 100)) : (weekly_est > 0 ? 100 : 0),
    pto_days: ptoDayCount,
    scheduledIds,
  };
}

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

// Shared by the My Week standup button and the manager's Standups tab —
// shows an "updated" qualifier only once a repost has actually happened.
function standupTimeLabel(standup) {
  const fmt = ts => new Date(ts * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const posted = fmt(standup.posted_at);
  return (standup.first_posted_at && standup.posted_at !== standup.first_posted_at)
    ? `Posted ${fmt(standup.first_posted_at)} &middot; updated ${posted}`
    : `Posted ${posted}`;
}

// Remaining hours on a task today (est minus what's already logged), same
// formula the day-planner's own dayHours() uses for the day-header total —
// the standup should show what's left to do today, not the task's full
// original estimate (which double-counts hours already logged elsewhere).
// Returns null when there's no estimate at all, distinct from a real 0.
function taskRemainingHrs(t) {
  if (t.est == null) return null;
  return Math.max(0, Math.round(((t.est || 0) - (t.logged || 0)) * 10) / 10);
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

function initialsOf(name) {
  return name.split(/\s+/).filter(Boolean).map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

// Real headshot when we have one (d.avatar, a local /static/img/avatars path),
// falling back to the colored-letter circle for anyone without a photo on file.
function avatarHTML(d, opts = {}) {
  const cls = (opts.cls || "avatar") + (opts.mini ? " mini" : "");
  const titleAttr = opts.title ? ` title="${esc(opts.title)}"` : "";
  if (d.avatar) {
    return `<img class="${cls}" src="${d.avatar}" alt="${esc(d.name)}"${titleAttr} />`;
  }
  // Brand contrast rule: navy text on lime, white everywhere else — the
  // fallback letter circle only shows for a designer with no photo on file,
  // but a lime-colored designer would otherwise get illegible white-on-lime.
  const textColor = d.color && d.color.toLowerCase() === "#d5de23" ? "var(--dr-navy)" : "#fff";
  return `<div class="${cls}" style="background:${d.color};color:${textColor}"${titleAttr}>${initialsOf(d.name)}</div>`;
}

function cleanClient(bucketName) {
  return (bucketName || "")
    .replace(/\s*\(\d+\+?\)\([A-Z]+\)\s*$/, "")
    .replace(/\s*\(\d+\+?\)\s*$/, "")
    .trim();
}

/* ---- Task categories (dropdown) ---- */
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

/* ---- Inline field editing, shared by both views ----
   The page defines window.__commitField(todoId, field, val) to say where
   the edit is saved and how the local model re-renders. */

function applyFieldLocal(t, field, val) {
  if (field === "est")      t.est = val ? parseFloat(val) : null;
  if (field === "true_est") t.true_est = val ? parseFloat(val) : null;
  if (field === "logged")   t.logged = val ? parseFloat(val) : 0;
  if (field === "category") t.category = val;
  if (field === "due_on")   t.due_on = val || null;
  if (field === "hdd") {
    t.hdd = val || null;
    if (val) t.hdd_stale = false;
    if (val && t.in_revisions) { t.in_revisions = false; t.revisions_since = null; }
  }
  const effEst = (t.true_est != null ? t.true_est : t.est) || 0;
  t.total_hours = effEst > 0 ? Math.max(effEst, t.logged || 0) : 0;
  t.over_by = effEst > 0 ? Math.max(0, Math.round(((t.logged || 0) - effEst) * 100) / 100) : 0;
  const stepComplete = t.designer_step && t.designer_step.completed;
  t.progress = stepComplete ? 100 : (t.total_hours > 0 ? Math.min(100, Math.round((t.logged || 0) / t.total_hours * 100)) : 0);
  if (!t.overrides) t.overrides = [];
  if (val && !t.overrides.includes(field)) t.overrides.push(field);
  if (!val) t.overrides = t.overrides.filter(f => f !== field);
}

function editField(evt, todoId, field, inputType, currentValue) {
  evt.stopPropagation();
  const pill = evt.currentTarget;
  const orig = pill.outerHTML;

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

  // Native date/number inputs can fire blur more than once during a single
  // interaction (e.g. the native date picker closing after Enter, which
  // blurs the field, which then blurs again) — without this guard that
  // meant the commit path could run twice for what looks like one edit,
  // briefly rendering a stale pill alongside the new one until the next
  // full data reload wiped it. Escape needs the same guard so a trailing
  // blur can't still commit a value the user just cancelled.
  let settled = false;
  const commit = async () => {
    if (settled) return;
    settled = true;
    const val = input.value.trim();
    if (val !== currentValue) {
      await window.__commitField(todoId, field, val);
    } else {
      input.insertAdjacentHTML("afterend", orig);
      input.remove();
    }
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    input.insertAdjacentHTML("afterend", orig);
    input.remove();
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { cancel(); }
  });
}

function saveCategory(todoId, value) {
  window.__commitField(todoId, "category", value);
}

/* ---- Editable pill builders (one source for both views) ---- */

function pillDate(t) {
  return `<span class="meta-pill date-pill editable" onclick="editField(event,'${t.id}','due_on','date','${t.due_on || ""}')" title="Click to change date — re-sorts the list">${t.due_on ? fmtDate(t.due_on) : "+ Date"}</span>`;
}

function pillHdd(t) {
  const cls = (t.overrides || []).includes("hdd") ? "hdd overridden" : "hdd";
  if (t.in_revisions && !t.hdd) {
    return `<span class="meta-pill revision-hdd editable" onclick="editField(event,'${t.id}','hdd','date','')" title="Task is back for revisions with no deadline yet — picking a date creates a Revision step in Basecamp">+ Revision HDD</span>`;
  }
  if (t.hdd_stale) {
    return `<span class="meta-pill hdd stale editable" onclick="editField(event,'${t.id}','hdd','date','')" title="Comment deadline over 14 days old — abandoned, not late. Click to set a new HDD">HDD ${fmtDate(t.hdd)} · stale</span>`;
  }
  return `<span class="meta-pill ${cls} editable" onclick="editField(event,'${t.id}','hdd','date','${t.hdd || ""}')" title="Click to edit — updates Basecamp step due date">${t.hdd ? "HDD " + fmtDate(t.hdd) : "+ HDD"}</span>`;
}

function estimateGuideLink(category) {
  if (!category || ESTIMATE_GUIDE_EXCLUDE.has(category)) return "";
  return `<button class="eg-link" onclick="event.stopPropagation();openEstimateGuidePanel('${esc(category)}')" title="See the estimate guide for ${esc(category)}">guide</button>`;
}

function pillEst(t) {
  const cls = (t.overrides || []).includes("est") ? "est overridden" : "est";
  const pill = `<span class="meta-pill ${cls} editable" onclick="editField(event,'${t.id}','est','number','${t.est ?? ""}')" title="Click to edit — updates Everhour estimate">${t.est != null ? "EST " + t.est + "h" : "+ EST"}</span>`;
  return t.est == null ? pill + estimateGuideLink(t.category) : pill;
}

function pillTrueEst(t, isCompleted = false) {
  const stepDone = t.designer_step && t.designer_step.completed;
  if (t.true_est != null) {
    return `<span class="meta-pill true-est editable" onclick="editField(event,'${t.id}','true_est','number','${t.true_est}')" title="Corrected estimate used for capacity — clear to revert to EST">TRUE ${t.true_est}h</span>`;
  }
  if (!isCompleted && !stepDone && t.est > 0 && (t.logged || 0) >= t.est) {
    return `<span class="meta-pill true-est needed editable" onclick="editField(event,'${t.id}','true_est','number','')" title="Logged hours reached EST but the task is still active, so it counts 0 toward capacity — set a true estimate">+ True EST</span>` + estimateGuideLink(t.category);
  }
  return "";
}

function pillLogged(t) {
  const logged = t.logged || 0;
  const cls = (t.overrides || []).includes("logged") ? "overridden" : "";
  return `<span class="meta-pill ${cls} editable" onclick="editField(event,'${t.id}','logged','number','${logged}')" title="Click to log hours">${logged > 0 ? logged + "h" : "+ Log"}</span>`;
}

function selCategory(t) {
  const catOptions = CATEGORIES.map(c =>
    `<option value="${c}"${c === (t.category || "") ? " selected" : ""}>${c}</option>`
  ).join("");
  const cls = (t.overrides || []).includes("category") ? "category-select overridden" : "category-select";
  return `<select class="${cls}" onchange="saveCategory('${t.id}', this.value)" title="Task category">${catOptions}</select>`;
}

// Progress against the stable allocation window max(est, true_est) —
// never the moving max(est, logged) capacity floor
function progressBlock(t, color) {
  const allocTotal = Math.max(t.est ?? 0, t.true_est ?? 0);
  const logged = t.logged || 0;
  const overBy = t.over_by || 0;
  const stepComplete = t.designer_step && t.designer_step.completed;
  const barPct = stepComplete ? 100 : (allocTotal > 0 ? Math.min(100, logged / allocTotal * 100) : 0);
  const loggedEl = pillLogged(t);
  if (allocTotal <= 0) return `<div class="progress-wrap">${loggedEl}</div>`;
  const barColor = overBy > 0 ? "var(--danger)" : color;
  const overBadge = overBy > 0 ? `<span class="over-budget-badge">+${overBy}h over</span>` : "";
  return `<div class="progress-wrap">
    <div class="progress-bar-outer"><div class="progress-bar-inner" style="width:${barPct}%;background:${barColor}"></div></div>
    <span class="progress-label">${logged}h / ${allocTotal}h ${overBadge}</span>
    ${loggedEl}
  </div>`;
}

function progressCellCompact(t, color) {
  const allocTotal = Math.max(t.est ?? 0, t.true_est ?? 0);
  const logged = t.logged || 0;
  const stepComplete = t.designer_step && t.designer_step.completed;
  const barPct = stepComplete ? 100 : (allocTotal > 0 ? Math.min(100, logged / allocTotal * 100) : 0);
  const overTxt = (t.over_by || 0) > 0 ? ` <span class="ov-over">+${t.over_by}h over</span>` : "";
  if (allocTotal <= 0) return `<span class="ov-muted">${logged ? logged + "h logged" : "&mdash;"}</span>`;
  return `<div class="ov-prog"><div class="ov-prog-track"><div class="ov-prog-fill" style="width:${barPct}%;background:${color}"></div></div><span class="ov-muted">${logged}h / ${allocTotal}h</span>${overTxt}</div>`;
}

/* ---- Editable task table — the Overview expanded row and the designer
   page render exactly this ---- */
function buildTaskTable(todos, color, opts = {}) {
  if (!todos.length) return `<div class="attention-empty">No active tasks this week.</div>`;
  const showSpotlight = !!opts.spotlight;
  const atCap = opts.spotlight && opts.spotlight.atCap;
  const sort = opts.sort || null;
  const sortFn = opts.sortFn || "";
  const th = (label, key) => sortableTh(label, key, sort, sortFn);
  const rows = todos.map(t => {
    let revNote = "";
    if (t.in_revisions && t.revisions_since) {
      const days = Math.max(0, Math.floor((Date.now() - new Date(t.revisions_since)) / 86400000));
      revNote = `<div class="ov-revnote">&#8617; back for revisions · waiting ${days}d</div>`;
    }
    return `<tr class="ov-task-row">
      ${showSpotlight ? `<td>${spotlightStarHTML(t, atCap)}</td>` : ""}
      <td class="ov-client">${esc(cleanClient(t.bucket_name)) || "&mdash;"}</td>
      <td class="ov-title" title="${esc(t.title)}">${esc(truncate(t.title, 52))}${revNote}</td>
      <td>${pillDate(t)}</td>
      <td>${pillHdd(t)}</td>
      <td>${pillEst(t)}</td>
      <td>${pillTrueEst(t) || `<span class="ov-muted">&mdash;</span>`}</td>
      <td>${pillLogged(t)}</td>
      <td>${selCategory(t)}</td>
      <td>${progressCellCompact(t, color)}</td>
      <td>${t.url ? `<a href="${t.url}" target="_blank" class="link-btn" title="Open in Basecamp" onclick="event.stopPropagation()">&#8599;</a>` : ""}</td>
    </tr>`;
  }).join("");
  return `<table class="ov-table">
    <thead><tr>${showSpotlight ? "<th></th>" : ""}${th("Client", "client")}${th("Task", "task")}${th("Date", "date")}${th("HDD", "hdd")}${th("EST", "est")}${th("True", "true_est")}${th("Logged", "logged")}${th("Category", "category")}${th("Progress", "progress")}<th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/* ---- Task card, shared by Designer Workload cards and the Spotlight
   section (spotlightOpts = null hides the star entirely) ---- */
function renderTodoItem(t, color, isCompleted = false, pulledForward = false, spotlightOpts = null) {
  const dateStr = pillDate(t);
  const hddStr = pillHdd(t);
  const estStr = pillEst(t);
  const trueEstStr = pillTrueEst(t, isCompleted);
  const progressHtml = progressBlock(t, color);
  const catStr = selCategory(t);

  const clientName = cleanClient(t.bucket_name);
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

  const spotlightBtn = spotlightOpts ? spotlightStarHTML(t, spotlightOpts.atCap) : "";

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
      ${spotlightBtn}
      ${t.url ? `<a href="${t.url}" target="_blank" class="link-btn" title="Open in Basecamp">↗</a>` : ""}
    </div>
  </li>`;
}

/* ---- Spotlight — up to 4 tasks a designer (or Richard, for My Stuff) can
   pin to the top of their own page. Toggled via a star on each task; the
   page defines window.__commitSpotlight(todoId, on) the same way it
   defines window.__commitField. ---- */
const SPOTLIGHT_MAX = 4;

function spotlightStarHTML(t, atCap) {
  const disabled = !t.is_spotlighted && atCap;
  const title = t.is_spotlighted
    ? "Remove from Spotlight"
    : (disabled ? `Spotlight is full (${SPOTLIGHT_MAX}/${SPOTLIGHT_MAX}) — remove one first` : "Add to Spotlight");
  const icon = t.is_spotlighted ? "/static/img/icons/lightbulb-on.png" : "/static/img/icons/lightbulb-off.png";
  return `<button class="spotlight-star${t.is_spotlighted ? " on" : ""}"${disabled ? " disabled" : ""}
    onclick="event.stopPropagation();toggleSpotlight('${t.id}', ${!t.is_spotlighted})" title="${title}"><img src="${icon}" class="spotlight-bulb" alt="" /></button>`;
}

function toggleSpotlight(todoId, on) {
  window.__commitSpotlight(todoId, on);
}

function buildSpotlightSection(todos, color) {
  const spotlighted = todos.filter(t => t.is_spotlighted && !t.is_complete);
  if (!spotlighted.length) return "";
  const items = spotlighted.map(t => renderTodoItem(t, color, false, false, { atCap: false })).join("");
  return `<div class="pulse-panel spotlight-panel">
    <div class="spotlight-head">
      <div class="spotlight-title"><img src="/static/img/icons/lightbulb-on.png" class="spotlight-bulb" alt="" /> Spotlight</div>
      <div class="spotlight-count">${spotlighted.length}/${SPOTLIGHT_MAX}</div>
    </div>
    <ul class="designer-todos spotlight-list">${items}</ul>
  </div>`;
}

/* ---- Sort — client-side only, mirrors the existing By-load/By-availability
   toggle pattern (session state, no persistence). Triggered by clicking a
   column header (see sortableTh below) rather than a separate control, so
   it works the same on mobile as the rest of the already-scrollable table. ---- */
function sortTodos(todos, key, dir = "asc") {
  if (!key) return [...todos];
  const arr = [...todos];
  const mul = dir === "asc" ? 1 : -1;
  const byStr = (a, b) => (a || "").localeCompare(b || "") * mul;
  const byNum = (a, b) => ((a || 0) - (b || 0)) * mul;
  switch (key) {
    case "client":   return arr.sort((a, b) => byStr(cleanClient(a.bucket_name), cleanClient(b.bucket_name)));
    case "task":     return arr.sort((a, b) => byStr(a.title, b.title));
    case "date":     return arr.sort((a, b) => byStr(a.due_on || "9999-99-99", b.due_on || "9999-99-99"));
    case "hdd":      return arr.sort((a, b) => byStr(a.hdd || "9999-99-99", b.hdd || "9999-99-99"));
    case "est":      return arr.sort((a, b) => byNum(a.est, b.est));
    case "true_est": return arr.sort((a, b) => byNum(a.true_est, b.true_est));
    case "logged":   return arr.sort((a, b) => byNum(a.logged, b.logged));
    case "category": return arr.sort((a, b) => byStr(a.category, b.category));
    case "progress": return arr.sort((a, b) => byNum(a.progress, b.progress));
    default:         return arr;
  }
}

// One clickable <th> — label + a direction arrow that only shows once this
// column is the active sort. sortFnName is the page's setXSort(key) global;
// sort (possibly null, meaning "no column picked yet") only affects which
// header shows the active arrow, not whether headers are clickable at all.
function sortableTh(label, key, sort, sortFnName) {
  if (!sortFnName) return `<th>${label}</th>`;
  const active = !!sort && sort.key === key;
  const arrow = active ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
  return `<th class="sortable${active ? " active" : ""}" onclick="${sortFnName}('${key}')">${label}<span class="sort-arrow">${arrow}</span></th>`;
}

/* ---- Estimate Guide — shared by the Overview panel (editable goals) and
   the designer page (read-only goal + personal pace). ---- */

function slugCat(cat) {
  return (cat || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// Misc. and Admin are catch-all buckets with no consistent scope, so a goal
// for them isn't meaningful — Richard's call, keep them out of the guide
const ESTIMATE_GUIDE_EXCLUDE = new Set(["Misc.", "Admin"]);

function buildEstimateGuide(guide, opts = {}) {
  guide = guide || {};
  const rows = CATEGORIES.filter(cat => !ESTIMATE_GUIDE_EXCLUDE.has(cat)).map(cat => {
    const g = guide[cat] || {};
    const slug = slugCat(cat);
    const timelineCell = `<td class="eg-timeline">${g.timeline ? esc(g.timeline) : `<span class="ov-muted">&mdash;</span>`}</td>`;
    let cells;
    if (opts.personal) {
      const pm = g.personal_median;
      const paceCell = pm != null
        ? `${pm}h`
        : `<span class="ov-muted">no data yet</span>`;
      const goalCell = g.goal != null ? `${g.goal}h` : `<span class="ov-muted">not set</span>`;
      let deltaCell = `<span class="ov-muted">&mdash;</span>`;
      if (pm != null && g.goal != null) {
        const diff = Math.round((pm - g.goal) * 10) / 10;
        deltaCell = diff <= 0
          ? `<span class="eg-delta ok">on pace</span>`
          : `<span class="eg-delta over">+${diff}h vs goal</span>`;
      }
      cells = `<td>${goalCell}</td><td>${paceCell}</td><td>${deltaCell}</td>${timelineCell}`;
    } else {
      const companyCell = g.company_n >= 1
        ? `${g.company_median}h <span class="eg-n">(${g.company_n} task${g.company_n === 1 ? "" : "s"})</span>`
        : `<span class="ov-muted">no data yet</span>`;
      const val = g.goal != null ? g.goal : "";
      const goalCell = `<input type="number" step="0.5" min="0" class="eg-goal-input" value="${val}"
        placeholder="set goal"
        onblur="commitEstimateGoal('${esc(cat)}', this.value, this)"
        onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}" />`;
      cells = `<td>${companyCell}</td><td>${goalCell}</td>${timelineCell}`;
    }
    return `<tr id="eg-row-${slug}"><td>${esc(cat)}</td>${cells}</tr>`;
  }).join("");
  const head = opts.personal
    ? `<th>Category</th><th>Goal</th><th>Your pace</th><th>vs Goal</th><th>Timeline</th>`
    : `<th>Category</th><th>Team median</th><th>Goal</th><th>Timeline</th>`;
  return `<table class="eg-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function estimateGuidePanelHTML(bodyHtml, subtitle) {
  return `<div class="pulse-panel eg-panel" id="estimate-guide-panel">
    <div class="eg-head" onclick="toggleEstimateGuidePanel()">
      <div>
        <div class="cap-chart-title">Estimate Guide</div>
        <div class="cap-chart-sub">${subtitle}</div>
      </div>
      <span class="eg-chevron">&#9662;</span>
    </div>
    <div class="eg-body" id="estimate-guide-body">${bodyHtml}</div>
  </div>`;
}

function toggleEstimateGuidePanel() {
  document.getElementById("estimate-guide-panel")?.classList.toggle("open");
}

function openEstimateGuidePanel(category) {
  const panel = document.getElementById("estimate-guide-panel");
  panel?.classList.add("open");
  panel?.scrollIntoView({ behavior: "smooth", block: "start" });
  const row = document.getElementById("eg-row-" + slugCat(category));
  if (row) {
    row.classList.add("eg-flash");
    setTimeout(() => row.classList.remove("eg-flash"), 1600);
  }
}
