const DAY_PREFIX = 'scrollReceipt:v2:day:';
const SETTINGS_KEY = 'scrollReceipt:v2:settings';
const TRACKER_STATUS_KEY = 'scrollReceipt:v2:tracker-status';
const TAB_MESSAGE_TIMEOUT_MS = 1200;
const SCRIPT_INJECTION_TIMEOUT_MS = 2000;

function settleWithin(promise, timeoutMs, fallback = null) {
  return new Promise((resolve) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(fallback);
      }
    );
  });
}

function localDayId() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');
}

function dayKey(dayId) {
  return `${DAY_PREFIX}${dayId}`;
}

function newDayBucket(impression) {
  const now = new Date().toISOString();
  return {
    schema_version: '2.0',
    day_id: impression.day_id,
    timezone: impression.timezone || 'Asia/Seoul',
    consent: true,
    started_at: now,
    updated_at: now,
    sessions: [],
    impressions: [],
    reports: []
  };
}

function recomputeSessions(day) {
  const sessions = new Map();
  for (const impression of day.impressions) {
    const key = impression.session_id || 'unknown-session';
    const existing = sessions.get(key) || {
      session_id: key,
      started_at: impression.started_at || null,
      ended_at: impression.ended_at || impression.started_at || null,
      active_watch_ms: 0
    };
    existing.active_watch_ms += Number(impression.watched_ms) || 0;
    if (impression.started_at && (!existing.started_at || impression.started_at < existing.started_at)) {
      existing.started_at = impression.started_at;
    }
    const end = impression.ended_at || impression.started_at;
    if (end && (!existing.ended_at || end > existing.ended_at)) existing.ended_at = end;
    sessions.set(key, existing);
  }
  day.sessions = [...sessions.values()];
}

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const value = stored[SETTINGS_KEY] || {};
  const consented = Boolean(value.consented);
  const activeDayId = value.active_day_id || null;
  const activeToday = activeDayId === localDayId();
  return {
    consented,
    // Recording requires an explicit start once per local day. This also
    // migrates older settings that predate active_day_id into the new prompt.
    paused: !consented || Boolean(value.paused) || !activeToday,
    active_day_id: activeDayId,
    prompt_dismissed_day_id: value.prompt_dismissed_day_id || null
  };
}

async function broadcast(message) {
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://www.youtube.com/*', 'https://youtube.com/*']
    });
    await Promise.all(tabs.map((tab) => settleWithin(
      chrome.tabs.sendMessage(tab.id, message),
      TAB_MESSAGE_TIMEOUT_MS
    )));
  } catch {
    // Storage remains the source of truth. A content script reads this on its next load.
  }
}

function isShortsUrl(value) {
  try {
    const url = new URL(value);
    return (url.hostname === 'www.youtube.com' || url.hostname === 'youtube.com') &&
      (url.pathname === '/shorts' || url.pathname.startsWith('/shorts/'));
  } catch {
    return false;
  }
}

function isYouTubeUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === 'www.youtube.com' || url.hostname === 'youtube.com';
  } catch {
    return false;
  }
}

async function injectTracker(tabId) {
  const existing = await settleWithin(
    chrome.tabs.sendMessage(tabId, { type: 'TRACKER_PING' }),
    TAB_MESSAGE_TIMEOUT_MS
  );
  if (existing?.alive) return { connected: true, reused: true };

  try {
    const cleared = await settleWithin(
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          delete globalThis.__scrollReceiptTrackerStarted;
        }
      }).then(() => true),
      SCRIPT_INJECTION_TIMEOUT_MS,
      false
    );
    if (!cleared) return { connected: false, reused: false };

    const loaded = await settleWithin(
      chrome.scripting.executeScript({
        target: { tabId },
        files: [
          'shared/metrics.js',
          'content/youtube-adapter.js',
          'content/tracker.js'
        ]
      }).then(() => true),
      SCRIPT_INJECTION_TIMEOUT_MS,
      false
    );
    if (!loaded) return { connected: false, reused: false };

    const injected = await settleWithin(
      chrome.tabs.sendMessage(tabId, { type: 'TRACKER_PING' }),
      TAB_MESSAGE_TIMEOUT_MS
    );
    return { connected: Boolean(injected?.alive), reused: false };
  } catch {
    // A tab can navigate away while injection is queued. The declarative
    // content script and the next SPA update both provide another chance.
    return { connected: false, reused: false };
  }
}

async function injectStartPrompt(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/start-prompt.js']
    });
  } catch {
    // The declarative content script handles the next full YouTube load.
  }
}

async function ensureTrackerInShortsTabs() {
  const tabs = await chrome.tabs.query({
    url: [
      'https://www.youtube.com/shorts',
      'https://www.youtube.com/shorts/*',
      'https://youtube.com/shorts',
      'https://youtube.com/shorts/*'
    ]
  });
  await Promise.all(tabs.map((tab) => injectTracker(tab.id)));
}

async function ensureStartPromptInYouTubeTabs() {
  const tabs = await chrome.tabs.query({
    url: ['https://www.youtube.com/*', 'https://youtube.com/*']
  });
  await Promise.all(tabs.map((tab) => injectStartPrompt(tab.id)));
}

async function getTrackerStatus() {
  const stored = await chrome.storage.local.get(TRACKER_STATUS_KEY);
  const status = stored[TRACKER_STATUS_KEY] || null;
  return {
    ...status,
    is_fresh: Boolean(status?.updated_at) && Date.now() - new Date(status.updated_at).getTime() < 12_000
  };
}

async function saveTrackerStatus(status, sender) {
  const value = {
    state: status?.state || 'unknown',
    updated_at: new Date().toISOString(),
    tab_id: sender?.tab?.id ?? null
  };
  await chrome.storage.local.set({ [TRACKER_STATUS_KEY]: value });
  return value;
}

async function setPaused(paused) {
  const settings = await getSettings();
  const nextPaused = Boolean(paused);
  const next = {
    ...settings,
    paused: nextPaused,
    active_day_id: nextPaused ? settings.active_day_id : localDayId(),
    prompt_dismissed_day_id: nextPaused ? settings.prompt_dismissed_day_id : null
  };
  await chrome.storage.local.set({
    [SETTINGS_KEY]: next
  });
  if (nextPaused) {
    await broadcast({ type: 'RECORDING_PAUSED', paused: true });
  } else {
    await chrome.storage.local.remove(TRACKER_STATUS_KEY);
    await ensureTrackerInShortsTabs();
    await broadcast({ type: 'RECORDING_PAUSED', paused: false });
  }
  return next;
}

async function setConsent(consented) {
  const next = {
    consented: Boolean(consented),
    // Consent and today's start are separate choices. Visiting YouTube asks
    // once per day before Shorts tracking begins.
    paused: true,
    active_day_id: null,
    prompt_dismissed_day_id: null
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  if (next.consented) await ensureStartPromptInYouTubeTabs();
  await broadcast({ type: 'RECORDING_CONSENT', consented: next.consented });
  await broadcast({ type: 'RECORDING_PAUSED', paused: true });
  return next;
}

async function getStartPromptState() {
  const settings = await getSettings();
  const dayId = localDayId();
  return {
    day_id: dayId,
    show: settings.consented &&
      settings.active_day_id !== dayId &&
      settings.prompt_dismissed_day_id !== dayId
  };
}

async function startToday() {
  const settings = await getSettings();
  if (!settings.consented) return { started: false, reason: 'consent-required' };
  const dayId = localDayId();
  const next = {
    ...settings,
    paused: false,
    active_day_id: dayId,
    prompt_dismissed_day_id: null
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  await chrome.storage.local.remove(TRACKER_STATUS_KEY);
  await ensureTrackerInShortsTabs();
  await broadcast({ type: 'RECORDING_PAUSED', paused: false });
  await broadcast({ type: 'DAILY_RECORDING_STARTED', dayId });
  return { started: true, day_id: dayId };
}

async function dismissStartPrompt() {
  const settings = await getSettings();
  const dayId = localDayId();
  const next = {
    ...settings,
    paused: true,
    prompt_dismissed_day_id: dayId
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  await broadcast({ type: 'DAILY_RECORDING_DISMISSED', dayId });
  return { dismissed: true, day_id: dayId };
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url;
  if (changeInfo.url || changeInfo.status === 'complete') {
    if (isYouTubeUrl(url)) injectStartPrompt(tabId);
    if (isShortsUrl(url)) injectTracker(tabId);
  }
});

async function reconnectOpenTabs() {
  await ensureStartPromptInYouTubeTabs();
  const settings = await getSettings();
  if (settings.consented && !settings.paused) await ensureTrackerInShortsTabs();
}

chrome.runtime.onInstalled.addListener(() => {
  reconnectOpenTabs().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  reconnectOpenTabs().catch(() => {});
});

async function saveSnapshot(impression) {
  const settings = await getSettings();
  const isPauseFinalization = settings.consented &&
    settings.paused &&
    settings.active_day_id === impression?.day_id &&
    Boolean(impression?.ended_at) &&
    impression?.end_reason === 'paused';
  if (!settings.consented ||
      (settings.paused && !isPauseFinalization) ||
      !impression?.day_id ||
      !impression?.impression_id) {
    return { ignored: true };
  }
  const key = dayKey(impression.day_id);
  const stored = await chrome.storage.local.get(key);
  const day = stored[key] || newDayBucket(impression);
  const index = day.impressions.findIndex((item) => item.impression_id === impression.impression_id);
  if (index >= 0) {
    day.impressions[index] = { ...day.impressions[index], ...impression };
  } else {
    day.impressions.push(impression);
  }
  day.updated_at = new Date().toISOString();
  recomputeSessions(day);
  await chrome.storage.local.set({ [key]: day });
  await pruneOldDays();
  return { saved: true };
}

async function pruneOldDays() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffDay = [
    cutoff.getFullYear(),
    String(cutoff.getMonth() + 1).padStart(2, '0'),
    String(cutoff.getDate()).padStart(2, '0')
  ].join('-');
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((key) => {
    if (!key.startsWith(DAY_PREFIX)) return false;
    return key.slice(DAY_PREFIX.length) < cutoffDay;
  });
  if (stale.length) await chrome.storage.local.remove(stale);
}

async function getDay(dayId) {
  const key = dayKey(dayId);
  const stored = await chrome.storage.local.get(key);
  return stored[key] || {
    schema_version: '2.0',
    day_id: dayId,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul',
    consent: true,
    started_at: null,
    updated_at: null,
    sessions: [],
    impressions: [],
    reports: []
  };
}

async function deleteDay(dayId) {
  await chrome.storage.local.remove(dayKey(dayId));
  await broadcast({ type: 'DAY_DELETED', dayId });
  return { deleted: true };
}

async function deleteAllRecords() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(DAY_PREFIX));
  await chrome.storage.local.remove(keys);
  await broadcast({ type: 'RECORDING_RECORDS_CLEARED' });
  return { deleted: keys.length };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'GET_SETTINGS':
        return getSettings();
      case 'SET_PAUSED':
        return setPaused(message.paused);
      case 'SET_CONSENT':
        return setConsent(message.consented);
      case 'GET_START_PROMPT_STATE':
        return getStartPromptState();
      case 'START_TODAY':
        return startToday();
      case 'DISMISS_START_PROMPT':
        return dismissStartPrompt();
      case 'ENSURE_TRACKER':
        await ensureTrackerInShortsTabs();
        return getTrackerStatus();
      case 'TRACKER_HEARTBEAT':
        return saveTrackerStatus(message.status, _sender);
      case 'GET_TRACKER_STATUS':
        return getTrackerStatus();
      case 'TRACKER_SNAPSHOT':
        return saveSnapshot(message.impression);
      case 'GET_DAY':
        return getDay(message.dayId);
      case 'DELETE_DAY':
        return deleteDay(message.dayId);
      case 'DELETE_ALL_RECORDS':
        return deleteAllRecords();
      case 'OPEN_REPORT': {
        const reportUrl = new URL(chrome.runtime.getURL('report/report.html'));
        reportUrl.searchParams.set('auto', '1');
        await chrome.tabs.create({ url: reportUrl.href });
        return { opened: true };
      }
      default:
        return { error: 'Unknown message.' };
    }
  })()
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message }));
  return true;
});
