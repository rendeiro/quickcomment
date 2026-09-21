// Shared configuration. Loaded by content.js (content script), background.js
// (service worker, via importScripts) and options.js.
//
// The API key is NOT here. It lives in chrome.storage.local, entered once
// through the extension's options page (click the toolbar icon). Nothing in
// this folder ever contains the key, so the folder is safe to copy or share.

const QC_API = {
  ENDPOINT: "https://api.anthropic.com/v1/messages",
  VERSION: "2023-06-01",
  // Hard per-request output ceiling. The read block plus three comments as
  // JSON fit in ~400 tokens even at the "mini" size; 640 leaves headroom.
  MAX_TOKENS: 640,
  // Posts longer than this are trimmed before being sent (roughly 600
  // tokens). Long posts rarely need more than their opening to comment on.
  MAX_POST_CHARS: 2500,
};

// The model. Opus 4.8 at low effort, no extended thinking: it reads tone
// and detail well, and the output is tiny so it stays quick. Prices are USD
// per million tokens, list price as of September 2026.
const QC_MODEL = { id: "claude-opus-4-8", inputPerM: 5.0, outputPerM: 25.0, effort: "low" };

// Spend guard. Every request's input + output tokens are added to a counter
// in chrome.storage.local, keyed by calendar month. When the counter reaches
// the cap, generation stops until next month or until you raise the cap or
// reset the counter in the options page. A generation is ~1,100 tokens,
// about $0.01. 300k tokens is ~270 generations, roughly $3.
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
      { key: "mini", label: "Mini", prompt: "Two or three short sentences, under 45 words total. The second sentence must add something the first did not." },
    ],
  },
  attitude: {
    label: "Attitude",
    options: [
      { key: "supportive", label: "Supportive", prompt: "On the author's side. Show you understood the point by extending it with a detail of your own, not by praising it. Warmth comes from specificity." },
      { key: "informative", label: "Informative", prompt: "Add one concrete fact, number, example, or practical tip the post did not mention. State it plainly, no lecture." },
      { key: "contrasting", label: "Contrasting", prompt: "Push back or offer a different angle. Name exactly where you differ and why, in one move. Friendly, not hedged, no 'with respect'." },
      { key: "funny", label: "Funny", prompt: "Dry wit. One playful observation or exaggeration tied to a detail in the post. No puns on the author's name, nothing at their expense." },
    ],
  },
  style: {
    label: "Style",
    options: [
      { key: "emojis", label: "Emojis", prompt: "One or two emojis that fit the content, placed at the end of a sentence, never as the first character. Exclamation marks allowed." },
      { key: "chill", label: "Chill", prompt: "Casual and conversational, like a message to a colleague you like. No emojis, no exclamation marks." },
      { key: "serious", label: "Serious", prompt: "Measured and professional. Full sentences, no emojis, no slang, no exclamation marks." },
    ],
  },
};

const QC_DEFAULT_KNOBS = { size: "short", attitude: "supportive", style: "chill" };

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