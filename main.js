const path = require("path");
const { app, BrowserWindow, session, Menu, nativeTheme } = require("electron");

/** Favicon: light voor donkere UI, dark voor lichte UI (zelfde als de site). */
function getAppIconPath() {
  const file = nativeTheme.shouldUseDarkColors ? "favicon-light.png" : "favicon-dark.png";
  return path.join(__dirname, "images", file);
}

/** Webleaders-app, pas na actieve Google-sessie in dezelfde sessie. */
const APP_URL = "https://pm.webleaders.nl/";

/** Eerst Google: zelfde cookie-jar, daarna is “Inloggen met Google” op de site meestal al gekoppeld. */
const GOOGLE_ENTRY_URL = "https://accounts.google.com/";

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

function isPmWebleadersHost(hostname) {
  return hostname === "pm.webleaders.nl" || hostname.endsWith(".webleaders.nl");
}

function isWebleadersAppUrl(url) {
  try {
    return isPmWebleadersHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Na inlog (of al ingelogd) leidt Google meestal naar mijn account.
 * Dan kunnen we veilig Webleaders laden met een bestaande Google-sessie.
 */
function isGoogleSessionReadyToHandoffUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return u.hostname === "myaccount.google.com";
  } catch {
    return false;
  }
}

function createWindow() {
  let handoffToWebleadersDone = false;

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    icon: getAppIconPath(),
    webPreferences: sharedWebPreferences,
  });

  const goToWebleaders = () => {
    if (handoffToWebleadersDone) return;
    handoffToWebleadersDone = true;
    void win.loadURL(APP_URL);
  };

  const maybeHandoffFromGoogle = (url) => {
    if (handoffToWebleadersDone) return;
    if (!url) return;
    if (isWebleadersAppUrl(url)) {
      return;
    }
    if (isGoogleSessionReadyToHandoffUrl(url)) {
      goToWebleaders();
    }
  };

  const menu = Menu.buildFromTemplate([
    {
      label: "Webleaders",
      submenu: [
        {
          label: "Open Webleaders (na Google-inlog)",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            goToWebleaders();
          },
        },
        {
          label: "Opnieuw: Google inlog",
          click: () => {
            handoffToWebleadersDone = false;
            void win.loadURL(GOOGLE_ENTRY_URL);
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
      icon: getAppIconPath(),
      webPreferences: sharedWebPreferences,
    },
  }));

  win.webContents.on("did-navigate", (_e, url) => {
    maybeHandoffFromGoogle(url);
  });
  win.webContents.on("did-navigate-in-page", (_e, url) => {
    maybeHandoffFromGoogle(url);
  });

  // ERR_ABORTED (-3) komt o.a. voor bij doorsturen/afbreken van een lopende laad, geen actie nodig
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return;
    // Zichtbaar in de terminal; open ook Ontwikkelgereedschap (F12) op het tabblad Network
    console.error("[app] pagina laadde niet:", { errorCode, errorDescription, validatedURL });
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  void win.loadURL(GOOGLE_ENTRY_URL);
}

app.setName("Webleaders PM");

app.whenReady().then(() => {
  session.defaultSession.setUserAgent(getChromeUserAgent());

  if (process.platform === "darwin") {
    try {
      app.dock.setIcon(getAppIconPath());
    } catch {
      /* icon optioneel */
    }
  }

  const syncAllWindowIcons = () => {
    const p = getAppIconPath();
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.setIcon(p);
      } catch {
        /* optioneel */
      }
    }
    if (process.platform === "darwin") {
      try {
        app.dock.setIcon(p);
      } catch {
        /* optioneel */
      }
    }
  };
  nativeTheme.on("updated", syncAllWindowIcons);

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
