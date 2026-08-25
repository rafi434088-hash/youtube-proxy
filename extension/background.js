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

function formatBytes(n) {
  if (!n || n < 0) return "";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
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

// Hebrew labels for the workflow's own step names, so "synced with GitHub" reads as
// actual GitHub step names rather than a generic "running…". Falls back to the raw
// name (with "…") for anything not in this list, so new steps still show something.
const RUN_STEP_LABELS = {
  "Set up job": "מתחיל את הריצה…",
  "Validate request id": "בודק את הבקשה…",
  "Set up Deno": "מתקין Deno…",
  "Install yt-dlp + ffmpeg": "מתקין yt-dlp ו-ffmpeg…",
  "Decrypt cookies": "מפענח עוגיות…",
  Download: "מוריד עם yt-dlp…",
  "Always drop cookies": "מנקה קבצים זמניים…",
  "Upload artifact": "מעלה את הקובץ ל-GitHub…",
  "Complete job": "מסיים את הריצה…"
};

// Up to 3 pages (300 jobs) — comfortably covers the 200-item collection cap plus
// enumerate/package/resolve-video.
async function fetchAllRunJobs(cfg, runId) {
  const all = [];
  for (let page = 1; page <= 3; page += 1) {
    const res = await ghFetch(`${API}/repos/${cfg.owner}/${cfg.repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`, cfg);
    if (!res.ok) break;
    const body = await res.json();
    const batch = body.jobs || [];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

// Collection mode fans out one GitHub job per item (see download.yml) specifically so
// this can exist: GitHub's API reports whole-job completion, so counting how many of
// those per-item jobs are done gives real "X of Y downloaded" progress — something no
// single step, however it's split up, can ever expose while it's still running.
async function fetchRunProgress(cfg, runId, mode) {
  const allJobs = await fetchAllRunJobs(cfg, runId);
  if (!allJobs.length) return null;

  if (mode === "collection") {
    const items = allJobs.filter((j) => j.name && j.name.startsWith("download-item "));
    if (!items.length) {
      const enumJob = allJobs.find((j) => j.name === "enumerate");
      if (!enumJob || enumJob.status !== "completed") {
        return { total: 0, completed: 0, label: "סופר כמה פריטים יש בערוץ…" };
      }
      return null;
    }
    const succeeded = items.filter((j) => j.status === "completed" && j.conclusion === "success").length;
    const failed = items.filter((j) => j.status === "completed" && j.conclusion !== "success").length;
    const packaging = allJobs.some((j) => j.name === "package" && j.status !== "queued");
    const label = packaging
      ? "אורז הכל ל-ZIP אחד…"
      : `${succeeded} מתוך ${items.length} פריטים ירדו` + (failed ? ` (${failed} נכשלו)` : "");
    return { total: items.length, completed: succeeded + failed, label };
  }

  const ghJob = allJobs[0];
  const steps = ghJob && ghJob.steps;
  if (!steps || !steps.length) return null;
  const total = steps.length;
  const completed = steps.filter((s) => s.status === "completed").length;
  const active = steps.find((s) => s.status === "in_progress");
  const label = active ? RUN_STEP_LABELS[active.name] || `${active.name}…` : null;
  return { total, completed, label };
}

async function waitForRun(cfg, runId, onTick, signal, mode) {
  for (let i = 0; i < 600; i += 1) {
    if (signal.cancelled) throw new Error("בוטל");
    const res = await ghFetch(`${API}/repos/${cfg.owner}/${cfg.repo}/actions/runs/${runId}`, cfg);
    if (!res.ok) throw new Error(await ghError(res, "בדיקת סטטוס הריצה נכשלה"));
    const run = await res.json();
    const steps = run.status === "in_progress" ? await fetchRunProgress(cfg, runId, mode).catch(() => null) : null;
    onTick(run, steps);
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

/* ------------------------------------------------------------ recovery sync */

// chrome.storage.session (where jobs live) doesn't survive a browser restart, and an
// extension reload during development can wipe it too — but the run itself keeps
// going on GitHub regardless. This picks up any workflow_dispatch run that's still
// actually in flight (not tracked locally yet) and re-attaches to it, so reloading
// the extension mid-download reconnects instead of losing track of it. Runs GitHub
// itself already finished are deliberately left alone — those were either already
// saved, or the extension never got the chance to and re-fetching them unprompted
// would just silently re-save an old file the user didn't ask for again.
let lastGithubSync = 0;
async function syncRunsFromGitHub() {
  const now = Date.now();
  if (now - lastGithubSync < 15000) return;
  lastGithubSync = now;

  const cfg = await getConfig();
  if (!cfg.owner || !cfg.repo || !cfg.token) return;

  try {
    const res = await ghFetch(`${API}/repos/${cfg.owner}/${cfg.repo}/actions/runs?event=workflow_dispatch&per_page=20`, cfg);
    if (!res.ok) return;
    const body = await res.json();
    let added = false;
    for (const run of body.workflow_runs || []) {
      if (run.status === "completed") continue; // only reconnect to runs still in flight
      const match = /^dl-(.+)$/.exec(run.display_title || run.name || "");
      if (!match) continue;
      const requestId = match[1];
      if (jobs.has(requestId)) continue;
      // The original mode isn't retrievable after dispatch (GitHub doesn't expose
      // workflow_dispatch inputs post-hoc), but the job names it actually created do
      // give it away — collection mode has "enumerate"/"download-item "/"package".
      const runJobs = await fetchAllRunJobs(cfg, run.id).catch(() => []);
      const mode = runJobs.some((j) => j.name === "enumerate" || (j.name && j.name.startsWith("download-item ")))
        ? "collection"
        : "video";
      jobs.set(requestId, {
        id: requestId,
        requestId,
        url: "",
        title: `ריצה משוחזרת (${run.display_title})`,
        quality: null,
        mode,
        status: "running",
        detail: "התחברתי מחדש לריצה קיימת ב-GitHub…",
        percent: 15,
        runId: run.id,
        startedAt: new Date(run.created_at).getTime() || Date.now(),
        withCookies: false,
        files: [],
        recovered: true
      });
      added = true;
    }
    if (added) await persistJobs();
  } catch {
    /* best effort — a failed sync just means it tries again on the next call */
  }
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

async function unpackArtifact(cfg, artifactId, jobId) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "UNZIP_ARTIFACT",
    jobId,
    url: `${API}/repos/${cfg.owner}/${cfg.repo}/actions/artifacts/${artifactId}/zip`,
    token: cfg.token
  });
  if (!res || !res.ok) throw new Error((res && res.error) || "פריקת הקובץ נכשלה");
  return res.files;
}

function revokeBlob(blobUrl) {
  chrome.runtime.sendMessage({ target: "offscreen", type: "REVOKE", blobUrl }).catch(() => {});
}

// onProgress(bytesReceived, totalBytes) is polled from chrome.downloads.search rather
// than driven by onChanged, since onChanged only fires on state transitions, not on
// every byte-count update — polling is the only way to get a moving number here.
function saveBlob(blobUrl, filename, onProgress) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url: blobUrl, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || "השמירה נכשלה"));
        return;
      }
      const pollTimer = setInterval(() => {
        chrome.downloads.search({ id: downloadId }, (items) => {
          const item = items && items[0];
          if (item && item.state === "in_progress" && onProgress) {
            onProgress(item.bytesReceived || 0, item.totalBytes || item.fileSize || 0);
          }
        });
      }, 400);
      const settle = (state) => {
        clearInterval(pollTimer);
        chrome.downloads.onChanged.removeListener(listener);
        revokeBlob(blobUrl);
        if (state === "complete") {
          if (onProgress) onProgress(1, 1);
          resolve(downloadId);
        } else {
          reject(new Error("ההורדה למחשב הופסקה"));
        }
      };
      const listener = (delta) => {
        if (delta.id !== downloadId || !delta.state) return;
        if (delta.state.current !== "complete" && delta.state.current !== "interrupted") return;
        settle(delta.state.current);
      };
      chrome.downloads.onChanged.addListener(listener);
      // A small file can finish before the listener is attached, so check once.
      chrome.downloads.search({ id: downloadId }, (items) => {
        const state = items && items[0] && items[0].state;
        if (state === "complete" || state === "interrupted") settle(state);
      });
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
      patchJob(jobId, { status: "queued", detail: "מחפש את הריצה ב-Actions…", percent: 5 });
      const runId = await findRun(cfg, job.requestId, signal);
      patchJob(jobId, { runId });
    }

    patchJob(jobId, { status: "running", detail: "רץ ב-GitHub Actions…", percent: 10 });
    const conclusion = await waitForRun(
      cfg,
      jobs.get(jobId).runId,
      (run, steps) => {
        if (run.status === "queued") {
          patchJob(jobId, { detail: "בתור אצל GitHub…", percent: 8 });
          return;
        }
        if (run.status !== "in_progress") {
          patchJob(jobId, { detail: "הריצה הסתיימה", percent: 55 });
          return;
        }
        if (!steps || !steps.total) {
          // Either no progress signal yet, or (collection mode) still counting items
          // in the channel/playlist — steps.label carries that "counting…" message.
          patchJob(jobId, { detail: (steps && steps.label) || "רץ ב-GitHub Actions…", percent: 12 });
          return;
        }
        // GitHub only reports whole-job/whole-step completion, so between two of
        // those there's no real number to show — most visible on plain video mode's
        // single "Download" step, which might be 2 seconds or several minutes of
        // yt-dlp actually fetching, with nothing in between. Confirmed live: the
        // job's raw logs 404 while it's still running (GitHub only exposes them once
        // the job completes), so there's no way to read yt-dlp's own progress output
        // mid-run either. Collection mode gets real per-item granularity instead
        // (see fetchRunProgress) since each item is its own GitHub job; this easing
        // only matters there for the time within a single item's own download.
        const base = 10 + Math.floor(45 * (steps.completed / steps.total));
        const next = 10 + Math.floor((45 * Math.min(steps.total, steps.completed + 1)) / steps.total);
        const job = jobs.get(jobId);
        if (job.stepBase !== base) patchJob(jobId, { stepBase: base, stepNext: next, stepSince: Date.now() });
        const since = jobs.get(jobId).stepSince || Date.now();
        const elapsedSec = (Date.now() - since) / 1000;
        const eased = base + (next - base) * (1 - Math.exp(-elapsedSec / 15)) * 0.92;
        patchJob(jobId, { detail: steps.label || "רץ ב-GitHub Actions…", percent: Math.round(eased) });
      },
      signal,
      job.mode
    );

    if (conclusion === "cancelled") {
      patchJob(jobId, { status: "cancelled", detail: "הריצה בוטלה" });
      return;
    }
    if (conclusion !== "success") {
      throw new Error(`הריצה נכשלה (${conclusion || "ללא מסקנה"}) — פתחו את הריצה ב-Actions לפירוט`);
    }

    patchJob(jobId, { status: "fetching", detail: "מושך את הקובץ מ-GitHub…", percent: 55 });
    const artifact = await findArtifact(cfg, jobs.get(jobId).runId, job.requestId);
    const files = await unpackArtifact(cfg, artifact.id, jobId);

    patchJob(jobId, { status: "saving", detail: "שומר במחשב…", percent: 85 });
    const saved = [];
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const filename = sanitizeFilename(file.name);
      await saveBlob(file.blobUrl, filename, (received, total) => {
        const frac = total ? received / total : 0;
        const base = 85 + Math.floor((15 * i) / files.length);
        const span = 15 / files.length;
        patchJob(jobId, {
          percent: Math.min(99, base + Math.floor(span * frac)),
          detail: total
            ? `שומר במחשב: ${formatBytes(received)} מתוך ${formatBytes(total)}`
            : "שומר במחשב…"
        });
      });
      saved.push(filename);
    }

    patchJob(jobId, { status: "completed", detail: "הקובץ נשמר במחשב", files: saved, percent: 100 });
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

  const mode = payload.mode === "collection" ? "collection" : "video";

  jobs.set(jobId, {
    id: jobId,
    requestId,
    url: payload.url,
    title: payload.title || payload.url,
    quality: payload.quality,
    mode,
    status: "preparing",
    detail: "שולח בקשה ל-GitHub…",
    percent: 2,
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
      mode,
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
    case "LIST_JOBS": {
      await syncRunsFromGitHub();
      const plain = {};
      for (const [id, job] of jobs) plain[id] = job;
      for (const [id, job] of jobs) if (!TERMINAL.has(job.status)) void driveJob(id);
      return { ok: true, jobs: plain };
    }
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
  if (!message) return undefined;
  if (message.target === "offscreen") return undefined; // request headed to the offscreen doc
  if (message.type === "UNZIP_PROGRESS") {
    // Fire-and-forget progress ping from offscreen.js mid-fetch — no response needed,
    // it just nudges the job's percent while the artifact zip streams in.
    const job = jobs.get(message.jobId);
    if (job && !TERMINAL.has(job.status)) {
      const total = message.total;
      const frac = total ? Math.min(1, message.received / total) : 0;
      patchJob(message.jobId, {
        percent: 55 + Math.floor(30 * frac),
        detail: total
          ? `מוריד לדפדפן: ${formatBytes(message.received)} מתוך ${formatBytes(total)}`
          : `מוריד לדפדפן: ${formatBytes(message.received)}`
      });
    }
    return undefined;
  }
  handle(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true;
});

// No default_popup is set, so a toolbar click lands here — open (or refocus) one
// persistent tab instead. The download itself never depended on any UI staying
// open; this just makes it obvious the icon isn't a "cancel my downloads" button.
chrome.action.onClicked.addListener(async () => {
  const panelUrl = chrome.runtime.getURL("panel.html");
  const existing = await chrome.tabs.query({ url: panelUrl });
  if (existing.length) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: panelUrl });
});

// The service worker can be torn down mid-run; this alarm picks any unfinished job
// back up instead of leaving it stuck on "running".
chrome.alarms.create("ytproxy-resume", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "ytproxy-resume") return;
  await restoreJobs();
  await syncRunsFromGitHub();
  for (const [id, job] of jobs) {
    if (!TERMINAL.has(job.status)) void driveJob(id);
  }
});
