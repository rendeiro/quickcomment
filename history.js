const $ = (id) => document.getElementById(id);
let history = [];

const KNOB_LABEL = (group, key) =>
  (QC_KNOBS[group]?.options.find((o) => o.key === key) || {}).label || key;

async function load() {
  const s = await chrome.storage.local.get(["history", "totals", "usage"]);
  history = s.history || [];
  const t = s.totals || { tokens: 0, cost: 0, requests: 0 };
  $("sumGen").textContent = t.requests.toLocaleString();
  $("sumCost").textContent = `$${t.cost.toFixed(3)}`;
  $("sumCostLabel").textContent = `spent, all time (${t.tokens.toLocaleString()} tokens)`;
  const q = qcQuality(history);
  $("sumRate").textContent = `${Math.round(q.copyRate * 100)}%`;
  $("sumRateLabel").textContent = `${q.landed} of ${q.generations} generations copied · ${q.copies} copies`;
  $("sumUnserved").textContent = q.postsUnserved;
  $("sumUnservedLabel").textContent = `of ${q.posts} posts got no copy`;
  const u = s.usage || { cost: 0, tokens: 0, month: "" };
  $("sumMonth").textContent = `$${(u.cost || 0).toFixed(3)}`;
  $("sumMonthLabel").textContent = `spent in ${u.month || "this month"} (${(u.tokens || 0).toLocaleString()} tokens)`;
  render();
}

function render() {
  const q = $("q").value.trim().toLowerCase();
  const list = $("list");
  list.replaceChildren();
  const rows = history.filter((h) => {
    if (!q) return true;
    const hay = [h.author, h.post, ...(h.comments || [])].join(" ").toLowerCase();
    return hay.includes(q);
  });
  if (!rows.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = history.length ? "No matches." : "No generations yet. Open the LinkedIn feed and click \"Comment ideas\" under a post.";
    list.appendChild(e);
    return;
  }
  rows.forEach((h) => list.appendChild(renderEntry(h)));
}

function renderEntry(h) {
  const copied = qcCopiedIndices(h);
  const el = document.createElement("div");
  el.className = "entry" + (copied.length ? "" : " entry--unserved");

  const head = document.createElement("div");
  head.className = "entry__head";
  const left = document.createElement("span");
  const author = document.createElement("span");
  author.className = "entry__author";
  author.textContent = h.author || "Unknown author";
  const when = document.createElement("span");
  when.textContent = ` · ${new Date(h.ts).toLocaleString()}`;
  left.append(author, when);
  const right = document.createElement("span");
  right.className = "knobs";
  right.textContent = `${KNOB_LABEL("size", h.knobs?.size)} · ${KNOB_LABEL("attitude", h.knobs?.attitude)} · ${KNOB_LABEL("style", h.knobs?.style)} · ${copied.length ? `${h.copies || copied.length} cop${(h.copies || copied.length) === 1 ? "y" : "ies"}` : "no copy"} · $${(h.cost || 0).toFixed(4)}`;
  head.append(left, right);

  const post = document.createElement("div");
  post.className = "entry__post";
  post.textContent = h.post.length >= 400 ? h.post + "…" : h.post;

  el.append(head, post);
  if (h.read) {
    const read = document.createElement("div");
    read.className = "entry__read";
    read.textContent = `Read as: ${h.read.gist} Tone: ${h.read.author_tone}. Wants: ${h.read.author_wants}. Hook: ${h.read.hook}`;
    el.appendChild(read);
  }
  (h.comments || []).forEach((text, i) => {
    const c = document.createElement("div");
    c.className = "comment" + (copied.includes(i) ? " comment--copied" : "");
    const body = document.createElement("div");
    body.className = "comment__text";
    body.textContent = text;
    const btn = document.createElement("button");
    btn.textContent = "Copy";
    btn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy"), 1500);
    });
    c.append(body);
    if (copied.includes(i)) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "copied";
      c.append(tag);
    }
    c.append(btn);
    el.appendChild(c);
  });
  return el;
}

$("q").addEventListener("input", render);

$("export").addEventListener("click", async () => {
  const s = await chrome.storage.local.get(["history", "totals", "usage"]);
  const blob = new Blob([JSON.stringify(s, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `quickcomment-history-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$("clear").addEventListener("click", async () => {
  if (!confirm("Delete all stored generations? Totals and the monthly counter are kept.")) return;
  await chrome.storage.local.remove("history");
  await load();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.history || changes.totals || changes.usage) load();
});

load();
