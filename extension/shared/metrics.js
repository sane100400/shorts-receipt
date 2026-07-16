(() => {
  const DAY_PREFIX = 'scrollReceipt:v2:day:';
  const SETTINGS_KEY = 'scrollReceipt:v2:settings';
  const MIN_VALID_WATCH_MS = 300;

  function dayId(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function timezone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul';
  }

  function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function formatDuration(milliseconds) {
    const seconds = Math.max(0, Math.floor(safeNumber(milliseconds) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      return `${hours}시간 ${String(minutes % 60).padStart(2, '0')}분`;
    }
    return `${minutes}분 ${String(remainder).padStart(2, '0')}초`;
  }

  function formatShortDuration(milliseconds) {
    const seconds = Math.max(0, Math.floor(safeNumber(milliseconds) / 1000));
    if (seconds < 60) return `${seconds}초`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}분 ${String(seconds % 60).padStart(2, '0')}초`;
  }

  function createDayBucket(id = dayId()) {
    const now = new Date().toISOString();
    return {
      schema_version: '2.0',
      day_id: id,
      timezone: timezone(),
      consent: true,
      started_at: now,
      updated_at: now,
      sessions: [],
      impressions: [],
      reports: []
    };
  }

  function isValidImpression(impression) {
    return Boolean(
      impression &&
      impression.video_id &&
      safeNumber(impression.watched_ms) >= MIN_VALID_WATCH_MS
    );
  }

  function viewKey(impression) {
    return impression?.view_id || impression?.impression_id || null;
  }

  function validViewImpressions(day) {
    const impressions = Array.isArray(day?.impressions)
      ? day.impressions.filter((item) => item?.video_id && viewKey(item))
      : [];
    const watchedByView = new Map();
    for (const impression of impressions) {
      const key = viewKey(impression);
      watchedByView.set(key, (watchedByView.get(key) || 0) + safeNumber(impression.watched_ms));
    }
    const validViews = new Set(
      [...watchedByView]
        .filter(([, watchedMs]) => watchedMs >= MIN_VALID_WATCH_MS)
        .map(([key]) => key)
    );
    return impressions.filter((item) => validViews.has(viewKey(item)));
  }

  function isFastSkip(impression) {
    if (impression?.was_completed) return false;
    if (impression?.end_reason && impression.end_reason !== 'video-change') return false;
    if (impression?.is_fast_skip === true) return true;
    if (!impression?.ended_at) return false;
    const exitPosition = safeNumber(impression?.first_exit_position_ms, Number.MAX_SAFE_INTEGER);
    const watched = safeNumber(impression?.watched_ms, Number.MAX_SAFE_INTEGER);
    return exitPosition <= 1000 || watched <= 1000;
  }

  function summarizeSessions(impressions) {
    const sessions = new Map();
    for (const impression of impressions) {
      const key = impression.session_id || 'unknown-session';
      const existing = sessions.get(key) || {
        session_id: key,
        active_watch_ms: 0,
        started_at: impression.started_at || null,
        ended_at: impression.ended_at || impression.started_at || null
      };
      existing.active_watch_ms += safeNumber(impression.watched_ms);
      if (impression.started_at && (!existing.started_at || impression.started_at < existing.started_at)) {
        existing.started_at = impression.started_at;
      }
      const end = impression.ended_at || impression.started_at;
      if (end && (!existing.ended_at || end > existing.ended_at)) existing.ended_at = end;
      sessions.set(key, existing);
    }
    return [...sessions.values()].sort((a, b) => b.active_watch_ms - a.active_watch_ms);
  }

  function summarizeViews(impressions) {
    const views = new Map();
    for (const impression of impressions) {
      const key = viewKey(impression);
      const existing = views.get(key) || {
        view_id: key,
        duration_known: false,
        was_completed: false,
        is_fast_skip: false
      };
      existing.duration_known ||= safeNumber(impression.duration_ms) > 0;
      existing.was_completed ||= Boolean(impression.was_completed);
      existing.is_fast_skip ||= isFastSkip(impression);
      views.set(key, existing);
    }
    return [...views.values()];
  }

  function buildSummary(day) {
    const impressions = validViewImpressions(day);
    const views = summarizeViews(impressions);
    const active_watch_ms = impressions.reduce((sum, item) => sum + safeNumber(item.watched_ms), 0);
    const muted_watch_ms = impressions.reduce((sum, item) => sum + safeNumber(item.muted_watch_ms), 0);
    const sessions = summarizeSessions(impressions);
    const durationKnown = views.filter((item) => item.duration_known);
    const completion_count = views.filter((item) => item.was_completed).length;
    const fast_skip_count = views.filter((item) => item.is_fast_skip).length;
    const replay_count = impressions.reduce((sum, item) => sum + safeNumber(item.replay_count), 0);

    return {
      daily_view_count: views.length,
      active_watch_ms,
      longest_session_ms: sessions[0]?.active_watch_ms || 0,
      fast_skip_count,
      fast_skip_rate: views.length ? fast_skip_count / views.length : null,
      completion_count,
      completion_rate: durationKnown.length ? completion_count / durationKnown.length : null,
      replay_count,
      muted_watch_ms,
      mute_rate: active_watch_ms >= 10000 ? muted_watch_ms / active_watch_ms : null,
      sessions
    };
  }

  function groupByVideo(day) {
    const groups = new Map();
    const impressions = validViewImpressions(day);
    for (const impression of impressions) {
      const existing = groups.get(impression.video_id) || {
        video_id: impression.video_id,
        url: impression.url || `https://www.youtube.com/shorts/${impression.video_id}`,
        title: impression.title || '제목을 불러오지 못한 쇼츠',
        channel: impression.channel || '채널 정보 없음',
        impression_count: 0,
        active_watch_ms: 0,
        duration_ms: 0,
        max_position_ms: 0,
        min_exit_position_ms: Number.MAX_SAFE_INTEGER,
        fast_skip_count: 0,
        was_completed: false,
        replay_count: 0,
        muted_watch_ms: 0,
        last_seen_at: impression.ended_at || impression.started_at || '',
        view_ids: new Set(),
        fast_skip_view_ids: new Set()
      };
      const logicalViewId = viewKey(impression);
      if (!existing.view_ids.has(logicalViewId)) {
        existing.view_ids.add(logicalViewId);
        existing.impression_count += 1;
      }
      existing.active_watch_ms += safeNumber(impression.watched_ms);
      existing.duration_ms = Math.max(existing.duration_ms, safeNumber(impression.duration_ms));
      existing.max_position_ms = Math.max(existing.max_position_ms, safeNumber(impression.max_position_ms));
      existing.min_exit_position_ms = Math.min(
        existing.min_exit_position_ms,
        safeNumber(impression.first_exit_position_ms, Number.MAX_SAFE_INTEGER)
      );
      if (isFastSkip(impression) && !existing.fast_skip_view_ids.has(logicalViewId)) {
        existing.fast_skip_view_ids.add(logicalViewId);
        existing.fast_skip_count += 1;
      }
      existing.was_completed ||= Boolean(impression.was_completed);
      existing.replay_count += safeNumber(impression.replay_count);
      existing.muted_watch_ms += safeNumber(impression.muted_watch_ms);
      if ((impression.ended_at || impression.started_at || '') > existing.last_seen_at) {
        existing.last_seen_at = impression.ended_at || impression.started_at || '';
        existing.url = impression.url || existing.url;
        existing.title = impression.title || existing.title;
        existing.channel = impression.channel || existing.channel;
      }
      groups.set(impression.video_id, existing);
    }
    return [...groups.values()].map(({ view_ids, fast_skip_view_ids, ...item }) => ({
      ...item,
      min_exit_position_ms: item.min_exit_position_ms === Number.MAX_SAFE_INTEGER
        ? null
        : item.min_exit_position_ms
    }));
  }

  function selectCandidates(day, max = 6) {
    const groups = groupByVideo(day);
    if (groups.length <= max) {
      return groups
        .sort((a, b) => (a.last_seen_at < b.last_seen_at ? -1 : 1))
        .map((item) => ({ ...item, selection_reason: 'all_valid_videos' }));
    }

    const byAttention = [...groups].sort((a, b) =>
      b.active_watch_ms - a.active_watch_ms ||
      b.replay_count - a.replay_count ||
      a.video_id.localeCompare(b.video_id)
    );
    const selected = byAttention.slice(0, Math.max(1, max - 1))
      .map((item) => ({ ...item, selection_reason: 'top_attention' }));
    const selectedIds = new Set(selected.map((item) => item.video_id));
    const contrast = [...groups]
      .filter((item) => !selectedIds.has(item.video_id))
      .filter((item) => item.fast_skip_count > 0)
      .sort((a, b) =>
        (a.min_exit_position_ms ?? Number.MAX_SAFE_INTEGER) -
        (b.min_exit_position_ms ?? Number.MAX_SAFE_INTEGER)
      )[0];

    if (contrast) {
      selected.push({ ...contrast, selection_reason: 'fast_skip_contrast' });
    } else {
      const fallback = byAttention.find((item) => !selectedIds.has(item.video_id));
      if (fallback) selected.push({ ...fallback, selection_reason: 'attention_backfill' });
    }
    return selected.slice(0, max);
  }

  function chooseTitle(summary, analysis = null) {
    if (summary.daily_view_count >= 200) return '스크롤 헤비급';
    if (summary.daily_view_count >= 100) return '백쇼츠 클럽';
    if (summary.active_watch_ms >= 60 * 60 * 1000) return '한 시간 순삭러';
    if (summary.active_watch_ms >= 30 * 60 * 1000) return '엄지 풀가동';
    if (analysis?.payoff_recovery_rate >= 0.8 && analysis.payoff_count >= 2) return '결말 수집가';
    if (summary.fast_skip_rate >= 0.6 && summary.fast_skip_count >= 10) return '0.8초 감별사';
    if (summary.replay_count >= 3) return '다시보기 집행관';
    if (analysis?.top_genre_share >= 0.65 && analysis?.success_count >= 3) return '장르 외길';
    if (analysis?.genre_count >= 5) return '밈 뷔페 정복자';
    return '오늘도 스크롤러';
  }

  function chooseBadges(summary, analysis = null) {
    const badges = [];
    if (summary.daily_view_count >= 100) badges.push('세 자릿수 입장');
    else if (summary.daily_view_count >= 50) badges.push('50개 돌파');
    if (summary.fast_skip_count >= 20) badges.push('번개 손절');
    if (summary.completion_count >= 10) badges.push('결말 회수반');
    if (summary.replay_count >= 3) badges.push('원점 회귀');
    if (summary.mute_rate !== null && summary.mute_rate >= 0.9) badges.push('무음 생존자');
    if (summary.longest_session_ms >= 20 * 60 * 1000) badges.push('스크롤 마라톤');
    if (analysis?.part2_fast_skips >= 2) badges.push('Part 2 면역');
    return badges.slice(0, 3);
  }

  function buildBehaviorOnlyReceipt(day) {
    const summary = buildSummary(day);
    const candidates = selectCandidates(day);
    const coverage = summary.active_watch_ms
      ? candidates.reduce((sum, item) => sum + item.active_watch_ms, 0) / summary.active_watch_ms
      : 0;
    return {
      request_id: `local-${Date.now()}`,
      status: 'behavior_only',
      metrics: summary,
      analysis: {
        requested_count: candidates.length,
        success_count: 0,
        coverage,
        top_genre: null,
        top_genre_share: null,
        genre_attention: [],
        format_counts: {}
      },
      title: chooseTitle(summary),
      badges: chooseBadges(summary),
      fact_sentence: `오늘 쇼츠 ${summary.daily_view_count}개, 다 합쳐 ${formatDuration(summary.active_watch_ms)} 봤어요.`,
      punchline: '오늘 기록은 이만큼.',
      evidence: candidates.slice(0, 3).map((item) => ({
        video_id: item.video_id,
        title: item.title,
        channel: item.channel,
        watched_ms: item.active_watch_ms,
        statement: `${formatShortDuration(item.active_watch_ms)} 봤어요.`
      })),
      limitations: [
        '확장 프로그램을 설치한 뒤 브라우저에서 센 기록입니다.',
        'Gemini 분석 없이 시청 기록만 넣었습니다.'
      ]
    };
  }

  globalThis.ScrollReceiptMetrics = {
    DAY_PREFIX,
    SETTINGS_KEY,
    MIN_VALID_WATCH_MS,
    dayId,
    timezone,
    safeNumber,
    formatDuration,
    formatShortDuration,
    createDayBucket,
    isValidImpression,
    isFastSkip,
    buildSummary,
    groupByVideo,
    selectCandidates,
    chooseTitle,
    chooseBadges,
    buildBehaviorOnlyReceipt
  };
})();
