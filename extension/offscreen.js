"use strict";
(() => {
  const EXT_TO_MIME = {
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
    "3gp": "video/3gpp",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    ogg: "audio/ogg",
    opus: "audio/opus",
    wav: "audio/wav"
  };

  function mimeForName(name) {
    const ext = (name.toLowerCase().split(".").pop() || "");
    return EXT_TO_MIME[ext] || "application/octet-stream";
  }

  async function unzipArtifact(msg) {
    try {
      // api.github.com answers with a 302 to storage. Chrome drops the Authorization
      // header on the cross-origin hop, which is exactly what the storage host wants.
      const res = await fetch(msg.url, {
        headers: {
          Authorization: `Bearer ${msg.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28"
        }
      });
      if (!res.ok) return { ok: false, error: `הורדת ה-artifact נכשלה (HTTP ${res.status})` };

      const zipped = new Uint8Array(await res.arrayBuffer());
      const entries = fflate.unzipSync(zipped);
      const files = [];
      for (const [name, data] of Object.entries(entries)) {
        if (!data || !data.length || name.endsWith("/")) continue;
        const blob = new Blob([data], { type: mimeForName(name) });
        files.push({ name, size: data.length, blobUrl: URL.createObjectURL(blob) });
      }
      if (!files.length) return { ok: false, error: "הארכיון שהתקבל ריק" };
      return { ok: true, files };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== "offscreen") return undefined;
    if (message.type === "UNZIP_ARTIFACT") {
      unzipArtifact(message).then(sendResponse);
      return true;
    }
    if (message.type === "REVOKE") {
      try {
        URL.revokeObjectURL(message.blobUrl);
      } catch {
        /* already gone */
      }
      sendResponse({ ok: true });
      return true;
    }
    return undefined;
  });
})();
