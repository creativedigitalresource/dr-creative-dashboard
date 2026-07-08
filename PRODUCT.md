# DR Creative Dashboard

## Product purpose
A management layer over Basecamp and Everhour for the Digital Resource Creative Team. Basecamp has no visual capacity view, no calendar scheduling, and no way to see team load at a glance; this dashboard adds all three without modifying Basecamp. Basecamp stays the source of truth; the dashboard reads from it, writes deliberate changes back to it (due dates, steps, estimates), and keeps local-only corrections (True EST, category overrides) in its own SQLite.

## Register
product

## Users
- **Richard (Creative Team Manager), primary.** Opens it several times a day to answer three questions in order: who is overloaded vs available, what is past due, and where does the next incoming task go. Decisions made here: delegation, deadline chasing, rebalancing.
- **Designers (7), secondary.** Check their own week: what is due, what order to work in, their day planner. They do not manage others.

Both use laptops in bright rooms during work hours. Light theme is the honest choice.

## Tone
Calm operations tool. It reports states plainly and never manufactures urgency: a task with no decided deadline is "waiting," not "late." Numbers must be trustworthy before they are pretty; a capacity bar that hides invisible work (overrun tasks, unscheduled revisions) is a bug, not a style choice.

## Domain vocabulary
- **HDD**: hard due date, always the designer's step `due_on` in Basecamp, never the parent todo date.
- **EST**: time estimate from Everhour. **True EST**: local corrected estimate for capacity math only.
- **Revision limbo**: designer finished their steps but the task came back; no deadline decided yet.
- **Notes** = Basecamp API `description`. **Subtask** = Basecamp step.
- Capacity model: 6.5h/day productive time, 32.5h/week.

## Strategic principles
1. **Answers before data.** The landing surface ranks and flags; raw task lists live one click deeper.
2. **Never lie about state.** Stale dates are suppressed, not shown as overdue. Unknowns are surfaced as "needs a decision," not silently counted as zero.
3. **Decisions are captured where they happen.** Setting a date on the dashboard creates the real Basecamp artifact (step, due date) in the same gesture.
4. **Exception-driven management.** Past due, at risk, and needs-decision items come to Richard; everything on track stays quiet.

## Anti-references
- Not a BI tool: no chart walls, no KPI hero tiles, no vanity metrics.
- Not a Basecamp clone: never re-render Basecamp threads or comments here.
- Not a surveillance tool: capacity and lateness are workload facts for rebalancing, not performance scorecards.
