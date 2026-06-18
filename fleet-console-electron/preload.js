"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fleetApp", {
  minimize:          () => ipcRenderer.invoke("window:minimize"),
  maximize:          () => ipcRenderer.invoke("window:maximize"),
  close:             () => ipcRenderer.invoke("window:close"),
  isMaximized:       () => ipcRenderer.invoke("window:is-maximized"),
  getPort:           () => ipcRenderer.invoke("get-port"),
  onMaximizedChange: (cb) => ipcRenderer.on("window-maximized", (_ev, val) => cb(val)),
});
