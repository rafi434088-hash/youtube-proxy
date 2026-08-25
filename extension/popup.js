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
    running: "מוריד ב-Actions…",
    fetching: "מושך את הקובץ…",
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
  const formatSelect = $("formatSelect");
  const downloadBtn = $("downloadBtn");
  const settingsBtn = $("settingsBtn");
  const setupBanner = $("setupBanner");
  const setupText = $("setupText");
  const setupBtn = $("setupBtn");
  const connDot = $("conn-dot");
  const connText = $("conn-text");
  const progressCard = $("progressCard");
  const progressStatus = $("progressStatus");
  const progressPct = $("progressPct");
  const progressFill = $("progressFill");
  const progressDetail = $("progressDetail");
  const progressActions = $("progressActions");

  let current = null; // { url, videoId, title }
  let currentJobId = null;
  let pollTimer = null;
  let previewToken = 0;

  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return { ok: false, error: "אין קשר לתוסף. נסו לפתוח מחדש." };
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

  async function validateAndPreview() {
    const raw = urlInput.value;
    previewToken += 1;
    const token = previewToken;

    if (!raw.trim()) {
      urlHint.textContent = " ";
      urlHint.classList.remove("is-fail");
      downloadBtn.disabled = true;
      downloadBtn.textContent = "הורדה";
      resetPreview();
      current = null;
      return;
    }

    if (!isHttpUrl(raw)) {
      urlHint.textContent = "זה לא נראה כמו קישור תקין";
      urlHint.classList.add("is-fail");
      downloadBtn.disabled = true;
      downloadBtn.textContent = "הורדה";
      resetPreview();
      current = null;
      return;
    }

    urlHint.textContent = " ";
    urlHint.classList.remove("is-fail");

    const videoId = extractVideoId(raw);
    if (!videoId) {
      // yt-dlp handles far more than YouTube; anything else just skips the preview.
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

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`,
        { signal: controller.signal }
      );
      clearTimeout(timeout);
      if (token !== previewToken) return;
      if (res.ok) {
        const data = await res.json();
        if (data && data.title && current && current.videoId === videoId) {
          current.title = data.title;
          previewTitle.textContent = data.title;
        }
      }
    } catch {
      /* best effort only — the runner names the file either way */
    } finally {
      if (token === previewToken && current && current.videoId === videoId && !current.title) {
        previewTitle.textContent = `לא הצלחתי לטעון כותרת — הקובץ ייקרא לפי ${videoId}`;
      }
    }
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

  const openOptions = () => {
    void send({ type: "OPEN_OPTIONS" });
    window.close();
  };
  settingsBtn.addEventListener("click", openOptions);
  setupBtn.addEventListener("click", openOptions);

  downloadBtn.addEventListener("click", () => {
    if (!current) return;
    void startDownload({
      url: current.url,
      title: current.title,
      quality: PRESETS[formatSelect.value].quality
    });
  });

  async function startDownload(input) {
    lockForm();
    showProgress({ status: "preparing", detail: "שולח בקשה ל-GitHub…" }, input);
    const res = await send({ type: "START_DOWNLOAD", payload: input });
    if (!res || !res.ok) {
      showProgress({ status: "failed", detail: (res && res.error) || "ההורדה נכשלה" }, input);
      unlockForm();
      return;
    }
    currentJobId = res.jobId;
    startPolling(res.jobId, input);
  }

  function startPolling(jobId, input) {
    stopPolling();
    let consecutiveErrors = 0;
    const tick = async () => {
      const res = await send({ type: "POLL_JOB", jobId });
      if (res && res.ok) {
        consecutiveErrors = 0;
        showProgress(res.job, input);
        if (isTerminal(res.job.status)) {
          stopPolling();
          unlockForm();
        }
        return;
      }
      consecutiveErrors += 1;
      if (consecutiveErrors >= 4) {
        showProgress({ status: "failed", detail: (res && res.error) || "אבד הקשר לעבודה" }, input);
        stopPolling();
        unlockForm();
      }
    };
    void tick();
    pollTimer = setInterval(() => void tick(), 1000);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function lockForm() {
    downloadBtn.disabled = true;
    urlInput.disabled = true;
    formatSelect.disabled = true;
    pasteBtn.disabled = true;
  }

  function unlockForm() {
    urlInput.disabled = false;
    formatSelect.disabled = false;
    pasteBtn.disabled = false;
    downloadBtn.disabled = !current;
    downloadBtn.textContent = "הורדה";
  }

  function elapsedLabel(startedAt) {
    if (!startedAt) return "";
    const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m ? `${m}:${String(s).padStart(2, "0")}` : `${s}ש׳`;
  }

  function addAction(label, primary, onClick) {
    const btn = document.createElement("button");
    btn.className = primary ? "btn btn--primary" : "btn";
    btn.type = "button";
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    progressActions.append(btn);
  }

  function showProgress(job, input) {
    progressCard.hidden = false;
    progressStatus.textContent = STATUS_LABELS[job.status] || job.status;
    progressDetail.textContent = job.detail || "";

    const done = isTerminal(job.status);
    // GitHub Actions gives no byte-level progress, so the bar stays indeterminate
    // until the job reaches a terminal state rather than faking a percentage.
    progressFill.style.width = done ? "100%" : "35%";
    progressPct.textContent = done ? "" : elapsedLabel(job.startedAt);
    progressFill.classList.toggle("is-failed", job.status === "failed" || job.status === "cancelled");
    progressFill.classList.toggle("is-done", job.status === "completed");

    progressActions.replaceChildren();
    if (!done) {
      addAction("עצור", false, () => {
        if (currentJobId) void send({ type: "CANCEL_JOB", jobId: currentJobId });
      });
    }
    if (job.runId) {
      addAction("פתח את הריצה", false, () => void send({ type: "OPEN_RUN", jobId: currentJobId }));
    }
    if (job.status === "completed") {
      addAction("פתח תיקייה", true, () => void send({ type: "OPEN_DOWNLOADS" }));
    }
    if (job.status === "failed") {
      addAction("נסה שוב", true, () => void startDownload(input));
    }
  }

  async function tryAutoFill() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && extractVideoId(tab.url)) {
        urlInput.value = tab.url;
        await validateAndPreview();
        return;
      }
    } catch {
      /* no tab permission for this page; fall through to the clipboard */
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
  urlInput.focus();
})();
