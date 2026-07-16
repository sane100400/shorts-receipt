import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const trackerSource = await fs.readFile(new URL('../extension/content/tracker.js', import.meta.url), 'utf8');

function createTrackerHarness() {
  let now = 1_000;
  let currentDay = '2026-07-15';
  let currentVideoId = 'firstShort01';
  let tick = null;
  let contentMessageListener = null;
  let extensionInvalidated = false;
  const snapshots = [];
  const heartbeats = [];
  const video = {
    currentTime: 0,
    duration: 20,
    paused: false,
    ended: false,
    muted: false,
    volume: 1
  };

  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }

    static now() {
      return now;
    }
  }

  const context = vm.createContext({
    Date: FakeDate,
    Promise,
    Math,
    Number,
    Boolean,
    String,
    Object,
    Array,
    crypto: { randomUUID: () => 'test-id-' + now },
    document: {
      visibilityState: 'visible',
      addEventListener() {}
    },
    addEventListener() {},
    setInterval(callback) {
      tick = callback;
      return 1;
    },
    chrome: {
      runtime: {
        sendMessage(message) {
          if (extensionInvalidated) throw new Error('Extension context invalidated.');
          if (message.type === 'GET_SETTINGS') return Promise.resolve({ consented: true, paused: false });
          if (message.type === 'TRACKER_SNAPSHOT') snapshots.push(message.impression);
          if (message.type === 'TRACKER_HEARTBEAT') heartbeats.push(message.status.state);
          return Promise.resolve({});
        },
        onMessage: {
          addListener(listener) {
            contentMessageListener = listener;
          }
        }
      }
    },
    ScrollReceiptMetrics: {
      dayId: () => currentDay,
      timezone: () => 'Asia/Seoul',
      safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) && Number(value) >= 0
        ? Number(value)
        : fallback
    },
    ScrollReceiptYouTube: {
      isShortsPage: () => true,
      videoIdFromLocation: () => currentVideoId,
      activeVideo: () => video,
      metadata: () => ({ title: '테스트 쇼츠 ' + currentVideoId, channel: '테스트 채널' })
    }
  });

  vm.runInContext(trackerSource, context, { filename: 'tracker.js' });
  return {
    video,
    snapshots,
    heartbeats,
    async ready() {
      await Promise.resolve();
      await Promise.resolve();
    },
    advance(milliseconds, mediaSeconds) {
      now += milliseconds;
      video.currentTime = mediaSeconds;
      tick();
    },
    switchVideo(videoId) {
      currentVideoId = videoId;
    },
    nextDay(dayId) {
      currentDay = dayId;
    },
    pause() {
      contentMessageListener({ type: 'RECORDING_PAUSED', paused: true });
    },
    resume() {
      contentMessageListener({ type: 'RECORDING_PAUSED', paused: false });
    },
    deleteDay(dayId) {
      contentMessageListener({ type: 'DAY_DELETED', dayId });
    },
    clearRecords() {
      contentMessageListener({ type: 'RECORDING_RECORDS_CLEARED' });
    },
    invalidateExtension() {
      extensionInvalidated = true;
    }
  };
}

test('tracker stores active watch only after consent and finalizes a switched Short', async () => {
  const harness = createTrackerHarness();
  assert.equal(harness.snapshots.length, 0, 'initial tick must not save before settings resolve');
  await harness.ready();

  harness.advance(600, 0.6);
  harness.advance(600, 1.2);
  harness.switchVideo('secondShort2');
  harness.advance(600, 0.2);

  const finished = harness.snapshots.find((snapshot) => snapshot.video_id === 'firstShort01' && snapshot.ended_at);
  assert.ok(finished, 'the prior Short is finalized when the URL video ID changes');
  assert.equal(finished.day_id, '2026-07-15');
  // The first post-consent tick establishes a playhead baseline; it must not
  // retroactively count playback from before consent.
  assert.ok(finished.watched_ms >= 500 && finished.watched_ms <= 700);

  harness.advance(600, 0.8);
  harness.pause();
  assert.equal(harness.heartbeats.at(-1), 'paused');
  harness.advance(2_000, 2.2);
  const paused = harness.snapshots.find((snapshot) =>
    snapshot.video_id === 'secondShort2' && snapshot.ended_at
  );
  assert.ok(paused, 'pausing finalizes the active impression');
});

test('tracker creates nothing while paused and resumes from a fresh playhead baseline', async () => {
  const harness = createTrackerHarness();
  await harness.ready();

  harness.advance(600, 0.6);
  harness.advance(600, 1.2);
  harness.pause();

  const pausedSnapshot = harness.snapshots.find((snapshot) =>
    snapshot.video_id === 'firstShort01' && snapshot.ended_at
  );
  assert.ok(pausedSnapshot, 'pausing flushes the active impression');
  assert.equal(pausedSnapshot.end_reason, 'paused');
  assert.equal(pausedSnapshot.is_fast_skip, false, 'pausing is not a fast skip');

  const snapshotCountAtPause = harness.snapshots.length;
  harness.switchVideo('secondShort2');
  harness.advance(2_500, 0.2);
  harness.advance(1_000, 1.2);
  assert.equal(
    harness.snapshots.length,
    snapshotCountAtPause,
    'no impression or snapshot may be created while recording is paused'
  );

  harness.resume();
  harness.advance(600, 1.8);
  assert.equal(harness.heartbeats.at(-1), 'recording-active');
  harness.switchVideo('thirdShort03');
  harness.advance(600, 0.1);

  const resumedSnapshot = harness.snapshots.find((snapshot) =>
    snapshot.video_id === 'secondShort2' && snapshot.ended_at
  );
  assert.ok(resumedSnapshot, 'the Short playing after resume is recorded');
  assert.ok(resumedSnapshot.watched_ms >= 500 && resumedSnapshot.watched_ms <= 700);
  assert.equal(resumedSnapshot.end_reason, 'video-change');
});

test('pausing and resuming the same visible Short does not create a second view', async () => {
  const harness = createTrackerHarness();
  await harness.ready();

  harness.advance(600, 0.6);
  harness.advance(600, 1.2);
  harness.pause();
  const beforePause = harness.snapshots.find((snapshot) => snapshot.end_reason === 'paused');
  assert.ok(beforePause);

  harness.advance(1_000, 5);
  harness.resume();
  harness.advance(600, 5.6);
  harness.switchVideo('secondShort2');
  harness.advance(600, 0.1);

  const afterResume = harness.snapshots.find((snapshot) =>
    snapshot.video_id === 'firstShort01' && snapshot.end_reason === 'video-change'
  );
  assert.ok(afterResume);
  assert.notEqual(afterResume.impression_id, beforePause.impression_id);
  assert.notEqual(afterResume.session_id, beforePause.session_id, 'pause ends the active session');
  assert.equal(afterResume.view_id, beforePause.view_id, 'the same visible Short remains one view');
});

test('tracker splits a continuous Short at the local day boundary', async () => {
  const harness = createTrackerHarness();
  await harness.ready();
  harness.advance(1_000, 1);
  harness.advance(1_000, 2);
  harness.nextDay('2026-07-16');
  harness.advance(1_000, 3);
  harness.advance(1_000, 4);

  const yesterday = harness.snapshots.find((snapshot) => snapshot.day_id === '2026-07-15' && snapshot.ended_at);
  const today = harness.snapshots.find((snapshot) => snapshot.day_id === '2026-07-16');
  assert.ok(yesterday, 'the old day impression is finalized at midnight');
  assert.ok(today, 'a new day impression starts for continued playback');
  assert.equal(today.video_id, 'firstShort01');
});

test('tracker discards the in-memory impression when its day is deleted', async () => {
  const harness = createTrackerHarness();
  await harness.ready();
  harness.advance(1_000, 1);
  harness.deleteDay('2026-07-15');

  const snapshotCount = harness.snapshots.length;
  harness.advance(1_000, 2);
  const endedBeforeDeletion = harness.snapshots
    .slice(snapshotCount)
    .find((snapshot) => snapshot.ended_at && snapshot.watched_ms > 0);
  assert.equal(endedBeforeDeletion, undefined, 'deleted watch time must not be saved again');
});

test('tracker starts a fresh impression after all stored records are cleared', async () => {
  const harness = createTrackerHarness();
  await harness.ready();
  harness.advance(1_000, 1);
  harness.clearRecords();

  const snapshotCount = harness.snapshots.length;
  harness.advance(1_000, 2);
  const restoredOldWatch = harness.snapshots
    .slice(snapshotCount)
    .find((snapshot) => snapshot.ended_at && snapshot.watched_ms > 0);
  assert.equal(restoredOldWatch, undefined, 'cleared watch time must not return from memory');
});

test('tracker stops cleanly when an extension reload invalidates its context', async () => {
  const harness = createTrackerHarness();
  await harness.ready();
  harness.advance(1_000, 1);
  harness.invalidateExtension();

  assert.doesNotThrow(() => harness.advance(1_000, 2));
  assert.doesNotThrow(() => harness.advance(1_000, 3));
});
