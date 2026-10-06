---
name: run-command-center
description: Start, run, drive, screenshot and stop the Command Center local dashboard (Node server on 127.0.0.1:8877 serving a single-page inbox/notes dashboard). Use when asked to run or start command-center, take a screenshot of it, click through its UI, or check a change to server.js or public/command-center-desktop.html works in the real app.
---

Command Center is a zero-dependency Node server (`server.js`, port 8877, localhost only) serving one HTML page. In a headless container you start the server in the background and drive the page with `driver.mjs` (headless Chromium via Playwright), which clicks through the UI, checks state, and saves screenshots.

All paths are relative to `command-center/`.

## Prerequisites

Node 18+ (verified with v22.22.0). No `npm install`: the server uses only Node built-ins. The driver needs Playwright and Chromium, both preinstalled in this container at `/opt/node-tools/node_modules/playwright` and `/opt/pw-browsers/chromium`. Override with `PLAYWRIGHT_PATH` / `CHROMIUM_PATH` if they live elsewhere. Do not run `playwright install`.

## Run (agent path)

```bash
# 1. free the port, start the server in the background, wait until it answers
lsof -ti:8877 -sTCP:LISTEN | xargs -r kill
(node server.js > /tmp/cc.log 2>&1 &)
timeout 20 bash -c 'until curl -sf http://127.0.0.1:8877/api/inbox >/dev/null; do sleep 0.5; done'

# 2. drive the UI; prints JSON of checks, exit 0 only if all pass
node .claude/skills/run-command-center/driver.mjs /tmp/cc-shots

# 3. stop
lsof -ti:8877 -sTCP:LISTEN | xargs -r kill
```

The driver loads the page, reads both inbox cards, clicks Audit `+1` three times, types a note, toggles dark mode, screenshots, reloads to prove `localStorage` persistence, resets, and fails on any browser console error. Screenshots: `/tmp/cc-shots/1-light.png`, `/tmp/cc-shots/2-dark-after-clicks.png`. Look at them; a blank page means something is wrong even if the JSON says ok.

Server-only checks, no browser needed:

```bash
curl -s http://127.0.0.1:8877/api/inbox                                   # JSON for both accounts
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.com' http://127.0.0.1:8877/   # 403 expected
```

## Run (human path)

`npm start` (or `./start.sh`) starts the server and tries `xdg-open` on a browser. Headless, the open fails silently and the server keeps running, so this is only useful on a desktop. Stop with Ctrl+C.

## Test

There is no test suite (`package.json` only defines `start`). `driver.mjs` is the smoke test.

## Gotchas

- **No credentials in this container, so both cards read "Not configured."** That is the expected state here, not a failure. `/api/inbox` returns `"status":"not_configured"` for both accounts. The sign-in flows need real Google/Microsoft OAuth files in `config/` (gitignored) and a real browser login; they cannot be exercised headless, and I did not try.
- **Starting a second server crashes with `EADDRINUSE`.** The port is fixed at 8877 and the process is detached, so always run the `lsof ... | xargs -r kill` line first.
- **Host check:** the server returns 403 for any `Host` header other than `localhost` or `127.0.0.1`. Drive it at `http://127.0.0.1:8877/`, not the container's hostname or IP.
- **Page state lives in `localStorage`** (`cc-theme`, `cc-skills`, `cc-directives`, `cc-audit`). A fresh Chromium context starts empty, so the driver is repeatable; it also resets what it changes.
- **`chromium-cli` is not installed here**, which is why this uses a small Playwright script instead.

## Troubleshooting

- **`listen EADDRINUSE: address already in use 127.0.0.1:8877`**: an earlier server is still running. Run the kill line in step 1.
- **driver prints `"ok": false`**: read the JSON; each check is listed. A non-empty `consoleErrors` array means the page threw.
