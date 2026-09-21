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

  let knobs = { ...QC_DEFAULT_KNOBS };
  chrome.storage.local.get("knobs").then((s) => {
    if (s.knobs) knobs = { ...knobs, ...s.knobs };
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
    trigger.innerHTML = '<span class="qc-trigger__spark">✦</span> Comment ideas';
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
    const res = await chrome.runtime.sendMessage({ type: "qc-has-key" }).catch(() => null);
    root.appendChild(res?.hasKey ? buildPanel(card) : buildSetupPanel());
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
    btn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "qc-open-options" }));
    panel.append(msg, btn);
    return panel;
  }

  function buildPanel(card) {
    const panel = document.createElement("div");
    panel.className = "qc-panel";
    panel.addEventListener("click", (e) => e.stopPropagation());

    const knobsWrap = document.createElement("div");
    knobsWrap.className = "qc-knobs";
    for (const group of Object.keys(QC_KNOBS)) knobsWrap.appendChild(buildKnobRow(group));
    panel.appendChild(knobsWrap);

    const actions = document.createElement("div");
    actions.className = "qc-actions";
    const go = document.createElement("button");
    go.type = "button";
    go.className = "qc-go";
    go.textContent = "Generate";
    const status = document.createElement("span");
    status.className = "qc-status";
    actions.append(go, status);
    panel.appendChild(actions);

    const results = document.createElement("div");
    results.className = "qc-results";
    panel.appendChild(results);

    go.addEventListener("click", () => generate(card, go, status, results));
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
        chrome.storage.local.set({ knobs });
        pills.querySelectorAll(".qc-pill").forEach((p) => p.classList.toggle("qc-pill--on", p === pill));
      });
      pills.appendChild(pill);
    }
    row.appendChild(pills);
    return row;
  }

  async function generate(card, go, status, results) {
    const post = getPostText(card);
    const author = getAuthor(card);
    if (!post) {
      status.textContent = "Could not read the post text.";
      return;
    }
    go.disabled = true;
    go.classList.add("qc-go--busy");
    status.textContent = "Writing…";
    status.classList.remove("qc-status--error");
    results.replaceChildren();

    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: "qc-generate", post, author, knobs: { ...knobs } });
    } catch (err) {
      response = { ok: false, error: String(err) };
    }
    go.disabled = false;
    go.classList.remove("qc-go--busy");

    if (!response || !response.ok) {
      status.textContent = response?.error || "No response from the extension.";
      status.classList.add("qc-status--error");
      return;
    }
    status.textContent = "";
    if (response.read) {
      const read = document.createElement("div");
      read.className = "qc-read";
      read.textContent = `Read as: ${response.read.gist} Tone: ${response.read.author_tone}. Hook: ${response.read.hook}`;
      results.appendChild(read);
    }
    response.comments.forEach((text, i) => results.appendChild(buildResult(card, text, response.id, i)));

    const foot = document.createElement("div");
    foot.className = "qc-foot";
    const cost = document.createElement("span");
    cost.textContent = `${response.model} · ~$${(response.cost || 0).toFixed(4)}`;
    const hist = document.createElement("a");
    hist.href = "#";
    hist.className = "qc-link";
    hist.textContent = "History";
    hist.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: "qc-open-history" });
    });
    foot.append(cost, hist);
    results.appendChild(foot);
  }

  function buildResult(card, text, id, index) {
    const item = document.createElement("div");
    item.className = "qc-result";

    const body = document.createElement("div");
    body.className = "qc-result__text";
    body.textContent = text;

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
        if (id != null) chrome.runtime.sendMessage({ type: "qc-mark-copied", id, index });
      } catch {
        copy.textContent = "Failed";
      }
    });

    item.append(body, copy);
    return item;
  }

  // ------------------------------------------------------------------
  // Discovery loop: full rescans, debounced, on any DOM change. Cheap
  // because only <h2> elements are enumerated and wired cards are skipped.
  // ------------------------------------------------------------------
  let lastReport = "";
  function scan() {
    const cards = findPosts(document);
    let wired = 0;
    cards.forEach((c) => { if (wire(c)) wired += 1; });
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

  console.log("[QuickComment] content script loaded on", location.href);
  scan();
  [800, 2000, 4000].forEach((ms) => setTimeout(scan, ms));
  setTimeout(diagnostics, 5000);
  const mo = new MutationObserver(scheduleScan);
  mo.observe(document.body, { childList: true, subtree: true });
})();
