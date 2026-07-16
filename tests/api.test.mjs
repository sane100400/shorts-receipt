import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

function startApi(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), GEMINI_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('API did not start in time.\n' + output));
    }, 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('listening')) {
        clearTimeout(timeout);
        resolve(child);
      }
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function candidate(index, watchMs) {
  const id = 'testvid0' + index;
  return {
    video_id: id,
    url: 'https://www.youtube.com/shorts/' + id,
    title: '테스트 쇼츠 ' + index,
    channel: '테스트 채널',
    behavior: {
      impression_count: 1,
      active_watch_ms: watchMs,
      duration_ms: 18000,
      max_position_ms: watchMs,
      min_exit_position_ms: watchMs,
      fast_skip_count: 0,
      was_completed: false,
      replay_count: 0,
      muted_watch_ms: 0
    }
  };
}

test('API health and behavior-only receipt work without a Gemini key', async () => {
  const port = 19000 + Math.floor(Math.random() * 500);
  const api = await startApi(port);
  try {
    const health = await fetch('http://localhost:' + port + '/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).gemini_configured, false);

    const response = await fetch('http://localhost:' + port + '/v1/daily-receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        day: { day_id: '2026-07-16', timezone: 'Asia/Seoul' },
        behavior_summary: {
          daily_view_count: 4,
          active_watch_ms: 30000,
          longest_session_ms: 30000,
          fast_skip_count: 2,
          completion_count: 1,
          replay_count: 0,
          muted_watch_ms: 0
        },
        analysis_candidates: [
          candidate(1, 9000),
          candidate(2, 8000),
          candidate(3, 7000),
          candidate(4, 6000)
        ]
      })
    });
    const receipt = await response.json();
    assert.equal(response.status, 200);
    assert.equal(receipt.status, 'behavior_only');
    assert.equal(receipt.metrics.daily_view_count, 4);
    assert.equal(receipt.analysis.success_count, 0);
    assert.match(receipt.fact_sentence, /쇼츠 4개/);
  } finally {
    api.kill();
  }
});

test('API rejects a candidate URL that is not the supplied Shorts video', async () => {
  const port = 19500 + Math.floor(Math.random() * 400);
  const api = await startApi(port);
  try {
    const invalidCandidate = candidate(1, 9000);
    invalidCandidate.url = 'https://www.youtube.com/watch?v=testvid01';
    const response = await fetch('http://localhost:' + port + '/v1/daily-receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        day: { day_id: '2026-07-16', timezone: 'Asia/Seoul' },
        behavior_summary: {
          daily_view_count: 4,
          active_watch_ms: 30000,
          longest_session_ms: 30000,
          fast_skip_count: 0,
          completion_count: 0,
          replay_count: 0,
          muted_watch_ms: 0
        },
        analysis_candidates: [
          invalidCandidate,
          candidate(2, 8000),
          candidate(3, 7000),
          candidate(4, 6000)
        ]
      })
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.match(body.error, /must match its public YouTube Shorts video ID/);
  } finally {
    api.kill();
  }
});

test('API punchline regeneration rejects missing parameters and errors gracefully when key is missing', async () => {
  const port = 19600 + Math.floor(Math.random() * 300);
  const api = await startApi(port);
  try {
    // 1. Missing fact_sentence or title
    const badRes = await fetch('http://localhost:' + port + '/v1/regenerate-punchline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '테스트' })
    });
    assert.equal(badRes.status, 400);
    assert.match((await badRes.json()).error, /fact_sentence and title are required/);

    // 2. Correct params but missing Gemini key
    const res = await fetch('http://localhost:' + port + '/v1/regenerate-punchline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '테스트',
        fact_sentence: '오늘 본 대표 쇼츠 중에서는 고양이를 제일 많이 봤어요.'
      })
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /GEMINI_API_KEY is not configured/);
  } finally {
    api.kill();
  }
});

