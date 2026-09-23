const $ = (id) => document.getElementById(id);
const send = (m) => chrome.runtime.sendMessage(m).catch((e) => ({ ok: false, error: String(e) }));

// ---------------------------------------------------------------------
// Tabs. Setup is the only tab until the walkthrough is finished; after
// that the popup opens on Activity and Setup disappears.
// ---------------------------------------------------------------------
let setupDone = false;

function showTab(name) {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll("section").forEach((s) => s.classList.toggle("on", s.id === `tab-${name}`));
}

function applyMode() {
  const setupBtn = document.querySelector('nav button[data-tab="setup"]');
  const others = document.querySelectorAll('nav button:not([data-tab="setup"])');
  setupBtn.style.display = setupDone ? "none" : "";
  others.forEach((b) => (b.style.display = setupDone ? "" : "none"));
  showTab(setupDone ? "activity" : "setup");
}

$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) showTab(b.dataset.tab);
});

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = (el.id === "statusSetup" ? "hint " : "") + (kind || "");
}

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
async function readState() {
  const s = await chrome.storage.local.get([
    "apiKey", "workspaceId", "persona", "tokenCap", "keyVerified", "tourDone",
    "meVanity", "meName", "pendingIdentity", "history",
  ]);
  const history = s.history || [];
  const steps = {
    key: !!(s.apiKey && s.keyVerified),
    me: !!s.meVanity,
    post: history.some((h) => h.kind !== "reply"),
    reply: history.some((h) => h.kind === "reply"),
    vote: history.some((h) => h.votes && Object.keys(h.votes).length),
  };
  return { ...s, history, steps };
}

async function load() {
  const s = await readState();
  setupDone = !!(s.steps.key && s.steps.me && s.tourDone);
  if (s.apiKey) {
    $("apiKey").value = s.apiKey;
    $("apiKeySetup").value = s.apiKey;
  }
  if (s.workspaceId) $("workspaceId").value = s.workspaceId;
  if (s.persona) $("persona").value = s.persona;
  $("tokenCap").value = s.tokenCap || QC_DEFAULT_MONTHLY_TOKEN_CAP;
  renderSteps(s);
  applyMode();
  refreshActivity();
}

function renderSteps(s) {
  const mark = (id, done, n) => {
    const el = $(id);
    el.classList.toggle("step--done", done);
    el.querySelector(".step__mark").textContent = done ? "✓" : String(n);
  };
  mark("st-key", s.steps.key, 1);
  mark("st-me", s.steps.me, 2);
  mark("st-post", s.steps.post, 3);
  mark("st-reply", s.steps.reply, 4);
  mark("st-vote", s.steps.vote, 5);

  if (s.steps.me) $("meStatus").textContent = `You are ${s.meName || ""} (/in/${s.meVanity}).`;
  else if (s.pendingIdentity && Date.now() - s.pendingIdentity < 5 * 60 * 1000) $("meStatus").textContent = "Waiting for your profile tab…";
  else $("meStatus").textContent = "";
  $("meLine").textContent = s.meVanity ? `${s.meName || ""} (/in/${s.meVanity})` : "Unknown. Run the walkthrough or click below.";

  const n = s.history.filter((h) => h.kind !== "reply").length;
  $("postStatus").textContent = n ? `${n} post generation${n === 1 ? "" : "s"} so far.` : "";
  const r = s.history.filter((h) => h.kind === "reply").length;
  $("replyStatus").textContent = r ? `${r} reply generation${r === 1 ? "" : "s"} so far.` : "";
  const v = s.history.reduce((a, h) => a + (h.votes ? Object.keys(h.votes).length : 0), 0);
  $("voteStatus").textContent = v ? `${v} vote${v === 1 ? "" : "s"} so far.` : "";

  const ready = s.steps.key && s.steps.me;
  $("finishSetup").disabled = !ready;
  $("finishHint").textContent = ready ? "Steps 3 to 5 keep ticking off after you finish." : "Finish steps 1 and 2 to continue.";
}

async function refreshActivity() {
  const res = await send({ type: "qc-usage" });
  const { history = [] } = await chrome.storage.local.get("history");
  const cap = Number($("tokenCap").value) || QC_DEFAULT_MONTHLY_TOKEN_CAP;
  const u = res?.usage || { tokens: 0, requests: 0, cost: 0, month: "" };
  const t = res?.totals || { tokens: 0, requests: 0, cost: 0 };
  const pct = Math.min(100, Math.round((u.tokens / cap) * 100));

  $("aMonthCost").textContent = `$${(u.cost || 0).toFixed(3)}`;
  $("aMonthLabel").textContent = `${u.month || "this month"} · ${u.requests} gen · ${u.tokens.toLocaleString()} of ${cap.toLocaleString()} tok`;
  $("aMeter").style.width = `${pct}%`;
  $("aAllCost").textContent = `$${(t.cost || 0).toFixed(3)}`;
  $("aAllLabel").textContent = `all time · ${t.requests} gen · ${t.tokens.toLocaleString()} tok`;
  $("usageLine").textContent = `This month: ${u.tokens.toLocaleString()} tokens (${pct}% of cap), $${(u.cost || 0).toFixed(3)}. All time: $${(t.cost || 0).toFixed(3)}.`;

  const q = qcQuality(history);
  $("aCopyRate").textContent = `${Math.round(q.copyRate * 100)}%`;
  $("aCopyLabel").textContent = `${q.landed} of ${q.generations} generations copied · ${q.copies} copies`;
  $("aUnserved").textContent = q.postsUnserved;
  $("aUnservedLabel").textContent = `of ${q.posts} posts got no copy`;

  const recent = $("recent");
  recent.replaceChildren();
  if (!history.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No generations yet. Click \"✦ Propose comment ideas\" under a LinkedIn post.";
    recent.appendChild(e);
    return;
  }
  history.slice(0, 8).forEach((h) => {
    const item = document.createElement("div");
    item.className = "item";
    const meta = document.createElement("div");
    meta.className = "item__meta";
    const left = document.createElement("span");
    const author = document.createElement("b");
    author.textContent = (h.kind === "reply" ? "↳ " : "") + (h.kind === "reply" ? (h.reply?.author || "reply") : (h.author || "Unknown"));
    left.append(author, document.createTextNode(` · ${timeAgo(h.ts)}`));
    const right = document.createElement("span");
    right.textContent = `$${(h.cost || 0).toFixed(4)}`;
    meta.append(left, right);
    const copied = qcCopiedIndices(h);
    const text = document.createElement("div");
    text.className = "item__text" + (copied.length ? " used" : "");
    text.textContent = copied.length ? h.comments[copied[0]] : h.comments[0];
    item.append(meta, text);
    recent.appendChild(item);
  });
}

function timeAgo(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ---------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------
async function saveSettings() {
  const apiKey = $("apiKey").value.trim();
  const workspaceId = $("workspaceId").value.trim();
  const persona = $("persona").value.trim();
  const tokenCap = Math.max(1000, Number($("tokenCap").value) || QC_DEFAULT_MONTHLY_TOKEN_CAP);
  $("tokenCap").value = tokenCap;
  await chrome.storage.local.set({ apiKey, workspaceId, persona, tokenCap });
  $("apiKeySetup").value = apiKey;
}

async function testKey(statusEl) {
  setStatus(statusEl, "Testing…");
  const res = await send({ type: "qc-test-key" });
  if (res?.ok) {
    setStatus(statusEl, `Key works. Model: ${res.model}`, "ok");
    await chrome.storage.local.set({ keyVerified: true });
  } else {
    setStatus(statusEl, res?.error || "No response.", "err");
    await chrome.storage.local.set({ keyVerified: false });
  }
  renderSteps(await readState());
  refreshActivity();
}

async function openMyProfile() {
  await chrome.storage.local.set({ pendingIdentity: Date.now() });
  $("meStatus").textContent = "Opening your profile in a new tab… come back here when you see the confirmation.";
  await send({ type: "qc-open-url", url: "https://www.linkedin.com/in/me/" });
}

$("testSetup").addEventListener("click", async () => {
  $("apiKey").value = $("apiKeySetup").value.trim();
  await saveSettings();
  await testKey($("statusSetup"));
});
$("openMe").addEventListener("click", openMyProfile);
$("openMe2").addEventListener("click", openMyProfile);
$("openFeed").addEventListener("click", () => send({ type: "qc-open-url", url: "https://www.linkedin.com/feed/" }));

$("finishSetup").addEventListener("click", async () => {
  await chrome.storage.local.set({ tourDone: true });
  setupDone = true;
  applyMode();
});

$("restartTour").addEventListener("click", async () => {
  await chrome.storage.local.set({ tourDone: false });
  setupDone = false;
  renderSteps(await readState());
  applyMode();
});

$("save").addEventListener("click", async () => {
  await saveSettings();
  setStatus($("status"), "Saved.", "ok");
  refreshActivity();
});
$("test").addEventListener("click", async () => {
  await saveSettings();
  await testKey($("status"));
});
$("reset").addEventListener("click", async () => {
  await chrome.storage.local.remove("usage");
  setStatus($("status"), "Counter reset.", "ok");
  refreshActivity();
});
$("openHistory").addEventListener("click", () => send({ type: "qc-open-history" }));

$("copyDiag").addEventListener("click", async () => {
  const { diag, diagAt } = await chrome.storage.local.get(["diag", "diagAt"]);
  const box = $("diagBox");
  if (!diag) {
    $("diagHint").textContent = "Nothing stored yet. Open any LinkedIn page, wait 10 seconds, try again.";
    return;
  }
  box.hidden = false;
  box.value = diag;
  box.focus();
  box.select();
  const age = Math.round((Date.now() - diagAt) / 1000);
  try {
    await navigator.clipboard.writeText(diag);
    $("diagHint").textContent = `Copied (${age}s old). Also selected below.`;
  } catch {
    $("diagHint").textContent = `Selected below (${age}s old). Press Cmd+C.`;
  }
});

chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.history || changes.totals || changes.usage) refreshActivity();
  if (changes.meVanity || changes.meName || changes.history || changes.keyVerified || changes.pendingIdentity) renderSteps(await readState());
});

load();
