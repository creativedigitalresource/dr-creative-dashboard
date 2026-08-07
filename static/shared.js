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

// Accepts "1h", "1hr", "90m", "30min", "1h30m", "1h 30m", or a bare number
// (hours — matches how logged/EST have always been typed, so a plain "2"
// still means 2h). Returns decimal hours rounded to 2 places, or null if
// the input doesn't parse as any of those.
function parseDurationInput(str) {
  const s = String(str || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  const round = n => Math.round(n * 100) / 100;

  let m = s.match(/^(\d+\.?\d*)h(?:rs?|ours?)?(\d+\.?\d*)m(?:ins?|inutes?)?$/);
  if (m) return round(parseFloat(m[1]) + parseFloat(m[2]) / 60);

  m = s.match(/^(\d+\.?\d*)h(?:rs?|ours?)?$/);
  if (m) return round(parseFloat(m[1]));

  m = s.match(/^(\d+\.?\d*)m(?:ins?|inutes?)?$/);
  if (m) return round(parseFloat(m[1]) / 60);

  m = s.match(/^\d+\.?\d*$/);
  if (m) return round(parseFloat(s));

  return null;
}

function editField(evt, todoId, field, inputType, currentValue) {
  evt.stopPropagation();
  const pill = evt.currentTarget;
  const orig = pill.outerHTML;

  const input = document.createElement("input");
  input.type = inputType === "duration" ? "text" : inputType;
  input.className = "inline-field-input";
  if (inputType === "number") {
    input.step = "0.5"; input.min = "0"; input.style.width = "70px";
  } else if (inputType === "duration") {
    input.style.width = "90px";
    input.placeholder = "1h, 30m…";
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
    const raw = input.value.trim();
    let val = raw;
    if (inputType === "duration") {
      const parsed = raw === "" ? null : parseDurationInput(raw);
      if (raw !== "" && parsed == null) {
        // Unparseable ("abc") — don't save garbage, just revert like a no-op
        input.insertAdjacentHTML("afterend", orig);
        input.remove();
        return;
      }
      val = parsed == null ? "" : String(parsed);
    }
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
  return `<span class="meta-pill ${cls} editable" onclick="editField(event,'${t.id}','logged','duration','${logged}')" title="Click to log time — try 1h, 30m, 1h30m, or a bare number for hours">${logged > 0 ? logged + "h" : "+ Log"}</span>`;
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
  const th = (label, key, tooltip) => sortableTh(label, key, sort, sortFn, tooltip);
  const rows = todos.map(t => {
    let revNote = "";
    if (t.in_revisions && t.revisions_since) {
      const days = Math.max(0, Math.floor((Date.now() - new Date(t.revisions_since)) / 86400000));
      revNote = `<div class="ov-revnote">&#8617; back for revisions · waiting ${days}d</div>`;
    }
    return `<tr class="ov-task-row">
      ${showSpotlight ? `<td>${spotlightStarHTML(t, atCap)}</td>` : ""}
      <td class="ov-client">${esc(cleanClient(t.bucket_name)) || "&mdash;"}</td>
      <td class="ov-title" title="${esc(t.title)}">${t.url
        ? `<a href="${t.url}" target="_blank" onclick="event.stopPropagation()">${esc(truncate(t.title, 52))}</a>`
        : esc(truncate(t.title, 52))}${revNote}</td>
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
function sortableTh(label, key, sort, sortFnName, tooltip) {
  // ⓘ sits to the left of the label so the tooltip triggers on the icon
  // itself, not on hovering the whole (clickable, sortable) header cell.
  // Custom-styled hover box instead of the native title tooltip.
  const icon = tooltip
    ? `<span class="th-info-wrap"><span class="th-info">&#9432;</span><span class="th-tooltip">${esc(tooltip)}</span></span>`
    : "";
  if (!sortFnName) return `<th>${icon}${label}</th>`;
  const active = !!sort && sort.key === key;
  const arrow = active ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
  return `<th class="sortable${active ? " active" : ""}" onclick="${sortFnName}('${key}')">${icon}${label}<span class="sort-arrow">${arrow}</span></th>`;
}

/* ---- To Delegate — shared by the manager's own tab and a delegate-enabled
   designer's own page (both target the same #unassigned-list/#unassigned-count
   ids, so this one implementation drives both). ---- */
let _unassignedData = [];
let _unassignedSort = { key: null, dir: "asc" };

function setUnassignedSort(key) {
  _unassignedSort = _unassignedSort.key === key
    ? { key, dir: _unassignedSort.dir === "asc" ? "desc" : "asc" }
    : { key, dir: "asc" };
  renderUnassigned();
}

async function loadUnassigned() {
  const todos = await fetchWithTimeout("/api/unassigned").then(r => r.json()).catch(() => []);
  _unassignedData = todos;
  document.getElementById("unassigned-count").textContent = todos.length || "";
  renderUnassigned();
}

function renderUnassigned() {
  const root = document.getElementById("unassigned-list");
  const todos = _unassignedData;
  if (!todos.length) {
    root.innerHTML = `<div class="loading-cell">Fetching from Basecamp — may take up to 60s on first load…</div>`;
    return;
  }
  const sorted = sortTodos(todos, _unassignedSort.key, _unassignedSort.dir);
  const th = (label, key) => sortableTh(label, key, _unassignedSort.key ? _unassignedSort : null, "setUnassignedSort");
  const rows = sorted.map(t => {
    const due = t.due_on ? formatDue(t.due_on) : "";
    const titleHtml = t.url
      ? `<a href="${t.url}" target="_blank">${esc(t.title)}</a>`
      : esc(t.title);
    return `<tr>
      <td><div class="todo-title">${titleHtml}</div></td>
      <td>${selCategory(t)}</td>
      <td><span class="due-date ${dueCls(t.due_on)}">${due}</span></td>
      <td>${t.url ? `<a href="${t.url}" target="_blank" class="link-btn" title="Open in Basecamp">↗</a>` : ""}</td>
    </tr>`;
  }).join("");
  root.innerHTML = `<table class="data-table">
    <thead><tr>${th("Task", "task")}${th("Category", "category")}${th("Due Date", "date")}<th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/* ---- Standups — shared by the manager's Standups tab and a delegate-
   enabled designer's own page (both target #standups-root). ---- */
async function loadStandups() {
  const root = document.getElementById("standups-root");
  const data = await fetchWithTimeout("/api/standups").then(r => r.json()).catch(() => null);
  if (!data) { root.innerHTML = `<div class="loading-card">Couldn't load standups.</div>`; return; }
  renderStandups(data);
}

function renderStandups(data) {
  const root = document.getElementById("standups-root");
  if (!data.length) { root.innerHTML = `<div class="loading-card">No designers yet.</div>`; return; }

  const posted = data.filter(d => d.posted_at).sort((a, b) => b.posted_at - a.posted_at);
  const waiting = data.filter(d => !d.posted_at).sort((a, b) => a.name.localeCompare(b.name));

  const taskRows = tasks => (tasks || []).length
    ? tasks.map(t => {
        const rem = taskRemainingHrs(t);
        const title = esc(truncate(t.title, 50));
        const titleHtml = t.url
          ? `<a href="${t.url}" target="_blank" title="Open in Basecamp">${title}</a>`
          : title;
        return `<div class="standup-task">
        <span class="standup-task-title">${titleHtml}</span>
        <span class="standup-task-hrs">${rem != null ? rem + "h left" : "&mdash;"}</span>
      </div>`;
      }).join("")
    : `<div class="standup-task-empty">No tasks scheduled today.</div>`;

  const postedCard = d => {
    const totalHrs = Math.round((d.tasks || []).reduce((s, t) => s + Math.max(0, (t.est || 0) - (t.logged || 0)), 0) * 10) / 10;
    return `<div class="standup-card">
      <div class="standup-card-head">
        ${avatarHTML(d, { cls: "designer-avatar" })}
        <div class="standup-card-info">
          <div class="designer-name">${esc(d.name)}</div>
          <div class="standup-card-time">${standupTimeLabel(d)} &middot; ${totalHrs}h planned</div>
        </div>
      </div>
      ${d.note ? `<div class="standup-card-note">&ldquo;${esc(d.note)}&rdquo;</div>` : ""}
      <div class="standup-card-tasks">${taskRows(d.tasks)}</div>
    </div>`;
  };

  const waitingCard = d => `<div class="standup-card waiting">
    <div class="standup-card-head">
      ${avatarHTML(d, { cls: "designer-avatar" })}
      <div class="standup-card-info">
        <div class="designer-name">${esc(d.name)}</div>
        <div class="standup-card-time">Hasn&rsquo;t posted yet</div>
      </div>
    </div>
  </div>`;

  root.innerHTML = posted.map(postedCard).join("") + waiting.map(waitingCard).join("");
}

/* ---- Team Pulse — the manager Overview tab's expandable roster + Needs
   Attention panel, shared with a delegate-enabled designer's own page.
   Sort/expanded state is keyed by ctx ("manager" default, "delegate" for
   the designer page) so the two pages never collide, even though they're
   the same functions. The manager's existing calls (setPulseSort('load'),
   togglePulseRow(id) — no ctx arg, e.g. from index.html's onclick strings)
   default to "manager" and behave exactly as before. ---- */
const _pulseSort = { manager: "load", delegate: "load" };
const _pulseExpanded = { manager: new Set(), delegate: new Set() };

function setPulseSort(mode, ctx = "manager") {
  _pulseSort[ctx] = mode;
  const navSel = ctx === "manager" ? "#pulse-sort" : "#my-pulse-sort";
  document.querySelectorAll(`${navSel} .sort-btn`).forEach(b =>
    b.classList.toggle("active", b.dataset.sort === mode));
  if (ctx === "manager") renderOverview(); else renderMyPulse();
}

function togglePulseRow(bcId, ctx = "manager") {
  const set = _pulseExpanded[ctx];
  const key = String(bcId);
  if (set.has(key)) set.delete(key); else set.add(key);
  if (ctx === "manager") renderOverview(); else renderMyPulse();
}

// Jumps to the manager's Designer Workload tab for a given designer — a
// no-op on pages that don't have that tab (e.g. a delegate-enabled
// designer's own page), rather than throwing.
function gotoDesigner(bcId) {
  const sel = document.getElementById("workload-filter");
  if (sel) sel.value = String(bcId);
  const tabBtn = document.querySelector('.tab-btn[data-tab="designers"]');
  if (!tabBtn) return;
  tabBtn.click();
  if (typeof onWorkloadFilterChange === "function") onWorkloadFilterChange();
}

function _overviewStats(d, weekOffset = 0) {
  // Capacity reflects the toggled week (same _weekOffset as Designer Workload);
  // Past Due / Needs Attention stay anchored to today regardless of the toggle —
  // "past due" isn't a meaningful idea for a hypothetical future/past week.
  const { weekly_est, cap, pct } = calcCapacity(d.todos, d.pto, weekOffset);
  const today = localISO(new Date());
  const active = (d.todos || []).filter(t => !t.is_complete && !t.is_misc);
  const pastDue = active.filter(t => !t.in_revisions && !t.hdd_stale && t.hdd && t.hdd < today);
  const free = Math.round((cap - weekly_est) * 10) / 10;
  return { weekly_est, cap, pct, active, pastDue, free };
}

function _barCls(pct) { return pct < 60 ? "low" : pct < 85 ? "mid" : "high"; }

function renderPulseItem(d, s, ctx = "manager") {
  const expanded = _pulseExpanded[ctx].has(String(d.bc_id));
  const freeCls = s.free <= 2 ? "low" : s.free <= 8 ? "mid" : "ok";
  const freeLabel = s.free < 0 ? `${Math.abs(s.free)}h over` : `${s.free}h free`;
  const overdue = s.pastDue.length
    ? `<span class="pulse-overdue">${s.pastDue.length} past due</span>`
    : `<span class="pulse-overdue none">&mdash;</span>`;
  return `
  <div class="pulse-item${expanded ? " open" : ""}">
    <div class="pulse-row" onclick="togglePulseRow('${d.bc_id}','${ctx}')">
      ${avatarHTML(d)}
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
    ${expanded ? renderPulseDetail(d, s, ctx) : ""}
  </div>`;
}

// Sort state for the expanded per-designer task table inside Team Pulse —
// one shared sort applied to every open row (same idea as _pulseSort's
// by-load/by-availability toggle), kept per ctx so the manager Overview
// tab and a delegate-enabled designer's Team Pulse tab never collide.
// sortableTh's onclick only ever passes one literal arg, so ctx can't be
// threaded through a single function call — hence the two thin wrappers.
const _pulseDetailSort = { manager: { key: null, dir: "asc" }, delegate: { key: null, dir: "asc" } };

function _setPulseDetailSort(key, ctx) {
  const cur = _pulseDetailSort[ctx];
  _pulseDetailSort[ctx] = cur.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
  if (ctx === "manager") renderOverview(); else renderMyPulse();
}
function setPulseDetailSort(key) { _setPulseDetailSort(key, "manager"); }
function setDelegatePulseDetailSort(key) { _setPulseDetailSort(key, "delegate"); }

function renderPulseDetail(d, s, ctx = "manager") {
  if (!s.active.length) {
    return `<div class="pulse-detail"><div class="attention-empty">No active tasks this week.</div></div>`;
  }
  const sort = _pulseDetailSort[ctx];
  const sorted = sortTodos(s.active, sort.key, sort.dir);
  const sortFn = ctx === "manager" ? "setPulseDetailSort" : "setDelegatePulseDetailSort";
  return `<div class="pulse-detail">
    ${buildTaskTable(sorted, d.color, { sort: sort.key ? sort : null, sortFn })}
    <button class="btn btn-ghost btn-sm ov-edit-link" onclick="gotoDesigner('${d.bc_id}')">Open day planner &rarr;</button>
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

  const mini = d => avatarHTML(d, { mini: true, title: d.name });
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

/* ---- QA Checklists — pick a service, check off items, get a shareable
   certificate. Shared by the manager's QA tab and a designer's own page
   (both just need a <div id="qa-root">). ---- */

let _qaTemplates = {};
let _qaService = null;
let _qaItems = []; // [{text, checked}]

// Entry point that's safe to call on every render of a page that also
// redraws other things over time (e.g. a designer page's 90s poll) — it
// redraws from whatever state already exists instead of always resetting
// to the service grid, so an in-progress checklist survives a background
// refresh instead of losing its checked items.
function renderQaMount() {
  if (!document.getElementById("qa-root")) return;
  if (!Object.keys(_qaTemplates).length) { loadQaServices(); return; }
  if (_qaService) renderQaChecklistView();
  else renderQaServiceGrid();
}

async function loadQaServices() {
  const root = document.getElementById("qa-root");
  const data = await fetchWithTimeout("/api/qa/templates").then(r => r.json()).catch(() => null);
  if (!data) { root.innerHTML = `<div class="loading-card">Couldn't load QA checklists.</div>`; return; }
  _qaTemplates = data;
  renderQaServiceGrid();
}

function renderQaServiceGrid() {
  const root = document.getElementById("qa-root");
  const services = Object.keys(_qaTemplates);
  if (!services.length) { root.innerHTML = `<div class="loading-card">No QA checklists set up yet.</div>`; return; }
  root.innerHTML = `<div class="qa-grid">` + services.map(s => `
    <button class="qa-card" data-service="${esc(s)}">
      <span class="qa-card-name">${esc(s)}</span>
      <span class="qa-card-count">${_qaTemplates[s].length} checks</span>
    </button>
  `).join("") + `</div>`;
  root.querySelectorAll(".qa-card").forEach(btn => {
    btn.addEventListener("click", () => openQaChecklist(btn.dataset.service));
  });
}

function openQaChecklist(service) {
  _qaService = service;
  _qaItems = (_qaTemplates[service] || []).map(text => ({ text, checked: false }));
  renderQaChecklistView();
}

function renderQaChecklistView() {
  const root = document.getElementById("qa-root");
  const doneCount = _qaItems.filter(i => i.checked).length;
  const allDone = doneCount === _qaItems.length && _qaItems.length > 0;
  root.innerHTML = `
    <div class="qa-checklist-head">
      <button class="btn btn-ghost btn-sm" onclick="backToQaServices()">&larr; All services</button>
      <h3 class="qa-service-title">${esc(_qaService)}</h3>
      <span class="qa-progress">${doneCount} / ${_qaItems.length} checked</span>
    </div>
    <ul class="qa-item-list">
      ${_qaItems.map((item, i) => `
        <li class="qa-item ${item.checked ? "done" : ""}" onclick="toggleQaItem(${i})">
          <span class="priority-check ${item.checked ? "checked" : ""}">${item.checked ? "&#10003;" : ""}</span>
          <span class="qa-item-text">${esc(item.text)}</span>
        </li>
      `).join("")}
    </ul>
    <div class="qa-meta-row">
      <input type="text" id="qa-task-title" class="priority-input" placeholder="Task / project title (optional)" />
      <input type="text" id="qa-client-name" class="priority-input" placeholder="Client name (optional)" />
    </div>
    <div class="qa-meta-row">
      <input type="text" id="qa-completed-by" class="priority-input" placeholder="Your name" />
    </div>
    <textarea id="qa-notes" class="qa-notes" placeholder="Notes (optional) — anything worth flagging even though everything passed"></textarea>
    <div class="qa-actions">
      <button class="btn btn-primary btn-lg" ${allDone ? "" : "disabled"} onclick="submitQaCertificate()">
        Complete QA &amp; Get Certificate
      </button>
      <button class="btn btn-ghost btn-sm" onclick="editQaTemplate()">Edit this checklist</button>
    </div>
    <div id="qa-result"></div>
  `;
}

function toggleQaItem(i) {
  _qaItems[i].checked = !_qaItems[i].checked;
  renderQaChecklistView();
}

function backToQaServices() {
  _qaService = null;
  _qaItems = [];
  renderQaServiceGrid();
}

async function submitQaCertificate() {
  const body = {
    service: _qaService,
    items: _qaItems,
    task_title: document.getElementById("qa-task-title")?.value || "",
    client_name: document.getElementById("qa-client-name")?.value || "",
    completed_by: document.getElementById("qa-completed-by")?.value || "",
    notes: document.getElementById("qa-notes")?.value || "",
  };
  const res = await fetch("/api/qa/certificates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(r => r.json()).catch(() => null);

  const resultEl = document.getElementById("qa-result");
  if (!res || res.ok === false) {
    resultEl.innerHTML = `<div class="qa-error">${esc(res?.error || "Couldn't create the certificate. Try again.")}</div>`;
    return;
  }
  const fullUrl = window.location.origin + res.url;
  resultEl.innerHTML = `
    <div class="qa-cert-success">
      <div class="qa-cert-success-title">&#9989; QA certificate created</div>
      <div class="qa-cert-link-row">
        <input type="text" class="priority-input" id="qa-cert-link" value="${esc(fullUrl)}" readonly onclick="this.select()" />
        <button class="btn btn-primary btn-sm" onclick="copyQaCertLink('${fullUrl}')">Copy Link</button>
        <a class="btn btn-ghost btn-sm" href="${res.url}" target="_blank">Open</a>
      </div>
      <div class="qa-cert-hint">Paste this link into the Basecamp to-do as your QA sign-off.</div>
    </div>
  `;
}

function copyQaCertLink(url) {
  navigator.clipboard?.writeText(url);
  const btn = event?.target;
  if (btn) {
    const original = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = original; }, 1500);
  }
}

function editQaTemplate() {
  const pin = prompt("Enter PIN to edit this checklist:");
  if (pin !== "1868") { if (pin !== null) alert("Incorrect PIN."); return; }
  const current = (_qaTemplates[_qaService] || []).join("\n");
  const updated = prompt("One checklist item per line:", current);
  if (updated === null) return;
  const items = updated.split("\n").map(s => s.trim()).filter(Boolean);
  if (!items.length) { alert("Need at least one item."); return; }
  fetch(`/api/qa/templates/${encodeURIComponent(_qaService)}?pin=1868`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  }).then(r => r.json()).then(res => {
    if (!res.ok) { alert(res.error || "Couldn't save."); return; }
    _qaTemplates[_qaService] = items;
    openQaChecklist(_qaService);
  }).catch(() => alert("Couldn't save."));
}
