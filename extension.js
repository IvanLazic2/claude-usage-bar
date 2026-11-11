// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const data = require('./data.js');

const REPO = 'IvanLazic2/claude-usage-bar';
const REFRESH_MS = 2000;
const UPDATE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const GREY = new vscode.ThemeColor('disabledForeground');
const YELLOW = new vscode.ThemeColor('charts.yellow');
const RED = new vscode.ThemeColor('charts.red');

// Live limits: the usage endpoint is rate limited per account, so all VS Code
// windows share one fetch schedule through a file in this extension's global
// storage. Fetched every 2 minutes while a window is focused, and after a new
// Claude message if the last attempt is at least a minute old. A 429 backs
// off exponentially (2, 4, 8, 15 min).
const LIVE_EVERY_MS = 2 * 60 * 1000;
const LIVE_MIN_GAP_MS = 60 * 1000;
const BACKOFF_BASE_MS = 2 * 60 * 1000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;
const STALE_AFTER_MS = 10 * 60 * 1000;
const UNFOCUSED_RENDER_MS = 30 * 1000;

/**
 * @typedef {{
 *   limits: import('./data.js').Limits | null,
 *   lastAttemptMs: number,
 *   blockedUntilMs: number,
 *   failures: number,
 * }} SharedLive
 */

/** @type {SharedLive} */
let shared = { limits: null, lastAttemptMs: 0, blockedUntilMs: 0, failures: 0 };
/** @type {string | null} */
let sharedFile = null;
let inFlight = false;
let lastTranscriptMs = 0;

// Label of the last active Claude chat tab in this window, so ctx follows the
// chat being looked at rather than whichever chat wrote last.
const CLAUDE_TAB_VIEW_TYPE = 'claudeVSCodePanel';
/** @type {string | null} */
let claudeTabLabel = null;

/** @param {vscode.Tab | undefined} tab */
function isClaudeTab(tab) {
  return !!tab && tab.input instanceof vscode.TabInputWebview
    && tab.input.viewType.endsWith(CLAUDE_TAB_VIEW_TYPE);
}

function updateClaudeTab() {
  const active = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (isClaudeTab(active)) {
    claudeTabLabel = /** @type {vscode.Tab} */ (active).label;
    return;
  }
  // Forget a tab that was closed.
  const open = vscode.window.tabGroups.all.some(g => g.tabs.some(t => isClaudeTab(t) && t.label === claudeTabLabel));
  if (!open) claudeTabLabel = null;
}

function loadShared() {
  if (!sharedFile) return;
  try {
    const s = JSON.parse(fs.readFileSync(sharedFile, 'utf8'));
    if (s && typeof s.lastAttemptMs === 'number') shared = s;
  } catch { /* missing or mid-write: keep what we have */ }
}

function saveShared() {
  if (!sharedFile) return;
  const tmp = `${sharedFile}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(shared));
    fs.renameSync(tmp, sharedFile);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** @param {boolean} force a new message or regained focus: use the shorter minimum gap */
async function refreshLive(force) {
  if (inFlight) return;
  loadShared();
  const now = Date.now();
  if (now < shared.blockedUntilMs) return;
  if (now - shared.lastAttemptMs < (force ? LIVE_MIN_GAP_MS : LIVE_EVERY_MS)) return;
  // Claim the slot before fetching so other windows skip it.
  shared.lastAttemptMs = now;
  saveShared();
  inFlight = true;
  try {
    const r = await data.fetchLiveLimits();
    loadShared();
    if ('limits' in r) {
      shared.limits = r.limits;
      shared.failures = 0;
      shared.blockedUntilMs = 0;
    } else if (r.rateLimited) {
      shared.failures = (shared.failures || 0) + 1;
      const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (shared.failures - 1));
      shared.blockedUntilMs = Date.now() + Math.max(backoff, r.retryAfterMs);
    }
    saveShared();
  } finally {
    inFlight = false;
  }
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const five = vscode.window.createStatusBarItem('claudeUsageBar.fiveHour', vscode.StatusBarAlignment.Right, 1003);
  const seven = vscode.window.createStatusBarItem('claudeUsageBar.sevenDay', vscode.StatusBarAlignment.Right, 1002);
  const ctx = vscode.window.createStatusBarItem('claudeUsageBar.context', vscode.StatusBarAlignment.Right, 1001);
  five.name = 'Claude 5h limit';
  seven.name = 'Claude 7d limit';
  ctx.name = 'Claude context';
  context.subscriptions.push(five, seven, ctx);
  sharedFile = path.join(context.globalStorageUri.fsPath, 'live.json');
  loadShared();

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeUsageBar.checkForUpdates', () => checkForUpdates(context, true)),
  );

  const render = () => {
    try { renderAll(five, seven, ctx); } catch (e) { console.error('[claude-usage-bar]', e); }
  };
  // Unfocused windows only redraw the countdown every 30 s and read nothing
  // in between; focusing the window redraws immediately.
  let lastRenderMs = 0;
  const tick = () => {
    const focused = vscode.window.state.focused;
    if (!focused && Date.now() - lastRenderMs < UNFOCUSED_RENDER_MS) return;
    lastRenderMs = Date.now();
    if (focused) refreshLive(false).then(render, render);
    render();
  };
  tick();
  const timer = setInterval(tick, REFRESH_MS);
  context.subscriptions.push(vscode.window.onDidChangeWindowState(s => {
    if (!s.focused) return;
    lastRenderMs = Date.now();
    render();
    refreshLive(true).then(render, render);
  }));
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  updateClaudeTab();
  const onTabs = () => { updateClaudeTab(); render(); };
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(onTabs),
    vscode.window.tabGroups.onDidChangeTabGroups(onTabs),
  );

  const maybeCheck = () => {
    if (!config().get('checkForUpdates', true)) return;
    const last = context.globalState.get('lastUpdateCheck', 0);
    if (Date.now() - last >= UPDATE_CHECK_EVERY_MS) checkForUpdates(context, false);
  };
  maybeCheck();
  const updateTimer = setInterval(maybeCheck, 60 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(updateTimer) });
}

function deactivate() {}

function config() {
  return vscode.workspace.getConfiguration('claudeUsageBar');
}

// ---------- Rendering ----------

/**
 * Sets text and color only when they change, so VS Code does not redraw the
 * item every tick.
 * @param {vscode.StatusBarItem} item
 * @param {string} text
 * @param {vscode.ThemeColor | undefined} color
 */
function setItem(item, text, color) {
  if (item.text !== text) item.text = text;
  if (item.color !== color) item.color = color;
}

/** @param {number} pct @param {number} warn @param {number} crit */
function colorFor(pct, warn, crit) {
  if (pct >= crit) return RED;
  if (pct >= warn) return YELLOW;
  return undefined;
}

/**
 * @param {vscode.StatusBarItem} item
 * @param {string} label
 * @param {{ percent: number, resetsAtMs: number | null } | null} win
 * @param {number} now
 * @param {boolean} stale data older than STALE_AFTER_MS: show it grey
 */
function renderLimit(item, label, win, now, stale) {
  if (!win) {
    setItem(item, `${label}: ?`, GREY);
    return;
  }
  if (win.resetsAtMs !== null && now >= win.resetsAtMs) {
    setItem(item, `${label}: reset`, GREY);
    return;
  }
  const pct = Math.round(win.percent);
  setItem(item,
    win.resetsAtMs === null ? `${label}: ${pct}%` : `${label}: ${pct}% - ${data.formatDuration(win.resetsAtMs - now)}`,
    stale ? GREY : colorFor(pct, config().get('limitWarning', 70), config().get('limitCritical', 90)));
}

/**
 * @param {vscode.StatusBarItem} five
 * @param {vscode.StatusBarItem} seven
 * @param {vscode.StatusBarItem} ctx
 */
function renderAll(five, seven, ctx) {
  const now = Date.now();
  loadShared(); // picks up fetches made by other windows
  const limits = shared.limits;
  const stale = !limits || now - limits.fetchedAtMs > STALE_AFTER_MS;

  renderLimit(five, '5h', limits?.fiveHour ?? null, now, stale);
  renderLimit(seven, '7d', limits?.sevenDay ?? null, now, stale);

  const folders = (vscode.workspace.workspaceFolders || [])
    .filter(f => f.uri.scheme === 'file')
    .map(f => f.uri.fsPath);
  const found = folders.length ? data.readContext(folders, claudeTabLabel) : null;
  const session = found?.context;
  if (session && session.updatedAtMs > lastTranscriptMs) {
    // A new Claude message: limits just changed, fetch them now.
    if (lastTranscriptMs) refreshLive(true);
    lastTranscriptMs = session.updatedAtMs;
  }
  const hideAfterMs = config().get('contextHideAfterMinutes', 30) * 60000;
  // The chat in the open tab is always shown; a fallback guess only while recent.
  if (session && (found?.matched || now - session.updatedAtMs <= hideAfterMs)) {
    data.fetchModelWindow(session.model).then(
      changed => { if (changed) renderAll(five, seven, ctx); },
      () => {},
    );
    const windowSize = data.contextWindowSize(session.tokens, session.model, config().get('contextWindow', 0));
    const pct = Math.round((session.tokens / windowSize) * 100);
    setItem(ctx, `ctx: ${pct}%`, colorFor(pct, config().get('contextWarning', 50), config().get('contextCritical', 70)));
    ctx.show();
  } else {
    ctx.hide();
  }

  five.show();
  seven.show();
}

// ---------- Updates ----------

/** @param {string} a @param {string} b */
function isNewer(a, b) {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {boolean} manual
 */
async function checkForUpdates(context, manual) {
  // Shared across windows, so only one window asks per day.
  await context.globalState.update('lastUpdateCheck', Date.now());
  const headers = { 'User-Agent': 'claude-usage-bar', Accept: 'application/vnd.github+json' };
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
    if (!res.ok) {
      if (manual) vscode.window.showWarningMessage(`Provjera nove verzije nije uspjela (HTTP ${res.status}).`);
      return;
    }
    const rel = /** @type {any} */ (await res.json());
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    const current = String(context.extension.packageJSON.version);
    if (!latest || !isNewer(latest, current)) {
      if (manual) vscode.window.showInformationMessage(`Imaš najnoviju verziju (${current}).`);
      return;
    }
    if (!manual && context.globalState.get('skippedVersion') === latest) return;
    const asset = (rel.assets || []).find((/** @type {any} */ a) => String(a.name).endsWith('.vsix'));
    if (!asset) return;

    const choice = await vscode.window.showInformationMessage(
      `Claude Usage Bar ${latest} je dostupan (imaš ${current}).`,
      'Instaliraj', 'Kasnije', 'Preskoči ovu verziju',
    );
    if (choice === 'Preskoči ovu verziju') await context.globalState.update('skippedVersion', latest);
    if (choice !== 'Instaliraj') return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Instaliram Claude Usage Bar ${latest}` },
      async () => {
        const dl = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'claude-usage-bar' } });
        if (!dl.ok) throw new Error(`preuzimanje nije uspjelo (HTTP ${dl.status})`);
        const file = path.join(os.tmpdir(), `claude-usage-bar-${latest}.vsix`);
        fs.writeFileSync(file, Buffer.from(await dl.arrayBuffer()));
        try {
          await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
        } finally {
          try { fs.unlinkSync(file); } catch { /* ignore */ }
        }
      },
    );
    const reload = await vscode.window.showInformationMessage('Nova verzija je instalirana. Ponovno učitaj prozor da se aktivira.', 'Reload');
    if (reload) vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (e) {
    if (manual) vscode.window.showErrorMessage(`Ažuriranje nije uspjelo: ${e instanceof Error ? e.message : e}`);
  }
}

module.exports = { activate, deactivate };
