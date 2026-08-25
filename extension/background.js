"use strict";

// config.js is local-only (it holds the token and the cookie key), so a checkout
// without it still has to load: the built-in blanks below keep the worker alive and
// the options page fills the rest in.
const BUILTIN_CONFIG = {
  owner: "",
  repo: "",
  workflow: "download.yml",
  ref: "main",
  token: "",
  cookieKey: ""
};
try {
  importScripts("config.js");
} catch {
  /* no local config.js — everything comes from the options page */
}
const DEFAULTS = { ...BUILTIN_CONFIG, ...(self.DEFAULT_CONFIG || {}) };

const API = "https://api.github.com";
const CFG_KEY = "ytproxy_cfg";
const JOBS_KEY = "ytproxy_jobs";

/* ------------------------------------------------------------------ config */

async function getConfig() {
  const stored = (await chrome.storage.local.get(CFG_KEY))[CFG_KEY] || {};
  const cfg = { ...DEFAULTS, ...stored };
  cfg.owner = (cfg.owner || "").trim();
  cfg.repo = (cfg.repo || "").trim();
  cfg.workflow = (cfg.workflow || "download.yml").trim();
  cfg.ref = (cfg.ref || "main").trim();
  cfg.token = (cfg.token || "").trim();
  cfg.cookieKey = (cfg.cookieKey || "").trim();
  return cfg;
}

async function setConfig(patch) {
  const stored = (await chrome.storage.local.get(CFG_KEY))[CFG_KEY] || {};
  const next = { ...stored, ...patch };
  await chrome.storage.local.set({ [CFG_KEY]: next });
  return getConfig();
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

/* ------------------------------------------------------------------- utils */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function bytesToB64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function sanitizeFilename(name) {
  const base = (name || "download").split(/[\\/]/).pop();
  const clean = base
    .replace(/[<>:"|?*\x00-\x1f]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180);
  return clean || "download";
}

/* ----------------------------------------------------------------- cookies */

const COOKIE_DOMAINS = ["youtube.com", "google.com"];

async function exportYoutubeCookies() {
  if (!chrome.cookies || !chrome.cookies.getAll) return null;
  try {
    const groups = await Promise.all(COOKIE_DOMAINS.map((domain) => chrome.cookies.getAll({ domain })));
    const seen = new Set();
    const lines = ["# Netscape HTTP Cookie File"];
    for (const c of groups.flat()) {
      const key = `${c.domain}|${c.name}|${c.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let domain = c.domain;
      if (!c.hostOnly && !domain.startsWith(".")) domain = `.${domain}`;
      const includeSub = c.hostOnly ? "FALSE" : "TRUE";
      const secure = c.secure ? "TRUE" : "FALSE";
      const expiry = c.expirationDate ? Math.floor(c.expirationDate) : 0;
      const prefix = c.httpOnly ? "#HttpOnly_" : "";
      lines.push(`${prefix}${domain}\t${includeSub}\t${c.path}\t${secure}\t${expiry}\t${c.name}\t${c.value}`);
    }
    return lines.length > 1 ? `${lines.join("\n")}\n` : null;
  } catch {
    return null;
  }
}

// The repo is public, so anything that lands in a workflow input can end up on a
// publicly readable run page. Cookies are live session credentials, so they travel
// encrypted and are only decrypted inside the job with the COOKIE_KEY repo secret.
async function encryptCookies(text, hexKey) {
  const raw = hexToBytes(hexKey);
  if (raw.length !== 32) throw new Error("COOKIE_KEY חייב להיות 32 בייטים (64 תווי hex)");
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text)));
  const blob = new Uint8Array(iv.length + ct.length);
  blob.set(iv, 0);
  blob.set(ct, iv.length);
  return bytesToB64(blob);
}

/* -------------------------------------------------------------- job state */

const jobs = new Map();
const driving = new Set();

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

async function persistJobs() {
  const plain = {};
  for (const [id, job] of jobs) plain[id] = job;
  try {
    await chrome.storage.session.set({ [JOBS_KEY]: plain });
  } catch {
    /* storage.session is best effort only */
  }
}

async function restoreJobs() {
  if (jobs.size) return;
  try {
    const plain = (await chrome.storage.session.get(JOBS_KEY))[JOBS_KEY] || {};
    for (const [id, job] of Object.entries(plain)) jobs.set(id, job);
  } catch {
    /* ignore */
  }
}

function patchJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch);
  void persistJobs();
  return job;
}

/* ------------------------------------------------------------ github calls */

function ghFetch(url, cfg, init = {}) {
  return fetch(url, {
    ...init,
    headers: { ...ghHeaders(cfg.token), ...(init.headers || {}) }
  });
}

async function ghError(res, fallback) {
  let message = fallback;
  try {
    const body = await res.json();
    if (body && body.message) message = body.message;
  } catch {
    /* non-JSON error body */
  }
  if (res.status === 401) return "הטוקן לא תקין או פג תוקף";
  if (res.status === 403) return `אין הרשאה: ${message}`;
  if (res.status === 404) return "לא נמצא — בדקו owner/repo/שם הוורקפלואו והרשאות הטוקן";
  return `${message} (HTTP ${res.status})`;
}

async function dispatchWorkflow(cfg, inputs) {
  const url = `${API}/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${encodeURIComponent(cfg.workflow)}/dispatches`;
  const res = await ghFetch(url, cfg, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: cfg.ref, inputs })
  });
  if (res.status !== 204) throw new Error(await ghError(res, "שליחת הבקשה נכשלה"));
}

// The run is matched by its run-name (dl-<requestId>), which the workflow builds
// from the request_id input. That is what keeps parallel downloads from crossing.
async function findRun(cfg, requestId, signal) {
  const target = `dl-${requestId}`;
  const url = `${API}/repos/${cfg.owner}/${cfg.repo}/actions/runs?event=workflow_dispatch&per_page=40`;
  for (let i = 0; i < 40; i += 1) {
    if (signal.cancelled) throw new Error("בוטל");
    const res = await ghFetch(url, cfg);
    if (res.ok) {
      const body = await res.json();
      const match = (body.workflow_runs || []).find((r) => r.display_title === target || r.name === target);
      if (match) return match.id;
    }
    await sleep(3000);
  }
  throw new Error("הריצה לא נמצאה תוך שתי דקות — בדקו בטאב Actions בריפו");
}

async function waitForRun(cfg, runId, onTick, signal) {
  for (let i = 0; i < 600; i += 1) {
    if (signal.cancelled) throw new Error("בוטל");
    const res = await ghFetch(`${API}/repos/${cfg.owner}/${cfg.repo}/actions/runs/${runId}`, cfg);
    if (!res.ok) throw new Error(await ghError(res, "בדיקת סטטוס הריצה נכשלה"));
    const run = await res.json();
    onTick(run);
    if (run.status === "completed") return run.conclusion;
    await sleep(5000);
  }
  throw new Error("הריצה לא הסתיימה בזמן סביר");
}

async function findArtifact(cfg, runId, requestId) {
  const res = await ghFetch(`${API}/repos/${cfg.owner}/${cfg.repo}/actions/runs/${runId}/artifacts`, cfg);
  if (!res.ok) throw new Error(await ghError(res, "שליפת ה-artifact נכשלה"));
  const body = await res.json();
  const list = body.artifacts || [];
  const found = list.find((a) => a.name === `dl-${requestId}`);
  if (!found) throw new Error("לא נוצר קובץ בריצה הזו");
  return found;
}

async function cancelRun(cfg, runId) {
  const res = await ghFetch(`${API}/repos/${cfg.owner}/${cfg.repo}/actions/runs/${runId}/cancel`, cfg, { method: "POST" });
  return res.ok || res.status === 202;
}

/* ------------------------------------------------------ offscreen unzipper */

let offscreenReady = null;

async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (existing.length) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "פריקת ה-ZIP של ה-artifact ויצירת blob URL לשמירה — לא זמין ב-service worker"
    });
  })();
  try {
    await offscreenReady;
  } catch (err) {
    offscreenReady = null;
    throw err;
  }
  return offscreenReady;
}

async function unpackArtifact(cfg, artifactId) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "UNZIP_ARTIFACT",
    url: `${API}/repos/${cfg.owner}/${cfg.repo}/actions/artifacts/${artifactId}/zip`,
    token: cfg.token
  });
  if (!res || !res.ok) throw new Error((res && res.error) || "פריקת הקובץ נכשלה");
  return res.files;
}

function revokeBlob(blobUrl) {
  chrome.runtime.sendMessage({ target: "offscreen", type: "REVOKE", blobUrl }).catch(() => {});
}

function saveBlob(blobUrl, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url: blobUrl, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || "השמירה נכשלה"));
        return;
      }
      const listener = (delta) => {
        if (delta.id !== downloadId || !delta.state) return;
        if (delta.state.current !== "complete" && delta.state.current !== "interrupted") return;
        chrome.downloads.onChanged.removeListener(listener);
        revokeBlob(blobUrl);
        if (delta.state.current === "complete") resolve(downloadId);
        else reject(new Error("ההורדה למחשב הופסקה"));
      };
      chrome.downloads.onChanged.addListener(listener);
    });
  });
}

/* ----------------------------------------------------------- job lifecycle */

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title,
      message
    });
  } catch {
    /* notifications are optional */
  }
}

async function driveJob(jobId) {
  if (driving.has(jobId)) return;
  driving.add(jobId);
  const job = jobs.get(jobId);
  if (!job) {
    driving.delete(jobId);
    return;
  }
  const signal = {
    get cancelled() {
      const j = jobs.get(jobId);
      return !j || j.status === "cancelled";
    }
  };

  try {
    const cfg = await getConfig();

    if (!job.runId) {
      patchJob(jobId, { status: "queued", detail: "מחפש את הריצה ב-Actions…" });
      const runId = await findRun(cfg, job.requestId, signal);
      patchJob(jobId, { runId });
    }

    patchJob(jobId, { status: "running", detail: "רץ ב-GitHub Actions…" });
    const conclusion = await waitForRun(
      cfg,
      jobs.get(jobId).runId,
      (run) => {
        const label =
          { queued: "בתור אצל GitHub…", in_progress: "מוריד ב-Actions…", completed: "הריצה הסתיימה" }[run.status] ||
          run.status;
        patchJob(jobId, { detail: label });
      },
      signal
    );

    if (conclusion === "cancelled") {
      patchJob(jobId, { status: "cancelled", detail: "הריצה בוטלה" });
      return;
    }
    if (conclusion !== "success") {
      throw new Error(`הריצה נכשלה (${conclusion || "ללא מסקנה"}) — פתחו את הריצה ב-Actions לפירוט`);
    }

    patchJob(jobId, { status: "fetching", detail: "מושך את הקובץ מ-GitHub…" });
    const artifact = await findArtifact(cfg, jobs.get(jobId).runId, job.requestId);
    const files = await unpackArtifact(cfg, artifact.id);

    patchJob(jobId, { status: "saving", detail: "שומר במחשב…" });
    const saved = [];
    for (const file of files) {
      const filename = sanitizeFilename(file.name);
      await saveBlob(file.blobUrl, filename);
      saved.push(filename);
    }

    patchJob(jobId, { status: "completed", detail: "הקובץ נשמר במחשב", files: saved });
    notify("ההורדה הסתיימה", saved[0] || job.title || job.url);
  } catch (err) {
    const current = jobs.get(jobId);
    if (current && current.status === "cancelled") return;
    const message = err instanceof Error ? err.message : String(err);
    patchJob(jobId, { status: "failed", detail: message, error: message });
    notify("ההורדה נכשלה", message);
  } finally {
    driving.delete(jobId);
  }
}

async function startDownload(payload) {
  const cfg = await getConfig();
  if (!cfg.owner || !cfg.repo) return { ok: false, error: "חסרים owner/repo — פתחו את ההגדרות" };
  if (!cfg.token) return { ok: false, error: "לא הוגדר טוקן GitHub — פתחו את ההגדרות" };
  if (!cfg.cookieKey) return { ok: false, error: "לא הוגדר COOKIE_KEY — פתחו את ההגדרות" };

  const requestId = crypto.randomUUID();
  const jobId = requestId;

  let cookiesEnc = "";
  const cookies = await exportYoutubeCookies();
  if (cookies) {
    try {
      cookiesEnc = await encryptCookies(cookies, cfg.cookieKey);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // workflow_dispatch caps its inputs; fail with something readable instead of
    // letting GitHub answer with an opaque 422.
    if (cookiesEnc.length > 60000) {
      return { ok: false, error: "העוגיות גדולות מדי לשליחה — נקו עוגיות ישנות בדפדפן ונסו שוב" };
    }
  }

  jobs.set(jobId, {
    id: jobId,
    requestId,
    url: payload.url,
    title: payload.title || payload.url,
    quality: payload.quality,
    status: "preparing",
    detail: "שולח בקשה ל-GitHub…",
    runId: null,
    startedAt: Date.now(),
    withCookies: Boolean(cookiesEnc),
    files: []
  });
  await persistJobs();

  try {
    await dispatchWorkflow(cfg, {
      request_id: requestId,
      url: payload.url,
      quality: payload.quality,
      cookies_enc: cookiesEnc
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    patchJob(jobId, { status: "failed", detail: message, error: message });
    return { ok: false, error: message, jobId };
  }

  void driveJob(jobId);
  return { ok: true, jobId };
}

async function testConnection() {
  const cfg = await getConfig();
  if (!cfg.owner || !cfg.repo) return { ok: false, error: "חסרים owner/repo" };
  if (!cfg.token) return { ok: false, error: "חסר טוקן" };
  const res = await ghFetch(
    `${API}/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${encodeURIComponent(cfg.workflow)}`,
    cfg
  );
  if (!res.ok) return { ok: false, error: await ghError(res, "החיבור נכשל") };
  const wf = await res.json();
  return { ok: true, detail: `${cfg.owner}/${cfg.repo} · ${wf.name || cfg.workflow} · ${wf.state}` };
}

/* -------------------------------------------------------------- messaging */

async function handle(msg) {
  await restoreJobs();
  switch (msg.type) {
    case "GET_PREFS": {
      const cfg = await getConfig();
      return {
        configured: Boolean(cfg.owner && cfg.repo && cfg.token && cfg.cookieKey),
        owner: cfg.owner,
        repo: cfg.repo,
        defaultOption: cfg.defaultOption || "video_best"
      };
    }
    case "GET_CONFIG":
      return getConfig();
    case "SET_CONFIG":
      return setConfig(msg.patch);
    case "RESET_CONFIG":
      await chrome.storage.local.remove(CFG_KEY);
      return getConfig();
    case "TEST_CONNECTION":
      return testConnection();
    case "START_DOWNLOAD":
      return startDownload(msg.payload);
    case "POLL_JOB": {
      const job = jobs.get(msg.jobId);
      if (!job) return { ok: false, error: "העבודה לא נמצאה" };
      if (!TERMINAL.has(job.status)) void driveJob(msg.jobId);
      return { ok: true, job };
    }
    case "CANCEL_JOB": {
      const job = jobs.get(msg.jobId);
      if (!job) return { ok: false, error: "העבודה לא נמצאה" };
      patchJob(msg.jobId, { status: "cancelled", detail: "מבטל…" });
      if (job.runId) {
        const cfg = await getConfig();
        await cancelRun(cfg, job.runId).catch(() => false);
      }
      patchJob(msg.jobId, { detail: "ההורדה בוטלה" });
      return { ok: true };
    }
    case "OPEN_RUN": {
      const job = jobs.get(msg.jobId);
      const cfg = await getConfig();
      const url =
        job && job.runId
          ? `https://github.com/${cfg.owner}/${cfg.repo}/actions/runs/${job.runId}`
          : `https://github.com/${cfg.owner}/${cfg.repo}/actions`;
      await chrome.tabs.create({ url });
      return { ok: true };
    }
    case "OPEN_DOWNLOADS":
      chrome.downloads.showDefaultFolder();
      return { ok: true };
    case "OPEN_OPTIONS":
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    default:
      return { ok: false, error: `הודעה לא מוכרת: ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.target === "offscreen") return undefined;
  handle(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true;
});

// The service worker can be torn down mid-run; this alarm picks any unfinished job
// back up instead of leaving it stuck on "running".
chrome.alarms.create("ytproxy-resume", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "ytproxy-resume") return;
  await restoreJobs();
  for (const [id, job] of jobs) {
    if (!TERMINAL.has(job.status)) void driveJob(id);
  }
});
