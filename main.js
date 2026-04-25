const path = require("path");
const {
  app,
  BrowserWindow,
  session,
  Menu,
  nativeTheme,
  nativeImage,
  dialog,
} = require("electron");
const { autoUpdater } = require("electron-updater");

/** Voor Windows-taakbalk groepering en juiste pictogram; zelfde als build.appId. */
if (process.platform === "win32") {
  app.setAppUserModelId("nl.webleaders.pm");
}

/** Favicon: light voor donkere UI, dark voor lichte UI (zelfde als de site). */
function getAppIconPath() {
  const file = nativeTheme.shouldUseDarkColors ? "favicon-light.png" : "favicon-dark.png";
  return path.join(__dirname, "images", file);
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    icon: createAppIcon(),
    webPreferences: sharedWebPreferences,
  });

  const menu = Menu.buildFromTemplate([
    {
      label: "Webleaders",
      submenu: [
        {
          label: "Vernieuwen",
          accelerator: "CmdOrCtrl+R",
          click: () => {
            if (!win.isDestroyed()) void win.webContents.reload();
          },
        },
        { type: "separator" },
        {
          label: "Controleren op updates…",
          click: () => {
            if (!app.isPackaged) {
              void dialog.showMessageBox(win, {
                type: "info",
                title: "Updates",
                message: "Updates werken in de geïnstalleerde app, niet in de ontwikkelmodus (npm start).",
              });
              return;
            }
            void autoUpdater.checkForUpdates();
          },
        },
        { type: "separator" },
        {
          label: "Ontwikkelgereedschap (Netwerk / console)",
          accelerator: "F12",
          click: () => {
            if (win.webContents.isDevToolsOpened()) {
              win.webContents.closeDevTools();
            } else {
              win.webContents.openDevTools({ mode: "undocked" });
            }
          },
        },
        { type: "separator" },
        { role: "quit", label: "Afsluiten" },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);

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

  autoUpdater.on("error", (err) => {
    console.error("[update] fout:", err);
  });

  autoUpdater.on("update-downloaded", (_e, info) => {
    void dialog
      .showMessageBox({
        type: "info",
        title: "Update beschikbaar",
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

  void autoUpdater.checkForUpdates().catch((e) => {
    console.error("[update] check mislukt:", e);
  });
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

  const syncAllWindowIcons = () => {
    const img = createAppIcon();
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.setIcon(img);
      } catch {
        /* optioneel */
      }
    }
    if (process.platform === "darwin") {
      try {
        app.dock.setIcon(getAppIconPath());
      } catch {
        /* optioneel */
      }
    }
  };
  nativeTheme.on("updated", syncAllWindowIcons);

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
