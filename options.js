const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------
// Tabs. Setup is the only tab until a key passes the test; after that the
// popup opens on Activity and Setup disappears.
// ---------------------------------------------------------------------
let verified = false;

function showTab(name) {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll("section").forEach((s) => s.classList.toggle("on", s.id === `tab-${name}`));
}

function applyMode() {
  const setupBtn = document.querySelector('nav button[data-tab="setup"]');
  const others = document.querySelectorAll('nav button:not([data-tab="setup"])');
  setupBtn.style.display = verified ? "none" : "";
  others.forEach((b) => (b.style.display = verified ? "" : "none"));
  showTab(verified ? "activity" : "setup");
}

$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) showTab(b.dataset.tab);
});

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = kind || "";
  el.id === "statusSetup" && (el.className = "hint " + (kind || ""));
}

// ---------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------
async function load() {
  const s = await chrome.storage.local.get(["apiKey", "workspaceId", "persona", "tokenCap", "keyVerified", "yourName"]);
  verified = !!(s.apiKey && s.keyVerified);
  if (s.apiKey) {
    $("apiKey").value = s.apiKey;
    $("apiKeySetup").value = s.apiKey;
  }
  if (s.workspaceId) $("workspaceId").value = s.workspaceId;
  if (s.persona) $("persona").value = s.persona;
  if (s.yourName) $("yourName").value = s.yourName;
  $("tokenCap").value = s.tokenCap || QC_DEFAULT_MONTHLY_TOKEN_CAP;
  applyMode();
  refreshActivity();
}

async function refreshActivity() {
  const res = await chrome.runtime.sendMessage({ type: "qc-usage" }).catch(() => null);
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
    e.textContent = "No generations yet. Click \"Comment ideas\" under a LinkedIn post.";
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
  const yourName = $("yourName").value.trim();
  const tokenCap = Math.max(1000, Number($("tokenCap").value) || QC_DEFAULT_MONTHLY_TOKEN_CAP);
  $("tokenCap").value = tokenCap;
  await chrome.storage.local.set({ apiKey, workspaceId, persona, tokenCap, yourName });
  $("apiKeySetup").value = apiKey;
}

async function testKey(statusEl) {
  setStatus(statusEl, "Testing…");
  const res = await chrome.runtime.sendMessage({ type: "qc-test-key" }).catch((e) => ({ ok: false, error: String(e) }));
  if (res?.ok) {
    setStatus(statusEl, `Key works. Model: ${res.model}`, "ok");
    await chrome.storage.local.set({ keyVerified: true });
    verified = true;
  } else {
    setStatus(statusEl, res?.error || "No response.", "err");
    await chrome.storage.local.set({ keyVerified: false });
    verified = false;
  }
  refreshActivity();
  return verified;
}

$("testSetup").addEventListener("click", async () => {
  const apiKey = $("apiKeySetup").value.trim();
  $("apiKey").value = apiKey;
  await saveSettings();
  const ok = await testKey($("statusSetup"));
  if (ok) setTimeout(applyMode, 700);
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

$("openHistory").addEventListener("click", () => chrome.runtime.sendMessage({ type: "qc-open-history" }));

chrome.storage.onChanged.addListener((changes) => {
  if (changes.history || changes.totals || changes.usage) refreshActivity();
});

load();


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
    $("diagHint").textContent = `Copied (${age}s old). Paste it to Claude. It is also selected below: Cmd+C works too.`;
  } catch {
    $("diagHint").textContent = `Selected below (${age}s old). Press Cmd+C, then paste it to Claude.`;
  }
});
