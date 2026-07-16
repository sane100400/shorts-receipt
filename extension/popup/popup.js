const metrics = globalThis.ScrollReceiptMetrics;
let refreshInFlight = false;
let flashHint = '';
let flashHintUntil = 0;

function query(id) {
  return document.getElementById(id);
}

async function message(payload) {
  return chrome.runtime.sendMessage(payload);
}

async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
  const dayId = metrics.dayId();
  const [day, settings, trackerStatus] = await Promise.all([
    message({ type: 'GET_DAY', dayId }),
    message({ type: 'GET_SETTINGS' }),
    message({ type: 'GET_TRACKER_STATUS' })
  ]);
  const summary = metrics.buildSummary(day);
  const paused = Boolean(settings?.paused);
  const consented = Boolean(settings?.consented);
  const activeToday = settings?.active_day_id === dayId;
  const dismissedToday = settings?.prompt_dismissed_day_id === dayId;
  const running = activeToday && !paused;

  query('onboarding').classList.toggle('is-hidden', consented);
  query('tracking-ui').classList.toggle('is-hidden', !consented);
  if (!consented) return;
  query('consent-toggle').checked = true;

  query('view-count').textContent = summary.daily_view_count.toLocaleString('ko-KR');
  query('active-watch').textContent = metrics.formatDuration(summary.active_watch_ms);
  query('fast-skip').textContent = summary.fast_skip_count + '회';
  query('longest-session').textContent = metrics.formatShortDuration(summary.longest_session_ms);
  const trackerConnected = Boolean(
    trackerStatus?.is_fresh &&
    ['shorts-ready', 'recording-active'].includes(trackerStatus?.state)
  );
  const activelyRecording = trackerStatus?.is_fresh && trackerStatus?.state === 'recording-active';
  query('recording-status').textContent = !activeToday
    ? dismissedToday ? '오늘은 쉼' : '시작 전'
    : paused
      ? '일시정지'
      : trackerConnected
      ? activelyRecording ? '기록 중' : '재생 대기'
      : '탭 연결 필요';
  query('recording-status').classList.toggle('is-paused', paused && activeToday);
  query('recording-status').classList.toggle('is-idle', !activeToday);
  query('recording-status').classList.toggle('needs-connection', running && !trackerConnected);
  query('toggle-pause').innerHTML = '<span class="control-glyph ' +
    (running ? 'is-pause' : '') + '" aria-hidden="true"></span>' +
    (running ? '기록 일시정지' : activeToday ? '기록 재개' : '오늘 기록 시작');
  query('reconnect-tracker').classList.toggle('is-hidden', !running || trackerConnected);
  query('reset-today').disabled = summary.daily_view_count === 0;

  const regularHint = !activeToday
    ? dismissedToday
      ? '오늘은 쉬는 날로 해뒀어요. 마음이 바뀌면 바로 시작할 수 있어요.'
      : '아직 세기 전이에요. 아래 버튼을 누르면 바로 시작합니다.'
    : paused
      ? '멈춘 동안 본 쇼츠는 세지 않아요.'
      : !trackerConnected
        ? '열어 둔 Shorts 탭과 연결이 끊겼어요. 아래에서 다시 연결해 주세요.'
    : summary.daily_view_count >= 4
      ? '영수증 뽑을 준비 끝. 오늘 뭘 오래 봤는지 열어 보세요.'
      : '쇼츠 ' + Math.max(0, 4 - summary.daily_view_count) + '개만 더 보면 오늘 영수증을 뽑을 수 있어요.';
  query('hint').textContent = flashHint && Date.now() < flashHintUntil ? flashHint : regularHint;
  query('open-report').disabled = false;
  } finally {
    refreshInFlight = false;
  }
}

query('open-report').addEventListener('click', async () => {
  await message({ type: 'OPEN_REPORT' });
  window.close();
});

query('reconnect-tracker').addEventListener('click', async () => {
  await message({ type: 'ENSURE_TRACKER' });
  setTimeout(refresh, 500);
});

query('toggle-pause').addEventListener('click', async () => {
  const settings = await message({ type: 'GET_SETTINGS' });
  const activeToday = settings?.active_day_id === metrics.dayId();
  if (activeToday && !settings?.paused) {
    await message({ type: 'SET_PAUSED', paused: true });
  } else {
    await message({ type: 'START_TODAY' });
  }
  refresh();
});

query('start-recording').addEventListener('click', async () => {
  await message({ type: 'SET_CONSENT', consented: true });
  window.close();
});

query('reset-today').addEventListener('click', async () => {
  if (!confirm('오늘 기록만 0으로 돌릴까요? 초기화한 뒤에도 기록은 계속됩니다.')) return;
  await message({ type: 'DELETE_DAY', dayId: metrics.dayId() });
  const settings = await message({ type: 'GET_SETTINGS' });
  flashHint = settings?.active_day_id === metrics.dayId() && !settings?.paused
    ? '오늘 기록을 초기화했어요. 지금 보는 쇼츠부터 다시 셉니다.'
    : '오늘 기록을 초기화했어요. 다음 시작은 0개부터 셉니다.';
  flashHintUntil = Date.now() + 5000;
  refresh();
});

query('delete-records').addEventListener('click', async () => {
  if (!confirm('저장된 기록을 모두 지울까요? 기록 동의와 설정은 그대로 유지됩니다.')) return;
  await message({ type: 'DELETE_ALL_RECORDS' });
  const settings = await message({ type: 'GET_SETTINGS' });
  flashHint = settings?.active_day_id === metrics.dayId() && !settings?.paused
    ? '저장된 기록을 모두 지웠어요. 지금 보는 쇼츠부터 다시 셉니다.'
    : '저장된 기록을 모두 지웠어요.';
  flashHintUntil = Date.now() + 5000;
  refresh();
});

query('consent-toggle').addEventListener('change', async (event) => {
  const toggle = event.currentTarget;
  toggle.disabled = true;
  try {
    await message({ type: 'SET_CONSENT', consented: toggle.checked });
    await refresh();
  } catch (error) {
    toggle.checked = !toggle.checked;
    query('hint').textContent = '기록 동의를 바꾸지 못했습니다: ' + error.message;
  } finally {
    toggle.disabled = false;
  }
});

refresh().catch((error) => {
  query('hint').textContent = '기록을 불러오지 못했습니다: ' + error.message;
});

setInterval(() => {
  refresh().catch(() => {});
}, 1500);
