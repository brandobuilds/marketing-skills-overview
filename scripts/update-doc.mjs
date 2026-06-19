#!/usr/bin/env node
/**
 * Fetches the current marketingskills release + per-skill versions and writes
 * the site's DATA (version.json + data/skills.json). It does NOT touch
 * index.html — that's assembled from the shared kit by `node kit/build/assemble.mjs`,
 * which the workflow runs immediately after this.
 *
 * Every run records "last checked" (Central Time). On a new library version it
 * also computes the "what's new" headline (diff of added / version-bumped skills)
 * and emits changed=true so the workflow sends a Telegram notification.
 *
 * Version source: the plugin manifest (.claude-plugin/plugin.json) is canonical.
 * Per-skill detail comes from VERSIONS.md, a machine-readable markdown table:
 *   | Skill | Version | Last Updated |
 *   | ai-seo | 2.1.0 | 2026-06-15 |
 * (There is no CHANGELOG.md upstream — the VERSIONS.md diff is the change signal.)
 *
 * Scheduled runs refresh at most once per Central day (dedupe on the CT calendar
 * date in version.json — immune to GitHub's late/erratic cron). Manual
 * (workflow_dispatch) and --force runs always proceed; --force also emits
 * changed=true to smoke-test the Telegram pipeline.
 *
 * Pure Node (global fetch + Intl). No dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'version.json');
const SKILLS_FILE = path.join(ROOT, 'data', 'skills.json');
const RAW = 'https://raw.githubusercontent.com/coreyhaines31/marketingskills/main';
const PLUGIN_JSON = `${RAW}/.claude-plugin/plugin.json`;
const VERSIONS_URL = `${RAW}/VERSIONS.md`;
const force = process.argv.includes('--force');

const CT = 'America/Chicago';
const ctDate = (d) => new Intl.DateTimeFormat('en-US', { timeZone: CT, month: 'short', day: 'numeric', year: 'numeric' }).format(d);
const ctTime = (d) => new Intl.DateTimeFormat('en-US', { timeZone: CT, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
const ctYMD = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: CT, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const ctDateTime = (d) => `${ctDate(d)} · ${ctTime(d)} CT`;
const calDate = (iso) => (iso ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso + 'T00:00:00Z')) : '');

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'marketing-skills-updater' } });
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return r.text();
}

function parseVersions(md) {
  const skills = {};
  const rowRe = /^\|\s*([a-z0-9][\w-]*)\s*\|\s*([\d.]+)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/gm;
  let m;
  while ((m = rowRe.exec(md)) !== null) skills[m[1]] = { v: m[2], u: m[3] };
  return skills;
}

function diffHeadline(next, prev, version, count) {
  const prevMap = prev || {};
  const added = [], bumped = [];
  for (const [name, info] of Object.entries(next)) {
    const before = prevMap[name];
    if (!before) added.push(name);
    else if (before.v !== info.v) bumped.push(`${name} ${info.v}`);
  }
  if (!Object.keys(prevMap).length) return `${count} marketing skills across 8 categories — v${version}.`;
  const parts = [];
  if (added.length) parts.push(`${added.length} new: ${added.join(', ')}`);
  if (bumped.length) parts.push(`updated ${bumped.join(', ')}`);
  return parts.join(' · ') || `marketing-skills v${version} is out.`;
}

function setOutput(obj) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  fs.appendFileSync(out, Object.entries(obj).map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, ' ')}`).join('\n') + '\n');
}
const readJSON = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {});

async function main() {
  const now = new Date();
  const eventName = process.env.GITHUB_EVENT_NAME || 'local';

  if (eventName === 'schedule' && !force) {
    const prev = readJSON(STATE);
    if (prev.checkedISO && ctYMD(new Date(prev.checkedISO)) === ctYMD(now)) {
      console.log(`Already refreshed today (${ctYMD(now)} CT) — skipping duplicate scheduled run.`);
      setOutput({ changed: 'false', skipped: 'true' });
      return;
    }
  }

  const manifest = JSON.parse(await fetchText(PLUGIN_JSON));
  const version = String(manifest.version).trim();
  const state = readJSON(STATE);
  const prevSkills = readJSON(SKILLS_FILE);
  const versionChanged = version !== state.version;
  const refresh = versionChanged || force;

  const skills = parseVersions(await fetchText(VERSIONS_URL));
  const count = Object.keys(skills).length;
  const newestISO = Object.values(skills).map((s) => s.u).sort().pop() || '';
  const updated = calDate(newestISO) || ctDate(now);

  let headline = state.headline || '';
  if (refresh) {
    headline = diffHeadline(skills, prevSkills, version, count);
    if (headline.length > 200) headline = headline.slice(0, 197).trimEnd() + '…';
  }

  const checked = ctDateTime(now);
  fs.mkdirSync(path.dirname(SKILLS_FILE), { recursive: true });
  fs.writeFileSync(SKILLS_FILE, JSON.stringify(skills, null, 2) + '\n');
  fs.writeFileSync(STATE, JSON.stringify({
    version, headline, count,
    updatedISO: newestISO, updated,
    checkedISO: now.toISOString(), checked,
  }, null, 2) + '\n');

  console.log(`${versionChanged ? 'NEW VERSION' : 'no version change'} | v${version} | ${count} skills | updated ${updated} | checked ${checked}`);
  setOutput({ changed: (versionChanged || force) ? 'true' : 'false', version, headline });
}

main().catch((e) => { console.error(e); process.exit(1); });
