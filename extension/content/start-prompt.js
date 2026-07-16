(() => {
  const INSTANCE_KEY = '__scrollReceiptStartPrompt';
  const previous = globalThis[INSTANCE_KEY];

  // YouTube navigation and the service worker can both inject this file.
  // Replacing the old instance also recovers cleanly after an extension reload.
  if (previous?.dispose) previous.dispose();

  const state = {
    host: null,
    intervalId: null,
    disposed: false,
    checking: false,
    listeners: []
  };
  globalThis[INSTANCE_KEY] = state;

  function listen(target, type, listener) {
    target.addEventListener(type, listener);
    state.listeners.push(() => target.removeEventListener(type, listener));
  }

  function isContextInvalidated(error) {
    return /extension context invalidated/i.test(String(error?.message || error));
  }

  function removePrompt() {
    state.host?.remove();
    state.host = null;
  }

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    removePrompt();
    for (const removeListener of state.listeners.splice(0)) {
      try {
        removeListener();
      } catch {
        // The old extension context can disappear while an unpacked build reloads.
      }
    }
    if (state.intervalId !== null) clearInterval(state.intervalId);
    state.intervalId = null;
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      // No cleanup call is available after the extension context is invalidated.
    }
    if (globalThis[INSTANCE_KEY] === state) delete globalThis[INSTANCE_KEY];
  }

  state.dispose = dispose;

  async function send(message) {
    if (state.disposed) return null;
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (isContextInvalidated(error)) dispose();
      return null;
    }
  }

  function createPrompt() {
    if (state.host || state.disposed || !document.documentElement) return;

    const host = document.createElement('div');
    host.id = 'scroll-receipt-start-prompt';
    host.setAttribute('role', 'complementary');
    host.setAttribute('aria-label', '쇼츠 영수증 기록 시작');
    const shadow = host.attachShadow({ mode: 'open' });
    const logoUrl = chrome.runtime.getURL('assets/scroll-receipt-mark.svg');
    const fontUrl = chrome.runtime.getURL('assets/fonts/Moneygraphy-Rounded.woff2');

    const style = document.createElement('style');
    style.textContent = `
      @font-face {
        font-family: "Moneygraphy";
        src: url("${fontUrl}") format("woff2");
        font-style: normal;
        font-weight: 400;
        font-display: swap;
      }

      :host {
        all: initial;
        position: fixed;
        z-index: 2147483647;
        top: 76px;
        right: 22px;
        width: min(326px, calc(100vw - 28px));
        color: #202124; /* Google Black */
        font-family: "Moneygraphy", "Google Sans", "Roboto", -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
        font-synthesis: none;
        line-height: 1.45;
      }

      .ticket {
        position: relative;
        padding: 24px 22px 20px;
        overflow: hidden;
        border: 1px solid #DADCE0; /* Google Gray 300 */
        border-radius: 24px;
        background: #FFFFFF;
        box-shadow: 0 4px 6px 0 rgba(60,64,67,0.15), 0 8px 24px 3px rgba(60,64,67,0.08);
        animation: receipt-in 200ms cubic-bezier(0.2, 0, 0, 1) both;
      }

      .tape {
        position: absolute;
        z-index: 10;
        top: -6px;
        left: 50%;
        width: 72px;
        height: 15px;
        background:
          repeating-linear-gradient(90deg, transparent 0 9px, rgba(26, 115, 232, .14) 9px 10px),
          repeating-linear-gradient(0deg, transparent 0 7px, rgba(26, 115, 232, .11) 7px 8px),
          #E8F0FE; /* Google Blue Soft tape background */
        clip-path: polygon(0 11%, 5% 0, 11% 8%, 18% 0, 28% 7%, 38% 0, 48% 6%, 58% 0, 69% 8%, 80% 0, 91% 7%, 100% 0, 98% 90%, 90% 100%, 80% 93%, 68% 100%, 57% 92%, 46% 100%, 35% 92%, 23% 100%, 12% 92%, 0 100%);
        pointer-events: none;
        transform: translateX(-50%) rotate(-2.5deg);
      }

      .ticket::before {
        display: none;
      }

      .ticket::after {
        display: none;
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 7px;
        margin: 0;
        color: #5F6368; /* Google Gray 600 */
        font-size: 11px;
        font-weight: 800;
        letter-spacing: -.01em;
      }

      .brand::after {
        display: none;
      }

      .brand img {
        width: 18px;
        height: 18px;
      }

      h2 {
        width: fit-content;
        margin: 14px 0 7px;
        color: #1A73E8; /* Classic Google Blue */
        font-size: 22px;
        font-weight: 800;
        letter-spacing: -.055em;
        line-height: 1.16;
        word-break: keep-all;
      }

      .copy {
        margin: 0;
        color: #5F6368; /* Google Gray 600 */
        font-size: 12px;
        word-break: keep-all;
      }

      .actions {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        margin-top: 18px;
        padding-top: 14px;
        border-top: 1px solid #DADCE0; /* Google Gray 300 */
      }

      button {
        min-height: 40px;
        padding: 0 16px;
        border-radius: 999px;
        font: 800 13px/1 "Moneygraphy", "Google Sans", "Roboto", -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.2, 0, 0, 1);
      }

      button:focus-visible {
        outline: 3px solid #1A73E8; /* Classic Google Blue */
        outline-offset: 3px;
        border-radius: 999px;
      }

      .start {
        border: none;
        background: #1A73E8; /* Classic Google Blue */
        color: #FFFFFF;
        box-shadow: 0 1px 2px 0 rgba(26,115,232,0.3), 0 1px 3px 1px rgba(26,115,232,0.15);
      }

      .start:hover {
        background: #174EA6; /* Google Blue Hover */
        transform: translateY(-2px);
        box-shadow: 0 4px 6px 0 rgba(26,115,232,0.3), 0 8px 24px 3px rgba(26,115,232,0.15);
      }

      .later {
        border: 1px solid #DADCE0; /* Google Gray 300 */
        background: transparent;
        color: #5F6368; /* Google Gray 600 */
      }

      .later:hover {
        background: #E8F0FE; /* Google Blue Soft */
      }

      button:disabled {
        cursor: wait;
        opacity: .58;
      }

      .privacy {
        margin: 10px 0 0;
        color: #5F6368; /* Google Gray 600 */
        font-size: 10px;
      }

      @keyframes receipt-in {
        from { opacity: 0; transform: translateY(-7px); }
        to { opacity: 1; transform: translateY(0); }
      }

      @media (max-width: 540px) {
        :host { top: 62px; right: 14px; }
      }

      @media (prefers-reduced-motion: reduce) {
        .ticket { animation: none; }
      }
    `;

    const ticket = document.createElement('section');
    ticket.className = 'ticket';
    ticket.innerHTML = `
      <div class="tape" aria-hidden="true"></div>
      <p class="brand"><img src="${logoUrl}" alt="">쇼츠 영수증</p>
      <h2>오늘 본 쇼츠, 셀까요?</h2>
      <p class="copy">지금부터 Shorts에서 본 개수와 시간을 기록해요.</p>
      <div class="actions">
        <button class="start" type="button">기록 시작</button>
        <button class="later" type="button">오늘은 안 함</button>
      </div>
      <p class="privacy">기록은 이 브라우저에만 남아요.</p>
    `;

    const buttons = [...ticket.querySelectorAll('button')];
    ticket.querySelector('.start').addEventListener('click', async () => {
      buttons.forEach((button) => { button.disabled = true; });
      const result = await send({ type: 'START_TODAY' });
      if (result?.started) removePrompt();
      else buttons.forEach((button) => { button.disabled = false; });
    });
    ticket.querySelector('.later').addEventListener('click', async () => {
      buttons.forEach((button) => { button.disabled = true; });
      const result = await send({ type: 'DISMISS_START_PROMPT' });
      if (result?.dismissed) removePrompt();
      else buttons.forEach((button) => { button.disabled = false; });
    });

    shadow.append(style, ticket);
    document.documentElement.append(host);
    state.host = host;
  }

  async function checkPrompt() {
    if (state.disposed || state.checking) return;
    state.checking = true;
    const promptState = await send({ type: 'GET_START_PROMPT_STATE' });
    state.checking = false;
    if (state.disposed) return;
    if (promptState?.show) createPrompt();
    else removePrompt();
  }

  function onRuntimeMessage(message) {
    if (message?.type === 'RECORDING_CONSENT') checkPrompt();
    if (
      message?.type === 'DAILY_RECORDING_STARTED' ||
      message?.type === 'DAILY_RECORDING_DISMISSED'
    ) {
      removePrompt();
    }
  }

  try {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  } catch (error) {
    if (isContextInvalidated(error)) dispose();
    return;
  }

  listen(document, 'yt-navigate-finish', checkPrompt);
  listen(document, 'visibilitychange', () => {
    if (document.visibilityState === 'visible') checkPrompt();
  });
  state.intervalId = setInterval(checkPrompt, 60_000);
  checkPrompt();
})();
