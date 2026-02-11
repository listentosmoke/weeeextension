# Gemini Visual Web Agent Chrome Extension

A complete Manifest V3 Chrome extension that can run **iterative, click-focused web automation** using the Gemini API with screenshot + extracted text context.

## Features

- Captures the visible tab screenshot (`chrome.tabs.captureVisibleTab`)
- Extracts visible page text from the DOM in a content script
- Sends screenshot + page text + task to Gemini Vision (`gemini-1.5-flash`)
- Enforces structured JSON action plans from the model
- Executes action plans in-page (click, double-click, right-click, type, keypress, scroll, drag, wait)
- Repeats for many steps (up to 500 in UI, default 120)
- Streams status and action logs to the popup via `chrome.storage.local`
- Stop button for user interruption

## Files

- `manifest.json` — extension config, permissions, service worker, popup, content script
- `background.js` — agent loop, screenshot capture, Gemini requests, orchestration/logging
- `content.js` — text extraction and action execution in the active page
- `popup.html` / `popup.css` / `popup.js` — controls, status, and logs UI

## Setup

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Open the extension popup.
5. Enter your Gemini API key.
6. Enter a high-level task prompt.
7. Click **Start**.

## Example prompts

- "Log into my project dashboard and open the latest build details page."
- "On this shopping page, add the top-rated wireless mouse under $40 to cart."
- "Find the contact form and fill in name/email/message with polite text, then stop before final submit."

## Notes and limitations

- Complex websites may use anti-automation patterns, shadow DOM, iframes, or virtualized UIs that can reduce reliability.
- Gemini may occasionally return selectors that do not match; logs help diagnose this.
- This extension intentionally emphasizes click-driven actions, with scroll/drag/type helpers when necessary.
- Review prompts carefully to avoid unwanted destructive actions.
