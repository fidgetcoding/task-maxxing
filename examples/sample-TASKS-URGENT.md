---
title: "TASKS — Urgent"
type: task-area
tags: [tasks, urgent]
related: [[TASKS]]
---

# TASKS-URGENT

Hot list — tasks that need to happen this week, regardless of their
natural project home. Use this file for any "do today" or "do this week"
items. Do **not** duplicate a task between URGENT and another area file
— pick one.

## Open

- [ ] Ship the task-maxxing repo ⏫ 📅 2026-04-15
- [ ] Reply to Lava Foundation kickoff email 🔺 📅 2026-04-14
- [ ] Refill prescription 🔼 📅 2026-04-16 ⏳ 2026-04-15
- [ ] Confirm Morgen backfill finished cleanly 🔼
- [ ] Renew domain registration 🔽 📅 2026-04-30 🔁 every year

## Recently done

- [x] Sanity-check the sync pipeline end to end ⏫ ✅ 2026-04-13
- [x] Grant FDA to the new wrapper .app ✅ 2026-04-13

## Query — overdue items across the vault

Tasks inside a fenced `tasks` block are **skipped by the parser**, so the
block below is a query, not a set of real tasks.

```tasks
not done
due before tomorrow
sort by priority
group by path
```

## Notes

- Priorities: 🔺 highest, ⏫ high, 🔼 medium, 🔽 low, ⏬ lowest.
- Dates: `📅` due, `⏳` scheduled, `🛫` start, `✅` done.
- Recurrence: `🔁 every week`, `🔁 every month on the 1st`, etc.
- The daemon will pick up edits to this file and trigger W1 via git push.
