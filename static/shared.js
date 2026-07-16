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

function cleanClient(bucketName) {
  return (bucketName || "")
    .replace(/\s*\(\d+\+?\)\([A-Z]+\)\s*$/, "")
    .replace(/\s*\(\d+\+?\)\s*$/, "")
    .trim();
}
