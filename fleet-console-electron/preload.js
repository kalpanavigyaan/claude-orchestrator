"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fleetApp", {
  minimize:          () => ipcRenderer.invoke("window:minimize"),
  maximize:          () => ipcRenderer.invoke("window:maximize"),
  close:             () => ipcRenderer.invoke("window:close"),
  isMaximized:       () => ipcRenderer.invoke("window:is-maximized"),
  getPort:           () => ipcRenderer.invoke("get-port"),
  getSettings:       () => ipcRenderer.invoke("get-settings"),
  setSettings:       (p) => ipcRenderer.invoke("set-settings", p),
  getSettingsRaw:    () => ipcRenderer.invoke("get-settings-raw"),
  saveSettingsRaw:   (text) => ipcRenderer.invoke("save-settings-raw", text),
  getVMs:            () => ipcRenderer.invoke("get-vms"),
  listVMDirs:        (opts) => ipcRenderer.invoke("list-vm-dirs", opts),
  listVMRepos:       (opts) => ipcRenderer.invoke("list-vm-repos", opts),
  onMaximizedChange: (cb) => ipcRenderer.on("window-maximized", (_ev, val) => cb(val)),
});
