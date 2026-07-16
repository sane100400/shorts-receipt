import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('content scripts cover YouTube entry pages and Shorts video URLs', async () => {
  const manifest = JSON.parse(await fs.readFile(
    new URL('../extension/manifest.json', import.meta.url),
    'utf8'
  ));
  const promptScript = manifest.content_scripts.find((entry) =>
    entry.js.includes('content/start-prompt.js')
  );
  const trackerScript = manifest.content_scripts.find((entry) =>
    entry.js.includes('content/tracker.js')
  );
  assert.ok(promptScript, 'the daily start prompt must be declared');
  assert.ok(trackerScript, 'the Shorts tracker must be declared');
  for (const pattern of ['https://www.youtube.com/*', 'https://youtube.com/*']) {
    assert.ok(promptScript.matches.includes(pattern), pattern + ' must inject the daily prompt');
    assert.ok(manifest.host_permissions.includes(pattern), pattern + ' must be permitted');
  }
  for (const pattern of [
    'https://www.youtube.com/shorts',
    'https://www.youtube.com/shorts/*',
    'https://youtube.com/shorts',
    'https://youtube.com/shorts/*'
  ]) {
    assert.ok(trackerScript.matches.includes(pattern), pattern + ' must inject the tracker');
  }
  const promptFile = await fs.stat(new URL('../extension/content/start-prompt.js', import.meta.url));
  assert.ok(promptFile.size > 0, 'the prompt content script must exist');
  const publicResources = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
  for (const asset of [
    'assets/scroll-receipt-mark.svg',
    'assets/fonts/Moneygraphy-Rounded.woff2'
  ]) {
    assert.ok(publicResources.includes(asset), asset + ' must load inside the YouTube prompt');
  }
});

test('extension declares its own receipt icon at every Chrome action size', async () => {
  const manifest = JSON.parse(await fs.readFile(
    new URL('../extension/manifest.json', import.meta.url),
    'utf8'
  ));
  for (const size of ['16', '32', '48', '128']) {
    const asset = manifest.icons[size];
    assert.equal(asset, 'assets/icon-' + size + '.png');
    const file = await fs.stat(new URL('../extension/' + asset, import.meta.url));
    assert.ok(file.size > 0, asset + ' must exist');
  }
});

test('manifest permits runtime tracker injection into an already-open Shorts tab', async () => {
  const manifest = JSON.parse(await fs.readFile(
    new URL('../extension/manifest.json', import.meta.url),
    'utf8'
  ));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.ok(manifest.permissions.includes('clipboardWrite'));
});
