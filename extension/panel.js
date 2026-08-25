"use strict";
(() => {
  const PRESETS = {
    video_best: { id: "video_best", quality: "best", label: "וידאו - איכות מיטבית" },
    video_1080: { id: "video_1080", quality: "1080", label: "וידאו - 1080p" },
    video_720: { id: "video_720", quality: "720", label: "וידאו - 720p" },
    video_480: { id: "video_480", quality: "480", label: "וידאו - 480p" },
    audio_only: { id: "audio_only", quality: "audio", label: "אודיו בלבד (MP3)" }
  };
  const PRESET_ORDER = ["video_best", "video_1080", "video_720", "video_480", "audio_only"];

  const STATUS_LABELS = {
    preparing: "שולח בקשה ל-GitHub…",
    queued: "בתור אצל GitHub…",
    running: "רץ ב-GitHub Actions…",
    fetching: "מושך את הקובץ מ-GitHub…",
    saving: "שומר במחשב…",
    completed: "הקובץ נשמר במחשב",
    failed: "ההורדה נכשלה",
    cancelled: "ההורדה בוטלה"
  };
  const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];
  const isTerminal = (s) => TERMINAL_STATUSES.includes(s);

  const $ = (id) => document.getElementById(id);
  const urlInput = $("urlInput");
  const urlHint = $("urlHint");
  const pasteBtn = $("pasteBtn");
  const preview = $("preview");
  const previewThumb = $("previewThumb");
  const previewTitle = $("previewTitle");
  const collectionBadge = $("collectionBadge");
  const collectionToggle = $("collectionToggle");
  const formatSelect = $("formatSelect");
  const downloadBtn = $("downloadBtn");
  const settingsBtn = $("settingsBtn");
  const setupBanner = $("setupBanner");
  const setupText = $("setupText");
  const setupBtn = $("setupBtn");
  const connDot = $("conn-dot");
  const connText = $("conn-text");
  const jobList = $("jobList");
  const jobEmpty = $("jobEmpty");

  let current = null; // { url, videoId, title }
  let previewToken = 0;
  let jobsPollTimer = null;
  const jobRows = new Map(); // jobId -> { root, fill, status, pct, detail, actions }

  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return { ok: false, error: "אין קשר לתוסף. נסו לרענן את הלשונית." };
    }
  }

  function extractVideoId(raw) {
    if (!raw) return null;
    const text = raw.trim();
    let url;
    try {
      url = new URL(text.includes("://") ? text : `https://${text}`);
    } catch {
      return null;
    }
    const host = url.hostname.replace(/^www\./, "").replace(/^m\./, "");
    if (host === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || null;
    if (host === "youtube.com" || host === "music.youtube.com") {
      if (url.pathname === "/watch") return url.searchParams.get("v");
      const parts = url.pathname.split("/").filter(Boolean);
      if ((parts[0] === "shorts" || parts[0] === "live" || parts[0] === "embed") && parts[1]) return parts[1];
      return null;
    }
    return null;
  }

  // A channel page or a bare playlist URL — not a single video that merely
  // happens to carry a "list=" param, which usually means "just this one video".
  function detectCollection(raw) {
    let url;
    try {
      url = new URL(raw.trim());
    } catch {
      return false;
    }
    const host = url.hostname.replace(/^www\./, "").replace(/^m\./, "");
    if (host !== "youtube.com" && host !== "music.youtube.com") return false;
    const path = url.pathname;
    if (path === "/playlist" && url.searchParams.get("list")) return true;
    if (/^\/(channel|c|user)\//.test(path)) return true;
    if (/^\/@[^/]+\/?(videos|streams|shorts|featured)?\/?$/.test(path)) return true;
    return false;
  }

  function isHttpUrl(raw) {
    try {
      const url = new URL(raw.trim());
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  function populateFormatSelect(selected) {
    formatSelect.replaceChildren();
    for (const id of PRESET_ORDER) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = PRESETS[id].label;
      formatSelect.append(opt);
    }
    formatSelect.value = selected && PRESETS[selected] ? selected : "video_best";
  }

  async function loadPrefs() {
    const prefs = await send({ type: "GET_PREFS" });
    populateFormatSelect(prefs && prefs.defaultOption);
    connDot.className = "dot";
    if (prefs && prefs.configured) {
      connDot.classList.add("is-ok");
      connText.textContent = `${prefs.owner}/${prefs.repo}`;
      setupBanner.hidden = true;
    } else {
      connDot.classList.add("is-fail");
      connText.textContent = "לא מוגדר";
      setupText.textContent = prefs && prefs.owner ? "חסר טוקן GitHub" : "צריך להגדיר ריפו וטוקן";
      setupBanner.hidden = false;
    }
  }

  function resetPreview() {
    preview.hidden = true;
    previewThumb.src = "";
    previewTitle.textContent = "";
  }

  // Always mirrors detection for whatever URL is currently in the box — on purpose,
  // so a toggle left on from an earlier channel/playlist paste can never silently
  // stick around for a plain video link typed afterward. A manual flip still works
  // for the URL that's there right now; editing the URL resets it to match detection.
  function setCollectionState(detected) {
    collectionBadge.hidden = !detected;
    collectionToggle.checked = detected;
  }

  async function validateAndPreview() {
    const raw = urlInput.value;
    previewToken += 1;
    const token = previewToken;

    if (!raw.trim()) {
      urlHint.textContent = " ";
      urlHint.classList.remove("is-fail");
      downloadBtn.disabled = true;
      downloadBtn.textContent = "הורדה";
      resetPreview();
      setCollectionState(false);
      current = null;
      return;
    }

    if (!isHttpUrl(raw)) {
      urlHint.textContent = "זה לא נראה כמו קישור תקין";
      urlHint.classList.add("is-fail");
      downloadBtn.disabled = true;
      downloadBtn.textContent = "הורדה";
      resetPreview();
      setCollectionState(false);
      current = null;
      return;
    }

    urlHint.textContent = " ";
    urlHint.classList.remove("is-fail");
    setCollectionState(detectCollection(raw));

    const videoId = extractVideoId(raw);
    if (!videoId) {
      // yt-dlp handles far more than YouTube (and channel/playlist pages don't
      // resolve to a single video id either); anything else just skips the preview.
      current = { url: raw.trim(), videoId: null, title: null };
      resetPreview();
      downloadBtn.disabled = false;
      downloadBtn.textContent = "הורדה";
      return;
    }

    const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
    current = { url: canonicalUrl, videoId, title: null };
    previewThumb.src = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    previewTitle.textContent = "טוען כותרת…";
    preview.hidden = false;
    downloadBtn.disabled = false;
    downloadBtn.textContent = "הורדה";

    const title = await fetchOembedTitleWithRetry(canonicalUrl, () => token === previewToken);
    if (token !== previewToken || !current || current.videoId !== videoId) return;

    if (title) {
      current.title = title;
      previewTitle.textContent = title;
    } else {
      // Still just a cosmetic preview after every retry failed. The saved filename
      // never comes from here either way — it's always the real title yt-dlp reads
      // on the GitHub runner, so this has no effect on what the file ends up called.
      previewTitle.textContent = "אין תצוגה מקדימה לכותרת — שם הקובץ הסופי נקבע בגיטהאב לפי הכותרת האמיתית";
    }
  }

  // oEmbed is a best-effort convenience (thumbnail preview only) and it does fail
  // sometimes — timeouts, transient YouTube errors — so retry a few times with a
  // short backoff before giving up. `stillWanted()` lets a newer URL in the input
  // cancel a stale retry early instead of racing it.
  async function fetchOembedTitleWithRetry(canonicalUrl, stillWanted, attempts = 4) {
    const delays = [0, 1200, 2500, 4500];
    for (let i = 0; i < attempts; i += 1) {
      if (!stillWanted()) return null;
      if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
      if (!stillWanted()) return null;
      if (i > 0) previewTitle.textContent = `טוען כותרת… (ניסיון ${i + 1} מתוך ${attempts})`;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        const res = await fetch(
          `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`,
          { signal: controller.signal }
        );
        clearTimeout(timeout);
        if (res.ok) {
          const data = await res.json();
          if (data && data.title) return data.title;
        }
      } catch {
        /* try again below, or give up after the last attempt */
      }
    }
    return null;
  }

  let debounceTimer = null;
  urlInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void validateAndPreview(), 250);
  });

  pasteBtn.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        urlInput.value = text.trim();
        await validateAndPreview();
        urlInput.focus();
      }
    } catch {
      urlHint.textContent = "לא ניתן לגשת ללוח ההעתקה — הדביקו ידנית (Ctrl+V)";
      urlHint.classList.add("is-fail");
      urlInput.focus();
    }
  });

  const openOptions = () => void send({ type: "OPEN_OPTIONS" });
  settingsBtn.addEventListener("click", openOptions);
  setupBtn.addEventListener("click", openOptions);

  downloadBtn.addEventListener("click", () => {
    if (!current) return;
    void startDownload({
      url: current.url,
      title: current.title,
      quality: PRESETS[formatSelect.value].quality,
      mode: collectionToggle.checked ? "collection" : "video"
    });
  });

  async function startDownload(input) {
    const res = await send({ type: "START_DOWNLOAD", payload: input });
    if (!res || !res.ok) {
      urlHint.textContent = (res && res.error) || "ההורדה נכשלה";
      urlHint.classList.add("is-fail");
      return;
    }
    void refreshJobs();
  }

  /* ------------------------------------------------------------- job list */

  function formatBytes(n) {
    if (!n || n < 0) return "";
    if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
    return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  }

  function elapsedLabel(startedAt) {
    if (!startedAt) return "";
    const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m ? `${m}:${String(s).padStart(2, "0")}` : `${s}ש׳`;
  }

  function buildJobRow(job) {
    const root = document.createElement("div");
    root.className = "job";

    const head = document.createElement("div");
    head.className = "job__head";
    const title = document.createElement("div");
    title.className = "job__title";
    title.title = job.title || job.url;
    head.append(title);
    root.append(head);

    const statusRow = document.createElement("div");
    statusRow.className = "job__row";
    const status = document.createElement("span");
    status.className = "job__status";
    const pct = document.createElement("span");
    pct.className = "job__pct";
    statusRow.append(status, pct);
    root.append(statusRow);

    const bar = document.createElement("div");
    bar.className = "job__bar";
    const fill = document.createElement("div");
    fill.className = "job__fill";
    bar.append(fill);
    root.append(bar);

    const detail = document.createElement("div");
    detail.className = "job__detail";
    root.append(detail);

    const actions = document.createElement("div");
    actions.className = "job__actions";
    root.append(actions);

    jobList.append(root);
    const row = { root, title, status, pct, fill, detail, actions };
    jobRows.set(job.id, row);
    return row;
  }

  function addAction(row, label, primary, onClick) {
    const btn = document.createElement("button");
    btn.className = primary ? "btn btn--primary" : "btn";
    btn.type = "button";
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    row.actions.append(btn);
  }

  function renderJob(job) {
    let row = jobRows.get(job.id);
    if (!row) row = buildJobRow(job);

    const modeTag = job.mode === "collection" ? " · אוסף" : "";
    // Once the run finishes, the real filename yt-dlp gave it on the GitHub runner is
    // known — that's always more accurate than the guessed title shown before the
    // download started (which may have come from a retried, or ultimately failed,
    // oEmbed preview), so it takes over here too, not just as the saved file's name.
    const displayTitle =
      job.status === "completed" && job.files && job.files.length ? job.files.join(", ") : job.title || job.url;
    row.title.textContent = displayTitle + modeTag;
    row.title.title = displayTitle;
    row.status.textContent = STATUS_LABELS[job.status] || job.status;

    const done = isTerminal(job.status);
    const percent = Math.max(0, Math.min(100, job.percent || 0));
    row.fill.style.width = `${done ? (job.status === "completed" ? 100 : percent) : percent}%`;
    row.pct.textContent = done
      ? job.status === "completed"
        ? "הושלם"
        : ""
      : `${percent}% · ${elapsedLabel(job.startedAt)}`;
    row.fill.classList.toggle("is-failed", job.status === "failed" || job.status === "cancelled");
    row.fill.classList.toggle("is-done", job.status === "completed");
    row.detail.textContent = job.status === "failed" ? job.error || job.detail || "" : job.detail || "";

    row.actions.replaceChildren();
    if (!done) {
      addAction(row, "עצור", false, () => void send({ type: "CANCEL_JOB", jobId: job.id }).then(refreshJobs));
    }
    if (job.runId) {
      addAction(row, "פתח את הריצה", false, () => void send({ type: "OPEN_RUN", jobId: job.id }));
    }
    if (job.directUrl && (job.status === "fetching" || job.status === "saving")) {
      // Opt-in only — the extension still fetches and saves this itself by default.
      // This just hands off the same pre-signed link GitHub gave the extension, for
      // someone who'd rather pull it with IDM or similar instead of waiting here.
      addAction(row, "העתק קישור ישיר (IDM וכו')", false, async () => {
        try {
          await navigator.clipboard.writeText(job.directUrl);
        } catch {
          /* clipboard access may need a user gesture; the click itself counts as one */
        }
      });
    }
    if (job.status === "completed") {
      addAction(row, "פתח תיקייה", true, () => void send({ type: "OPEN_DOWNLOADS" }));
    }
    if (job.status === "failed" && job.url) {
      // A recovered job (reconnected to a run this session never dispatched) has no
      // real URL to retry with — GitHub doesn't expose workflow_dispatch inputs after
      // the fact, so job.url is deliberately left empty for those. "Open the run" above
      // is the only way back into one of those.
      addAction(row, "נסה שוב", true, () =>
        void startDownload({ url: job.url, title: job.title, quality: job.quality, mode: job.mode })
      );
    }
  }

  async function refreshJobs() {
    const res = await send({ type: "LIST_JOBS" });
    const jobs = (res && res.jobs) || {};
    const ids = Object.keys(jobs).sort((a, b) => (jobs[b].startedAt || 0) - (jobs[a].startedAt || 0));

    jobEmpty.hidden = ids.length > 0;

    const seen = new Set();
    for (const id of ids) {
      renderJob(jobs[id]);
      seen.add(id);
    }
    for (const [id, row] of jobRows) {
      if (!seen.has(id)) {
        row.root.remove();
        jobRows.delete(id);
      }
    }
    // keep the list in the same order as `ids` (newest first)
    for (const id of ids) {
      const row = jobRows.get(id);
      if (row) jobList.append(row.root);
    }
  }

  function startJobsPolling() {
    if (jobsPollTimer) return;
    void refreshJobs();
    jobsPollTimer = setInterval(() => void refreshJobs(), 1000);
  }

  async function tryAutoFill() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab && tab.url && (extractVideoId(tab.url) || detectCollection(tab.url))) {
        urlInput.value = tab.url;
        await validateAndPreview();
        return;
      }
    } catch {
      /* no visibility into that tab; fall through to the clipboard */
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text && isHttpUrl(text)) {
        urlInput.value = text.trim();
        await validateAndPreview();
      }
    } catch {
      /* clipboard access may be denied without a user gesture; ignore */
    }
  }

  void loadPrefs();
  void tryAutoFill();
  startJobsPolling();
  urlInput.focus();
})();
