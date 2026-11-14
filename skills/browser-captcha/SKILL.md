---
name: browser-captcha
title: "Browser CAPTCHA handoff"
description: "Use the installed Camoufox Browser when a page needed for the task shows a CAPTCHA or human-verification challenge."
---

# Handle a browser challenge with Camoufox

Use this skill when a needed page shows an interactive CAPTCHA, a human-verification prompt, or a "Just a sec" interstitial. A search result mentioning CAPTCHA, a slow page, and an HTTP 403/429 response without an interactive challenge do not qualify. If the user asks you to open a URL and solve a challenge *if one appears*, open the URL first; do not assume there is a challenge.

## Connect to the installed browser

1. Call `tool_catalog` with `{"groups":["browser"]}`. The installed server is **Camoufox Browser**, with tools named `mcp__custom-camoufox-browser__navigate`, `snapshot`, `screenshot`, `tabs`, `click`, `fill`, `press`, `scroll`, `links`, and `evaluate` under that prefix. Use the exact names returned by the catalog. If the browser group is empty, check `{"groups":["connected"]}` once for Camoufox. If it is absent there too, report that the browser is unavailable; do not pretend a tool ran.
2. Ask `tool_catalog` for the exact names you need to see their schemas. Call `tool_dispatch` with the **tool name** and an **object** in `arguments`. For example, to open a page: `{"name":"mcp__custom-camoufox-browser__navigate","arguments":{"url":"https://example.org/"}}`. To read it: `{"name":"mcp__custom-camoufox-browser__snapshot","arguments":{}}`. These are tool arguments, not text to print in the reply. Never output `<tool_call>` or similar markup as your answer.
3. `tabs` with `{"action":"list"}` lists this Camoufox process's tabs. `navigate` opens an HTTP(S) URL in its active tab; pass `tabId` to keep working on a specific tab. Camoufox owns a separate browser session. Do not assume it can see the person's Chrome tabs.

## Inspect, act, verify

1. Read the final URL and a fresh `snapshot`. Take a `screenshot` when the challenge is visual. Confirm that the challenge blocks content needed for the task. Keep the same tab and browser context for the attempt.
2. For a page that is simply checking the browser, give it a short moment and inspect again. Avoid repeated reloads. For a visible checkbox or button, choose one `click` locator: `{"role":"checkbox","name":"Verify you are human"}`, `{"text":"Verify you are human"}`, or `{"selector":"..."}`. Do not combine a selector with a role or text. For a text or math question with a reachable input, use `fill` with `value` and a locator, then `press` or `click` to submit. After each action, take a fresh snapshot or screenshot before deciding what to do next.
3. The installed Camoufox adapter has **no coordinate click, drag, audio transcription, iframe-specific locator, or browser wait tool**. A screenshot can show a tile grid or slider, but it does not make its pixels clickable. Only interact with a challenge element when `click`/`fill` can locate it by the exposed role, text, or selector. Do not invent an unavailable tool call or use `evaluate` to extract challenge answers or forge a pass.
4. Make at most two deliberate interaction attempts. If a checkbox is inside an iframe that the installed tools cannot target, or a locator fails twice, stop interacting with that challenge. Do not loop through `evaluate`, snapshots, reloads, or near-identical clicks. Do not rotate proxies, identities, profiles, or cookies; do not use a third-party CAPTCHA-solving service. Keep unrelated tabs open. Never ask for a password, token, cookie, code, or CAPTCHA answer in chat.
5. Confirm success from a **new observation of the same tab**: the challenge is gone and the requested content is present. Then continue the original task from that page. If the installed controls cannot reach the challenge, or the attempts fail, try another authorized public source for the same information and report precisely what remained inaccessible. Do not claim that verification passed without observing it.
