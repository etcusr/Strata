---
name: browser-captcha
title: "Browser CAPTCHA handoff"
description: "Use when a browser page asks for a CAPTCHA or human verification and the user's task needs that page."
---

# Continue after a browser challenge

Use this skill only when a page needed for the current task displays a CAPTCHA, a human verification prompt, or an equivalent interactive access challenge. A search result mentioning CAPTCHA is not a challenge.

1. Confirm the challenge with the available browser tool. Check the current tab's URL and a fresh page snapshot or screenshot. Do not assume a slow page or an empty search result is a CAPTCHA.
2. Stop automated interaction with that site. Do not repeatedly reload, retry the same request, switch proxies or identities, extract challenge tokens, or use a third-party solving service.
3. Leave the challenged page open and tell the person, in their language, which site needs verification. Ask them to complete the challenge in the visible browser and say when it is done. Never ask them to send a password, code, cookie, or CAPTCHA answer in chat.
4. Wait for the person's response. Then inspect the same tab again. If the challenge is gone, continue the original task from the page's current state. If it remains, explain the observed limit once and continue with other authorized sources if possible.

Use the enabled browser tools' actual names and schemas. Do not claim that verification succeeded until a fresh page observation confirms it. Keep the person's unrelated tabs open.
