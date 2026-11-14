---
name: browser-captcha
title: "Cloudflare verification in Camoufox"
description: "Use the installed Camoufox Browser when Cloudflare or Turnstile blocks a page needed for the user's task."
---

# Cloudflare verification

Use this skill only when a needed page actually shows a Cloudflare or Turnstile challenge. Open the requested page first. A "Verifying..." spinner is an automatic check, not a checkbox.

1. Call `tool_catalog` with `{"groups":["browser"]}` and use the exact `mcp__custom-camoufox-browser__*` names it returns. Call `tool_dispatch` with the exact tool `name` and an **object** in `arguments`; do not print tool-call markup as an answer.
2. Keep the same Camoufox `tabId`. Read `snapshot`, then call `cloudflare_status` with `{"tabId":"...","maxWaitMs":30000}`. It checks the page repeatedly and returns immediately when the challenge clears or a visible checkbox appears; 30 seconds is only the maximum wait. Do not reload or click a `verifying` spinner.
3. If the status is `checkbox`, use `click` with `{"role":"checkbox","tabId":"..."}` or the observed accessible name. `click` searches the page and its frames. If no accessible locator finds a checkbox but a fresh `screenshot` clearly shows one, use `click_at` with `x` and `y` as fractions of the screenshot width and height, each between 0 and 1. Calculate the center of the visible checkbox; never guess from a spinner or stale image.
4. Call `cloudflare_status` again, then `snapshot`. Continue the user's task only when the challenge is gone and the requested content is visible. If verification stays automatic, no control appears, or the visible checkbox still fails after the locator or coordinate fallback, stop interacting and use another authorized public source. State what was inaccessible; do not claim the challenge passed.
