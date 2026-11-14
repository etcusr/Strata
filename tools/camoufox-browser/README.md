# Local browser for Strata

This optional MCP tool uses the official [Camoufox](https://github.com/daijro/camoufox) Node package. It opens a separate local Firefox-based browser and needs no account or API key. The process communicates with Strata over stdio. No HTTP control server is opened.

Install the pinned Node dependencies in this folder with `npm ci`, then run `npm run fetch` once to download the matching Camoufox browser. The macOS arm64 download for Camoufox 0.5.9 is about 1.3 GB; the extracted browser occupies more space in `~/Library/Caches/camoufox`.

In Settings → Tools, add a custom **server** tool named **Camoufox Browser**. Set its program to Node and its sole argument to the absolute path of `browser-mcp.mjs`. Disable the previous Chrome DevTools tool to avoid duplicate browser controls. The adapter launches the browser on its first tool call, then keeps it private to that MCP process. It closes the browser when Strata closes the connection.

The default is a visible browser window. Set `STRATA_CAMOUFOX_HEADLESS=1` in the Strata host environment to run headless. Camoufox reduces common automation signals, but websites can still detect or block it. Test on the sites you use before relying on it.
