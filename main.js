const path = require("path");
const fs = require("fs");
const pkg = require(path.join(__dirname, "package.json"));
const {
  app,
  BrowserWindow,
  session,
  Menu,
  globalShortcut,
  nativeImage,
  dialog,
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
 */
function getAppIconPath() {
  const relative = path.join("images", "favicon-dark.png");
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon: createAppIcon(),
    webPreferences: sharedWebPreferences,
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
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return;
    console.error("[app] pagina laadde niet:", { errorCode, errorDescription, validatedURL });
  });

  win.once("ready-to-show", () => {
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
    const showSystemDialog = !updatePanelReady;
    if (!showSystemDialog) {
      return;
    }
    const parent = getDialogParent();
    const ver = info && info.version ? info.version : "?";
    void dialog
      .showMessageBox(parent, {
        type: "info",
        title: "Update klaar",
        message: `Versie ${ver} is binnen. Wil je de app herstarten om te installeren?`,
        buttons: ["Later", "Herstarten"],
        defaultId: 1,
        cancelId: 0,
      })
      .then((r) => {
        if (r.response === 1) {
          autoUpdater.quitAndInstall(true, true);
        }
      });
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
