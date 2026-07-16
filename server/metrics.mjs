const GENRE_LABELS = {
  story: '썰·사연',
  meme_comedy: '밈·코미디',
  idol_music_dance: '아이돌·댄스',
  gaming: '게임',
  food: '먹방·요리',
  animal: '동물',
  information_tip: '꿀팁·정보',
  study_productivity: '공부·생산성',
  sports: '스포츠',
  beauty_fashion: '뷰티·패션',
  daily_vlog: '일상·브이로그',
  entertainment_edit: '예능 편집',
  ai_generated_story: 'AI 스토리',
  other: '기타'
};

const FEATURE_LABELS = {
  large_center_captions: '큰 중앙 자막',
  tts_voice: 'TTS',
  split_screen: '분할 화면',
  list_countdown: '랭킹 카운트다운',
  red_arrow_or_circle: '강조 원·화살표',
  cliffhanger_or_part2: 'Part 2',
  rapid_cut: '빠른 컷',
  loop_edit: '루프 편집',
  ai_generated_visuals: 'AI 시각물'
};

export function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(safeNumber(milliseconds) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) {
    return String(Math.floor(minutes / 60)) + '시간 ' + String(minutes % 60).padStart(2, '0') + '분';
  }
  return String(minutes) + '분 ' + String(seconds % 60).padStart(2, '0') + '초';
}

export function buildBehaviorMetrics(summary) {
  const daily_view_count = Math.floor(safeNumber(summary?.daily_view_count));
  const active_watch_ms = safeNumber(summary?.active_watch_ms);
  const longest_session_ms = safeNumber(summary?.longest_session_ms);
  const fast_skip_count = Math.min(daily_view_count, Math.floor(safeNumber(summary?.fast_skip_count)));
  const completion_count = Math.min(daily_view_count, Math.floor(safeNumber(summary?.completion_count)));
  const replay_count = Math.floor(safeNumber(summary?.replay_count));
  const muted_watch_ms = Math.min(active_watch_ms, safeNumber(summary?.muted_watch_ms));
  return {
    daily_view_count,
    active_watch_ms,
    longest_session_ms,
    fast_skip_count,
    fast_skip_rate: daily_view_count ? fast_skip_count / daily_view_count : null,
    completion_count,
    completion_rate: daily_view_count ? completion_count / daily_view_count : null,
    replay_count,
    muted_watch_ms,
    mute_rate: active_watch_ms >= 10000 ? muted_watch_ms / active_watch_ms : null
  };
}

export function buildContentAnalysis(candidates, analyses, totalActiveWatchMs) {
  const byVideo = new Map(analyses.map((analysis) => [analysis.video_id, analysis]));
  const genreTotals = new Map();
  const formatCounts = {};
  let analyzedWatchMs = 0;
  let success_count = 0;
  let payoffCount = 0;
  let payoffRecovered = 0;
  let part2FastSkips = 0;

  for (const candidate of candidates) {
    const analysis = byVideo.get(candidate.video_id);
    if (!analysis || analysis.analysis_status !== 'success' || safeNumber(analysis.confidence) < 0.6) continue;
    const watchMs = safeNumber(candidate.behavior?.active_watch_ms);
    analyzedWatchMs += watchMs;
    success_count += 1;
    const genre = analysis.primary_genre || 'other';
    genreTotals.set(genre, (genreTotals.get(genre) || 0) + watchMs);
    for (const [feature, enabled] of Object.entries(analysis.features || {})) {
      if (enabled) formatCounts[feature] = (formatCounts[feature] || 0) + 1;
    }
    const payoff = analysis.payoff_timestamp_sec;
    if (analysis.analysis_source === 'url_context' && Number.isFinite(payoff) && safeNumber(analysis.confidence) >= 0.7) {
      payoffCount += 1;
      if (safeNumber(candidate.behavior?.max_position_ms) >= payoff * 1000) payoffRecovered += 1;
    }
    if (analysis.features?.cliffhanger_or_part2 && safeNumber(candidate.behavior?.fast_skip_count) > 0) {
      part2FastSkips += 1;
    }
  }

  const genre_attention = [...genreTotals.entries()]
    .map(([genre, watchMs]) => ({
      genre,
      label: GENRE_LABELS[genre] || GENRE_LABELS.other,
      share: analyzedWatchMs ? watchMs / analyzedWatchMs : 0,
      watch_ms: watchMs
    }))
    .sort((a, b) => b.watch_ms - a.watch_ms);
  const top = genre_attention[0] || null;

  return {
    requested_count: candidates.length,
    success_count,
    coverage: totalActiveWatchMs ? analyzedWatchMs / totalActiveWatchMs : 0,
    top_genre: top?.genre || null,
    top_genre_label: top?.label || null,
    top_genre_share: top?.share || null,
    genre_attention,
    genre_count: genre_attention.length,
    format_counts: formatCounts,
    formatted_features: Object.entries(formatCounts)
      .filter(([, count]) => count >= 2)
      .map(([feature, count]) => ({ feature, label: FEATURE_LABELS[feature] || feature, count }))
      .sort((a, b) => b.count - a.count),
    payoff_count: payoffCount,
    payoff_recovery_rate: payoffCount >= 2 ? payoffRecovered / payoffCount : null,
    part2_fast_skips: part2FastSkips
  };
}

export function chooseTitle(metrics, analysis) {
  if (metrics.daily_view_count >= 200) return '스크롤 헤비급';
  if (metrics.daily_view_count >= 100) return '백쇼츠 클럽';
  if (metrics.active_watch_ms >= 60 * 60 * 1000) return '한 시간 순삭러';
  if (metrics.active_watch_ms >= 30 * 60 * 1000) return '엄지 풀가동';
  if (analysis.payoff_recovery_rate !== null && analysis.payoff_recovery_rate >= 0.8 && analysis.payoff_count >= 2) return '결말 수집가';
  if (metrics.fast_skip_rate !== null && metrics.fast_skip_rate >= 0.6 && metrics.fast_skip_count >= 10) return '0.8초 감별사';
  if (metrics.replay_count >= 3) return '다시보기 집행관';
  if (analysis.top_genre_share !== null && analysis.top_genre_share >= 0.65 && analysis.success_count >= 3) return '장르 외길';
  if (analysis.genre_count >= 5) return '밈 뷔페 정복자';
  return '오늘도 스크롤러';
}

export function chooseBadges(metrics, analysis) {
  const badges = [];
  if (metrics.daily_view_count >= 100) badges.push('세 자릿수 입장');
  else if (metrics.daily_view_count >= 50) badges.push('50개 돌파');
  if (metrics.fast_skip_count >= 20) badges.push('번개 손절');
  if (metrics.completion_count >= 10) badges.push('결말 회수반');
  if (metrics.replay_count >= 3) badges.push('원점 회귀');
  if (metrics.mute_rate !== null && metrics.mute_rate >= 0.9) badges.push('무음 생존자');
  if (metrics.longest_session_ms >= 20 * 60 * 1000) badges.push('스크롤 마라톤');
  if (analysis.part2_fast_skips >= 2) badges.push('Part 2 면역');
  return badges.slice(0, 3);
}

export function buildFacts(candidates, analyses, metrics, analysis) {
  const byVideo = new Map(analyses.map((item) => [item.video_id, item]));
  const evidence = candidates
    .map((candidate) => {
      const item = byVideo.get(candidate.video_id);
      if (!item || item.analysis_status !== 'success') return null;
      const watched = safeNumber(candidate.behavior?.active_watch_ms);
      return {
        video_id: candidate.video_id,
        title: candidate.title,
        channel: candidate.channel,
        watched_ms: watched,
        genre: item.primary_genre,
        genre_label: GENRE_LABELS[item.primary_genre] || GENRE_LABELS.other,
        statement: candidate.behavior?.was_completed
          ? '끝까지 봤어요.'
          : String(Math.max(1, Math.round(watched / 1000))) + '초 봤어요.'
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.watched_ms - a.watched_ms)
    .slice(0, 3);

  const fact_sentence = analysis.top_genre_label
    ? '오늘 본 대표 쇼츠 ' + analysis.success_count + '개 중에서는 ' +
      analysis.top_genre_label + ' 영상을 제일 오래 봤어요.'
    : '오늘 쇼츠 ' + metrics.daily_view_count + '개, 다 합쳐 ' +
      formatDuration(metrics.active_watch_ms) + ' 봤어요.';
  return { fact_sentence, evidence };
}

export { GENRE_LABELS, FEATURE_LABELS };
