// QuickComment content script. Runs on the LinkedIn feed and on /posts/ pages.
//
// Post detection anchors on accessibility markup because LinkedIn's CSS
// classes are hashed and unstable: each card has a hidden <h2> heading and a
// button[aria-label="Open control menu for post by <Name>"] that also gives
// us the author. The post's own text is whichever element follows the actor
// block. The trigger and panel are placed directly under the
// Like / Comment / Repost action bar, which is exactly where LinkedIn opens
// its comment editor, so generated comments land next to where they get used.

(() => {
  "use strict";

  const ALLOWED_PATHS = ["/feed", "/posts/"];
  if (!ALLOWED_PATHS.some((p) => location.pathname.startsWith(p))) return;

  const WIRED_ATTR = "data-qc-wired";
  const CONTROL_BUTTON_PREFIX = "Open control menu for post by ";
  const CONTROL_BUTTON_SELECTOR = `button[aria-label^="${CONTROL_BUTTON_PREFIX}"]`;

  // chrome.runtime.sendMessage throws synchronously once the extension has
  // been reloaded while this tab stayed open ("Extension context
  // invalidated"). Route every message through here so that case turns into
  // a visible note instead of a silent failure.
  const STALE_MSG = "QuickComment was updated. Refresh this page (Cmd+R) to keep using it.";
  function alive() {
    try {
      return !!(chrome?.runtime?.id && chrome?.storage?.local);
    } catch {
      return false;
    }
  }

  async function send(message) {
    if (!alive()) return { ok: false, error: STALE_MSG };
    try {
      const res = await chrome.runtime.sendMessage(message);
      return res || { ok: false, error: "No response from the extension. Refresh this page." };
    } catch (err) {
      const stale = /context invalidated|Extension context|sendMessage/i.test(String(err));
      return { ok: false, error: stale ? STALE_MSG : String(err?.message || err) };
    }
  }

  let knobs = { ...QC_DEFAULT_KNOBS };
  chrome.storage.local.get("knobs").then((s) => {
    if (!s || !s.knobs) return;
    // Keep stored choices only if they still exist (knob sets change).
    for (const group of Object.keys(QC_KNOBS)) {
      const valid = QC_KNOBS[group].options.some((o) => o.key === s.knobs[group]);
      if (valid) knobs[group] = s.knobs[group];
    }
  });

  // ------------------------------------------------------------------
  // Post discovery
  // ------------------------------------------------------------------
  function findPosts(root) {
    const scope = root.querySelectorAll ? root : document;
    const posts = [];
    scope.querySelectorAll("h2").forEach((h2) => {
      const card = h2.parentElement;
      if (!card || card.hasAttribute(WIRED_ATTR)) return;
      const isFeedHeading = h2.textContent.trim() === "Feed post";
      const hasControl = !!card.querySelector(CONTROL_BUTTON_SELECTOR);
      if (isFeedHeading || hasControl) posts.push(card);
    });
    return posts;
  }

  function getAuthor(card) {
    const btn = card.querySelector(CONTROL_BUTTON_SELECTOR);
    return btn ? btn.getAttribute("aria-label").slice(CONTROL_BUTTON_PREFIX.length).trim() : null;
  }

  function getActorBlock(card, name) {
    return Array.from(card.children).find((c) => c.textContent.includes(name)) || null;
  }

  function getTextElement(card) {
    const name = getAuthor(card);
    if (!name) return null;
    const actor = getActorBlock(card, name);
    return actor ? actor.nextElementSibling : null;
  }

  function getPostText(card) {
    const el = getTextElement(card);
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll(".qc-root").forEach((n) => n.remove());
    return clone.textContent.replace(/\s+/g, " ").replace(/…more$/i, "").trim();
  }

  // The Like / Comment / Repost bar: climb from the Comment button to the
  // first ancestor that also contains Like and Repost.
  // LinkedIn's comment control is usually a <button aria-label="Comment">,
  // but the label may carry extra words or the control may be a
  // role="button" element, so match loosely and skip our own UI.
  function getCommentButton(scope) {
    const candidates = scope.querySelectorAll('button, [role="button"]');
    for (const b of candidates) {
      if (b.closest(".qc-root")) continue;
      const label = ((b.getAttribute("aria-label") || "") + " " + (b.textContent || "")).replace(/\s+/g, " ").trim();
      if (/^comment\b/i.test(label) || /\bcomment on\b/i.test(label) || /^comentar\b/i.test(label)) return b;
    }
    return null;
  }

  function getRepostButton(scope) {
    const candidates = scope.querySelectorAll('button, [role="button"]');
    for (const b of candidates) {
      if (b.closest(".qc-root")) continue;
      const label = ((b.getAttribute("aria-label") || "") + " " + (b.textContent || "")).replace(/\s+/g, " ").trim();
      if (/^(repost|republicar)\b/i.test(label)) return b;
    }
    return null;
  }

  // The bar is the nearest ancestor of the Comment button that also holds
  // the Repost button. Like is not used: its accessible label is
  // "Reaction button state: ..." with no word "Like" in the DOM.
  function findBarWithin(scope, stopAt) {
    const comment = getCommentButton(scope);
    const repost = getRepostButton(scope);
    if (!comment || !repost) return null;
    let el = comment.parentElement;
    while (el && el !== stopAt) {
      if (el.contains(repost)) return el;
      el = el.parentElement;
    }
    return null;
  }

  // The bar is usually inside the card, but on some layouts it sits in a
  // sibling container. Search the card, then up to three ancestors.
  function getActionBar(card) {
    let scope = card;
    for (let i = 0; i < 4 && scope; i += 1) {
      const bar = findBarWithin(scope, scope.parentElement);
      if (bar) return bar;
      scope = scope.parentElement;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Wiring. LinkedIn adds a card first and fills it (text, action bar) a
  // moment later, so a card that is not ready is left unmarked and retried
  // on the next scan. After MAX_ATTEMPTS it is given up on (image-only
  // posts, ads without a bar).
  // ------------------------------------------------------------------
  const ATTEMPTS_ATTR = "data-qc-attempts";
  const MAX_ATTEMPTS = 6;

  function wire(card) {
    const attempts = Number(card.getAttribute(ATTEMPTS_ATTR) || 0) + 1;
    card.setAttribute(ATTEMPTS_ATTR, String(attempts));

    const text = getPostText(card);
    let bar = getActionBar(card);
    let anchor = bar;
    if (text.length < 20 || !bar) {
      if (attempts < MAX_ATTEMPTS) return false;
      // Last attempt: if there is text but no bar was found, anchor the
      // trigger after the post text so the feature still works.
      if (text.length >= 20) {
        anchor = getTextElement(card);
        console.log("[QuickComment] no action bar found, anchoring under post text:", { author: getAuthor(card) });
      }
      if (!anchor) {
        card.setAttribute(WIRED_ATTR, "skip");
        console.log("[QuickComment] gave up on a card:", { author: getAuthor(card), textLen: text.length, hasBar: !!bar });
        return false;
      }
    }

    card.setAttribute(WIRED_ATTR, "1");
    const root = document.createElement("div");
    root.className = "qc-root";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "qc-trigger";
    trigger.innerHTML = '<span class="qc-trigger__spark">✦</span> Propose comment ideas';
    trigger.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel(root, card, trigger);
    });

    root.appendChild(trigger);
    anchor.insertAdjacentElement("afterend", root);
    return true;
  }

  async function togglePanel(root, card, trigger) {
    const existing = root.querySelector(".qc-panel");
    if (existing) {
      existing.remove();
      trigger.classList.remove("qc-trigger--open");
      return;
    }
    trigger.classList.add("qc-trigger--open");
    const res = await send({ type: "qc-has-key" });
    if (!res.ok) {
      root.appendChild(buildNotePanel(res.error));
      return;
    }
    if (!res.hasKey) {
      root.appendChild(buildSetupPanel());
      return;
    }
    const panel = buildPanel(card);
    root.appendChild(panel);
    panel.qcGenerate();
  }

  function buildNotePanel(text) {
    const panel = document.createElement("div");
    panel.className = "qc-panel";
    const msg = document.createElement("div");
    msg.className = "qc-status qc-status--error";
    msg.textContent = text;
    panel.appendChild(msg);
    return panel;
  }

  function buildSetupPanel() {
    const panel = document.createElement("div");
    panel.className = "qc-panel";
    panel.addEventListener("click", (e) => e.stopPropagation());
    const msg = document.createElement("div");
    msg.className = "qc-setup__text";
    msg.textContent = "QuickComment needs an Anthropic API key before it can write comments. Setup takes about 3 minutes.";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "qc-go";
    btn.textContent = "Set up key";
    btn.addEventListener("click", () => send({ type: "qc-open-options" }));
    panel.append(msg, btn);
    return panel;
  }

  // Panel: results first, then a footer with Regenerate and a collapsed
  // Options toggle for the knobs. Every round's options and votes are kept
  // on the panel so regeneration can send them back as feedback.
  function buildPanel(card, opts = null) {
    const panel = document.createElement("div");
    panel.className = "qc-panel";
    panel.addEventListener("click", (e) => e.stopPropagation());
    const rounds = []; // [{ id, comments: [text], votes: {index: 1|-1} }]

    const results = document.createElement("div");
    results.className = "qc-results";

    const footer = document.createElement("div");
    footer.className = "qc-actions";
    const go = document.createElement("button");
    go.type = "button";
    go.className = "qc-go";
    go.textContent = "Regenerate";
    const optionsBtn = document.createElement("button");
    optionsBtn.type = "button";
    optionsBtn.className = "qc-options-toggle";
    optionsBtn.textContent = "Options";
    const status = document.createElement("span");
    status.className = "qc-status";
    footer.append(go, optionsBtn);

    // Reply mode: say which register was picked. Decided automatically from
    // the post author's profile link against the user's own.
    if (opts?.mode === "reply") {
      const role = document.createElement("span");
      role.className = "qc-role";
      const who = opts.target?.author ? ` to ${opts.target.author}` : "";
      role.textContent = opts.asAuthor ? `Replying${who} as the post's author` : `Replying${who} as a reader`;
      role.title = `you: ${meVanity || "unknown"}${meSource ? ` (${meSource})` : ""} · post author: ${opts.postVanity || "unknown"}`;
      const why = document.createElement("span");
      why.className = "qc-role__why";
      why.textContent = ` · you: ${meVanity || meName || "?"} · post: ${opts.postVanity || opts.ctx?.author || "?"}`;
      role.appendChild(why);
      footer.appendChild(role);
    }
    footer.appendChild(status);

    const knobsWrap = document.createElement("div");
    knobsWrap.className = "qc-knobs";
    knobsWrap.hidden = true;
    for (const group of Object.keys(QC_KNOBS)) knobsWrap.appendChild(buildKnobRow(group));
    optionsBtn.addEventListener("click", () => {
      knobsWrap.hidden = !knobsWrap.hidden;
      optionsBtn.classList.toggle("qc-options-toggle--open", !knobsWrap.hidden);
    });

    panel.append(results, footer, knobsWrap);

    panel.qcGenerate = () => generate(card, opts, { go, status, results, rounds });
    go.addEventListener("click", panel.qcGenerate);
    return panel;
  }

  function buildKnobRow(group) {
    const row = document.createElement("div");
    row.className = "qc-row";
    const label = document.createElement("span");
    label.className = "qc-row__label";
    label.textContent = QC_KNOBS[group].label;
    row.appendChild(label);

    const pills = document.createElement("div");
    pills.className = "qc-pills";
    for (const opt of QC_KNOBS[group].options) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "qc-pill" + (knobs[group] === opt.key ? " qc-pill--on" : "");
      pill.textContent = opt.label;
      pill.addEventListener("click", () => {
        knobs[group] = opt.key;
        if (alive()) chrome.storage.local.set({ knobs });
        pills.querySelectorAll(".qc-pill").forEach((p) => p.classList.toggle("qc-pill--on", p === pill));
      });
      pills.appendChild(pill);
    }
    row.appendChild(pills);
    return row;
  }

  async function generate(card, opts, ui) {
    const { go, status, results, rounds } = ui;
    const isReply = opts?.mode === "reply";
    const post = isReply ? opts.ctx.post : getPostText(card);
    const author = isReply ? opts.ctx.author : getAuthor(card);
    const reply = isReply ? opts.target : null;
    if (!post && !reply) {
      status.textContent = "Could not read the post text.";
      return;
    }
    go.disabled = true;
    go.classList.add("qc-go--busy");
    status.textContent = rounds.length ? "Rewriting with your feedback…" : isReply ? "Reading the comment…" : "Reading the post…";
    status.classList.remove("qc-status--error");

    const feedback = rounds.flatMap((r) =>
      r.comments.map((text, i) => ({ text, vote: r.votes[i] || 0 }))
    );
    const response = await send({
      type: "qc-generate",
      post,
      author,
      reply: reply ? { text: reply.text, author: reply.author, byPostAuthor: !!reply.byPostAuthor } : null,
      thread: isReply ? (opts.thread || []).map((t) => ({ author: t.author, text: t.text, byPostAuthor: !!t.byPostAuthor, isMe: !!t.isMe, isTarget: !!t.isTarget })) : [],
      asAuthor: isReply ? !!opts.asAuthor : false,
      knobs: { ...knobs },
      feedback,
    });
    go.disabled = false;
    go.classList.remove("qc-go--busy");

    if (!response.ok) {
      status.textContent = response.error || "No response from the extension.";
      status.classList.add("qc-status--error");
      return;
    }
    status.textContent = "";
    results.replaceChildren();

    const round = { id: response.id, comments: response.comments, votes: {} };
    rounds.push(round);

    if (response.read) {
      const read = document.createElement("div");
      read.className = "qc-read";
      read.textContent = `Read as: ${response.read.gist} Tone: ${response.read.author_tone}. Hook: ${response.read.hook}`;
      results.appendChild(read);
    }
    response.comments.forEach((text, i) => results.appendChild(buildResult(round, text, i)));

    const foot = document.createElement("div");
    foot.className = "qc-foot";
    const cost = document.createElement("span");
    cost.textContent = `${response.model} · ~$${(response.cost || 0).toFixed(4)}${rounds.length > 1 ? ` · round ${rounds.length}` : ""}`;
    const hist = document.createElement("a");
    hist.href = "#";
    hist.className = "qc-link";
    hist.textContent = "History";
    hist.addEventListener("click", (e) => {
      e.preventDefault();
      send({ type: "qc-open-history" });
    });
    foot.append(cost, hist);
    results.appendChild(foot);
  }

  function buildResult(round, text, index) {
    const item = document.createElement("div");
    item.className = "qc-result";

    const body = document.createElement("div");
    body.className = "qc-result__text";
    body.textContent = text;

    const side = document.createElement("div");
    side.className = "qc-result__side";

    const votes = document.createElement("div");
    votes.className = "qc-votes";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "qc-vote";
    up.textContent = "▲";
    up.title = "Good. More like this.";
    const down = document.createElement("button");
    down.type = "button";
    down.className = "qc-vote";
    down.textContent = "▼";
    down.title = "Bad. Avoid this.";
    const setVote = (v) => {
      const next = round.votes[index] === v ? 0 : v;
      round.votes[index] = next;
      up.classList.toggle("qc-vote--on", next === 1);
      down.classList.toggle("qc-vote--on", next === -1);
      item.classList.toggle("qc-result--down", next === -1);
      if (round.id != null) send({ type: "qc-vote", id: round.id, index, vote: next });
    };
    up.addEventListener("click", () => setVote(1));
    down.addEventListener("click", () => setVote(-1));
    votes.append(up, down);

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "qc-copy";
    copy.textContent = "Copy";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = "Copied";
        copy.classList.add("qc-copy--done");
        item.classList.add("qc-result--used");
        if (round.id != null) send({ type: "qc-mark-copied", id: round.id, index });
      } catch {
        copy.textContent = "Failed";
      }
    });

    side.append(votes, copy);
    item.append(body, side);
    return item;
  }

  // ------------------------------------------------------------------
  // Reply ideas, shown only once the user opens LinkedIn's reply box.
  // Anchors verified on a live post page:
  //   button[aria-label="Reply"] with no text      -> the speech-bubble icon
  //   a [contenteditable] whose box holds a button  -> the reply editor
  //     with the text "Reply"                          (the main comment box
  //                                                     says "Comment")
  //   button[aria-label^="View more options for "]  -> "…for <Name>’s comment."
  //   a leaf element with text "Author"             -> commenter wrote the post
  //   name and headline sit inside <a href="/in/…">; the comment body is
  //   the longest text outside links, buttons and editors.
  // A comment's container is the largest ancestor holding exactly one
  // reply icon, which excludes nested replies below it.
  // ------------------------------------------------------------------
  const REPLY_EDITOR_WIRED = "data-qc-reply-editor";

  // Who is the user? LinkedIn redirects /in/me/ to the user's own profile,
  // so one same-origin fetch yields the profile slug ("rendeiro"). Cached
  // for a day. Used to tell "you wrote this post" and "this reply is yours".
  let meVanity = "";
  function vanityFromHref(href) {
    const m = String(href || "").match(/\/in\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]).toLowerCase() : "";
  }
  let meName = "";
  const normName = (n) => String(n || "").toLowerCase().replace(/\s+/g, " ").trim();
  function altToName(alt) {
    const t = String(alt || "").replace(/^(photo of|picture of|profile photo of|foto de)\s+/i, "").trim();
    if (!t || t.length > 60 || t.split(" ").length < 2) return "";
    if (/^(linkedin|profile|avatar|photo)$/i.test(t)) return "";
    return t;
  }
  // The user's own avatar sits next to every comment/reply editor. Its alt
  // is the user's name. Checked whenever an editor is wired.
  function learnMeFromEditor(editor) {
    if (meName) return;
    let el = editor.parentElement;
    for (let i = 0; i < 6 && el && el !== document.body; i += 1) {
      const imgs = Array.from(el.querySelectorAll("img[alt]")).filter((im) => !im.closest("[contenteditable]"));
      for (const im of imgs) {
        const n = altToName(im.getAttribute("alt"));
        if (n) {
          meName = n;
          if (alive()) chrome.storage.local.set({ meName: n });
          console.log(`[QuickComment] you are "${n}" (avatar next to the editor)`);
          return;
        }
      }
      el = el.parentElement;
    }
  }
  chrome.storage.local.get("meName").then((s) => {
    if (s && s.meName && !meName) meName = s.meName;
  });

  let meSource = "";
  function rememberMe(v, source) {
    meVanity = v;
    meSource = source;
    if (alive()) chrome.storage.local.set({ meVanity: v, meAt: Date.now(), meSource: source });
    console.log(`[QuickComment] you are /in/${v} (via ${source})`);
  }

  // Three ways, tried in order:
  // 1. same-origin fetch of /in/me/, which redirects to the profile
  // 2. the same fetch from the background worker (page CSP cannot block it)
  // 3. the page's own embedded data, which names the viewer's publicIdentifier
  async function loadMe() {
    try {
      const s = await chrome.storage.local.get(["meVanity", "meAt", "meSource"]);
      if (s && s.meVanity && Date.now() - (s.meAt || 0) < 86400000) {
        meVanity = s.meVanity;
        meSource = s.meSource || "cache";
        return;
      }
    } catch {}
    try {
      const res = await fetch("https://www.linkedin.com/in/me/", { redirect: "follow", credentials: "include" });
      const v = vanityFromHref(res.url);
      if (v && v !== "me") return rememberMe(v, "page fetch");
      console.log("[QuickComment] /in/me/ did not redirect from the page, final url:", res.url);
    } catch (err) {
      console.log("[QuickComment] /in/me/ fetch from page failed:", String(err));
    }
    const bg = await send({ type: "qc-whoami" });
    if (bg.ok && bg.vanity) return rememberMe(bg.vanity, "background fetch");
    console.log("[QuickComment] /in/me/ from background:", bg.error || "no vanity");
    const embedded = meFromEmbeddedData();
    if (embedded) return rememberMe(embedded, "embedded data");
    console.log("[QuickComment] could not find who you are");
  }

  function meFromEmbeddedData() {
    const blobs = Array.from(document.querySelectorAll("code, script[type='application/json']"));
    for (const b of blobs) {
      const t = b.textContent || "";
      if (!t.includes("publicIdentifier")) continue;
      const me = t.match(/"\$type":"com\.linkedin\.voyager(?:\.dash)?\.common\.Me"[\s\S]{0,4000}?"publicIdentifier":"([^"]+)"/);
      if (me) return me[1].toLowerCase();
      const plain = t.match(/"publicIdentifier":"([^"]+)"[\s\S]{0,4000}?"\$type":"com\.linkedin\.voyager(?:\.dash)?\.common\.Me"/);
      if (plain) return plain[1].toLowerCase();
    }
    return "";
  }
  loadMe();

  function postVanityFor(container, ctxCard) {
    if (ctxCard) {
      const name = getAuthor(ctxCard);
      const actor = name ? getActorBlock(ctxCard, name) : null;
      const link = actor ? actor.querySelector('a[href*="/in/"], a[href*="/company/"]') : null;
      const v = link ? vanityFromHref(link.getAttribute("href")) : "";
      if (v) return v;
    }
    const m = location.pathname.match(/^\/posts\/([^_/]+)_/);
    if (m) return decodeURIComponent(m[1]).toLowerCase();
    // A comment carrying the "Author" badge links to the post author.
    const badged = replyIconsIn(document).map(commentContainerOf).filter(Boolean).find(commentIsByPostAuthor);
    return badged ? commentVanity(badged) : "";
  }

  function commentVanity(container) {
    const link = container.querySelector('a[href*="/in/"]');
    return link ? vanityFromHref(link.getAttribute("href")) : "";
  }

  // The thread a comment belongs to. LinkedIn nests one level: a top-level
  // comment followed by its replies, indented further right. Returns the
  // top-level comment plus every reply under it, in order.
  function threadFor(container) {
    const all = replyIconsIn(document).map(commentContainerOf).filter(Boolean);
    const idx = all.indexOf(container);
    if (idx < 0) return [container];
    const left = (c) => Math.round(c.getBoundingClientRect().left);
    const L = left(container);
    let start = idx;
    for (let i = idx - 1; i >= 0; i -= 1) {
      if (left(all[i]) < L) { start = i; break; }
    }
    const base = left(all[start]);
    const out = [all[start]];
    for (let i = start + 1; i < all.length; i += 1) {
      if (left(all[i]) <= base) break;
      out.push(all[i]);
    }
    return out;
  }

  function describeComment(c, target) {
    const v = commentVanity(c);
    return {
      author: commentAuthor(c),
      text: commentText(c).slice(0, 600),
      byPostAuthor: commentIsByPostAuthor(c),
      isMe: !!((meVanity && v === meVanity) || (meName && normName(commentAuthor(c)) === normName(meName))),
      isTarget: c === target,
    };
  }

  function isReplyIcon(b) {
    return b.getAttribute("aria-label") === "Reply" && (b.textContent || "").trim() === "";
  }
  function replyIconsIn(el) {
    return Array.from(el.querySelectorAll('button[aria-label="Reply"]')).filter(isReplyIcon);
  }

  function commentContainerOf(replyIcon) {
    let cand = replyIcon;
    let up = replyIcon.parentElement;
    while (up && up !== document.body && replyIconsIn(up).length === 1) {
      cand = up;
      up = up.parentElement;
    }
    return cand === replyIcon ? null : cand;
  }

  function commentAuthor(container) {
    const btn = container.querySelector('button[aria-label^="View more options for "]');
    if (!btn) return "";
    const m = btn.getAttribute("aria-label").match(/^View more options for (.+?)[’']s comment/i);
    return m ? m[1].trim() : "";
  }

  function commentIsByPostAuthor(container) {
    return Array.from(container.querySelectorAll("span, div")).some(
      (e) => e.children.length === 0 && /^author$/i.test((e.textContent || "").trim())
    );
  }

  function commentText(container) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let best = null;
    let node;
    while ((node = walker.nextNode())) {
      const t = node.nodeValue.replace(/\s+/g, " ").trim();
      if (t.length < 8) continue;
      const el = node.parentElement;
      if (!el || el.closest("a, button, time, .qc-root, [contenteditable]")) continue;
      if (!best || t.length > best.t.length) best = { t, el };
    }
    if (!best) return "";
    // Widen to the body element: climb while the parent adds only body
    // text (mentions are short links), stopping before the header link or
    // the action row.
    let body = best.el;
    while (body.parentElement && body.parentElement !== container) {
      const parent = body.parentElement;
      if (parent.querySelector('button[aria-label="Reply"], [contenteditable]')) break;
      const links = Array.from(parent.querySelectorAll('a[href*="/in/"], a[href*="/company/"]'));
      const onlyMentions = links.every((a) => (a.textContent || "").trim().length < 40);
      if (!onlyMentions) break;
      body = parent;
    }
    return (body.textContent || "").replace(/\s+/g, " ").trim();
  }

  // The reply editor's box: the nearest ancestor of the editor that holds
  // the submit button whose text is "Reply".
  function replyBoxOf(editor) {
    let box = editor.parentElement;
    for (let i = 0; i < 8 && box && box !== document.body; i += 1) {
      const submit = Array.from(box.querySelectorAll("button")).find((b) => /^reply$/i.test((b.textContent || "").trim()));
      if (submit) return box;
      box = box.parentElement;
    }
    return null;
  }

  // The comment the reply box belongs to: climb to the first ancestor
  // holding reply icons; with one icon that ancestor is (inside) the
  // comment, with several pick the icon sitting nearest above the box.
  function commentForBox(box) {
    let el = box.parentElement;
    while (el && el !== document.body && replyIconsIn(el).length === 0) el = el.parentElement;
    if (!el || el === document.body) return null;
    const icons = replyIconsIn(el);
    if (icons.length === 1) return commentContainerOf(icons[0]);
    const top = box.getBoundingClientRect().top;
    const above = icons.filter((b) => b.getBoundingClientRect().bottom <= top + 2);
    const icon = above.length ? above[above.length - 1] : icons[0];
    return commentContainerOf(icon);
  }

  const replyRoots = []; // [{ root, box }] so we can drop panels whose box closed
  function wireReplyEditors() {
    document.querySelectorAll('[contenteditable="true"]').forEach((editor) => {
      if (editor.hasAttribute(REPLY_EDITOR_WIRED) || editor.closest(".qc-root")) return;
      learnMeFromEditor(editor);
      const box = replyBoxOf(editor);
      if (!box) return; // main comment box, or not a reply editor
      const container = commentForBox(box);
      if (!container) return;
      editor.setAttribute(REPLY_EDITOR_WIRED, "1");

      const root = document.createElement("div");
      root.className = "qc-root qc-root--reply";
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "qc-trigger";
      trigger.innerHTML = '<span class="qc-trigger__spark">✦</span> Propose reply ideas';
      trigger.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleReplyPanel(root, container, trigger);
      });
      root.appendChild(trigger);
      box.insertAdjacentElement("afterend", root);
      replyRoots.push({ root, box });
      console.log("[QuickComment] reply box wired for", commentAuthor(container) || "unknown commenter");
    });
    // Drop panels whose reply box has been closed.
    for (let i = replyRoots.length - 1; i >= 0; i -= 1) {
      if (!document.contains(replyRoots[i].box)) {
        replyRoots[i].root.remove();
        replyRoots.splice(i, 1);
      }
    }
  }

  async function toggleReplyPanel(root, container, trigger) {
    const existing = root.querySelector(".qc-panel");
    if (existing) {
      existing.remove();
      trigger.classList.remove("qc-trigger--open");
      return;
    }
    trigger.classList.add("qc-trigger--open");
    const res = await send({ type: "qc-has-key" });
    if (!res.ok) {
      root.appendChild(buildNotePanel(res.error));
      return;
    }
    if (!res.hasKey) {
      root.appendChild(buildSetupPanel());
      return;
    }
    if (!meVanity) await loadMe();
    const ctx = postContextFor(container, container.getBoundingClientRect());
    const postVanity = postVanityFor(container, ctx.card);
    const asAuthor =
      !!(meVanity && postVanity && postVanity === meVanity) ||
      !!(meName && ctx.author && normName(ctx.author) === normName(meName));
    const thread = threadFor(container).map((c) => describeComment(c, container)).slice(0, 14);
    const target = thread.find((t) => t.isTarget) || describeComment(container, container);
    console.log(`[QuickComment] reply role: you=${meVanity || meName || "?"} post=${postVanity || ctx.author || "?"} asAuthor=${asAuthor}`);
    const panel = buildPanel(null, { mode: "reply", ctx, target, thread, asAuthor, postVanity });
    root.appendChild(panel);
    panel.qcGenerate();
  }

  // ------------------------------------------------------------------
  // Reply ideas from a text selection. Highlight any comment's text and a
  // small bubble appears; click it and a floating panel opens under the
  // selection with reply options. No dependence on LinkedIn's comment
  // markup: the selection is the comment, the nearest post card above it
  // is the context.
  // ------------------------------------------------------------------
  let bubble = null;
  let floating = null;

  function hideBubble() {
    if (bubble) bubble.remove();
    bubble = null;
  }
  function closeFloating() {
    if (floating) floating.remove();
    floating = null;
  }

  function selectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const text = sel.toString().replace(/\s+/g, " ").trim();
    if (text.length < 4 || text.length > 2000) return null;
    const range = sel.getRangeAt(0);
    let node = range.commonAncestorContainer;
    if (node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;
    if (!node || node.closest(".qc-root, .qc-bubble")) return null;
    if (node.closest('[contenteditable="true"], input, textarea')) return null;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    return { text, node, rect };
  }

  // Best effort: the commenter's name is the first profile link in the
  // smallest ancestor that has one.
  function guessCommenter(node) {
    let el = node;
    for (let i = 0; i < 8 && el; i += 1) {
      const link = el.querySelector ? el.querySelector('a[href*="/in/"], a[href*="/company/"]') : null;
      if (link) {
        const name = (link.textContent || "").replace(/\s+/g, " ").trim().split(/ • | · /)[0];
        if (name && name.length < 60) return name;
      }
      el = el.parentElement;
    }
    return "";
  }

  // The post the comment belongs to: the card containing the selection,
  // else the nearest wired card above it on the page.
  function postContextFor(node, rect) {
    let card = node.closest(`[${WIRED_ATTR}="1"]`);
    if (!card) {
      const cards = Array.from(document.querySelectorAll(`[${WIRED_ATTR}="1"]`));
      const above = cards.filter((c) => c.getBoundingClientRect().top <= rect.top);
      card = above.length ? above[above.length - 1] : cards[0] || null;
    }
    if (!card) return { post: "", author: "", card: null };
    return { post: getPostText(card), author: getAuthor(card) || "", card };
  }

  function showBubble(info) {
    hideBubble();
    bubble = document.createElement("button");
    bubble.type = "button";
    bubble.className = "qc-bubble";
    bubble.innerHTML = '<span class="qc-trigger__spark">✦</span> Reply ideas';
    bubble.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
    bubble.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideBubble();
      openReplyPanel(info);
    });
    document.body.appendChild(bubble);
    const top = window.scrollY + info.rect.top - bubble.offsetHeight - 8;
    const left = window.scrollX + Math.max(8, Math.min(info.rect.left, window.innerWidth - bubble.offsetWidth - 8));
    bubble.style.top = `${Math.max(window.scrollY + 8, top)}px`;
    bubble.style.left = `${left}px`;
  }

  function openReplyPanel(info) {
    closeFloating();
    const ctx = postContextFor(info.node, info.rect);
    const postVanity = postVanityFor(info.node, ctx.card);
    const asAuthor =
      !!(meVanity && postVanity && postVanity === meVanity) ||
      !!(meName && ctx.author && normName(ctx.author) === normName(meName));
    const target = { text: info.text, author: guessCommenter(info.node), byPostAuthor: false, isMe: false, isTarget: true };

    floating = document.createElement("div");
    floating.className = "qc-root qc-float";

    const head = document.createElement("div");
    head.className = "qc-float__head";
    const title = document.createElement("span");
    title.innerHTML = `<span class="qc-trigger__spark">✦</span> Reply to ${escapeHtml(target.author || "this comment")}`;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "qc-float__close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.addEventListener("click", closeFloating);
    head.append(title, close);

    const quote = document.createElement("div");
    quote.className = "qc-float__quote";
    quote.textContent = info.text.length > 220 ? info.text.slice(0, 220) + "…" : info.text;

    const panel = buildPanel(null, { mode: "reply", ctx, target, thread: [target], asAuthor, postVanity });
    floating.append(head, quote, panel);
    document.body.appendChild(floating);

    const width = Math.min(560, window.innerWidth - 32);
    floating.style.width = `${width}px`;
    const left = window.scrollX + Math.max(16, Math.min(info.rect.left, window.innerWidth - width - 16));
    floating.style.left = `${left}px`;
    floating.style.top = `${window.scrollY + info.rect.bottom + 8}px`;
    panel.qcGenerate();
  }

  function escapeHtml(t) {
    return String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  let lastSelText = "";
  function maybeShowBubble(source) {
    const info = selectionInfo();
    if (!info) {
      hideBubble();
      lastSelText = "";
      return;
    }
    if (info.text === lastSelText && bubble) return;
    lastSelText = info.text;
    console.log(`[QuickComment] selection via ${source}: ${info.text.length} chars`);
    showBubble(info);
  }

  // Capture phase: LinkedIn stops some mouse events from bubbling.
  document.addEventListener(
    "mouseup",
    (e) => {
      if (e.target?.closest && e.target.closest(".qc-bubble, .qc-root")) return;
      setTimeout(() => maybeShowBubble("mouseup"), 10);
    },
    true
  );
  // The selection itself cannot be blocked by the page. Debounced so the
  // bubble appears once the drag settles, and also covers keyboard selection.
  let selTimer = null;
  document.addEventListener("selectionchange", () => {
    clearTimeout(selTimer);
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      hideBubble();
      lastSelText = "";
      return;
    }
    selTimer = setTimeout(() => maybeShowBubble("selectionchange"), 350);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideBubble();
      closeFloating();
    }
  });

  // ------------------------------------------------------------------
  // Discovery loop: full rescans, debounced, on any DOM change. Cheap
  // because only <h2> elements are enumerated and wired cards are skipped.
  // ------------------------------------------------------------------
  let lastReport = "";
  function scan() {
    const cards = findPosts(document);
    let wired = 0;
    cards.forEach((c) => { if (wire(c)) wired += 1; });
    try { wireReplyEditors(); } catch (err) { console.log("[QuickComment] reply wiring error", err); }
    const total = document.querySelectorAll(`[${WIRED_ATTR}="1"]`).length;
    const report = `${cards.length} pending, ${total} wired`;
    if (report !== lastReport) {
      lastReport = report;
      console.log(`[QuickComment] scan on ${location.pathname}: ${report}`);
    }
  }

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 300);
  }

  // Self-diagnostics, printed once a few seconds after load so a screenshot
  // of the console is enough to debug placement without pasting snippets.
  function diagnostics() {
    const T = "[QuickComment] diag";
    const roots = Array.from(document.querySelectorAll(".qc-root"));
    console.log(T, "roots on page:", roots.length);
    roots.slice(0, 2).forEach((r, i) => {
      const cs = getComputedStyle(r);
      const b = r.getBoundingClientRect();
      const chain = [];
      let el = r;
      while (el && chain.length < 8) {
        const c = getComputedStyle(el);
        chain.push(`${el.tagName.toLowerCase()} disp=${c.display} ovf=${c.overflow} h=${el.getBoundingClientRect().height | 0}`);
        el = el.parentElement;
      }
      console.log(T, `root ${i}: display=${cs.display} vis=${cs.visibility} rect=${b.x | 0},${b.y | 0} ${b.width | 0}x${b.height | 0}`);
      console.log(T, `root ${i} ancestors: ${chain.join(" | ")}`);
    });
    const card = document.querySelector(`[${WIRED_ATTR}="1"]`);
    if (!card) return;
    const lab = (b) => ((b.getAttribute("aria-label") || "") + " " + (b.textContent || "")).replace(/\s+/g, " ").trim().slice(0, 60);
    const inCard = Array.from(card.querySelectorAll('button, [role="button"], a')).map(lab).filter(Boolean);
    const inParent = Array.from(card.parentElement.querySelectorAll('button, [role="button"], a')).map(lab).filter(Boolean);
    console.log(T, "card:", card.tagName, `children=${card.children.length}`, "class=", card.className.slice(0, 80));
    console.log(T, "controls inside card:", JSON.stringify(inCard.slice(0, 25)));
    console.log(T, "controls inside card's parent:", JSON.stringify(inParent.slice(0, 40)));
    console.log(T, "parent:", card.parentElement.tagName, `children=${card.parentElement.children.length}`, "class=", card.parentElement.className.slice(0, 80));
  }

  // Comment-thread readout. Written to storage so the popup's "Copy debug
  // info" button can put it on the clipboard; no console work needed.
  function describe(el) {
    if (!el) return "null";
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") ? ` role=${el.getAttribute("role")}` : "";
    const aria = el.getAttribute("aria-label") ? ` aria="${el.getAttribute("aria-label").slice(0, 50)}"` : "";
    return `${tag}${role}${aria} kids=${el.children.length} text=${(el.textContent || "").replace(/\s+/g, " ").trim().length}`;
  }

  function commentDiag() {
    const out = [];
    const lab = (b) => ((b.getAttribute("aria-label") || "") + " | " + (b.textContent || "")).replace(/\s+/g, " ").trim().slice(0, 80);
    const controls = Array.from(document.querySelectorAll('button, [role="button"], a'));
    const replyBtns = controls.filter((b) => /^reply\b|\breply to\b|^responder\b/i.test(lab(b)) && !b.closest(".qc-root"));
    out.push(`url: ${location.href}`);
    out.push(`reply-like controls: ${replyBtns.length}`);
    const navImgs = Array.from(document.querySelectorAll("header img[alt], nav img[alt], [role='banner'] img[alt]")).map((i) => i.alt).filter(Boolean).slice(0, 5);
    out.push(`nav image alts (for detecting your own name): ${JSON.stringify(navImgs)}`);
    const authorBadges = Array.from(document.querySelectorAll("span, div")).filter((e) => e.children.length === 0 && /^author$/i.test((e.textContent || "").trim())).length;
    out.push(`"Author" badges on page: ${authorBadges}`);
    out.push(`me: vanity=${meVanity || "?"} name=${meName || "?"}`);
    const editors = Array.from(document.querySelectorAll('[contenteditable="true"]')).slice(0, 3);
    editors.forEach((ed, i) => {
      let el = ed.parentElement;
      const alts = [];
      for (let d = 0; d < 6 && el && el !== document.body; d += 1) {
        el.querySelectorAll("img[alt]").forEach((im) => alts.push(im.getAttribute("alt").slice(0, 60)));
        el = el.parentElement;
      }
      out.push(`editor ${i} nearby image alts: ${JSON.stringify(Array.from(new Set(alts)).slice(0, 8))}`);
    });
    replyBtns.slice(0, 3).forEach((btn, n) => {
      out.push("");
      out.push(`--- reply control ${n}: ${lab(btn)}`);
      let el = btn;
      for (let depth = 0; depth < 9 && el; depth += 1) {
        const replies = el.querySelectorAll ? Array.from(el.querySelectorAll('button, [role="button"], a')).filter((b) => /^reply\b|\breply to\b/i.test(lab(b))).length : 0;
        out.push(`  up${depth}: ${describe(el)} replyControlsInside=${replies}`);
        el = el.parentElement;
      }
      // Candidate container: largest ancestor with exactly one Reply control.
      let cand = btn;
      let up = btn.parentElement;
      while (up && Array.from(up.querySelectorAll('button, [role="button"], a')).filter((b) => /^reply\b|\breply to\b/i.test(lab(b))).length === 1) {
        cand = up;
        up = up.parentElement;
      }
      out.push(`  candidate container: ${describe(cand)}`);
      const ctrls = Array.from(cand.querySelectorAll('button, [role="button"], a')).map(lab).filter(Boolean).slice(0, 20);
      out.push(`  controls in container: ${JSON.stringify(ctrls)}`);
      const links = Array.from(cand.querySelectorAll("a[href]")).map((a) => a.getAttribute("href").slice(0, 60)).slice(0, 6);
      out.push(`  links in container: ${JSON.stringify(links)}`);
      const blocks = Array.from(cand.querySelectorAll("p, span, div")).filter((e) => e.children.length === 0 && (e.textContent || "").trim().length > 25).map((e) => `${e.tagName.toLowerCase()}: ${(e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90)}`).slice(0, 6);
      out.push(`  text blocks in container: ${JSON.stringify(blocks)}`);
      out.push(`  container text: ${(cand.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300)}`);
    });
    const text = out.join("\n");
    console.log("[QuickComment] comment diag\n" + text);
    try {
      chrome.storage.local.set({ diag: text, diagAt: Date.now() }).catch(() => {});
    } catch {}
  }

  console.log("[QuickComment] content script loaded on", location.href);
  setTimeout(commentDiag, 6000);
  const diagTimer = setInterval(() => {
    if (!alive()) {
      clearInterval(diagTimer); // extension was reloaded; this copy is stale
      return;
    }
    try { commentDiag(); } catch (err) { console.log("[QuickComment] diag error", err); }
  }, 30000);
  scan();
  [800, 2000, 4000].forEach((ms) => setTimeout(scan, ms));
  setTimeout(diagnostics, 5000);
  const mo = new MutationObserver(scheduleScan);
  mo.observe(document.body, { childList: true, subtree: true });
})();
