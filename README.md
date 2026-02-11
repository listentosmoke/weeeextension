# Gemini Visual Web Agent Chrome Extension

A Manifest V3 Chrome extension that runs **iterative, click-focused web automation** using the Gemini API with screenshot + extracted text context.

## Features

- Captures visible tab screenshots (`chrome.tabs.captureVisibleTab`)
- Extracts visible page text from the DOM in a content script
- Sends screenshot + page text + task to Gemini Vision with model fallback (`gemini-2.0-flash` → `gemini-2.0-flash-lite` → `gemini-1.5-flash`)
- Enforces structured JSON action plans from the model
- Executes actions in-page (`click`, `doubleClick`, `rightClick`, `type`, `keypress`, `scroll`, `drag`, `wait`)
- **Optional Chrome Debug Mode** (`chrome.debugger` + DevTools Input domain) for stronger input simulation
- Repeats for many steps (up to 500 in UI, default 120)
- Streams status and logs to popup via `chrome.storage.local` with accurate completion/error state
- Stop button for user interruption

## Files

- `manifest.json` — extension config, permissions, service worker, popup, content script
- `background.js` — agent loop, screenshot capture, Gemini requests, debugger-mode orchestration/logging
- `content.js` — text extraction, selector/target resolution, and fallback action execution
- `popup.html` / `popup.css` / `popup.js` — controls, debug-mode toggle, status, and logs UI

## Setup

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Open the extension popup.
5. Enter your Gemini API key.
6. Enter a high-level task prompt.
7. Keep **Use Chrome Debug Mode** enabled for stronger click/type/drag automation.
8. Click **Start**.

## Notes and limitations

- Complex sites may still use anti-automation patterns, heavy shadow DOM, iframes, or virtualized UIs that reduce reliability.
- Gemini may return selectors that do not match runtime DOM; logs help diagnose this.
- If one model is unavailable for your API/project, the extension retries fallback models automatically.
- API key auth is sent through request headers (`x-goog-api-key`).
- Debug mode attaches a debugger session to the active tab while the run is active and detaches at the end.
