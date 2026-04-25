const path = require("path");
const fs = require("fs");
const {
  app,
  BrowserWindow,
  session,
  Menu,
  globalShortcut,
  nativeImage,
  dialog,
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

function checkUpdatesUserInitiated() {
  if (!app.isPackaged) {
    void dialog.showMessageBox({
      type: "info",
      title: "Updates",
      message: "Updates werken in de geïnstalleerde app, niet in de ontwikkelmodus (npm start).",
    });
    return;
  }

  const parent = getDialogParent();
  const cleanup = () => {
    autoUpdater.removeListener("error", onError);
    autoUpdater.removeListener("update-not-available", onNotAvailable);
  };

  const onError = (err) => {
    cleanup();
    void dialog.showMessageBox(parent, {
      type: "error",
      title: "Update",
      message: "Controleren op updates op GitHub is mislukt.",
      detail: `${err.name ?? "Fout"}\n${err.message}\n\nControleer of op de release o.a. latest.yml (Windows) of latest-mac.yml (Mac) als bijlage staan, en geen 'pre-release' zonder toestemming.`,
    });
  };

  const onNotAvailable = () => {
    cleanup();
    void dialog.showMessageBox(parent, {
      type: "info",
      title: "Geen update",
      message: "Er is geen nieuwere release dan jouw huidige versie, of de server gaf geen resultaat (zelfde of oudere versie).",
    });
  };

  /** Nieuwe versie: geen extra dialoog; autoDownload + update-downloaded vangen dit af. */
  const onAvailable = () => {
    cleanup();
  };

  autoUpdater.once("error", onError);
  autoUpdater.once("update-not-available", onNotAvailable);
  autoUpdater.once("update-available", onAvailable);
  void autoUpdater.checkForUpdates().catch(() => {
    /* onError afhandelt */
  });
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
  autoUpdater.logger = {
    info: (m) => console.log("[update]", m),
    warn: (m) => console.warn("[update]", m),
    error: (m) => console.error("[update]", m),
    debug: (m) => (console.debug ? console.debug("[update]", m) : console.log("[update]", m)),
  };

  // Alleen stille logs bij automatische start (geen pop-up-storm)
  autoUpdater.on("error", (err) => {
    console.error("[update] fout (start):", err);
  });

  autoUpdater.on("update-downloaded", (_e, info) => {
    const parent = getDialogParent();
    void dialog
      .showMessageBox(parent, {
        type: "info",
        title: "Update klaar",
        message: `Versie ${info.version} is binnen. Wil je de app herstarten om te installeren?`,
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
