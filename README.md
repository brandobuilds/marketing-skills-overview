# marketing-skills-overview

Auto-updating overview of the [marketingskills](https://github.com/coreyhaines31/marketingskills)
library by Corey Haines — a self-contained static page that stays current with zero manual upkeep.

Live: **https://marketing-skills.vercel.app**

Sibling sites: `gstack-status.vercel.app` (gstack-overview) · `compound-status.vercel.app` (compound-status).
Same architecture as both — pure-Node generator, marker-based HTML rewrite, GitHub Actions + Vercel auto-deploy, Telegram on change.

## How it works

- **`index.html`** — single self-contained page (inline CSS/JS, no build step). The skill grid renders
  dynamically by merging static category + description metadata (`META` in the page) with a live skill
  table injected between `<!--MS_DATA_START-->…<!--MS_DATA_END-->`. New upstream skills appear
  automatically with live version pills and dates.
- **`scripts/update-doc.mjs`** — pure Node (global `fetch` + `Intl`, no deps). Each run:
  - reads the canonical library version from upstream `.claude-plugin/plugin.json`;
  - parses `VERSIONS.md` into `{ skill: { v, u } }` and re-injects it into the page;
  - on a version change (or `--force`), rewrites the version badge, "what's new" banner (a diff of
    added / version-bumped skills since last check), and the "updated" date;
  - always stamps "last checked" (Central Time);
  - emits `changed` / `version` / `headline` GitHub outputs.
- **`.github/workflows/check-marketing-skills.yml`** — two daily UTC crons gated to the 5pm Central hour
  (`workflow_dispatch` with `force` for manual/test runs). Commits any change (→ Vercel redeploy) and
  sends a Telegram notification when the version changed. Reuses the shared
  `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` / `TELEGRAM_THREAD_IMPORTANT` secrets.

## Markers rewritten by the script

| Marker | Content |
|--------|---------|
| `<!--MSV-->` | library version badge (`v2.4.2`) |
| `<!--MSU-->` | "updated" date (newest per-skill date in VERSIONS.md) |
| `<!--MSC-->` | "checked" timestamp (Central Time) |
| `<!--MSN-->` | total skill count |
| `<!--MS_WHATSNEW_START-->…<!--MS_WHATSNEW_END-->` | what's-new banner |
| `<!--MS_DATA_START-->…<!--MS_DATA_END-->` | injected `window.__SKILLS__` table |

## Local test

```bash
node scripts/update-doc.mjs --force   # fetch upstream, rewrite markers, write version.json
git checkout -- index.html version.json   # discard if only smoke-testing
```

Upstream: https://github.com/coreyhaines31/marketingskills · MIT.
