import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const workerSource = await fs.readFile(
  new URL('../extension/service-worker.js', import.meta.url),
  'utf8'
);

const SETTINGS_KEY = 'scrollReceipt:v2:settings';
const DAY_PREFIX = 'scrollReceipt:v2:day:';
const TODAY = '2026-07-15';
const NativeDate = Date;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

class FakeDate extends NativeDate {
  constructor(...args) {
    super(...(args.length ? args : ['2026-07-15T12:00:00']));
  }

  static now() {
    return new NativeDate('2026-07-15T12:00:00').getTime();
  }
}

function createHarness(initial = {}, options = {}) {
  const store = { ...initial };
  const sentToTabs = [];
  const createdTabs = [];
  const executedScripts = [];
  let runtimeListener = null;

  const storage = {
    async get(keys) {
      if (keys === null) return { ...store };
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, store[key]]));
      }
      return { ...keys, ...Object.fromEntries(
        Object.keys(keys || {}).filter((key) => key in store).map((key) => [key, store[key]])
      ) };
    },
    async set(values) {
      Object.assign(store, values);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    }
  };

  const context = vm.createContext({
    Date: FakeDate,
    Intl,
    URL,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Map,
    Set,
    setTimeout,
    clearTimeout,
    chrome: {
      storage: { local: storage },
      tabs: {
        async query(queryInfo) {
          return options.queryTabs?.(queryInfo) || [];
        },
        async sendMessage(tabId, message) {
          sentToTabs.push({ tabId, message });
          return options.onTabMessage?.(tabId, message) || {};
        },
        async create(options) {
          createdTabs.push(options);
          return {};
        },
        onUpdated: { addListener() {} }
      },
      scripting: {
        async executeScript(details) {
          executedScripts.push(details);
          return [];
        }
      },
      runtime: {
        getURL(path) {
          return 'chrome-extension://test/' + path;
        },
        onMessage: {
          addListener(listener) {
            runtimeListener = listener;
          }
        },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} }
      }
    }
  });

  vm.runInContext(workerSource, context, { filename: 'service-worker.js' });

  return {
    store,
    sentToTabs,
    createdTabs,
    executedScripts,
    send(message) {
      return new Promise((resolve, reject) => {
        try {
          runtimeListener(message, {}, resolve);
        } catch (error) {
          reject(error);
        }
      });
    }
  };
}

test('consent waits for an explicit daily start and starts only today', async () => {
  const harness = createHarness();

  await harness.send({ type: 'SET_CONSENT', consented: true });
  assert.deepEqual(plain(harness.store[SETTINGS_KEY]), {
    consented: true,
    paused: true,
    active_day_id: null,
    prompt_dismissed_day_id: null
  });

  assert.deepEqual(plain(await harness.send({ type: 'GET_START_PROMPT_STATE' })), {
    day_id: TODAY,
    show: true
  });

  assert.deepEqual(plain(await harness.send({ type: 'START_TODAY' })), {
    started: true,
    day_id: TODAY
  });
  assert.equal(harness.store[SETTINGS_KEY].paused, false);
  assert.equal(harness.store[SETTINGS_KEY].active_day_id, TODAY);
  assert.equal((await harness.send({ type: 'GET_START_PROMPT_STATE' })).show, false);
});

test('resuming today verifies the open Shorts tracker before sending resume', async () => {
  let trackerPaused = true;
  const openShortsTab = { id: 42, url: 'https://www.youtube.com/shorts/resume-test' };
  const harness = createHarness({
    [SETTINGS_KEY]: {
      consented: true,
      paused: true,
      active_day_id: TODAY,
      prompt_dismissed_day_id: null
    },
    'scrollReceipt:v2:tracker-status': {
      state: 'shorts-ready',
      updated_at: '2026-07-15T12:00:00.000Z',
      tab_id: 42
    }
  }, {
    queryTabs: () => [openShortsTab],
    onTabMessage: (_tabId, message) => {
      if (message.type === 'TRACKER_PING') {
        return { alive: true, paused: trackerPaused, consented: true };
      }
      if (message.type === 'RECORDING_PAUSED') trackerPaused = message.paused;
      return {};
    }
  });

  const result = await harness.send({ type: 'START_TODAY' });
  assert.deepEqual(plain(result), { started: true, day_id: TODAY });
  assert.equal(trackerPaused, false);
  assert.equal(harness.executedScripts.length, 0, 'a live tracker is reused without reinjection');

  const trackerMessages = harness.sentToTabs
    .filter((entry) => entry.tabId === 42)
    .map((entry) => entry.message.type);
  assert.ok(trackerMessages.indexOf('TRACKER_PING') >= 0);
  assert.ok(
    trackerMessages.indexOf('TRACKER_PING') < trackerMessages.indexOf('RECORDING_PAUSED'),
    'resume is sent only after a live tracker answers'
  );
});

test('resetting today keeps consent and the active recording day', async () => {
  const todayKey = DAY_PREFIX + TODAY;
  const olderKey = DAY_PREFIX + '2026-07-14';
  const harness = createHarness({
    [SETTINGS_KEY]: {
      consented: true,
      paused: false,
      active_day_id: TODAY,
      prompt_dismissed_day_id: null
    },
    [todayKey]: { day_id: TODAY, impressions: [{ video_id: 'today' }] },
    [olderKey]: { day_id: '2026-07-14', impressions: [{ video_id: 'older' }] }
  });

  await harness.send({ type: 'DELETE_DAY', dayId: TODAY });
  assert.equal(harness.store[todayKey], undefined);
  assert.ok(harness.store[olderKey], 'older daily buckets must remain');
  assert.equal(harness.store[SETTINGS_KEY].consented, true);
  assert.equal(harness.store[SETTINGS_KEY].paused, false);
  assert.equal(harness.store[SETTINGS_KEY].active_day_id, TODAY);
});

test('dismissing the daily prompt pauses today without revoking consent', async () => {
  const harness = createHarness();
  await harness.send({ type: 'SET_CONSENT', consented: true });
  const result = await harness.send({ type: 'DISMISS_START_PROMPT' });

  assert.deepEqual(plain(result), { dismissed: true, day_id: TODAY });
  assert.equal(harness.store[SETTINGS_KEY].consented, true);
  assert.equal(harness.store[SETTINGS_KEY].paused, true);
  assert.equal(harness.store[SETTINGS_KEY].prompt_dismissed_day_id, TODAY);
  assert.equal((await harness.send({ type: 'GET_START_PROMPT_STATE' })).show, false);
});

test('deleting all records keeps consent and recording settings', async () => {
  const todayKey = DAY_PREFIX + TODAY;
  const olderKey = DAY_PREFIX + '2026-07-14';
  const harness = createHarness({
    [SETTINGS_KEY]: {
      consented: true,
      paused: false,
      active_day_id: TODAY,
      prompt_dismissed_day_id: null
    },
    [todayKey]: { day_id: TODAY, impressions: [{ video_id: 'today' }] },
    [olderKey]: { day_id: '2026-07-14', impressions: [{ video_id: 'older' }] },
    unrelated: { keep: true }
  });

  const result = await harness.send({ type: 'DELETE_ALL_RECORDS' });
  assert.equal(result.deleted, 2);
  assert.equal(harness.store[todayKey], undefined);
  assert.equal(harness.store[olderKey], undefined);
  assert.equal(harness.store[SETTINGS_KEY].consented, true);
  assert.equal(harness.store[SETTINGS_KEY].paused, false);
  assert.equal(harness.store[SETTINGS_KEY].active_day_id, TODAY);
  assert.deepEqual(harness.store.unrelated, { keep: true });
});

test('turning consent off stops recording without deleting stored days', async () => {
  const todayKey = DAY_PREFIX + TODAY;
  const harness = createHarness({
    [SETTINGS_KEY]: {
      consented: true,
      paused: false,
      active_day_id: TODAY,
      prompt_dismissed_day_id: null
    },
    [todayKey]: { day_id: TODAY, impressions: [{ video_id: 'today' }] }
  });

  await harness.send({ type: 'SET_CONSENT', consented: false });
  assert.ok(harness.store[todayKey], 'withdrawing consent must preserve existing records');
  assert.equal(harness.store[SETTINGS_KEY].consented, false);
  assert.equal(harness.store[SETTINGS_KEY].paused, true);
  assert.equal(harness.store[SETTINGS_KEY].active_day_id, null);
});

test('pausing keeps the final active impression but rejects later paused snapshots', async () => {
  const todayKey = DAY_PREFIX + TODAY;
  const harness = createHarness({
    [SETTINGS_KEY]: {
      consented: true,
      paused: true,
      active_day_id: TODAY,
      prompt_dismissed_day_id: null
    }
  });
  const base = {
    impression_id: 'pause-boundary-impression',
    session_id: 'pause-boundary-session',
    video_id: 'short-at-pause',
    day_id: TODAY,
    timezone: 'Asia/Seoul',
    started_at: '2026-07-15T11:59:58.000Z',
    watched_ms: 700
  };

  const finalResult = await harness.send({
    type: 'TRACKER_SNAPSHOT',
    impression: {
      ...base,
      ended_at: '2026-07-15T12:00:00.000Z',
      end_reason: 'paused',
      is_fast_skip: false
    }
  });
  assert.deepEqual(plain(finalResult), { saved: true });
  assert.equal(harness.store[todayKey].impressions.length, 1);

  const pausedResult = await harness.send({
    type: 'TRACKER_SNAPSHOT',
    impression: {
      ...base,
      impression_id: 'created-while-paused',
      ended_at: null
    }
  });
  assert.deepEqual(plain(pausedResult), { ignored: true });
  assert.equal(harness.store[todayKey].impressions.length, 1);
});

test('opening the report skips the checkout confirmation screen', async () => {
  const harness = createHarness();
  await harness.send({ type: 'OPEN_REPORT' });
  assert.equal(
    harness.createdTabs[0].url,
    'chrome-extension://test/report/report.html?auto=1'
  );
});
