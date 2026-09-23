# ✦ QuickComment

A Chrome extension that adds a **✦ Comment ideas** button under every
LinkedIn post. Pick a size, an attitude and a style, press Generate, and get
three short comment options written by Claude. Copy the one you like.

Works on the feed and on single post pages (`linkedin.com/posts/...`).

- Reads the post first (gist, the author's tone, what they want, the one
  detail worth picking up), then writes comments that match that tone,
  adjusted by your knobs.
- No parroting: it never quotes or summarizes the post back.
- Every generation is logged locally with its cost. A quality index shows
  how often you actually copied something.
- Your Anthropic key stays in Chrome's extension storage. It is never
  written to a file, and this repo contains no key.

Personal tool, not on the Chrome Web Store. You bring your own Claude API key.

## Install (no terminal)

1. Download the extension: open the
   [latest release](../../releases/latest) and download
   `quickcomment.zip`. Unzip it. You get a folder called `quickcomment`.
   Keep that folder somewhere permanent (Chrome loads it from disk every
   time), not in Downloads.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (toggle, top right).
4. Click **Load unpacked** and select the `quickcomment` folder.
5. The setup page opens by itself. Follow the three steps on it, or read
   the next section.

## Get a Claude API key (about 3 minutes)

1. Go to <https://platform.claude.com/settings/keys> and sign in or create
   an account. Add a small amount of credit under Billing if you have none.
2. Click **Create key**.
3. Name it `quickcomment`. Expiration: 30 days is a sensible default for a
   key that lives in a browser. Linked account: yourself. Workspace: pick
   one specific workspace, so the extension does not need a workspace ID.
4. Copy the key. It is shown once.
5. Click the QuickComment icon in Chrome's toolbar (pin it from the puzzle
   icon if it is hidden), paste the key, click **Test key**. You should see
   "Key works". The popup then switches to the Activity tab.

To rotate or revoke the key later, use the same page on
platform.claude.com, then paste the new one under the popup's Settings tab.

## Use it

1. Open the LinkedIn feed. Under each post's Like / Comment / Repost row,
   right-aligned, there is a **✦ Propose comment ideas** pill.
2. Click it. It reads the post and writes three options right away. The
   grey "Read as" line shows what it understood.
3. **▲ / ▼** on each option tells it what was good or bad.
   **Regenerate** writes three new options using those votes, plus your
   recent votes on other posts as a taste memory.
4. **Copy** the one you like, click LinkedIn's Comment, paste.
5. **Options** (collapsed under the footer) holds the knobs. They stick.

**Replying to a comment:** click LinkedIn's reply icon under a comment,
the speech bubble. When the reply box opens, a **✦ Propose reply ideas**
pill appears right under it. Click it. Three replies, votes, Regenerate
and Copy, same as for posts. The **I wrote the post** pill in the footer
switches the register to answering as the author. Put your name in
Settings and it switches itself on for your own posts. Second path:
highlight any text and click the black **✦ Reply ideas** bubble.

| Knob | Options |
| --- | --- |
| Size | Ultra short (one line, 8 words max), Short (one sentence, 20 words max) |
| Attitude | Supportive, Insights, Funny |
| Style | Emoji (exactly one), Neutral |

## Cost

- Model: Claude Opus 5.5 at low effort. Thinking is always on for this
  model; low effort keeps it short. $4 per million input tokens, $20 per
  million output. Sonnet 5 is the cheap alternative at $2 / $10.
- A generation is about 1,200 tokens including a little thinking, roughly
  $0.01.
- Output is capped at 2,048 tokens per request (thinking counts against
  it). Posts are trimmed to 2,500 characters before sending.
- A monthly token cap (default 300,000, about 250 generations, roughly $3)
  stops generation when reached. Change it or reset the counter in the
  popup's Settings tab.

## Activity, history and the quality index

The popup's Activity tab shows this month's spend against the cap, all-time
spend, and the last eight generations. **Full history** opens a page with
every generation: author, post excerpt, the read, the knobs, the three
options, which one you copied, tokens and cost. Search, export as JSON, or
clear.

Votes are stored per option and shown on the history page. Two quality
numbers, in the popup and on the history page:

- **Copy rate**: generations where you copied at least one option.
- **Posts with no copy**: posts where you generated but used nothing. The
  bad case. Those rows get a red left edge.

Everything is stored in `chrome.storage.local` on your machine. Nothing
leaves your browser except the post text sent to the Claude API.

## Advanced: install and hack on it from the terminal

```bash
git clone https://github.com/rendeiro/quickcomment.git
```

Then `chrome://extensions`, Developer mode, **Load unpacked**, pick the
cloned folder. After editing any file, click the reload arrow on the
extension's card. `background.js` only picks up changes on that reload.

Layout:

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3. Content script on `/feed/*` and `/posts/*`, background service worker, popup. |
| `config.js` | Model and pricing (`QC_MODEL`), token caps, the knobs and their prompt fragments (`QC_KNOBS`), quality-metric helpers. Shared by every script. |
| `content.js` | Finds post cards by their accessibility markup, injects the trigger and panel under the action bar, handles Copy. Logs `[QuickComment]` lines to the console for debugging. |
| `background.js` | Builds the prompt, calls `POST /v1/messages` with a JSON schema (`read` block, then `comments`), records usage, cost and history. |
| `options.html` / `options.js` | The popup: Setup (until the key passes), Activity, Settings. |
| `history.html` / `history.js` | Full history page. |
| `styles.css` | In-feed styles. Light, monochrome, green star accent. |

Things you will probably want to change:

- **Prompt**: `buildPrompt()` in `background.js`.
- **Knobs**: add an option to `QC_KNOBS` in `config.js`. The panel row and
  the prompt pick it up. Nothing else changes.
- **Model**: `QC_MODEL` in `config.js`. Update the prices next to it so the
  cost tracking stays right. Sonnet 5 works as a drop-in. Models without an
  `effort` parameter (Haiku 4.5) need the `output_config.effort` line in
  `callClaude()` removed.

Build a release zip:

```bash
cd quickcomment && zip -r ../quickcomment.zip . -x '.git/*' '.DS_Store' '*/.DS_Store'
```

LinkedIn changes its markup often. If the button stops appearing, open the
console on the feed, filter for `QuickComment`, and read the `diag` lines
printed five seconds after load. `getActionBar()` and `findPosts()` in
`content.js` are where the selectors live.

## Privacy and security notes

- The API key is stored with `chrome.storage.local`, readable only by this
  extension. Do not share your Chrome profile.
- Only the post text and author name are sent to Anthropic. Nothing else
  from the page.
- The extension requests access to `linkedin.com` and `api.anthropic.com`
  only.

## License

MIT. See `LICENSE`.
