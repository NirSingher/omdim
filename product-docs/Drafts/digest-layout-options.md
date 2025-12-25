# Digest Layout Options

## Current Output (What You Saw)

```
📊 *engineering Weekly Digest*
_2024-12-18 to 2024-12-24_

*Summary:*
• 12 submissions from 4/5 team members
• Participation: 80% ↑
• Completion: 75% →
• Blockers: 15% ↓

*🏆 Team Rankings:*
🥇 <@U123> (92 pts) - 100% participation, 85% completion
🥈 <@U456> (78 pts) - 80% participation, 90% completion
🥉 <@U789> (65 pts) - 60% participation, 75% completion ⚠️

*Team Performance:*
🟢 <@U123>: 5/5 days (100%)
    ✅ 12 completed • 📋 15 planned • 3/day avg
🟢 <@U456>: 4/5 days (80%)
    ✅ 8 completed • 📋 10 planned • 2.5/day avg
    ⚠️ 1 days with blockers
🟡 <@U789>: 3/5 days (60%)
    ✅ 5 completed • 📋 8 planned • 2.7/day avg
    ⚠️ 2 days with blockers
🔴 <@U000>: 0/5 days (0%)

*🔥 Bottlenecks:*
_Carried 3+ days:_
• <@U789>: "Fix auth issue" _(5 days, carried 4x)_
• <@U456>: "Update docs" _(3 days, carried 2x)_
_High drop rate (>30%):_
• <@U789>: 8/20 items dropped (40%)

*Blockers:*
• <@U456> (2024-12-20): Need API access
• <@U789> (2024-12-19): Waiting on design review
• <@U789> (2024-12-18): Blocked by infra

*🔗 Work Alignment:* _Not configured_
```

**Problems:**
- Too long and cluttered
- Rankings + Team Performance = redundant info
- Bottlenecks nested structure is confusing
- Work Alignment placeholder adds noise

---

## Option A: Compact Executive Summary

Focus: Quick glance, action items only

```
📊 *engineering* · Weekly · Dec 18-24

*At a glance:*
80% participation ↑ · 75% completion · 3 blockers

*Team:*
🟢 Alice · 5/5 · 12 done
🟢 Bob · 4/5 · 8 done
🟡 Carol · 3/5 · 5 done ⚠️ high drops
🔴 Dave · 0/5

*Needs attention:*
🔥 Carol: "Fix auth issue" stuck 5 days
🔥 Bob: "Update docs" stuck 3 days
🚧 Bob: Need API access
🚧 Carol: Waiting on design review
```

**Pros:** Very scannable, action-oriented
**Cons:** Loses some detail (trends, scores)

---

## Option B: Structured Cards

Focus: Visual hierarchy, grouped logically

```
📊 *engineering Weekly Digest*
_Dec 18-24, 2024_

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📈 *Trends*
Participation: 80% ↑  ·  Completion: 75% →

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

👥 *Team* (4/5 submitted)
🟢 Alice 5/5  ·  🟢 Bob 4/5  ·  🟡 Carol 3/5
🔴 Dave 0/5

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️ *Action Items*

_Stuck work:_
• Carol: "Fix auth issue" (5 days)
• Bob: "Update docs" (3 days)

_Blockers:_
• Bob: Need API access
• Carol: Waiting on design review

_High drop rate:_
• Carol: 40% items dropped
```

**Pros:** Clear sections, visual breaks
**Cons:** Still long, separators may not render well

---

## Option C: Priority-First (Recommended)

Focus: Lead with what matters, hide noise

```
📊 *engineering Weekly* · Dec 18-24

80% participation ↑ · 75% completion

⚠️ *Needs Attention*
🔥 Carol: "Fix auth issue" stuck 5 days
🔥 Bob: "Update docs" stuck 3 days
🚧 Bob: Need API access
🚧 Carol: Waiting on design (2 items)

👥 *Team*
🟢 Alice 5/5 (12 done)
🟢 Bob 4/5 (8 done)
🟡 Carol 3/5 (5 done) — 40% drops
🔴 Dave 0/5
```

**Pros:**
- Problems first (manager cares most about this)
- Team summary is compact but complete
- No redundant sections
- No placeholder noise

**Cons:** Less detail on trends/history

---

## Option C + Full Report Command

Option C digest stays compact, with a `/standup report` command for deep dives.

### Automatic Digest (sent via cron)

```
📊 *engineering Weekly* · Dec 18-24

80% participation ↑ · 75% completion

⚠️ *Needs Attention*
🔥 Carol: "Fix auth issue" stuck 5 days
🔥 Bob: "Update docs" stuck 3 days
🚧 Bob: Need API access
🚧 Carol: Waiting on design (2 items)

👥 *Team*
🟢 Alice 5/5 (12 done)
🟢 Bob 4/5 (8 done)
🟡 Carol 3/5 (5 done) — 40% drops
🔴 Dave 0/5

_Details: `/standup report engineering week`_
```

### `/standup report <daily> [day|week|month]`

Full individual breakdown on demand:

```
📋 *engineering Full Report* · Dec 18-24

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

*Alice* 🟢
Participation: 5/5 days (100%)
Items: 12 completed · 15 planned · 3/day avg
Completion rate: 80%
Blockers: 0 days

*Bob* 🟢
Participation: 4/5 days (80%)
Items: 8 completed · 10 planned · 2.5/day avg
Completion rate: 80%
Blockers: 1 day
  • Dec 20: Need API access

Stuck items:
  🔥 "Update docs" (3 days, carried 2x)

*Carol* 🟡
Participation: 3/5 days (60%)
Items: 5 completed · 8 planned · 2.7/day avg
Completion rate: 63%
Drop rate: 40% ⚠️
Blockers: 2 days
  • Dec 19: Waiting on design review
  • Dec 18: Blocked by infra

Stuck items:
  🔥 "Fix auth issue" (5 days, carried 4x)

*Dave* 🔴
Participation: 0/5 days (0%)
No submissions this period.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

*Period Trends*
Participation: 80% (↑ from 72% last week)
Completion: 75% (→ stable)
Blockers: 15% (↓ from 22% last week)
```

### Why This Split Works

| Digest (auto) | Report (on-demand) |
|---------------|-------------------|
| Quick scan | Deep dive |
| Action items | Individual profiles |
| ~15 lines | ~40+ lines |
| Cron push | Pull when needed |

**Implementation:** New command handler for `/standup report <daily> [period]`

---

## Option D: Minimal + Expandable

Focus: Ultra-brief with link to full report

```
📊 *engineering* · Dec 18-24

✅ 80% participation (↑8%) · 4/5 submitted
⚠️ 2 items stuck 3+ days
🚧 3 blockers

👥 Alice 5/5 · Bob 4/5 · Carol 3/5 · Dave 0/5

_Use `/standup report engineering` for full details_
```

**Pros:** Super scannable, fits in a glance
**Cons:** Requires follow-up command for details

---

## Comparison

| Aspect | Current | A | B | C | D |
|--------|---------|---|---|---|---|
| Lines | ~35 | ~15 | ~25 | ~15 | ~8 |
| Scannable | ❌ | ✅ | ⚠️ | ✅ | ✅ |
| Action-focused | ⚠️ | ✅ | ✅ | ✅ | ⚠️ |
| Complete | ✅ | ⚠️ | ✅ | ✅ | ❌ |
| Redundancy | ❌ | ✅ | ✅ | ✅ | ✅ |

---

## My Recommendation: Option C

**Why:**
1. Problems/actions at top (what managers act on)
2. Team summary is compact but informative
3. Removes redundant Rankings vs Performance sections
4. No placeholder noise (Work Alignment)
5. ~15 lines vs ~35 current

**Changes from current:**
- Remove Rankings section (merge into Team)
- Remove verbose Team Performance multi-line format
- Remove Work Alignment placeholder
- Combine Bottlenecks + Blockers into "Needs Attention"
- Lead with action items, not stats

---

## Questions

1. Do you want rankings/scores shown at all for weekly?
2. Should daily digest be even more compact (just missing + blockers)?
3. Keep the snooze buttons as a separate message or integrate?

🦊
