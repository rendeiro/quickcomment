// Shared configuration. Loaded by content.js (content script), background.js
// (service worker, via importScripts) and options.js.
//
// The API key is NOT here. It lives in chrome.storage.local, entered once
// through the extension's options page (click the toolbar icon). Nothing in
// this folder ever contains the key, so the folder is safe to copy or share.

const QC_API = {
  ENDPOINT: "https://api.anthropic.com/v1/messages",
  VERSION: "2023-06-01",
  // Per-request output ceiling. The read block plus three comments as JSON
  // fit in ~400 tokens, but on Opus 5.5 adaptive thinking also counts
  // against this, so leave room. Cost stays capped by the number itself.
  MAX_TOKENS: 2048,
  // Posts longer than this are trimmed before being sent (roughly 600
  // tokens). Long posts rarely need more than their opening to comment on.
  MAX_POST_CHARS: 2500,
};

// The model. Opus 5.5 (released 2026-09-22) at low effort. Thinking is
// always on for this model and cannot be disabled; at low effort it stays
// small. Thinking tokens bill as output, so max_tokens must leave room.
// Sonnet 5 ($2 in / $10 out) is the cheap alternative: swap the id and the
// two prices. Prices are USD per million tokens, list price, September 2026.
const QC_MODEL = { id: "claude-opus-5-5", inputPerM: 4.0, outputPerM: 20.0, effort: "low" };

// Spend guard. Every request's input + output tokens are added to a counter
// in chrome.storage.local, keyed by calendar month. When the counter reaches
// the cap, generation stops until next month or until you raise the cap or
// reset the counter in the options page. A generation is ~1,200 tokens
// including a little thinking, about $0.01. 300k tokens is ~250
// generations, roughly $3.
const QC_DEFAULT_MONTHLY_TOKEN_CAP = 300000;

// How many past generations to keep. Oldest are dropped beyond this.
const QC_HISTORY_MAX = 500;

// The three knobs. `key` is what gets stored and sent; `label` is the pill
// text; `prompt` is the instruction fragment the model sees.
const QC_KNOBS = {
  size: {
    label: "Size",
    options: [
      { key: "ultra", label: "Ultra short", prompt: "One line, at most 8 words. A fragment is fine." },
      { key: "short", label: "Short", prompt: "One sentence, two at most, under 20 words total." },
    ],
  },
  attitude: {
    label: "Attitude",
    options: [
      { key: "supportive", label: "Supportive", prompt: "On the author's side. Show you understood the point by extending it with a detail of your own, not by praising it. Warmth comes from specificity." },
      { key: "insights", label: "Insights", prompt: "Add one concrete thing the post did not say: a number, an example, a counterexample, a practical tip, or a sharp question. Can agree or disagree. State it plainly, no lecture." },
      { key: "funny", label: "Funny", prompt: "Dry wit. One playful observation or exaggeration tied to a detail in the post. No puns on the author's name, nothing at their expense." },
    ],
  },
  style: {
    label: "Style",
    options: [
      { key: "emoji", label: "Emoji", prompt: "Exactly one emoji per option, at the end of a sentence, never as the first character. One exclamation mark allowed across all options." },
      { key: "neutral", label: "Neutral", prompt: "Conversational but clean: contractions fine, no slang, no emojis, no exclamation marks." },
    ],
  },
};

const QC_DEFAULT_KNOBS = { size: "short", attitude: "supportive", style: "neutral" };

// How many comment options to produce per generation.
const QC_OPTION_COUNT = 3;


// Quality metrics computed from the stored history. Shared by the popup and
// the history page. A generation "landed" when at least one option was
// copied. A post is "unserved" when none of its generations landed.
function qcCopiedIndices(entry) {
  if (Array.isArray(entry.copied)) return entry.copied;
  return entry.copied == null ? [] : [entry.copied];
}

function qcQuality(history) {
  const gens = history.length;
  let landed = 0;
  let copies = 0;
  const posts = new Map(); // postHash -> landed?
  for (const h of history) {
    const c = qcCopiedIndices(h);
    if (c.length) landed += 1;
    copies += h.copies || c.length;
    const key = h.postHash || h.id;
    posts.set(key, (posts.get(key) || false) || c.length > 0);
  }
  const postCount = posts.size;
  const unserved = Array.from(posts.values()).filter((v) => !v).length;
  return {
    generations: gens,
    landed,
    copies,
    copyRate: gens ? landed / gens : 0,
    posts: postCount,
    postsUnserved: unserved,
  };
}