#!/usr/bin/env node
/**
 * Keeps the marketing-skills overview current and stamps it with timestamps.
 *
 * Every run:
 *   - records "last checked" (now, in Central Time) into the page + version.json
 *
 * When coreyhaines31/marketingskills ships a new library version:
 *   - rewrites the version badges (between <!--MSV--> markers)
 *   - rewrites the "what's new" banner (between the MS_WHATSNEW markers) with a
 *     diff of which skills were added or version-bumped since last check
 *   - sets "last updated" to the newest per-skill date (between <!--MSU--> markers)
 *   - re-injects the full skill table as JSON (between MS_DATA markers) so the
 *     page's dynamic grid renders live versions + dates with no manual edits
 *   - emits changed=true so the workflow sends a Telegram notification
 *
 * Version source: the plugin manifest (.claude-plugin/plugin.json) is canonical.
 * Per-skill detail comes from VERSIONS.md, a machine-readable markdown table:
 *
 *   | Skill | Version | Last Updated |
 *   |-------|---------|--------------|
 *   | ai-seo | 2.1.0 | 2026-06-15 |
 *
 * (There is no CHANGELOG.md upstream — the VERSIONS.md diff is the change signal.)
 *
 * Timestamps shown on the page:
 *   - Updated  = newest per-skill "Last Updated" date in VERSIONS.md
 *   - Checked  = when this script last polled upstream (Central Time)
 *
 * Scheduled runs only proceed during the 5pm Central hour (the workflow fires
 * two UTC crons to cover CST/CDT; this gate keeps exactly one). Manual
 * (workflow_dispatch) runs always proceed.
 *
 * Run with --force to refresh the banner + emit changed=true even when the
 * version is unchanged (smoke-tests the notification pipeline).
 *
 * Pure Node (global fetch + Intl). No dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'index.html');
const STATE = path.join(ROOT, 'version.json');
const RAW = 'https://raw.githubusercontent.com/coreyhaines31/marketingskills/main';
const PLUGIN_JSON = `${RAW}/.claude-plugin/plugin.json`;
const VERSIONS_URL = `${RAW}/VERSIONS.md`;
const VERSIONS_LINK = 'https://github.com/coreyhaines31/marketingskills/blob/main/VERSIONS.md';
const DOC_URL = 'https://marketing-skills.vercel.app';
const force = process.argv.includes('--force');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const CT = 'America/Chicago';
const ctDate = (d) => new Intl.DateTimeFormat('en-US', { timeZone: CT, month: 'short', day: 'numeric', year: 'numeric' }).format(d);
const ctTime = (d) => new Intl.DateTimeFormat('en-US', { timeZone: CT, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
const ctHour = (d) => parseInt(new Intl.DateTimeFormat('en-US', { timeZone: CT, hour: 'numeric', hour12: false }).format(d), 10);
const ctDateTime = (d) => `${ctDate(d)} · ${ctTime(d)} CT`;
// Format a YYYY-MM-DD calendar date without timezone drift.
const calDate = (iso) => (iso ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso + 'T00:00:00Z')) : '');

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'marketing-skills-updater' } });
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return r.text();
}

// Parse the VERSIONS.md table into { skill: { v: version, u: 'YYYY-MM-DD' } }.
function parseVersions(md) {
  const skills = {};
  const rowRe = /^\|\s*([a-z0-9][\w-]*)\s*\|\s*([\d.]+)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/gm;
  let m;
  while ((m = rowRe.exec(md)) !== null) {
    skills[m[1]] = { v: m[2], u: m[3] };
  }
  return skills;
}

// Build a human "what's new" line by diffing the new skill table vs the stored one.
function diffHeadline(next, prev, version, count) {
  const prevMap = prev || {};
  const added = [];
  const bumped = [];
  for (const [name, info] of Object.entries(next)) {
    const before = prevMap[name];
    if (!before) added.push(name);
    else if (before.v !== info.v) bumped.push(`${name} ${info.v}`);
  }
  if (!Object.keys(prevMap).length) {
    return `${count} marketing skills across 8 categories — v${version}.`;
  }
  const parts = [];
  if (added.length) parts.push(`${added.length} new: ${added.join(', ')}`);
  if (bumped.length) parts.push(`updated ${bumped.join(', ')}`);
  return parts.join(' · ') || `marketing-skills v${version} is out.`;
}

function setOutput(obj) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  const line = Object.entries(obj)
    .map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, ' ')}`)
    .join('\n') + '\n';
  fs.appendFileSync(out, line);
}

function replaceMarker(html, tag, value) {
  const re = new RegExp(`<!--${tag}-->[\\s\\S]*?<!--/${tag}-->`, 'g');
  return html.replace(re, `<!--${tag}-->${value}<!--/${tag}-->`);
}

async function main() {
  const now = new Date();
  const eventName = process.env.GITHUB_EVENT_NAME || 'local';

  // Scheduled runs only proceed during the 5pm Central hour.
  if (eventName === 'schedule' && ctHour(now) !== 17) {
    console.log(`Scheduled run at ${ctDateTime(now)} is outside the 5pm CT window — skipping.`);
    setOutput({ changed: 'false', skipped: 'true' });
    return;
  }

  // Version is canonical from the plugin manifest.
  const manifest = JSON.parse(await fetchText(PLUGIN_JSON));
  const version = String(manifest.version).trim();

  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  const versionChanged = version !== state.version;
  const refresh = versionChanged || force;

  // Always pull the skill table — it's cheap and drives the dynamic grid.
  const skills = parseVersions(await fetchText(VERSIONS_URL));
  const count = Object.keys(skills).length;
  const newestISO = Object.values(skills).map((s) => s.u).sort().pop() || '';
  const updated = calDate(newestISO) || ctDate(now);

  let headline = state.headline || '';
  if (refresh) {
    headline = diffHeadline(skills, state.skills, version, count);
    if (headline.length > 200) headline = headline.slice(0, 197).trimEnd() + '…';
  }

  const checked = ctDateTime(now);

  let html = fs.readFileSync(HTML, 'utf8');
  html = replaceMarker(html, 'MSV', `v${version}`);
  html = replaceMarker(html, 'MSU', esc(updated));
  html = replaceMarker(html, 'MSC', esc(checked));
  html = replaceMarker(html, 'MSN', String(count));
  // Re-inject the live skill table for the dynamic grid (every run — keeps pills current).
  const dataScript = `<script>window.__SKILLS__=${JSON.stringify(skills)};window.__MSMETA__={version:${JSON.stringify(version)},count:${count},updated:${JSON.stringify(updated)}};</script>`;
  html = html.replace(/<!--MS_DATA_START-->[\s\S]*?<!--MS_DATA_END-->/, `<!--MS_DATA_START-->${dataScript}<!--MS_DATA_END-->`);
  if (refresh) {
    const banner =
      `<!--MS_WHATSNEW_START--><a class="whatsnew" href="${VERSIONS_LINK}" target="_blank" rel="noopener">` +
      `<span class="wn-badge">NEW</span><span class="wn-ver">v${version}</span>` +
      `<span class="wn-text">${esc(headline)}</span><span class="wn-arrow">versions →</span></a>` +
      `<!--MS_WHATSNEW_END-->`;
    html = html.replace(/<!--MS_WHATSNEW_START-->[\s\S]*?<!--MS_WHATSNEW_END-->/, banner);
  }
  fs.writeFileSync(HTML, html);

  fs.writeFileSync(STATE, JSON.stringify({
    version, headline, count,
    updatedISO: newestISO, updated,
    checkedISO: now.toISOString(), checked,
    skills,
  }, null, 2) + '\n');

  console.log(`${versionChanged ? 'NEW VERSION' : 'no version change'} | v${version} | ${count} skills | updated ${updated} | checked ${checked}`);
  setOutput({ changed: (versionChanged || force) ? 'true' : 'false', version, headline });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
