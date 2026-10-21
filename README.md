# PostHog Engineering Impact Analysis

A single-page dashboard that names the five most impactful engineers in
[PostHog/posthog](https://github.com/PostHog/posthog) over the last 90 days and shows, for each,
exactly which PRs and reviews earned that place.

**Live dashboard:** https://posthog-impact-analysis-doyo.vercel.app

## What "impact" means here

GitHub records work, not outcomes. So the method picks the proxies that sit closest to outcomes,
cannot be bought with volume, and stay clickable so a leader can verify them. Lines of code, commit
counts and PR counts are never inputs. Each merged PR earns credit only by clearing a quality bar in
one of four lenses, and each lens sums an engineer's **15 strongest** credits, so a hundred small PRs
cannot outrank ten important ones.

| Lens | What earns credit |
|---|---|
| **Shipped to users** | A feature or perf PR with no flag: 1.0, plus +0.5 if it closed a request someone else filed (up to +0.5 more for reactions/comments on that request). Built behind a feature flag: 0.5, lifted to 1.0 once a later PR in the same area touching the same files made the feature available to everyone. That gate-removal PR earns 0.25 (0.10 if it is flag cleanup). |
| **Fixed what hurt** | A fix closing an issue filed by someone else: 1.0 (0.5 if self-filed), +0.5 if the filer is not a PostHog contributor (not a public org member and merged no PRs in the window), up to +0.5 for reactions/comments on the issue. A fix with no linked issue: 0.25 (severity unknown; no AI guessing). Reverting a change or hot-fixing someone else's change within 72 h: firefighting credit. |
| **Multiplied others** | A review counts when a human who is not the author requested changes or left inline comments: 1.0, +0.5 if the author pushed commits after it. Empty approvals and bots count zero. Credits are grouped by the author reviewed and summed with diminishing returns, so breadth beats volume. PRs whose files are mostly shared tooling (CI, dev env, agent skills) add 1.0 each, at most five. |
| **Carried risk, and it held** | Radius = the most shared non-hub file the PR changed: number of engineers who changed that file in the window × a category multiplier (migrations 2×; HogQL/schema, ingestion, auth/billing 1.5×; CI 1.3×; tests/docs 0.3×) + a category base so a solo migration counts like a file ten people work in. Held: ×0 if reverted, ×0.5 if someone else hot-fixed its files within 72 h with a reference, a regression note, or a fresh issue in the same area. |

Each lens becomes a percentile rank across eligible engineers (a zero stays zero). The composite is
the weighted sum, default 30 / 25 / 25 / 20, and the dashboard's sliders change the weights live.

### Who gets credit

PostHog's PR template requires the human **DRI** to be set as assignee when an agent did the work
under direction, so credit goes to the assignee, else the author. PRs marked **Fully autonomous**
credit nobody by default; a toggle credits their assignee instead. Bot accounts never earn credit.
Every card shows the share of an engineer's PRs that were agent-assisted, as context, not penalty.

### Eligibility

An engineer needs at least 8 credited PRs spanning 3 weeks, or 10 substantive reviews.

## What this misses

- Rollouts happen in PostHog's feature-flag UI, which the repo never sees; only gate removals are visible.
- The template's Release status marker appeared only late in the window; older PRs are classified
  from their own wording ("behind a flag", "remove the flag") and the evidence says so.
- Work in other PostHog repositories, and design, product, support and incident work.
- Features whose build PRs predate the window; reviews beyond inline engagement; the severity of
  fixes with no linked issue; PRs merged in the last three days cannot yet have been hot-fixed.
- Issues referenced without a closing keyword are not linked.

## Reproduce

```bash
gh auth login                      # or export GITHUB_TOKEN
bun run fetch                      # ~10 min: GraphQL search by day → data/raw/
bun run analyze                    # → public/data.json + data/summary.md
bun run serve                      # http://localhost:8787
```

`scripts/fetch.ts` pulls every merged PR in the window with its files, reviews, linked issues and
last commits (raised nested limits plus a REST follow-up for the few that overflow), and asserts
the per-day count against GitHub's own search total. `scripts/analyze.ts` applies the rules above
and writes compact per-engineer credits; `public/app.js` recomputes percentiles and the composite in
the browser.

## Results (default weights, fully-autonomous PRs not credited)

- merged PRs: 17371; counted (human-driven, credited to a DRI): 13597; fully autonomous: 3320 (2684 with a human assignee, credited only with the toggle); bot-authored: 2090; excluded: 1090
- agent-assisted (Human-driven block): 11986; no agent block: 2065
- release status: {"no-feature-flag":15394,"behind-feature-flag":1431,"fully-available":233,"unspecified":313}
- reverts: 25 (17 resolved to an original PR); hub files: 827; shipped-feature anchors: 218 (65 with in-window builders)
- engineers with any credit: 193; eligible: 127; substantive human reviews: 2077

| # | engineer | composite | shipped | fixed | leverage | risk | PRs (agent-assisted) | reviews | reverted |
|---|---|---|---|---|---|---|---|---|---|
| 1 | webjunkie | 0.932 | 0.86 (15.2) | 0.93 (7.8) | 0.98 (29.5) | 0.99 (270.9) | 518 (515) | 31 | 0 |
| 2 | thmsobrmlr | 0.930 | 0.98 (16.6) | 1.00 (13.2) | 0.81 (17.2) | 0.91 (253.8) | 225 (225) | 14 | 0 |
| 3 | pauldambra | 0.923 | 0.94 (15.6) | 0.99 (11.9) | 0.95 (29.1) | 0.78 (215.5) | 502 (488) | 32 | 1 |
| 4 | haacked | 0.917 | 0.75 (15.1) | 0.98 (11.0) | 1.00 (60.2) | 0.98 (267.1) | 219 (208) | 170 | 0 |
| 5 | mariusandra | 0.903 | 0.97 (15.9) | 0.81 (5.8) | 0.97 (29.3) | 0.84 (228.9) | 160 (160) | 44 | 0 |
| 6 | rafaeelaudibert | 0.890 | 0.84 (15.1) | 0.87 (6.2) | 0.93 (27.6) | 0.94 (259.4) | 213 (204) | 38 | 1 |
| 7 | Gilbert09 | 0.889 | 0.92 (15.6) | 0.96 (8.1) | 0.79 (16.1) | 0.87 (240.2) | 991 (349) | 14 | 0 |
| 8 | andrewm4894 | 0.863 | 0.94 (15.7) | 0.95 (8.0) | 0.77 (15.3) | 0.75 (208.8) | 271 (270) | 22 | 1 |
| 9 | tatoalo | 0.814 | 0.90 (15.6) | 0.79 (5.4) | 0.96 (29.3) | 0.53 (182.7) | 349 (14) | 34 | 0 |
| 10 | sampennington | 0.806 | 0.99 (16.7) | 0.72 (5.0) | 0.68 (12.9) | 0.79 (217.0) | 198 (188) | 16 | 0 |

Why the top five, in one line each (every claim is a linked PR on the dashboard):

1. **webjunkie** (devex, stamphog, visual-review): built PostHog's PR-review bot and digest tooling end to end, with the highest held-risk score in the repo and inline reviews that changed outcomes. 99% of their 518 PRs were agent-assisted, which the card shows.
2. **thmsobrmlr** (insights, dashboards, product analytics): the strongest fixed-what-hurt lens, closing long-standing externally filed bugs with people waiting on them, plus dashboard features that closed user requests.
3. **pauldambra** (frontend, desktop, CI, tests): shipped user-visible insight features, fixed hobby-deployment issues reported by self-hosters, and reviewed agent-authored PRs line by line.
4. **haacked** (flags, cohorts, HogQL): the repo's most prolific substantive reviewer by far, 170 reviews across 28 authors, some with 40 inline comments, plus fixes closing bugs filed outside the contributor base.
5. **mariusandra** (frontend, HogQL): shipped features that closed requests and ranks near the top on review leverage, with 44 substantive reviews.