const metrics = globalThis.ScrollReceiptMetrics;
const API_URL = String(globalThis.SCROLL_RECEIPT_API_URL || 'http://localhost:8080').replace(/\/$/, '');
const DEMO_MODE = new URLSearchParams(location.search).has('demo');
const AUTO_ANALYZE = new URLSearchParams(location.search).has('auto');

let day;
let summary;
let candidates;
let receipt;

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function percent(value) {
  return Number.isFinite(value) ? Math.round(value * 100) + '%' : '-';
}

function dayLabel(dayId) {
  const parts = String(dayId || '').split('-');
  return parts.length === 3 ? parts.join('.') : dayId;
}

function showState(id) {
  ['loading-state', 'empty-state', 'checkout-state', 'analysis-state', 'receipt-state']
    .forEach((stateId) => byId(stateId).classList.toggle('is-hidden', stateId !== id));
}

function message(payload) {
  return chrome.runtime.sendMessage(payload);
}

function demoDay() {
  const base = new Date().toISOString();
  const rows = [
    ['demo0001', '고양이의 반응', '동물 채널', 800, 9000, false, 1],
    ['demo0002', '회사에서 벌어진 일', '썰 채널', 12400, 18000, true, 0],
    ['demo0003', '오늘의 랭킹', '랭킹 채널', 3600, 15000, false, 0],
    ['demo0004', '야식 레시피', '요리 채널', 5200, 18000, false, 0],
    ['demo0005', '퇴사 전 마지막 점심', '직장인 채널', 16000, 18000, true, 0],
    ['demo0006', '계속 보게 되는 편집', '편집 채널', 9000, 12000, false, 0]
  ];
  return {
    day_id: metrics.dayId(),
    timezone: metrics.timezone(),
    impressions: rows.map((row, index) => ({
      impression_id: 'demo-impression-' + index,
      session_id: 'demo-session',
      video_id: row[0],
      url: 'https://www.youtube.com/shorts/' + row[0],
      title: row[1],
      channel: row[2],
      started_at: base,
      ended_at: base,
      watched_ms: row[3],
      duration_ms: row[4],
      max_position_ms: row[3],
      first_exit_position_ms: row[3],
      was_completed: row[5],
      replay_count: index === 5 ? 1 : 0,
      muted_watch_ms: 0,
      is_fast_skip: Boolean(row[6])
    }))
  };
}

function demoReceipt() {
  const demoMetrics = {
    daily_view_count: 50,
    active_watch_ms: 2778000,
    longest_session_ms: 1024000,
    fast_skip_count: 31,
    completion_count: 12,
    replay_count: 3,
    muted_watch_ms: 0,
    mute_rate: 0
  };
  return {
    status: 'success',
    metrics: demoMetrics,
    analysis: {
      success_count: 6,
      coverage: 0.68,
      top_genre_label: '썰·사연',
      top_genre_share: 0.42,
      genre_attention: [
        { genre: 'story', label: '썰·사연', share: 0.42 },
        { genre: 'entertainment_edit', label: '예능 편집', share: 0.24 },
        { genre: 'food', label: '먹방·요리', share: 0.16 }
      ],
      formatted_features: [
        { label: '큰 중앙 자막', count: 5 },
        { label: 'TTS', count: 4 },
        { label: 'Part 2', count: 2 }
      ]
    },
    title: '0.8초 감별사',
    badges: ['50개 돌파', '번개 손절', '원점 회귀'],
    fact_sentence: '오늘 본 대표 쇼츠 6개 중에서는 썰·사연 영상을 제일 오래 봤어요.',
    punchline: '오늘의 주인공은 고양이가 아니라 남의 퇴사였습니다.',
    evidence: [
      { title: '퇴사 전 마지막 점심', watched_ms: 16000, statement: '끝까지 봤어요.' },
      { title: '회사에서 벌어진 일', watched_ms: 12400, statement: '끝까지 봤어요.' },
      { title: '계속 보게 되는 편집', watched_ms: 9000, statement: '9초 봤어요.' }
    ],
    limitations: ['DEMO 미리보기입니다. 실제 확장 프로그램 기록이 아닙니다.']
  };
}

function renderCheckout() {
  byId('checkout-stats').innerHTML = [
    '<div><dt>오늘 본 쇼츠</dt><dd>' + summary.daily_view_count.toLocaleString('ko-KR') + '개</dd></div>',
    '<div><dt>총 활성 시청</dt><dd>' + metrics.formatShortDuration(summary.active_watch_ms) + '</dd></div>',
    '<div><dt>1초 컷</dt><dd>' + summary.fast_skip_count + '회</dd></div>'
  ].join('');

  byId('candidate-items').innerHTML = candidates.map((candidate, index) => [
    '<li>',
    '<span class="candidate-index">0' + (index + 1) + '</span>',
    '<div>',
    '<div class="candidate-title">' + escapeHtml(candidate.title) + '</div>',
    '<div class="candidate-meta">' +
      escapeHtml(candidate.channel || '채널 정보 없음') + ' · ' +
      metrics.formatShortDuration(candidate.active_watch_ms) + ' 시청</div>',
    '</div>',
    '</li>'
  ].join('')).join('');

  const coverage = summary.active_watch_ms
    ? candidates.reduce((total, candidate) => total + candidate.active_watch_ms, 0) / summary.active_watch_ms
    : 0;
  byId('checkout-note').textContent =
    '대표 ' + candidates.length + '개가 오늘 시청 시간의 ' +
    Math.round(coverage * 100) + '%를 차지해요.';
}

function payloadForCheckout() {
  return {
    schema_version: '2.0',
    day: {
      day_id: day.day_id,
      timezone: day.timezone
    },
    behavior_summary: {
      daily_view_count: summary.daily_view_count,
      active_watch_ms: summary.active_watch_ms,
      longest_session_ms: summary.longest_session_ms,
      fast_skip_count: summary.fast_skip_count,
      completion_count: summary.completion_count,
      replay_count: summary.replay_count,
      muted_watch_ms: summary.muted_watch_ms
    },
    analysis_candidates: candidates.map((candidate) => ({
      video_id: candidate.video_id,
      url: candidate.url,
      title: candidate.title,
      channel: candidate.channel,
      selection_reason: candidate.selection_reason,
      behavior: {
        impression_count: candidate.impression_count,
        active_watch_ms: candidate.active_watch_ms,
        duration_ms: candidate.duration_ms,
        max_position_ms: candidate.max_position_ms,
        min_exit_position_ms: candidate.min_exit_position_ms,
        fast_skip_count: candidate.fast_skip_count,
        was_completed: candidate.was_completed,
        replay_count: candidate.replay_count,
        muted_watch_ms: candidate.muted_watch_ms
      }
    }))
  };
}

async function startAnalysis() {
  const analysisButton = byId('start-analysis');
  analysisButton.disabled = true;
  analysisButton.textContent = '영수증 인쇄 중…';
  showState('analysis-state');
  try {
    const response = await fetch(API_URL + '/v1/daily-receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadForCheckout())
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '정산 요청에 실패했습니다.');
    receipt = payload;
  } catch (error) {
    receipt = metrics.buildBehaviorOnlyReceipt(day);
  }
  renderReceipt();
  showState('receipt-state');
  analysisButton.disabled = false;
  analysisButton.textContent = '쇼츠 정산하기';
}

function renderGenreRanks(items) {
  byId('genre-bars').innerHTML = items.slice(0, 3).map((item, index) => [
    '<div class="genre-rank genre-rank-' + (index + 1) + '">',
    '<span class="genre-order">' + (index + 1) + '위</span>',
    '<strong>' + percent(item.share) + '</strong>',
    '<span class="genre-name">' + escapeHtml(item.label || item.genre) + '</span>',
    '</div>'
  ].join('')).join('');
}

function renderEvidence(items) {
  byId('evidence-list').innerHTML = items.length
    ? items.map((item, index) => [
      '<li>',
      '<span class="evidence-index">0' + (index + 1) + '</span>',
      '<span class="evidence-copy"><strong>' + escapeHtml(item.title || '대표 쇼츠') + '</strong>',
      '<span>' + escapeHtml(item.statement || '') + '</span></span>',
      '<span class="evidence-time">' + metrics.formatShortDuration(item.watched_ms) + '</span>',
      '</li>'
    ].join('')).join('')
    : '<li class="evidence-empty"><span class="evidence-copy"><strong>대표 영상을 분석하지 못했어요.</strong></span></li>';
}

function renderShareCard() {
  const analysis = receipt.analysis || {};
  const badges = receipt.badges || [];
  const genre = analysis.top_genre_label
    ? '<p class="share-genre">오늘의 최애 장르<strong>' +
      escapeHtml(analysis.top_genre_label + ' ' + percent(analysis.top_genre_share)) + '</strong></p>'
    : '';
  byId('share-card').innerHTML = [
    '<span class="share-tape" aria-hidden="true"></span>',
    '<p class="share-kicker">오늘의 쇼츠 영수증</p>',
    '<p class="share-date">' + escapeHtml(dayLabel(day.day_id)) + '</p>',
    '<p class="share-title">' + escapeHtml(receipt.title) + '</p>',
    '<p class="share-count">' + receipt.metrics.daily_view_count.toLocaleString('ko-KR') + '</p>',
    '<p class="share-label">오늘 본 쇼츠</p>',
    '<div class="share-rule"></div>',
    '<div class="share-mini"><span>총 활성 시청</span><span>' + escapeHtml(metrics.formatShortDuration(receipt.metrics.active_watch_ms)) + '</span></div>',
    '<div class="share-mini"><span>최장 연속 시청</span><span>' + escapeHtml(metrics.formatShortDuration(receipt.metrics.longest_session_ms)) + '</span></div>',
    '<div class="share-mini"><span>1초 컷</span><span>' + receipt.metrics.fast_skip_count + '회</span></div>',
    '<div class="share-mini"><span>끝까지 본 쇼츠</span><span>' + receipt.metrics.completion_count + '개</span></div>',
    '<div class="share-mini"><span>다시 본 횟수</span><span>' + receipt.metrics.replay_count + '회</span></div>',
    genre,
    '<p class="share-punchline">' + escapeHtml(receipt.punchline) + '</p>',
    '<div class="share-badges">' + badges.map((badge) => '<span class="badge">#' + escapeHtml(badge) + '</span>').join('') + '</div>',
    '<p class="share-cta">너 오늘 몇 개 봄?</p>'
  ].join('');
}

function renderReceipt() {
  const resultMetrics = receipt.metrics;
  const analysis = receipt.analysis || {};

  byId('receipt-date').textContent = dayLabel(day.day_id);
  byId('receipt-title').textContent = receipt.title;
  byId('receipt-view-count').textContent = resultMetrics.daily_view_count.toLocaleString('ko-KR');
  byId('receipt-active-watch').textContent = metrics.formatDuration(resultMetrics.active_watch_ms);
  byId('receipt-longest-session').textContent = metrics.formatDuration(resultMetrics.longest_session_ms);
  byId('receipt-fast-skip').textContent = resultMetrics.fast_skip_count + '회';
  byId('receipt-completion').textContent = resultMetrics.completion_count + '개';
  byId('receipt-replay').textContent = resultMetrics.replay_count + '회';
  byId('fact-sentence').textContent = receipt.fact_sentence;
  byId('punchline').textContent = '“' + receipt.punchline + '”';

  const hasGenres = Array.isArray(analysis.genre_attention) && analysis.genre_attention.length;
  byId('taste-section').classList.toggle('is-hidden', !hasGenres);
  if (hasGenres) {
    byId('top-genre').textContent = analysis.top_genre_label || '기타';
    renderGenreRanks(analysis.genre_attention);
  }

  const features = analysis.formatted_features || [];
  byId('feature-section').classList.toggle('is-hidden', !features.length);
  byId('feature-list').innerHTML = features.map((feature) =>
    '<li><span>' + escapeHtml(feature.label) + '</span><strong>' + feature.count + '개</strong></li>'
  ).join('');

  renderEvidence(receipt.evidence || []);
  renderShareCard();

  const hasGemini = receipt.status !== 'behavior_only';
  byId('regenerate-punchline').classList.toggle('is-hidden', !hasGemini);
}

function drawText(ctx, text, x, y, maxWidth, lineHeight) {
  const chars = [...String(text)];
  let line = '';
  let currentY = y;
  for (const char of chars) {
    const candidate = line + char;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      ctx.fillText(line, x, currentY);
      currentY += lineHeight;
      line = char;
    } else {
      line = candidate;
    }
  }
  if (line) ctx.fillText(line, x, currentY);
  return currentY;
}

function drawSparkle(ctx, x, y, size, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(size * .18, -size * .18);
  ctx.lineTo(size, 0);
  ctx.lineTo(size * .18, size * .18);
  ctx.lineTo(0, size);
  ctx.lineTo(-size * .18, size * .18);
  ctx.lineTo(-size, 0);
  ctx.lineTo(-size * .18, -size * .18);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawWashiTape(ctx, x, y, width, height) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-2 * Math.PI / 180);
  ctx.fillStyle = 'rgba(232, 240, 254, .7)';
  ctx.fillRect(-width / 2, -height / 2, width, height);
  ctx.strokeStyle = 'rgba(26, 115, 232, .16)';
  ctx.lineWidth = 2;
  for (let lineX = -width / 2 + 18; lineX < width / 2; lineX += 22) {
    ctx.beginPath();
    ctx.moveTo(lineX, -height / 2);
    ctx.lineTo(lineX, height / 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(-width / 2, 0);
  ctx.lineTo(width / 2, 0);
  ctx.stroke();
  ctx.restore();
}

function drawPawPrint(ctx, x, y, size, color) {
  ctx.save();
  ctx.fillStyle = color;
  // Large main pad bean
  ctx.beginPath();
  ctx.ellipse(x, y + size * 0.25, size * 0.45, size * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();
  
  // 4 toe beans
  ctx.beginPath();
  ctx.arc(x - size * 0.45, y - size * 0.15, size * 0.15, 0, Math.PI * 2); // left toe
  ctx.arc(x - size * 0.18, y - size * 0.42, size * 0.16, 0, Math.PI * 2); // mid-left toe
  ctx.arc(x + size * 0.18, y - size * 0.42, size * 0.16, 0, Math.PI * 2); // mid-right toe
  ctx.arc(x + size * 0.45, y - size * 0.15, size * 0.15, 0, Math.PI * 2); // right toe
  ctx.fill();
  ctx.restore();
}

function drawHeart(ctx, x, y, size, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y + size * 0.3);
  // Left curve
  ctx.bezierCurveTo(x - size * 0.5, y - size * 0.5, x - size, y - size * 0.1, x, y + size);
  // Right curve
  ctx.bezierCurveTo(x + size, y - size * 0.1, x + size * 0.5, y - size * 0.5, x, y + size * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}


async function createShareImageBlob() {
  await Promise.all([
    document.fonts.load('800 32px "Moneygraphy"'),
    document.fonts.load('400 64px "Moneygraphy"')
  ]);

  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1920;
  const ctx = canvas.getContext('2d');
  const resultMetrics = receipt.metrics;
  const analysis = receipt.analysis || {};
  const topGenre = analysis.top_genre_label
    ? analysis.top_genre_label + ' ' + percent(analysis.top_genre_share)
    : '';

  const paper = '#FFFFFF'; /* Clean Google white paper */
  const ink = '#202124'; /* Crisp Google black ink */
  const muted = '#5F6368'; /* Soft Google gray 600 */
  const rule = '#DADCE0'; /* Google gray 300 divider */
  const stamp = '#1A73E8'; /* Vibrant Google Blue */

  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#F1F3F4'; /* Google gray 100 soft background grid */
  ctx.lineWidth = 1;
  for (let gridY = 236; gridY < 1810; gridY += 64) {
    ctx.beginPath();
    ctx.moveTo(70, gridY);
    ctx.lineTo(1010, gridY);
    ctx.stroke();
  }
  ctx.strokeStyle = ink;
  ctx.lineWidth = 3;
  ctx.strokeRect(52, 52, 976, 1816);
  
  // Shift Y down slightly from 58 to 72 to prevent top clipping and look perfectly stuck
  drawWashiTape(ctx, 540, 72, 164, 34);

  ctx.fillStyle = ink;
  ctx.font = '800 32px "Moneygraphy", sans-serif'; /* Scaled from 31px to 32px */
  ctx.fillText('오늘의 쇼츠 영수증', 104, 132);
  
  // Adorable tiny paw print right next to the title
  drawPawPrint(ctx, 402, 120, 15, stamp);
  
  ctx.fillStyle = muted;
  ctx.font = '800 20px "Moneygraphy", sans-serif'; /* Scaled from 23px to 20px */
  ctx.fillText(dayLabel(day.day_id), 104, 174);

  ctx.save();
  ctx.translate(908, 142);
  ctx.rotate(10 * Math.PI / 180);
  ctx.strokeStyle = stamp;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, 56, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = stamp;
  ctx.font = '800 20px "Moneygraphy", sans-serif'; /* Scaled from 18px to 20px */
  ctx.textAlign = 'center';
  ctx.fillText('정산', 0, 7);
  ctx.restore();

  ctx.fillStyle = ink;
  ctx.font = '800 64px "Moneygraphy", sans-serif'; /* Scaled from 82px to 64px for a much sleeker look */
  drawText(ctx, receipt.title, 104, 312, 760, 92);
  drawSparkle(ctx, 928, 350, 18, stamp);
  drawSparkle(ctx, 963, 315, 8, stamp);

  ctx.strokeStyle = stamp;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(104, 425);
  ctx.lineTo(976, 425);
  ctx.stroke();

  ctx.fillStyle = ink;
  ctx.font = '800 180px "Moneygraphy", sans-serif'; /* Scaled from 300px to a much more elegant, professional 180px */
  ctx.fillText(String(resultMetrics.daily_view_count), 86, 700);
  ctx.fillStyle = muted;
  ctx.font = '400 32px "Moneygraphy", sans-serif'; /* Scaled from 31px to 32px */
  ctx.fillText('오늘 넘겨 본 쇼츠', 104, 750);

  ctx.strokeStyle = rule;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(104, 796);
  ctx.lineTo(976, 796);
  ctx.stroke();

  const rows = [
    ['총 활성 시청', metrics.formatShortDuration(resultMetrics.active_watch_ms)],
    ['최장 연속 시청', metrics.formatShortDuration(resultMetrics.longest_session_ms)],
    ['1초 컷', String(resultMetrics.fast_skip_count) + '회'],
    ['끝까지 본 쇼츠', String(resultMetrics.completion_count) + '개'],
    ['다시 본 횟수', String(resultMetrics.replay_count) + '회']
  ];
  rows.forEach((row, index) => {
    const y = 846 + index * 60;
    ctx.fillStyle = muted;
    ctx.font = '400 32px "Moneygraphy", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(row[0], 104, y);
    ctx.fillStyle = ink;
    ctx.font = '800 32px "Moneygraphy", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(row[1], 976, y);
    ctx.strokeStyle = rule;
    ctx.beginPath();
    ctx.moveTo(104, y + 24);
    ctx.lineTo(976, y + 24);
    ctx.stroke();
  });
  ctx.textAlign = 'left';

  if (topGenre) {
    ctx.fillStyle = muted;
    ctx.font = '800 20px "Moneygraphy", sans-serif';
    ctx.fillText('오늘의 최애 장르', 104, 1180);
    ctx.fillStyle = ink;
    ctx.font = '800 64px "Moneygraphy", sans-serif';
    drawText(ctx, topGenre, 104, 1245, 820, 72);
  }

  let badgeX = 104;
  let badgeY = topGenre ? 1370 : 1180;
  ctx.font = '800 20px "Moneygraphy", sans-serif';
  for (const badge of receipt.badges || []) {
    const label = '#' + badge;
    const width = ctx.measureText(label).width + 34;
    if (badgeX + width > 976) {
      badgeX = 104;
      badgeY += 62;
    }
    ctx.strokeStyle = stamp;
    ctx.lineWidth = 2;
    ctx.fillStyle = '#E8F0FE';
    ctx.fillRect(badgeX, badgeY - 34, width, 48);
    ctx.strokeRect(badgeX, badgeY - 34, width, 48);
    ctx.fillStyle = stamp;
    ctx.fillText(label, badgeX + 17, badgeY);
    badgeX += width + 12;
  }

  ctx.fillStyle = muted;
  ctx.font = '400 32px "Moneygraphy", sans-serif';
  drawText(ctx, receipt.punchline, 104, topGenre ? 1515 : 1340, 820, 50);

  const footerY = topGenre ? 1680 : 1490;
  ctx.fillStyle = ink;
  ctx.font = '400 64px "Moneygraphy", sans-serif';
  ctx.fillText('너 오늘 몇 개 봄?', 104, footerY);
  
  // High-fidelity cute decorations right next to the question!
  drawHeart(ctx, 615, footerY - 28, 13, stamp);
  drawPawPrint(ctx, 675, footerY - 18, 16, stamp);
  
  drawSparkle(ctx, 901, footerY - 25, 14, stamp);
  ctx.strokeStyle = rule;
  ctx.setLineDash([10, 10]);
  ctx.beginPath();
  ctx.moveTo(104, footerY + 62);
  ctx.lineTo(976, footerY + 62);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = rule; /* Clean Google Gray 300 jagged bottom tear line */
  ctx.lineWidth = 2;
  for (let x = 68; x < 1010; x += 16) {
    ctx.beginPath();
    ctx.moveTo(x, 1848);
    ctx.lineTo(x + 8, 1839);
    ctx.stroke();
  }

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('이미지를 만들지 못했습니다.');
  return blob;
}

async function exportPng() {
  const feedback = byId('share-feedback');
  feedback.textContent = '이미지를 만드는 중이에요.';
  const blob = await createShareImageBlob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'scroll-receipt-' + day.day_id + '.png';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  feedback.textContent = '이미지 저장을 시작했어요.';
}

function shareSummaryText() {
  return [
    '쇼츠 영수증 ' + dayLabel(day.day_id),
    receipt.title,
    '오늘 본 쇼츠 ' + receipt.metrics.daily_view_count.toLocaleString('ko-KR') + '개',
    '총 시청 ' + metrics.formatShortDuration(receipt.metrics.active_watch_ms),
    '너 오늘 몇 개 봄?'
  ].join('\n');
}

async function copyShareText() {
  await navigator.clipboard.writeText(shareSummaryText());
  byId('share-feedback').textContent = '공유할 내용을 복사했어요.';
}

async function shareWithSystem() {
  const feedback = byId('share-feedback');
  if (typeof navigator.share !== 'function') {
    feedback.textContent = '이 브라우저에서는 이미지 저장이나 내용 복사를 이용해 주세요.';
    return;
  }

  feedback.textContent = '공유 메뉴를 여는 중이에요.';
  const blob = await createShareImageBlob();
  const file = new File([blob], 'scroll-receipt-' + day.day_id + '.png', { type: 'image/png' });
  const data = {
    title: '오늘의 쇼츠 영수증',
    text: shareSummaryText()
  };
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    data.files = [file];
  }

  try {
    await navigator.share(data);
    feedback.textContent = '공유 메뉴를 열었어요.';
  } catch (error) {
    if (error?.name === 'AbortError') {
      feedback.textContent = '';
      return;
    }
    throw error;
  }
}

async function shareWithFriend() {
  if (typeof navigator.share === 'function') {
    await shareWithSystem();
    return;
  }
  await copyShareText();
  byId('share-feedback').textContent = '공유할 내용을 복사했어요. 친구에게 붙여넣어 보내세요.';
}

async function deleteToday() {
  if (!confirm('오늘 기록만 0으로 돌릴까요? 초기화한 뒤에도 기록은 계속됩니다.')) return;
  await message({ type: 'DELETE_DAY', dayId: day.day_id });
  location.reload();
}

async function init() {
  if (DEMO_MODE) {
    day = demoDay();
    summary = metrics.buildSummary(day);
    candidates = metrics.selectCandidates(day);
    receipt = demoReceipt();
    renderReceipt();
    showState('receipt-state');
    return;
  }
  day = await message({ type: 'GET_DAY', dayId: metrics.dayId() });
  summary = metrics.buildSummary(day);
  candidates = metrics.selectCandidates(day);
  if (summary.daily_view_count < 4) {
    byId('empty-copy').textContent = '지금 ' + summary.daily_view_count + '개예요. ' +
      Math.max(0, 4 - summary.daily_view_count) + '개만 더 보면 정산할 수 있어요.';
    showState('empty-state');
    return;
  }
  renderCheckout();
  if (AUTO_ANALYZE) {
    await startAnalysis();
  } else {
    showState('checkout-state');
  }
}

async function regeneratePunchline() {
  const button = byId('regenerate-punchline');
  button.disabled = true;
  button.classList.add('is-loading');
  const originalText = button.innerHTML;
  button.innerHTML = '<span class="regenerate-icon" aria-hidden="true">🔄</span> 다시 쓰는 중…';

  try {
    const response = await fetch(API_URL + '/v1/regenerate-punchline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fact_sentence: receipt.fact_sentence,
        title: receipt.title
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'AI 한 줄 평을 다시 쓰는 데 실패했습니다.');

    receipt.punchline = data.punchline;
    byId('punchline').textContent = '“' + receipt.punchline + '”';
    renderShareCard();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    button.classList.remove('is-loading');
    button.innerHTML = originalText;
  }
}

byId('start-analysis').addEventListener('click', startAnalysis);
byId('retry-analysis').addEventListener('click', () => {
  startAnalysis();
});
byId('regenerate-punchline').addEventListener('click', regeneratePunchline);
byId('export-png').addEventListener('click', () => {
  exportPng().catch((error) => {
    byId('share-feedback').textContent = '이미지를 만들지 못했습니다: ' + error.message;
  });
});
byId('friend-share').addEventListener('click', () => {
  shareWithFriend().catch((error) => {
    byId('share-feedback').textContent = '공유 메뉴를 열지 못했습니다: ' + error.message;
  });
});
byId('delete-day').addEventListener('click', deleteToday);

init().catch((error) => {
  byId('loading-state').innerHTML = '<p class="eyebrow">오류</p><h1>오늘 기록을 불러오지 못했습니다.</h1><p>' +
    escapeHtml(error.message) + '</p>';
  showState('loading-state');
});
