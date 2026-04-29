const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const pkg = require(path.join(__dirname, "package.json"));
const {
  app,
  BrowserWindow,
  screen,
  session,
  Menu,
  globalShortcut,
  nativeImage,
  ipcMain,
  clipboard,
} = require("electron");
const { autoUpdater } = require("electron-updater");

/** Voor Windows-taakbalk groepering en juiste pictogram; zelfde als build.appId. */
if (process.platform === "win32") {
  app.setAppUserModelId("nl.webleaders.pm");
}

/**
 * Pictogram: in productie liever van schijf (app.asar.unpacked) i.p.v. asar;
 * + signAndEditExecutable in de build zet het icoon in de .exe voor de Windows-taakbalk.
 * Op macOS de lichte variant (beter in Dock/menubalk); elders de donkere.
 */
function getAppIconRelativeFilename() {
  return process.platform === "darwin" ? "favicon-light.png" : "favicon-dark.png";
}

function getAppIconPath() {
  const relative = path.join("images", getAppIconRelativeFilename());
  if (app.isPackaged) {
    const unpacked = path.join(process.resourcesPath, "app.asar.unpacked", relative);
    if (fs.existsSync(unpacked)) {
      return unpacked;
    }
  }
  return path.join(__dirname, relative);
}

function createAppIcon() {
  const p = getAppIconPath();
  const img = nativeImage.createFromPath(p);
  if (img.isEmpty()) {
    console.warn("[app] pictogram ontbreekt of is ongeldig op pad:", p);
  }
  return img;
}

const APP_URL = "https://pm.webleaders.nl/";

function getWindowStateFilePath() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function readWindowState() {
  const fp = getWindowStateFilePath();
  if (!fs.existsSync(fp)) {
    return null;
  }
  try {
    const o = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (typeof o.width !== "number" || typeof o.height !== "number") {
      return null;
    }
    o.width = Math.max(800, Math.round(o.width));
    o.height = Math.max(600, Math.round(o.height));
    if (typeof o.x === "number") {
      o.x = Math.round(o.x);
    } else {
      o.x = undefined;
    }
    if (typeof o.y === "number") {
      o.y = Math.round(o.y);
    } else {
      o.y = undefined;
    }
    o.isMaximized = Boolean(o.isMaximized);
    return o;
  } catch {
    return null;
  }
}

function writeWindowState(win) {
  if (!win || win.isDestroyed()) {
    return;
  }
  try {
    const isMax = win.isMaximized();
    const b =
      isMax && typeof win.getNormalBounds === "function"
        ? win.getNormalBounds()
        : win.getBounds();
    const o = {
      width: b.width,
      height: b.height,
      x: b.x,
      y: b.y,
      isMaximized: isMax,
    };
    fs.writeFileSync(getWindowStateFilePath(), JSON.stringify(o) + "\n", "utf8");
  } catch (e) {
    console.warn("[app] vensterstate opslaan mislukt:", e);
  }
}

function isWindowSufficientlyOnScreen(window) {
  if (window.isDestroyed()) {
    return true;
  }
  const b = window.getBounds();
  const displays = screen.getAllDisplays();
  return displays.some((d) => {
    const w = d.workArea;
    const xOverlap = Math.max(0, Math.min(b.x + b.width, w.x + w.width) - Math.max(b.x, w.x));
    const yOverlap = Math.max(0, Math.min(b.y + b.height, w.y + w.height) - Math.max(b.y, w.y));
    return xOverlap >= 80 && yOverlap >= 80;
  });
}

let mainWindowStateSaveTimer = null;

function scheduleWriteMainWindowState(win) {
  clearTimeout(mainWindowStateSaveTimer);
  mainWindowStateSaveTimer = setTimeout(() => {
    mainWindowStateSaveTimer = null;
    writeWindowState(win);
  }, 500);
}

function buildMainWindowOptions() {
  const d = { width: 1280, height: 800, minWidth: 800, minHeight: 600 };
  const saved = readWindowState();
  if (!saved) {
    return d;
  }
  d.width = saved.width;
  d.height = saved.height;
  if (typeof saved.x === "number" && typeof saved.y === "number") {
    d.x = saved.x;
    d.y = saved.y;
  }
  d.show = false;
  d.autoHideMenuBar = true;
  return { ...d, _saved: saved };
}

/**
 * Zelfde Chromium-build als de Electron-versie, maar zonder "Electron" in de UA.
 */
function getChromeUserAgent() {
  const v = process.versions.chrome;
  if (process.platform === "win32") {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
  }
  if (process.platform === "darwin") {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
}

const sharedWebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

/** Geen Webleaders-menubalk; op macOS wel standaard app- + bewerkingsmenu. */
function setApplicationMenu() {
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }
}

function getDialogParent() {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

/** Events voor het update-diagnosevenster (ook als dat nog dicht is). */
const pendingUpdatePanelEvents = [];
const PENDING_UPDATE_MAX = 100;

let updatePanelWindow = null;
let updatePanelReady = false;

function safeErrorPayload(err) {
  if (!err) {
    return { message: "Onbekende fout" };
  }
  if (err instanceof Error) {
    return {
      message: err.message,
      name: err.name,
      code: err.code,
      stack: err.stack,
    };
  }
  if (typeof err === "string") {
    return { message: err };
  }
  if (err.message) {
    return {
      message: err.message,
      name: err.name,
      code: err.code,
      stack: err.stack,
    };
  }
  return { message: String(err) };
}

function safeDetailForPanel(type, data) {
  if (type === "error") {
    return safeErrorPayload(data);
  }
  if (type === "download-progress" && data && typeof data === "object") {
    return {
      percent: data.percent,
      bytesPerSecond: data.bytesPerSecond,
      total: data.total,
      transferred: data.transferred,
    };
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    try {
      return JSON.parse(JSON.stringify(data));
    } catch {
      return { message: String(data) };
    }
  }
  return data;
}

function pushUpdateEvent(type, data) {
  const entry = { type, t: Date.now(), data: safeDetailForPanel(type, data) };
  if (
    updatePanelWindow &&
    !updatePanelWindow.isDestroyed() &&
    updatePanelReady
  ) {
    try {
      updatePanelWindow.webContents.send("update:append", entry);
    } catch (e) {
      console.error("[update] panel sturen mislukt:", e);
    }
  } else {
    pendingUpdatePanelEvents.push(entry);
    if (pendingUpdatePanelEvents.length > PENDING_UPDATE_MAX) {
      pendingUpdatePanelEvents.shift();
    }
  }
}

function flushPendingUpdatePanelEvents() {
  if (!updatePanelWindow || updatePanelWindow.isDestroyed()) {
    return;
  }
  for (const e of pendingUpdatePanelEvents) {
    try {
      updatePanelWindow.webContents.send("update:append", e);
    } catch (err) {
      console.error("[update] buffer flush mislukt:", err);
    }
  }
  pendingUpdatePanelEvents.length = 0;
}

function openOrFocusUpdatePanel() {
  if (updatePanelWindow && !updatePanelWindow.isDestroyed()) {
    updatePanelWindow.show();
    try {
      updatePanelWindow.moveTop();
    } catch {
      /* */
    }
    updatePanelWindow.focus();
    return;
  }

  const parent = getDialogParent();
  const w = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 400,
    minHeight: 420,
    show: false,
    autoHideMenuBar: true,
    title: "Updates — Webleaders PM",
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    modal: false,
    icon: createAppIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "updatePanel", "preload.js"),
    },
  });

  w.once("ready-to-show", () => {
    w.show();
  });

  w.on("closed", () => {
    updatePanelWindow = null;
    updatePanelReady = false;
  });

  w.loadFile(path.join(__dirname, "updatePanel", "index.html"));
  updatePanelWindow = w;
}

function registerUpdatePanelIpc() {
  ipcMain.handle("update:panelWebReady", (event) => {
    if (!updatePanelWindow || updatePanelWindow.isDestroyed()) {
      return { ok: false };
    }
    const s = event.sender;
    if (!s || s.id !== updatePanelWindow.webContents.id) {
      return { ok: false };
    }
    updatePanelReady = true;
    flushPendingUpdatePanelEvents();
    return { ok: true };
  });

  ipcMain.handle("update:getInit", () => {
    const publish = pkg.build && pkg.build.publish ? pkg.build.publish : {};
    return {
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      platform: process.platform,
      githubOwner: publish.owner ?? "",
      githubRepo: publish.repo ?? "",
    };
  });

  ipcMain.handle("update:check", async () => {
    if (!app.isPackaged) {
      return { ok: false, error: "not_packaged" };
    }
    try {
      const r = await autoUpdater.checkForUpdates();
      return { ok: true, result: r ? { isUpdateAvailable: r.isUpdateAvailable, version: r.updateInfo?.version } : null };
    } catch (e) {
      pushUpdateEvent("error", e);
      return { ok: false, error: safeErrorPayload(e) };
    }
  });

  ipcMain.handle("update:copyLog", (_e, text) => {
    if (typeof text === "string" && text.length > 0) {
      clipboard.writeText(text);
    }
    return { ok: true };
  });

  ipcMain.handle("update:install", () => {
    if (!app.isPackaged) {
      return { ok: false };
    }
    setImmediate(() => {
      try {
        autoUpdater.quitAndInstall(true, true);
      } catch (e) {
        console.error("[update] quitAndInstall:", e);
      }
    });
    return { ok: true };
  });

  ipcMain.handle("update:closePanel", () => {
    if (updatePanelWindow && !updatePanelWindow.isDestroyed()) {
      updatePanelWindow.close();
    }
    return { ok: true };
  });
}

function checkUpdatesUserInitiated() {
  openOrFocusUpdatePanel();
  if (app.isPackaged) {
    setTimeout(() => {
      void autoUpdater.checkForUpdates().catch((e) => {
        pushUpdateEvent("error", e);
      });
    }, 500);
  }
}

function registerUpdateShortcut() {
  const ok = globalShortcut.register("CommandOrControl+U", () => {
    checkUpdatesUserInitiated();
  });
  if (!ok) {
    console.warn("[app] Snelkoppeling Ctrl+U (updates) kon niet geregistreerd worden (mogelijk in gebruik).");
  }
}

function isOfflineFileUrl(failedUrl) {
  if (!failedUrl) {
    return false;
  }
  try {
    const u = new URL(failedUrl);
    return u.protocol === "file:" && u.pathname.replace(/\\/g, "/").includes("offline/index.html");
  } catch {
    return false;
  }
}

function loadOfflineErrorPage(win, errorCode, errorDescription, validatedURL) {
  const filePath = path.join(__dirname, "offline", "index.html");
  const u = pathToFileURL(filePath);
  u.search = new URLSearchParams({
    code: String(errorCode),
    desc: String(errorDescription ?? ""),
    url: String(validatedURL ?? ""),
    target: APP_URL,
  }).toString();
  void win.loadURL(u.href);
}

function createWindow() {
  const winOpts = buildMainWindowOptions();
  const saved = winOpts._saved ?? null;
  const browserOpts = { ...winOpts };
  delete browserOpts._saved;

  const win = new BrowserWindow({
    width: browserOpts.width,
    height: browserOpts.height,
    x: browserOpts.x,
    y: browserOpts.y,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon: createAppIcon(),
    webPreferences: sharedWebPreferences,
  });

  win.on("resize", () => {
    if (!win.isMaximized()) {
      scheduleWriteMainWindowState(win);
    }
  });
  win.on("move", () => {
    if (!win.isMaximized()) {
      scheduleWriteMainWindowState(win);
    }
  });
  win.on("maximize", () => {
    writeWindowState(win);
  });
  win.on("unmaximize", () => {
    scheduleWriteMainWindowState(win);
  });
  win.on("close", () => {
    clearTimeout(mainWindowStateSaveTimer);
    mainWindowStateSaveTimer = null;
    writeWindowState(win);
  });

  win.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: {
      width: 500,
      height: 700,
      autoHideMenuBar: true,
      parent: win,
      modal: false,
      icon: createAppIcon(),
      webPreferences: sharedWebPreferences,
    },
  }));

  // ERR_ABORTED (-3) komt o.a. voor bij doorsturen/afbreken van een lopende laad, geen actie nodig
  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame === false) {
        return;
      }
      if (errorCode === -3) {
        return;
      }
      if (isOfflineFileUrl(String(validatedURL))) {
        console.error("[app] offline-pagina laadde niet:", { errorCode, errorDescription, validatedURL });
        return;
      }
      console.error("[app] pagina laadde niet:", { errorCode, errorDescription, validatedURL });
      loadOfflineErrorPage(win, errorCode, errorDescription, String(validatedURL ?? ""));
    },
  );

  win.once("ready-to-show", () => {
    if (saved) {
      if (saved.isMaximized) {
        win.maximize();
      } else if (!isWindowSufficientlyOnScreen(win)) {
        win.center();
      }
    }
    if (process.platform === "win32") {
      try {
        win.setIcon(createAppIcon());
      } catch {
        /* optioneel */
      }
    }
    win.show();
  });

  void win.loadURL(APP_URL);
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.disableDifferentialDownload = true;
  const log = {
    info: (m) => {
      const s = String(m);
      console.log("[update]", m);
      pushUpdateEvent("log", { level: "info", m: s });
    },
    warn: (m) => {
      const s = String(m);
      console.warn("[update]", m);
      pushUpdateEvent("log", { level: "warn", m: s });
    },
    error: (m) => {
      const s = String(m);
      console.error("[update]", m);
      pushUpdateEvent("log", { level: "error", m: s });
    },
    debug: (m) => {
      const s = String(m);
      if (console.debug) {
        console.debug("[update]", m);
      } else {
        console.log("[update]", m);
      }
      pushUpdateEvent("log", { level: "debug", m: s });
    },
  };
  autoUpdater.logger = log;

  autoUpdater.on("checking-for-update", () => {
    pushUpdateEvent("checking-for-update", {});
  });

  autoUpdater.on("update-available", (info) => {
    pushUpdateEvent("update-available", info);
  });

  autoUpdater.on("update-not-available", (info) => {
    pushUpdateEvent("update-not-available", info ?? {});
  });

  autoUpdater.on("download-progress", (progress) => {
    pushUpdateEvent("download-progress", progress);
  });

  autoUpdater.on("error", (err) => {
    console.error("[update] fout:", err);
    pushUpdateEvent("error", err);
  });

  autoUpdater.on("update-downloaded", (info) => {
    pushUpdateEvent("update-downloaded", info);
    pushUpdateEvent("log", {
      level: "info",
      m: "Update is binnen. De app stopt zo en start de installer (stille modus op Windows waar mogelijk).",
    });
    const delayMs = 1500;
    setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(true, true);
      } catch (e) {
        console.error("[update] quitAndInstall na download:", e);
      }
    }, delayMs);
  });

  // Na start even wachten (netwerk / sessie), dan op achtergrond controleren
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((e) => {
      console.error("[update] start-check:", e);
      pushUpdateEvent("error", e);
    });
  }, 5000);
}

app.setName("Webleaders PM");

app.whenReady().then(() => {
  session.defaultSession.setUserAgent(getChromeUserAgent());

  if (process.platform === "darwin") {
    try {
      app.dock.setIcon(getAppIconPath());
    } catch {
      /* optioneel */
    }
  }

  setApplicationMenu();
  registerUpdatePanelIpc();
  registerUpdateShortcut();
  setupAutoUpdater();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
