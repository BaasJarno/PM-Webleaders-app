const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("updateUI", {
  getInit: () => ipcRenderer.invoke("update:getInit"),
  onAppend: (cb) => {
    const fn = (_e, payload) => {
      try {
        cb(payload);
      } catch {
        /* */
      }
    };
    ipcRenderer.on("update:append", fn);
    return () => {
      ipcRenderer.removeListener("update:append", fn);
    };
  },
  checkNow: () => ipcRenderer.invoke("update:check"),
  copyLog: (text) => ipcRenderer.invoke("update:copyLog", text),
  installAndRestart: () => ipcRenderer.invoke("update:install"),
  close: () => ipcRenderer.invoke("update:closePanel"),
  notifyWebReady: () => ipcRenderer.invoke("update:panelWebReady"),
});
