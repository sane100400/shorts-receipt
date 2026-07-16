(() => {
  if (globalThis.__scrollReceiptTrackerStarted) return;
  globalThis.__scrollReceiptTrackerStarted = true;

  const adapter = globalThis.ScrollReceiptYouTube;
  const metrics = globalThis.ScrollReceiptMetrics;
  const TICK_MS = 500;
  const SNAPSHOT_MS = 2000;
  const SESSION_GAP_MS = 5 * 60 * 1000;
  const MIN_VALID_WATCH_MS = 300;

  let paused = false;
  let consented = false;
  let current = null;
  let currentSessionId = null;
  let pausedContinuation = null;
  let lastSnapshotAt = 0;
  let lastActiveAt = 0;
  let lastHeartbeatAt = 0;
  let lastHeartbeatState = null;
  let intervalId = null;
  let stopped = false;

  function isContextInvalidated(error) {
    return /extension context invalidated/i.test(String(error?.message || error));
  }

  // Reloading an unpacked extension invalidates scripts already running in
  // open YouTube tabs. chrome.runtime then throws synchronously (so a
  // Promise.catch alone cannot handle it). Stop this old tracker quietly;
  // the current script will be injected again on the next Shorts navigation
  // or through the popup's reconnect action.
  function stopForInvalidatedContext(error) {
    if (!isContextInvalidated(error)) return;
    stopped = true;
    current = null;
    pausedContinuation = null;
    if (intervalId !== null && typeof clearInterval === 'function') clearInterval(intervalId);
    intervalId = null;
    delete globalThis.__scrollReceiptTrackerStarted;
  }

  function sendRuntimeMessage(message) {
    if (stopped) return Promise.resolve(null);
    try {
      return Promise.resolve(chrome.runtime.sendMessage(message)).catch((error) => {
        stopForInvalidatedContext(error);
        return null;
      });
    } catch (error) {
      stopForInvalidatedContext(error);
      return Promise.resolve(null);
    }
  }

  function newId(prefix) {
    return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`}`;
  }

  function newImpression(videoId, video, viewId = null) {
    const now = Date.now();
    const meta = adapter.metadata();
    return {
      impression_id: newId('impression'),
      view_id: viewId || newId('view'),
      session_id: currentSessionId || (currentSessionId = newId('session')),
      video_id: videoId,
      url: `https://www.youtube.com/shorts/${videoId}`,
      title: meta.title,
      channel: meta.channel,
      day_id: metrics.dayId(),
      timezone: metrics.timezone(),
      started_at: new Date(now).toISOString(),
      ended_at: null,
      watched_ms: 0,
      duration_ms: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0,
      max_position_ms: Math.max(0, Math.round(video.currentTime * 1000)),
      first_exit_position_ms: null,
      completion_rate: 0,
      was_completed: false,
      replay_count: 0,
      muted_watch_ms: 0,
      is_fast_skip: false,
      last_wall_ms: now,
      last_media_ms: Math.max(0, Math.round(video.currentTime * 1000))
    };
  }

  function serializable(record, endReason = null) {
    const copy = { ...record };
    delete copy.last_wall_ms;
    delete copy.last_media_ms;
    if (endReason) {
      copy.ended_at = new Date().toISOString();
      copy.end_reason = endReason;
      copy.first_exit_position_ms ??= copy.max_position_ms;
      copy.is_fast_skip = endReason === 'video-change' && !copy.was_completed &&
        (metrics.safeNumber(copy.first_exit_position_ms, Number.MAX_SAFE_INTEGER) <= 1000 ||
          metrics.safeNumber(copy.watched_ms, Number.MAX_SAFE_INTEGER) <= 1000);
    }
    return copy;
  }

  function sendSnapshot(endReason = null) {
    if (stopped || !current || current.watched_ms < MIN_VALID_WATCH_MS) {
      return Promise.resolve(null);
    }
    return sendRuntimeMessage({
      type: 'TRACKER_SNAPSHOT',
      impression: serializable(current, endReason)
    });
  }

  function heartbeat(state) {
    if (stopped) return;
    const now = Date.now();
    if (now - lastHeartbeatAt < 3000 && state === lastHeartbeatState) return;
    lastHeartbeatAt = now;
    lastHeartbeatState = state;
    sendRuntimeMessage({
      type: 'TRACKER_HEARTBEAT',
      status: { state }
    });
  }

  function finishCurrent(endSession = false, endReason = 'unknown') {
    if (!current) return Promise.resolve(null);
    const pending = sendSnapshot(endReason);
    current = null;
    lastSnapshotAt = 0;
    if (endSession) currentSessionId = null;
    return pending;
  }

  function pauseCurrent() {
    if (current) {
      pausedContinuation = {
        video_id: current.video_id,
        view_id: current.view_id
      };
    }
    return finishCurrent(true, 'paused');
  }

  function updateCurrent(video) {
    if (!current) return false;
    const now = Date.now();
    const mediaMs = Math.max(0, Math.round(video.currentTime * 1000));
    const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : current.duration_ms;
    const wallDelta = Math.min(Math.max(0, now - current.last_wall_ms), 1250);
    const mediaDelta = mediaMs - current.last_media_ms;
    const progressing = mediaDelta > 25;
    const eligible = !paused &&
      document.visibilityState === 'visible' &&
      !video.paused &&
      !video.ended &&
      progressing;

    if (durationMs > 0 && current.last_media_ms >= durationMs * 0.9 && mediaMs <= durationMs * 0.1 && progressing) {
      current.replay_count += 1;
    }

    if (eligible) {
      current.watched_ms += wallDelta;
      if (video.muted || video.volume === 0) current.muted_watch_ms += wallDelta;
      lastActiveAt = now;
    }

    current.duration_ms = durationMs;
    current.max_position_ms = Math.max(current.max_position_ms, mediaMs);
    current.completion_rate = durationMs > 0 ? Math.min(1, current.max_position_ms / durationMs) : 0;
    current.was_completed = current.was_completed || current.completion_rate >= 0.9 || video.ended;
    current.last_wall_ms = now;
    current.last_media_ms = mediaMs;

    const meta = adapter.metadata();
    if (meta.title) current.title = meta.title;
    if (meta.channel) current.channel = meta.channel;
    return eligible;
  }

  function shouldStartNewSession(now) {
    return Boolean(lastActiveAt && now - lastActiveAt > SESSION_GAP_MS);
  }

  function tick() {
    if (stopped) return;
    if (!consented) {
      heartbeat('waiting-for-consent');
      pausedContinuation = null;
      finishCurrent(true, 'consent-revoked');
      return;
    }
    if (paused) {
      heartbeat('paused');
      pauseCurrent();
      return;
    }
    if (!adapter?.isShortsPage()) {
      heartbeat('not-on-shorts');
      pausedContinuation = null;
      finishCurrent(false, 'page-exit');
      return;
    }
    const videoId = adapter.videoIdFromLocation();
    const video = adapter.activeVideo();
    if (!videoId || !video) {
      heartbeat('shorts-loading');
      return;
    }

    // A single continuous Shorts playback can cross local midnight. Keep each
    // side of that boundary in its own daily bucket rather than attributing
    // the next day's watch time to the impression that began yesterday.
    if (current && current.day_id !== metrics.dayId()) finishCurrent(true, 'day-change');
    if (current && current.video_id !== videoId) finishCurrent(false, 'video-change');
    if (current && shouldStartNewSession(Date.now())) finishCurrent(true, 'session-gap');
    if (!current) {
      const continuedViewId = pausedContinuation?.video_id === videoId
        ? pausedContinuation.view_id
        : null;
      current = newImpression(videoId, video, continuedViewId);
      pausedContinuation = null;
      lastSnapshotAt = 0;
    }

    const activelyRecording = updateCurrent(video);
    heartbeat(activelyRecording ? 'recording-active' : 'shorts-ready');
    if (stopped) return;
    if (current.watched_ms >= MIN_VALID_WATCH_MS &&
        (!lastSnapshotAt || Date.now() - lastSnapshotAt >= SNAPSHOT_MS)) {
      lastSnapshotAt = Date.now();
      sendSnapshot();
    }
  }

  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (stopped) return;
      if (message?.type === 'TRACKER_PING') {
        sendResponse?.({ alive: true, paused, consented });
        return;
      }
      if (message?.type === 'RECORDING_PAUSED') {
        const wasPaused = paused;
        paused = Boolean(message.paused);
        if (paused) {
          pauseCurrent();
          heartbeat('paused');
        } else if (wasPaused) {
          current = null;
          currentSessionId = null;
          lastActiveAt = 0;
          lastSnapshotAt = 0;
          if (pausedContinuation?.video_id !== adapter?.videoIdFromLocation?.()) {
            pausedContinuation = null;
          }
          tick();
        }
      }
      if (message?.type === 'RECORDING_CONSENT') {
        consented = Boolean(message.consented);
        if (!consented) {
          pausedContinuation = null;
          finishCurrent(true, 'consent-revoked');
        }
      }
      if (message?.type === 'DAY_DELETED' && current?.day_id === message.dayId) {
        // Do not send the pre-deletion in-memory impression back to storage.
        current = null;
        currentSessionId = null;
        pausedContinuation = null;
      }
      if (message?.type === 'RECORDING_RECORDS_CLEARED') {
        current = null;
        currentSessionId = null;
        pausedContinuation = null;
      }
    });
  } catch (error) {
    stopForInvalidatedContext(error);
  }

  sendRuntimeMessage({ type: 'GET_SETTINGS' })
    .then((settings) => {
      if (stopped) return;
      paused = Boolean(settings?.paused);
      consented = Boolean(settings?.consented);
      heartbeat(!consented
        ? 'waiting-for-consent'
        : paused
          ? 'paused'
        : adapter?.isShortsPage()
          ? 'shorts-ready'
          : 'not-on-shorts');
    });

  addEventListener('pagehide', () => finishCurrent(true, 'page-exit'));
  addEventListener('beforeunload', () => finishCurrent(true, 'page-exit'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sendSnapshot(false);
  });
  if (!stopped) {
    intervalId = setInterval(tick, TICK_MS);
    tick();
  }
})();
