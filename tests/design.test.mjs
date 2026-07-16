import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const themeCss = await fs.readFile(new URL('../extension/shared/theme.css', import.meta.url), 'utf8');
const popupCss = await fs.readFile(new URL('../extension/popup/popup.css', import.meta.url), 'utf8');
const reportCss = await fs.readFile(new URL('../extension/report/report.css', import.meta.url), 'utf8');
const popupHtml = await fs.readFile(new URL('../extension/popup/popup.html', import.meta.url), 'utf8');
const popupJs = await fs.readFile(new URL('../extension/popup/popup.js', import.meta.url), 'utf8');
const reportHtml = await fs.readFile(new URL('../extension/report/report.html', import.meta.url), 'utf8');
const reportJs = await fs.readFile(new URL('../extension/report/report.js', import.meta.url), 'utf8');
const promptJs = await fs.readFile(new URL('../extension/content/start-prompt.js', import.meta.url), 'utf8');
const markSvg = await fs.readFile(new URL('../extension/assets/scroll-receipt-mark.svg', import.meta.url), 'utf8');

test('popup and report bundle and use the Korean display font pairing', async () => {
  for (const asset of [
    'Moneygraphy-Rounded.woff2'
  ]) {
    const file = await fs.stat(new URL('../extension/assets/fonts/' + asset, import.meta.url));
    assert.ok(file.size > 0, asset + ' must be bundled');
  }

  for (const css of [themeCss]) {
    assert.match(css, /font-family:\s*"Moneygraphy"/);
  }
});

test('the receipt interface does not regress to the rejected neon palette', () => {
  const rejected = ['#c9ff32', '#ff4d2f', '#7c3aed'];
  const styles = (popupCss + reportCss).toLowerCase();
  for (const color of rejected) assert.ok(!styles.includes(color), color + ' must stay removed');
});

test('Korean stationery details stay consistent across the extension and shared image', () => {
  assert.match(popupHtml, /class="paper-tape" aria-hidden="true"/);
  assert.match(popupCss, /\.paper-tape \{[\s\S]*repeating-linear-gradient[\s\S]*clip-path: polygon/);
  assert.match(reportJs, /class="share-tape" aria-hidden="true"/);
  assert.match(reportCss, /\.share-card \.share-tape \{[\s\S]*repeating-linear-gradient[\s\S]*clip-path: polygon/);
  assert.match(reportJs, /function drawWashiTape\(/);
  assert.match(reportJs, /function drawSparkle\(/);
  assert.match(promptJs, /font-family:\s*"Moneygraphy"/);
  assert.match(markSvg, /M84 91c/);
});

test('recording start and pause controls share the same bottom dock pattern', () => {
  const dockCount = (popupHtml.match(/class="control-dock"/g) || []).length;
  assert.equal(dockCount, 2);
  assert.match(popupHtml, /id="start-recording" class="tracking-toggle"/);
  assert.match(popupHtml, /id="toggle-pause" class="tracking-toggle"/);
});

test('consent closes the extension popup before the YouTube prompt takes over', () => {
  assert.match(
    popupJs,
    /start-recording'[\s\S]*SET_CONSENT'[\s\S]*window\.close\(\)/
  );
});

test('daily controls and the YouTube start prompt use concrete Korean copy', () => {
  assert.match(popupHtml, /id="reset-today"/);
  assert.match(popupHtml, /id="consent-toggle" type="checkbox" role="switch"/);
  assert.match(popupHtml, /전체 기록 삭제/);
  assert.match(popupHtml, /쇼츠 정산하기/);
  assert.ok(!popupHtml.includes('모든 기록과 동의 삭제'));
  assert.ok(!popupHtml.includes('동의 삭제'));
  assert.match(promptJs, /오늘 본 쇼츠, 셀까요\?/);
  assert.match(promptJs, /START_TODAY/);
  assert.match(promptJs, /DISMISS_START_PROMPT/);
  assert.match(promptJs, /attachShadow/);
  assert.match(popupCss, /\.report-button \{[\s\S]*background: var\(--stamp\)/);
});

test('report removes rejected AI-dashboard labels and progress tracks', () => {
  const source = reportHtml + reportCss;
  for (const rejected of ['공유용 한 장', 'SCROLL RECEIPT', 'PAID', 'genre-track', 'genre-fill']) {
    assert.ok(!source.includes(rejected), rejected + ' must stay removed');
  }
  assert.match(reportHtml, /id="share-title"[\s\S]*공유하기/);
  assert.match(reportHtml, /id="export-png"[\s\S]*이미지 저장/);
  assert.match(reportHtml, /id="friend-share"[\s\S]*친구에게 공유/);
  assert.ok(!reportHtml.includes('aria-expanded'));
  assert.ok(!reportHtml.includes('share-options'));
  assert.ok(!reportHtml.includes('스토리 미리보기'));
  assert.match(reportCss, /content:\s*"정산"/);
  assert.match(reportCss, /genre-rank-1/);
});

test('report uses plain metric and export labels', () => {
  assert.match(reportHtml, /이미지 저장/);
  assert.match(reportHtml, /끝까지 본 쇼츠/);
  assert.match(reportHtml, /다시 본 횟수/);
  assert.ok(!reportHtml.includes('9:16 PNG 저장'));
  assert.ok(!reportHtml.includes('완주 / 반복'));
  for (const rejected of [
    '기록만 반영',
    '부분 분석',
    '분석 완료',
    'PC Chrome에서만 기록',
    'PC Chrome에서 센 기록',
    '영상 제목과 채널명은 넣지 않았어요.',
    '시청 기록은 그대로 남아 있어요.',
    '분석 준비 중'
  ]) {
    assert.ok(!(reportHtml + reportJs).includes(rejected));
  }
  assert.ok(!(reportHtml + reportCss + reportJs).includes('share-disclaimer'));
  assert.ok(!(reportHtml + reportCss).includes('share-note'));
  assert.ok(!reportHtml.includes('id="limitations"'));
  assert.match(reportJs, /대표 영상을 분석하지 못했어요\./);
  assert.match(reportJs, /if \(AUTO_ANALYZE\) \{\s*await startAnalysis\(\)/);
  assert.match(reportJs, /class="evidence-empty"/);
  assert.match(reportCss, /\.evidence-list li\.evidence-empty \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
});
