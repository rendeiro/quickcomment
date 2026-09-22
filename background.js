// MV3 service worker. Owns the API call so the key never enters the LinkedIn
// page context, and so the request is not subject to page-origin CORS (the
// worker is exempt for hosts listed in host_permissions).

importScripts("config.js");

// First-run setup: on a fresh install (or if the key was never saved), open
// the options page so the user lands on the setup steps right away.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install" && details.reason !== "update") return;
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "qc-open-options") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "qc-has-key") {
    chrome.storage.local.get("apiKey").then(({ apiKey }) => sendResponse({ ok: true, hasKey: !!apiKey }));
    return true;
  }
  if (message?.type === "qc-open-history") {
    chrome.tabs.create({ url: chrome.runtime.getURL("history.html") });
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "qc-vote") {
    markVote(message.id, message.index, message.vote).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "qc-mark-copied") {
    markCopied(message.id, message.index).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "qc-usage") {
    Promise.all([readUsage(), chrome.storage.local.get("totals")]).then(([usage, { totals }]) =>
      sendResponse({ ok: true, usage, totals: totals || null })
    );
    return true;
  }
  if (message?.type !== "qc-generate" && message?.type !== "qc-test-key") return false;

  (async () => {
    try {
      const settings = await chrome.storage.local.get(["apiKey", "workspaceId", "persona", "tokenCap"]);
      if (!settings.apiKey) {
        throw new Error("No API key set. Click the QuickComment toolbar icon and paste your key.");
      }
      await assertUnderCap(settings);

      if (message.type === "qc-test-key") {
        const data = await callClaude(settings, {
          system: "Reply with the single word OK.",
          user: "Ping.",
          schema: null,
          maxTokens: 16,
        });
        sendResponse({ ok: true, model: data.model });
        return;
      }

      const { author, knobs } = message;
      const post = trimPost(message.post);
      const taste = await recentTaste(hashText(post));
      const prompt = buildPrompt({ post, author, knobs, persona: settings.persona, feedback: message.feedback || [], taste });
      const data = await callClaude(settings, {
        system: prompt.system,
        user: prompt.user,
        schema: COMMENTS_SCHEMA,
        maxTokens: QC_API.MAX_TOKENS,
      });

      if (data.stop_reason === "refusal") {
        throw new Error("The model declined this request" + (data.stop_details?.explanation ? ": " + data.stop_details.explanation : "."));
      }
      if (data.stop_reason === "max_tokens") {
        throw new Error("Output was cut off. Try a smaller size.");
      }
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      const parsed = JSON.parse(text);
      const comments = (parsed.comments || []).map((c) => String(c.text || "").trim()).filter(Boolean).slice(0, QC_OPTION_COUNT);
      if (!comments.length) throw new Error("No comments came back.");
      const read = parsed.read || null;
      const entry = await recordHistory({ data, author, post, knobs, comments, read });
      sendResponse({ ok: true, comments, read, model: data.model, id: entry.id, cost: entry.cost });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();

  return true; // keep the channel open for the async sendResponse
});

// `read` comes first on purpose: structured output is generated in order,
// so the model commits to a reading of the post before writing comments.
const COMMENTS_SCHEMA = {
  type: "object",
  properties: {
    read: {
      type: "object",
      properties: {
        gist: { type: "string" },
        author_tone: { type: "string" },
        author_wants: { type: "string" },
        hook: { type: "string" },
        language: { type: "string" },
      },
      required: ["gist", "author_tone", "author_wants", "hook", "language"],
      additionalProperties: false,
    },
    comments: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  required: ["read", "comments"],
  additionalProperties: false,
};

function trimPost(text) {
  const t = String(text || "");
  if (t.length <= QC_API.MAX_POST_CHARS) return t;
  return t.slice(0, QC_API.MAX_POST_CHARS) + " [post trimmed]";
}

// ---------------------------------------------------------------------
// Spend guard: monthly token counter in chrome.storage.local
// ---------------------------------------------------------------------
function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function readUsage() {
  const { usage } = await chrome.storage.local.get("usage");
  if (!usage || usage.month !== monthKey()) return { month: monthKey(), tokens: 0, requests: 0 };
  return usage;
}

async function assertUnderCap(settings) {
  const cap = Number(settings.tokenCap) > 0 ? Number(settings.tokenCap) : QC_DEFAULT_MONTHLY_TOKEN_CAP;
  const usage = await readUsage();
  if (usage.tokens >= cap) {
    throw new Error(
      `Monthly token cap reached (${usage.tokens.toLocaleString()} of ${cap.toLocaleString()}). Raise the cap or reset the counter in the options page.`
    );
  }
}

function costOf(data) {
  const inp = data?.usage?.input_tokens || 0;
  const out = data?.usage?.output_tokens || 0;
  return {
    inputTokens: inp,
    outputTokens: out,
    cost: (inp * QC_MODEL.inputPerM + out * QC_MODEL.outputPerM) / 1e6,
  };
}

async function recordUsage(data) {
  const { inputTokens, outputTokens, cost } = costOf(data);
  const usage = await readUsage();
  usage.tokens += inputTokens + outputTokens;
  usage.requests += 1;
  usage.cost = (usage.cost || 0) + cost;

  const { totals = { tokens: 0, inputTokens: 0, outputTokens: 0, cost: 0, requests: 0 } } =
    await chrome.storage.local.get("totals");
  totals.tokens += inputTokens + outputTokens;
  totals.inputTokens += inputTokens;
  totals.outputTokens += outputTokens;
  totals.cost += cost;
  totals.requests += 1;

  await chrome.storage.local.set({ usage, totals });
}

// ---------------------------------------------------------------------
// History: one entry per generation
// ---------------------------------------------------------------------
async function recordHistory({ data, author, post, knobs, comments, read }) {
  const { inputTokens, outputTokens, cost } = costOf(data);
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    author: author || "",
    post: String(post || "").slice(0, 400),
    knobs: { ...knobs },
    comments,
    read: read || null,
    copied: [], // indices of the options the user copied (unique)
    votes: {}, // index -> 1 (up) | -1 (down)
    copies: 0, // total copy clicks on this generation
    postHash: hashText(post),
    model: data.model,
    inputTokens,
    outputTokens,
    cost,
  };
  const { history = [] } = await chrome.storage.local.get("history");
  history.unshift(entry);
  if (history.length > QC_HISTORY_MAX) history.length = QC_HISTORY_MAX;
  await chrome.storage.local.set({ history });
  return entry;
}

async function markVote(id, index, vote) {
  const { history = [] } = await chrome.storage.local.get("history");
  const entry = history.find((h) => h.id === id);
  if (!entry) return;
  entry.votes = entry.votes || {};
  if (vote) entry.votes[index] = vote;
  else delete entry.votes[index];
  await chrome.storage.local.set({ history });
}

// Taste memory: the most recent up- and down-voted comments on other posts,
// a handful each, so regeneration on a new post can lean toward what the
// user has liked before and away from what they have rejected.
async function recentTaste(excludePostHash) {
  const { history = [] } = await chrome.storage.local.get("history");
  const liked = [];
  const disliked = [];
  for (const h of history) {
    if (h.postHash === excludePostHash || !h.votes) continue;
    for (const [i, v] of Object.entries(h.votes)) {
      const text = h.comments?.[Number(i)];
      if (!text) continue;
      if (v === 1 && liked.length < 5) liked.push(text);
      if (v === -1 && disliked.length < 5) disliked.push(text);
    }
    if (liked.length >= 5 && disliked.length >= 5) break;
  }
  return { liked, disliked };
}

async function markCopied(id, index) {
  const { history = [] } = await chrome.storage.local.get("history");
  const entry = history.find((h) => h.id === id);
  if (!entry) return;
  if (!Array.isArray(entry.copied)) entry.copied = entry.copied == null ? [] : [entry.copied];
  if (!entry.copied.includes(index)) entry.copied.push(index);
  entry.copies = (entry.copies || 0) + 1;
  await chrome.storage.local.set({ history });
}

// Small stable hash so generations for the same post can be grouped.
function hashText(text) {
  let h = 2166136261;
  const t = String(text || "").slice(0, 400);
  for (let i = 0; i < t.length; i += 1) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

function knobPrompt(group, key) {
  const opt = QC_KNOBS[group].options.find((o) => o.key === key) || QC_KNOBS[group].options[0];
  return opt.prompt;
}

function feedbackBlock(feedback, taste) {
  const lines = [];
  const up = feedback.filter((f) => f.vote === 1);
  const down = feedback.filter((f) => f.vote === -1);
  const none = feedback.filter((f) => !f.vote);
  if (feedback.length) {
    lines.push("This is a regeneration. Earlier options for this same post, with the user's reaction:");
    up.forEach((f) => lines.push(`- GOOD (more like this): ${f.text}`));
    down.forEach((f) => lines.push(`- BAD (avoid this angle, tone and shape): ${f.text}`));
    none.forEach((f) => lines.push(`- no reaction: ${f.text}`));
    lines.push("Write three new options. None may repeat an earlier option's angle or opening. If any were marked GOOD, keep their spirit (what they pick up on, their tone and length) and vary the angle. If any were marked BAD, treat that as a hard constraint: different angle, different rhythm, and do not reuse their wording or their kind of joke or question.");
  }
  if (taste.liked.length || taste.disliked.length) {
    lines.push("");
    lines.push("The user's taste from earlier posts (different posts, so do not reuse content, only the manner):");
    taste.liked.forEach((t) => lines.push(`- liked: ${t}`));
    taste.disliked.forEach((t) => lines.push(`- disliked: ${t}`));
  }
  return lines.join("\n");
}

function buildPrompt({ post, author, knobs, persona, feedback = [], taste = { liked: [], disliked: [] } }) {
  const system = [
    "You draft LinkedIn comments for the user to post under other people's posts. Think of it as replying to a message from someone you know a bit: light, quick, human. Not a fan, not a marketer, not an assistant, not a critic writing a review.",
    "",
    "Work in two steps, in this order.",
    "",
    "STEP 1, read the post. Fill the `read` object before writing anything else:",
    "- gist: what the post is actually about, in one plain sentence. Not the topic label, the point.",
    "- author_tone: how the author sounds. Pick precise words: dry, wry, earnest, proud, vulnerable, ranting, teaching, selling, playful, grieving, bragging, matter-of-fact. Note the register too: casual or formal, first person story or general advice.",
    "- author_wants: what reaction the author is fishing for. Recognition, debate, a laugh, sympathy, sign-ups, validation of a decision, help.",
    "- hook: the single most specific detail worth picking up. A number, an object, a moment, a decision, an odd phrase. Not the main claim.",
    "- language: the language the post is written in.",
    "",
    "STEP 2, write the comments. Everything below is anchored on the read:",
    "- Match the author's tone first, then apply the knobs on top. The post sets the register, the knobs adjust it. A dry post gets a dry comment. A proud personal milestone gets warmth, not analysis. A grieving post never gets a joke, whatever the attitude knob says; in that case Funny means gentle and light, Contrasting means a soft different angle. A teaching post can take a real counterpoint.",
    "- Give the author the reaction they want, in your own words, then add a small hook: a related experience, a question they would enjoy answering, a twist. Keep the conversation going.",
    "- Build on the `hook` you identified. Say something about it the author did not already say.",
    "- Say one thing. Two points is two comments.",
    "- Write in the `language` you identified, in the same register.",
    "",
    "What a comment never does:",
    "- Parrot the post. Do not quote it, paraphrase it, or summarize it back. Borrow at most one or two words from it.",
    "- Open with praise, agreement, or the author's name. Banned openers: Great post, Love this, This, So true, Spot on, Couldn't agree more, Thanks for sharing, This resonates, Well said, Such a, As someone who, I love how.",
    "- Explain the post's own point back to the author, or tell them what they should have added.",
    "- Use an em dash or en dash. Use a comma, a period, or a new sentence.",
    "- Use hashtags, links, sign-offs, or questions aimed at the crowd.",
    "- Use corporate vocabulary: leverage, journey, game-changer, unlock, synergy, empower, navigate, landscape, elevate, impactful, resonate.",
    "- Stack exclamation marks. At most one across all options, and only if the style knob allows it.",
    "",
    "Voice: plain words, contractions, short sentences. Specific beats clever. Under-write rather than over-write. Output ready to paste: no quotes, no numbering, no labels.",
    "",
    `Produce exactly ${QC_OPTION_COUNT} options with different angles: one reacts to the hook, one brings something from the commenter's own side, one asks the author a question they would enjoy answering. All three obey the knobs. Vary length and rhythm within the size limit.`,
    "",
    "Knobs for this request:",
    `- Size: ${knobPrompt("size", knobs.size)}`,
    `- Attitude: ${knobPrompt("attitude", knobs.attitude)}`,
    `- Style: ${knobPrompt("style", knobs.style)}`,
    persona
      ? `\nAbout the commenter (only for the option that brings their own side, and only when it makes the comment more specific. Never to name-drop or self-promote):\n${persona}`
      : "",
  ].join("\n");

  const fb = feedbackBlock(feedback, taste);
  const user = [
    `Post author: ${author || "unknown"}`,
    "",
    "Post text:",
    "<post>",
    post,
    "</post>",
    fb ? "\n" + fb : "",
    "",
    `Return JSON: a "read" object (gist, author_tone, author_wants, hook, language), then a "comments" array of ${QC_OPTION_COUNT} objects, each with a "text" field.`,
  ].join("\n");

  return { system, user };
}

async function callClaude(settings, { system, user, schema, maxTokens }) {
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": settings.apiKey,
    "anthropic-version": QC_API.VERSION,
    // Requests from a browser context carry an Origin header; this opt-in
    // tells the API that is intentional. Harmless if not required.
    "anthropic-dangerous-direct-browser-access": "true",
  };
  if (settings.workspaceId) headers["anthropic-workspace-id"] = settings.workspaceId;

  // Opus 5 thinks by default. Switch it off (allowed at effort "low") so
  // no reasoning tokens are billed and max_tokens is all for the answer.
  const body = {
    model: QC_MODEL.id,
    max_tokens: maxTokens,
    thinking: { type: "disabled" },
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort: QC_MODEL.effort },
  };
  if (schema) body.output_config.format = { type: "json_schema", schema };

  const res = await fetch(QC_API.ENDPOINT, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  await recordUsage(data);
  return data;
}
