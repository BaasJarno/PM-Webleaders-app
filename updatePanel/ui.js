/* global window */

function handleAppend(payload) {
  const { t, type, data } = payload;
  const time = t ? new Date(t).toLocaleString("nl-NL", { hour12: false }) : formatTime();

  switch (type) {
    case "init":
      return;
    case "log": {
      const msg = data?.m ?? data?.message ?? String(data);
      const lvl = data?.level;
      const cls = lvl === "error" ? "line--error" : lvl === "warn" ? "line--warn" : "";
      appendLine(`[${time}] [${lvl ?? "log"}] ${msg}`, cls);
      return;
    }
    case "checking-for-update":
      setDownloadProgress(false);
      appendLine(`[${time}] Zoeken naar updates op GitHub…`, "");
      return;
    case "update-available": {
      const v = data?.version ?? data?.ver ?? "?";
      setDownloadProgress(false);
      appendLine(`[${time}] Nieuwe versie gevonden: ${v} (download start op de achtergrond, tenzij geblokkeerd).`, "line--ok");
      $btnInstall.hidden = true;
      return;
    }
    case "update-not-available": {
      setDownloadProgress(false);
      appendLine(`[${time}] Geen nieuwere release dan deze app, of dezelfde versie.`, "");
      $btnInstall.hidden = true;
      return;
    }
    case "download-progress": {
      const p = data;
      if (p && typeof p.percent === "number") {
        setDownloadProgress(true, p.percent, p.transferred, p.total);
      }
      return;
    }
    case "update-downloaded": {
      const v = data?.version ?? "?";
      setDownloadProgress(false);
      lastDownloadedInfo = data;
      $btnInstall.hidden = true;
      appendLine(
        `[${time}] Update ${v} is binnen. De app start zo automatisch opnieuw (installer).`,
        "line--ok",
      );
      return;
    }
    case "error": {
      setDownloadProgress(false);
      const m = data?.message ?? "Onbekende fout";
      const code = data?.code ? ` (code: ${data.code})` : "";
      const st = data?.stack ? `\n${String(data.stack).slice(0, 800)}` : "";
      appendLine(`[${time}] FOUT${code}: ${m}${st}`, "line--error");
      return;
    }
    default: {
      let s;
      try {
        s = typeof data === "string" ? data : JSON.stringify(data, null, 2);
      } catch {
        s = String(data);
      }
      appendLine(`[${time}] [${type}] ${s ?? ""}`, "");
    }
  }
}

const $log = document.getElementById("log");
const $meta = document.getElementById("meta");
const $btnCheck = document.getElementById("btnCheck");
const $btnCopy = document.getElementById("btnCopy");
const $btnClear = document.getElementById("btnClear");
const $btnInstall = document.getElementById("btnInstall");
const $progressWrap = document.getElementById("progressWrap");
const $progressBar = document.getElementById("progressBar");
const $progressMeta = document.getElementById("progressMeta");
const $progressLabel = document.getElementById("progressLabel");

let lastDownloadedInfo = null;
let lineCount = 0;
const maxLines = 500;

function setDownloadProgress(visible, percent, transferred, total) {
  if (!$progressWrap || !$progressBar || !$progressMeta) {
    return;
  }
  if (!visible) {
    $progressWrap.classList.remove("is-visible");
    $progressWrap.setAttribute("aria-hidden", "true");
    $progressBar.value = 0;
    $progressMeta.textContent = "";
    if ($progressLabel) {
      $progressLabel.textContent = "Download";
    }
    return;
  }
  $progressWrap.classList.add("is-visible");
  $progressWrap.setAttribute("aria-hidden", "false");
  if (typeof percent === "number") {
    $progressBar.value = Math.min(100, Math.max(0, percent));
  }
  if ($progressLabel) {
    $progressLabel.textContent =
      typeof percent === "number" ? `Download (${percent.toFixed(0)}%)` : "Download";
  }
  if (transferred != null && total != null && total > 0) {
    $progressMeta.textContent = `${(transferred / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`;
  } else if (typeof percent === "number") {
    $progressMeta.textContent = `${percent.toFixed(1)}% voltooid`;
  }
}

function clearLog() {
  if (!$log) {
    return;
  }
  $log.replaceChildren();
  lineCount = 0;
}

function appendLine(text, className) {
  lineCount += 1;
  if (lineCount > maxLines) {
    const all = $log.querySelectorAll("div");
    if (all[0]) {
      all[0].remove();
      lineCount -= 1;
    }
  }
  const d = document.createElement("div");
  if (className) {
    d.className = className;
  }
  d.textContent = text;
  $log.appendChild(d);
  $log.scrollTop = $log.scrollHeight;
}

function fullLogText() {
  return (
    "Webleaders PM — update-log\n" +
    Array.from($log.querySelectorAll("div"))
      .map((d) => d.textContent)
      .join("\n")
  );
}

function formatTime() {
  return new Date().toLocaleString("nl-NL", { hour12: false });
}

$btnCopy.addEventListener("click", () => {
  const t = fullLogText();
  void window.updateUI.copyLog(t);
  appendLine(`[${formatTime()}] (Log gekopieerd naar klembord.)`, "line--ok");
});

$btnClear?.addEventListener("click", () => {
  clearLog();
  appendLine(`[${formatTime()}] Log gewist.`, "");
});

$btnCheck.addEventListener("click", () => {
  $btnCheck.disabled = true;
  void window.updateUI
    .checkNow()
    .then(() => {
      appendLine(`[${formatTime()}] Controle verzoek verstuurd.`, "");
    })
    .catch((e) => {
      appendLine(`[${formatTime()}] checkNow mislukt: ${e?.message ?? e}`, "line--error");
    })
    .finally(() => {
      $btnCheck.disabled = false;
    });
});

$btnInstall.addEventListener("click", () => {
  if (!lastDownloadedInfo) {
    return;
  }
  $btnInstall.disabled = true;
  void window.updateUI.installAndRestart();
});

window.updateUI.onAppend(handleAppend);
void window.updateUI.notifyWebReady();

async function boot() {
  const init = await window.updateUI.getInit();
  if (!init.isPackaged) {
    $btnCheck.disabled = true;
  }
  $meta.innerHTML = `
    <span>Huidige versie: <strong>${init.appVersion}</strong></span>
    <span>Modus: <strong>${init.isPackaged ? "geïnstalleerd" : "ontwikkeling (npm start)"}</strong></span>
    <span>Platform: <strong>${init.platform}</strong></span>
    <span>GitHub: <strong>${init.githubOwner}</strong> / <strong>${init.githubRepo}</strong></span>
  `;
  if (!init.isPackaged) {
    appendLine("In ontwikkelmodus: er wordt niet echt op GitHub gezocht na updates.", "line--warn");
  }
  appendLine(`[${formatTime()}] Diagnosevenster geopend. Klik op “Zoek nu naar updates” om te proberen.`, "");
}

void boot().catch((e) => {
  $log.textContent = `Fout bij laden: ${e?.message ?? e}`;
});
