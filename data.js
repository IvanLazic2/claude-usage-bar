// @ts-check
'use strict';

// Data sources. No VS Code API here, so it can be tested with plain Node.
//   - Limits: GET /api/oauth/usage with Claude Code's own OAuth token (the
//     same call Claude Code makes for /usage)
//   - Context: token usage of the last assistant message in the session
//     transcript under ~/.claude/projects/, divided by the model's
//     max_input_tokens from GET /v1/models/<model>

const fs = require('fs');
const path = require('path');
const os = require('os');

const TAIL_BYTES = 512 * 1024;

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** @param {number} ms */
function formatDuration(ms) {
  if (ms <= 0) return '0m';
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days >= 1) return `${days}d`;
  if (hours >= 1) return `${hours}h${String(mins).padStart(2, '0')}m`;
  return `${mins}m`;
}

// ---------- Limits ----------

/**
 * @typedef {{ percent: number, resetsAtMs: number | null }} Window
 * @typedef {{ fiveHour: Window | null, sevenDay: Window | null, fetchedAtMs: number }} Limits
 */

/** @param {any} w @returns {Window | null} */
function toWindow(w) {
  if (!w || typeof w.utilization !== 'number') return null;
  const t = w.resets_at ? Date.parse(w.resets_at) : NaN;
  return { percent: w.utilization, resetsAtMs: Number.isNaN(t) ? null : t };
}

/**
 * Reads Claude Code's access token. Never refreshes it: refreshing rotates the
 * refresh token, which would log Claude Code out. Claude Code refreshes it
 * itself while you use it.
 * @returns {string | null}
 */
function readAccessToken() {
  try {
    const oauth = JSON.parse(fs.readFileSync(path.join(claudeDir(), '.credentials.json'), 'utf8')).claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string') return null;
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now()) return null;
    return oauth.accessToken;
  } catch {
    return null;
  }
}

/**
 * GET on api.anthropic.com with Claude Code's token. Null when there is no
 * usable token or the request fails before a response.
 * @param {string} urlPath
 * @returns {Promise<Response | null>}
 */
async function anthropicGet(urlPath) {
  const token = readAccessToken();
  if (!token) return null;
  try {
    return await fetch(`https://api.anthropic.com${urlPath}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'User-Agent': 'claude-usage-bar',
      },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return null;
  }
}

/**
 * Current limits from the endpoint behind Claude Code's /usage.
 * @returns {Promise<{ limits: Limits } | { rateLimited: boolean, retryAfterMs: number }>}
 */
async function fetchLiveLimits() {
  const failed = { rateLimited: false, retryAfterMs: 0 };
  const res = await anthropicGet('/api/oauth/usage');
  if (!res) return failed;
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after'));
    return { rateLimited: true, retryAfterMs: retry > 0 ? retry * 1000 : 0 };
  }
  if (!res.ok) return failed;
  try {
    /** @type {any} */
    const body = await res.json();
    const fiveHour = toWindow(body?.five_hour);
    const sevenDay = toWindow(body?.seven_day);
    if (!fiveHour && !sevenDay) return failed;
    return { limits: { fiveHour, sevenDay, fetchedAtMs: Date.now() } };
  } catch {
    return failed;
  }
}

// ---------- Context ----------

/**
 * Claude Code names a project's transcript folder after its path with every
 * non-alphanumeric character replaced by "-".
 * @param {string} dir
 */
function projectFolderName(dir) {
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * @typedef {{ tokens: number, model: string, updatedAtMs: number }} SessionContext
 * @typedef {{ context: SessionContext | null, tabLabel: string | null }} Transcript
 * @type {Map<string, { mtimeMs: number, size: number, value: Transcript }>}
 */
const transcriptCache = new Map();

/**
 * The label the Claude extension gives a session's editor tab (claudeVSCodePanel):
 * the title cut to 24 characters plus an ellipsis when longer than 25.
 * @param {string} title
 */
function tabLabelFor(title) {
  return title.length > 25 ? `${title.substring(0, 24)}…` : title;
}

/**
 * Reads the transcript's tail: token usage of the last main-thread assistant
 * message, and the session title (a rename beats the generated title). Claude
 * Code re-appends the title entries every turn, so the tail has them.
 * @param {string} file
 * @param {number} mtimeMs
 * @param {number} size
 * @returns {Transcript}
 */
function readTranscript(file, mtimeMs, size) {
  const cached = transcriptCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.value;

  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return cached ? cached.value : { context: null, tabLabel: null };
  }

  /** @type {SessionContext | null} */
  let context = null;
  /** @type {string | null} */
  let customTitle = null;
  /** @type {string | null} */
  let aiTitle = null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const wantUsage = !context && line.includes('"usage"');
    const wantCustom = !customTitle && line.includes('"custom-title"');
    const wantAi = !aiTitle && line.includes('"ai-title"');
    if (!wantUsage && !wantCustom && !wantAi) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (wantCustom && entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
      customTitle = entry.customTitle;
    } else if (wantAi && entry.type === 'ai-title' && typeof entry.aiTitle === 'string') {
      aiTitle = entry.aiTitle;
    } else if (wantUsage && entry.type === 'assistant' && !entry.isSidechain && entry.message?.usage) {
      const usage = entry.message.usage;
      const tokens = (usage.input_tokens || 0)
        + (usage.cache_creation_input_tokens || 0)
        + (usage.cache_read_input_tokens || 0);
      if (tokens > 0) context = { tokens, model: entry.message.model || '', updatedAtMs: mtimeMs };
    }
    if (context && customTitle) break;
  }
  const title = customTitle || aiTitle;
  const value = { context, tabLabel: title ? tabLabelFor(title) : null };
  transcriptCache.set(file, { mtimeMs, size, value });
  return value;
}

const RESCAN_EVERY_MS = 30 * 1000;

/** Result of the last folder scan. */
const scan = {
  key: '',
  /** @type {string | null} */
  file: null,
  matched: false,
  atMs: 0,
};

/**
 * Transcripts in the workspace's project folders, newest first.
 * @param {string[]} workspaceDirs
 * @returns {{ file: string, mtimeMs: number, size: number }[]}
 */
function listTranscripts(workspaceDirs) {
  const projectsDir = path.join(claudeDir(), 'projects');
  let names;
  try { names = fs.readdirSync(projectsDir); } catch { return []; }
  const wanted = new Set(workspaceDirs.map(d => projectFolderName(d).toLowerCase()));
  const out = [];
  for (const name of names) {
    if (!wanted.has(name.toLowerCase())) continue;
    const dir = path.join(projectsDir, name);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      try {
        const st = fs.statSync(file);
        out.push({ file, mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* ignore */ }
    }
  }
  return out.sort((x, y) => y.mtimeMs - x.mtimeMs);
}

/**
 * Context of the session shown in the given Claude tab, or of the most
 * recently active session in the workspace when there is no tab or no
 * transcript matches its label. The folders are rescanned every 30 s or when
 * the tab changes; in between only the chosen transcript is checked.
 * @param {string[]} workspaceDirs
 * @param {string | null} tabLabel label of the last active Claude tab
 * @returns {{ context: SessionContext, matched: boolean } | null}
 */
function readContext(workspaceDirs, tabLabel) {
  const now = Date.now();
  const key = `${workspaceDirs.join('|')}\n${tabLabel ?? ''}`;
  let st = null;
  if (scan.file && scan.key === key && now - scan.atMs < RESCAN_EVERY_MS) {
    try { st = fs.statSync(scan.file); } catch { st = null; }
  }
  if (!st) {
    scan.key = key;
    scan.atMs = now;
    const files = listTranscripts(workspaceDirs);
    const match = tabLabel
      ? files.find(f => readTranscript(f.file, f.mtimeMs, f.size).tabLabel === tabLabel)
      : undefined;
    scan.matched = !!match;
    scan.file = (match || files[0])?.file ?? null;
    if (!scan.file) return null;
    try { st = fs.statSync(scan.file); } catch { return null; }
  }
  const { context } = readTranscript(scan.file, st.mtimeMs, st.size);
  return context ? { context, matched: scan.matched } : null;
}

// Context window per model, from max_input_tokens of the Models API. A model
// is asked once per VS Code session; null means the API doesn't know it.
/** @type {Map<string, number | null>} */
const modelWindows = new Map();
/** @type {Map<string, number>} */
const modelWindowAttemptMs = new Map();
const MODEL_RETRY_MS = 5 * 60 * 1000;

/**
 * Looks up the model's context window unless it is already known.
 * @param {string} model
 * @returns {Promise<boolean>} true if a new value was stored
 */
async function fetchModelWindow(model) {
  if (!model || modelWindows.has(model)) return false;
  if (Date.now() - (modelWindowAttemptMs.get(model) || 0) < MODEL_RETRY_MS) return false;
  modelWindowAttemptMs.set(model, Date.now());
  const res = await anthropicGet(`/v1/models/${encodeURIComponent(model)}`);
  if (!res) return false;
  if (res.status === 404) {
    modelWindows.set(model, null);
    return true;
  }
  if (!res.ok) return false;
  try {
    /** @type {any} */
    const body = await res.json();
    const n = body?.max_input_tokens;
    modelWindows.set(model, typeof n === 'number' && n > 0 ? n : null);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {number} tokens
 * @param {string} model
 * @param {number} setting claudeUsageBar.contextWindow, 0 = auto
 */
function contextWindowSize(tokens, model, setting) {
  if (setting > 0) return setting;
  // Unknown model: assume 200K. A session past its window must be running
  // with 1M enabled.
  const known = modelWindows.get(model) || 200000;
  return tokens > known ? 1000000 : known;
}

module.exports = {
  formatDuration,
  fetchLiveLimits,
  fetchModelWindow,
  readContext,
  contextWindowSize,
};
