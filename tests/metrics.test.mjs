import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  buildBehaviorMetrics,
  buildContentAnalysis,
  buildFacts,
  chooseBadges,
  chooseTitle
} from '../server/metrics.mjs';

function clientMetrics() {
  const source = fs.readFileSync(new URL('../extension/shared/metrics.js', import.meta.url), 'utf8');
  const context = {
    globalThis: {},
    Intl,
    Date,
    Number,
    String,
    Boolean,
    Math,
    Map,
    Set,
    Array,
    Object
  };
  vm.runInNewContext(source, context);
  return context.globalThis.ScrollReceiptMetrics;
}

test('behavior metrics clamp invalid daily values and calculate rates', () => {
  const metrics = buildBehaviorMetrics({
    daily_view_count: 10,
    active_watch_ms: 60000,
    longest_session_ms: 42000,
    fast_skip_count: 12,
    completion_count: 3,
    replay_count: 2,
    muted_watch_ms: 80000
  });

  assert.equal(metrics.fast_skip_count, 10);
  assert.equal(metrics.fast_skip_rate, 1);
  assert.equal(metrics.muted_watch_ms, 60000);
  assert.equal(metrics.mute_rate, 1);
  assert.equal(metrics.completion_rate, 0.3);
});

test('content analysis joins Gemini labels to actual watched time', () => {
  const candidates = [
    {
      video_id: 'story0001',
      behavior: { active_watch_ms: 12000, max_position_ms: 10000, was_completed: true }
    },
    {
      video_id: 'animal01',
      behavior: { active_watch_ms: 2000, max_position_ms: 1000, fast_skip_count: 1 }
    }
  ];
  const analyses = [
    {
      video_id: 'story0001',
      analysis_status: 'success',
      analysis_source: 'url_context',
      primary_genre: 'story',
      confidence: 0.9,
      payoff_timestamp_sec: 9,
      features: { tts_voice: true, large_center_captions: true }
    },
    {
      video_id: 'animal01',
      analysis_status: 'success',
      analysis_source: 'url_context',
      primary_genre: 'animal',
      confidence: 0.9,
      payoff_timestamp_sec: null,
      features: { tts_voice: true, large_center_captions: false }
    }
  ];

  const analysis = buildContentAnalysis(candidates, analyses, 20000);
  assert.equal(analysis.success_count, 2);
  assert.equal(analysis.top_genre, 'story');
  assert.equal(analysis.top_genre_share, 12000 / 14000);
  assert.equal(analysis.coverage, 14000 / 20000);
  assert.equal(analysis.format_counts.tts_voice, 2);
  assert.equal(analysis.payoff_recovery_rate, null);
});

test('titles and badges are deterministic and do not need an audience percentile', () => {
  const metrics = buildBehaviorMetrics({
    daily_view_count: 50,
    active_watch_ms: 180000,
    longest_session_ms: 1210000,
    fast_skip_count: 35,
    completion_count: 5,
    replay_count: 0,
    muted_watch_ms: 0
  });
  const analysis = {
    payoff_recovery_rate: null,
    payoff_count: 0,
    top_genre_share: null,
    success_count: 0,
    genre_count: 0,
    part2_fast_skips: 0
  };

  assert.equal(chooseTitle(metrics, analysis), '0.8초 감별사');
  assert.deepEqual(chooseBadges(metrics, analysis), ['50개 돌파', '번개 손절', '스크롤 마라톤']);
});

test('facts never derive their number from Gemini text', () => {
  const metrics = buildBehaviorMetrics({
    daily_view_count: 6,
    active_watch_ms: 30000,
    longest_session_ms: 30000,
    fast_skip_count: 0,
    completion_count: 1,
    replay_count: 0,
    muted_watch_ms: 0
  });
  const facts = buildFacts(
    [{
      video_id: 'story0001',
      title: '직장인 썰',
      channel: '테스트',
      behavior: { active_watch_ms: 12000, was_completed: true }
    }],
    [{
      video_id: 'story0001',
      analysis_status: 'success',
      primary_genre: 'story'
    }],
    metrics,
    { top_genre_label: '썰·사연', success_count: 1 }
  );

  assert.match(facts.fact_sentence, /썰·사연/);
  assert.equal(facts.evidence[0].statement, '끝까지 봤어요.');
});

test('extension candidate selection keeps five high-attention videos and one skip contrast', () => {
  const client = clientMetrics();
  const impressions = Array.from({ length: 8 }, (_, index) => ({
    impression_id: 'impression-' + index,
    session_id: 'session-1',
    video_id: 'video000' + index,
    watched_ms: (index + 1) * 1000,
    duration_ms: 15000,
    max_position_ms: (index + 1) * 1000,
    first_exit_position_ms: index === 0 ? 400 : (index + 1) * 1000,
    is_fast_skip: index === 0,
    was_completed: false,
    replay_count: 0,
    muted_watch_ms: 0,
    title: '쇼츠 ' + index,
    channel: '테스트',
    url: 'https://www.youtube.com/shorts/video000' + index,
    started_at: '2026-07-16T00:00:00.000Z'
  }));
  const candidates = client.selectCandidates({ impressions });
  assert.equal(candidates.length, 6);
  assert.equal(candidates.at(-1).selection_reason, 'fast_skip_contrast');
  assert.equal(candidates.at(-1).video_id, 'video0000');
  assert.ok(candidates.some((item) => item.video_id === 'video0007'));
});

test('paused segments of the same visible Short count as one view', () => {
  const client = clientMetrics();
  const day = {
    impressions: [
      {
        impression_id: 'segment-before-pause',
        view_id: 'same-visible-view',
        session_id: 'session-before-pause',
        video_id: 'same-video',
        watched_ms: 200,
        duration_ms: 10000,
        muted_watch_ms: 0,
        replay_count: 0,
        ended_at: '2026-07-16T00:00:01.000Z',
        end_reason: 'paused',
        is_fast_skip: false
      },
      {
        impression_id: 'segment-after-resume',
        view_id: 'same-visible-view',
        session_id: 'session-after-resume',
        video_id: 'same-video',
        watched_ms: 250,
        duration_ms: 10000,
        muted_watch_ms: 0,
        replay_count: 0,
        ended_at: '2026-07-16T00:00:03.000Z',
        end_reason: 'video-change',
        is_fast_skip: true
      }
    ]
  };

  const summary = client.buildSummary(day);
  assert.equal(summary.daily_view_count, 1);
  assert.equal(summary.active_watch_ms, 450);
  assert.equal(summary.fast_skip_count, 1);
  assert.equal(summary.sessions.length, 2);

  const grouped = client.groupByVideo(day);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].impression_count, 1);
  assert.equal(grouped[0].active_watch_ms, 450);
});
