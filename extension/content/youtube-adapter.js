(() => {
  function videoIdFromLocation() {
    const match = location.pathname.match(/^\/shorts\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  function isShortsPage() {
    return Boolean(videoIdFromLocation());
  }

  function visibleArea(video) {
    const rect = video.getBoundingClientRect();
    const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    return width * height;
  }

  function activeVideo() {
    const videos = [...document.querySelectorAll('video')].filter((video) => video.isConnected);
    if (!videos.length) return null;
    return videos
      .map((video) => {
        const rect = video.getBoundingClientRect();
        const centerDistance = Math.abs(rect.top + rect.height / 2 - innerHeight / 2);
        const playingBonus = !video.paused && !video.ended ? innerWidth * innerHeight : 0;
        return { video, score: visibleArea(video) + playingBonus - centerDistance * 12 };
      })
      .sort((a, b) => b.score - a.score)[0]?.video || null;
  }

  function text(selector) {
    const node = document.querySelector(selector);
    return node?.textContent?.trim() || '';
  }

  function metadata() {
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content?.trim();
    // YouTube's current desktop Shorts player uses ytd-shorts and a player
    // title link. Keep the former reel selectors as fallbacks for rollouts.
    const title = text('#shorts-player .ytp-title-link') ||
      text('ytd-shorts .ytp-title-link') ||
      text('ytd-reel-video-renderer[is-active] #video-title') ||
      text('ytd-reel-video-renderer[is-active] h2') ||
      ogTitle ||
      document.title.replace(/ - YouTube$/, '').trim();
    const channel = text('ytd-shorts a.ytAttributedStringLink[href*="/@"]') ||
      text('ytd-reel-video-renderer[is-active] #channel-name a') ||
      text('ytd-reel-video-renderer[is-active] #channel-name') ||
      '';
    return { title, channel };
  }

  globalThis.ScrollReceiptYouTube = {
    videoIdFromLocation,
    isShortsPage,
    activeVideo,
    metadata
  };
})();
