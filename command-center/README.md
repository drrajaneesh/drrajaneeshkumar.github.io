# Command center — local inbox dashboard

A local-only desktop dashboard that shows unread-mail counts for one Gmail
account and one Outlook/Hotmail account. It never reads or displays subject
lines, message bodies, snippets, or attachments — only unread counts, sender
display names, timestamps, and a link to open the message in your web mail
client.

Everything runs on your machine. The server binds to `127.0.0.1` only and
refuses any request that doesn't say `Host: localhost` or `Host: 127.0.0.1`.
The only network calls it ever makes are to `accounts.google.com`,
`oauth2.googleapis.com`, `gmail.googleapis.com`, `login.microsoftonline.com`,
and `graph.microsoft.com`.

There are no npm dependencies — the server uses only Node's built-in
modules, so there is nothing to `npm install`.

## 1. One-time setup

### Requirements

- [Node.js](https://nodejs.org/) 18 or newer installed.

### Create the Google OAuth credential (Gmail)

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) →
   create or select a project.
2. **APIs & Services → Library** → enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen** → configure it (External is
   fine for personal use; you don't need to publish it, just add your own
   Gmail address as a test user).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   → Application type **Desktop app** → create it.
5. Click **Download JSON** on the credential you just created.
6. Save that file as:
   `command-center/config/google-oauth-client.json`
   (it should look like `config/google-oauth-client.example.json`).

Because this is a "Desktop app" credential, Google accepts a loopback
redirect on any port automatically — you do not need to add a redirect URI
manually. If your console ever insists on one, add exactly:
`http://127.0.0.1:8877/oauth/google/callback`.

> **Note on the 7-day test-mode token expiry:** while your OAuth consent
> screen is in "Testing" status, Google expires refresh tokens after 7 days.
> When that happens the Gmail card will show **Needs sign-in again** with a
> one-click **Sign in** button — clicking it is the entire re-authorization
> step. To stop this from happening, publish the OAuth consent screen (still
> free, no verification needed for `gmail.readonly` at low request volume) or
> just re-click Sign in weekly.

### Create the Microsoft OAuth app (Outlook/Hotmail)

1. Go to [Azure Portal → App registrations](https://portal.azure.com/) →
   **New registration**.
2. Name it anything (e.g. "Command Center").
3. **Supported account types** → choose **Accounts in any organizational
   directory and personal Microsoft accounts** (or the personal-accounts-only
   option if offered).
4. **Redirect URI** → platform **Mobile and desktop applications** → add
   exactly:
   `http://localhost:8877/oauth/microsoft/callback`
5. Create the app. On the app's **Overview** page, copy the **Application
   (client) ID**.
6. **API permissions → Add a permission → Microsoft Graph → Delegated
   permissions** → add `Mail.Read` and `offline_access`. (No admin consent
   needed for personal accounts.)
7. Leave **Certificates & secrets** empty — this app is a public client and
   uses PKCE, not a client secret.
8. Create the file `command-center/config/microsoft-oauth-client.json`:
   ```json
   { "client_id": "PASTE-YOUR-APPLICATION-CLIENT-ID-HERE", "tenant": "common" }
   ```

### Files created by setup

| File | Purpose | In git? |
|---|---|---|
| `config/google-oauth-client.json` | Your Google OAuth client ID + secret | No — gitignored |
| `config/microsoft-oauth-client.json` | Your Microsoft OAuth client ID | No — gitignored |
| `~/.command-center-secrets/tokens.json` | Refresh/access tokens (outside this folder entirely), owner-only permissions | No — not part of this project at all |

If a credential file is missing, the matching card simply shows **Not
configured** — the app still starts and the other account still works.

## 2. Start command

From the `command-center` folder:

```
npm start
```

(equivalent to `node server.js`). Or use the shortcut for your OS:

- **macOS**: double-click `start.command` (first time: right-click → Open,
  to get past Gatekeeper's "unidentified developer" warning).
- **Windows**: double-click `start.bat`.
- **Linux / manual**: `./start.sh`

Any of these start the server on `http://127.0.0.1:8877/` and automatically
open it in your default browser.

## 3. First sign-in

On first run both cards show **Not configured** (if you haven't dropped in
the credential files yet) or **Needs sign-in again**. Click **Sign in to
Gmail** / **Sign in to Outlook** on each card — a browser tab opens the
provider's real login page. After you approve access, the tab shows "Signed
in" and closes itself; the dashboard tab picks up the new data automatically
within a few seconds.

## 4. Stopping the server

Close the terminal window it's running in, or press `Ctrl+C` in that
terminal. Nothing keeps running in the background afterwards.

## 5. Re-authorizing later

If a card shows **Needs sign-in again** (tokens revoked, expired, or the
7-day testing-mode limit above), just click the **Sign in** button on that
card again — it's a single click, same as first-time setup.

To fully disconnect an account yourself: stop the server, delete
`~/.command-center-secrets/tokens.json`, and restart.

## What each card shows

- Unread count for the inbox.
- Unread count that's also marked important (Gmail "important", Outlook
  "high importance").
- The five newest unread messages: sender display name and time only, each
  linking to that message in Gmail/Outlook on the web.
- "Updated at" time and a manual Refresh button.
- Auto-refreshes every 5 minutes.

It never shows subject lines, previews, message bodies, or attachments —
the server doesn't request that data from Google or Microsoft in the first
place, so it never exists on your screen or in any log.

## Failure states (shown inside the affected card only)

- **Not configured** — the credential file for that account is missing.
- **Needs sign-in again** — with a one-click Sign in button.
- **Can't reach the local server** — shown if the browser can't reach
  `127.0.0.1:8877` at all (e.g. the server isn't running).
- **Temporary error** — rate limited or a transient provider error; the last
  known numbers stay on screen, marked stale, until the next successful
  refresh.

## Guardrails this app follows

- Read-only: only `gmail.readonly` and `Mail.Read` scopes are requested. The
  server never sends, deletes, labels, marks-read, or moves any mail.
- Binds to `127.0.0.1` only — never `0.0.0.0`.
- Rejects any HTTP request whose `Host` header isn't `localhost` or
  `127.0.0.1`.
- No analytics, no third-party scripts, no CDNs. All calls go only to
  Google/Microsoft mail endpoints or to `127.0.0.1` itself.
- No credentials or tokens ever appear in the HTML, in a URL, or in
  `localStorage`. Tokens live only in `~/.command-center-secrets/tokens.json`
  (created with owner-only file permissions) and are never logged or printed.
