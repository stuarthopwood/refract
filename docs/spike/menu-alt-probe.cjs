// Alt-menu probe (spec 001 T100 half).
//
// Question: with `titleBarStyle: 'hidden'` + `titleBarOverlay: true`, does
// `autoHideMenuBar: true` still reveal the native application menu while Alt
// is tapped, the same as a normal framed window?
//
// Run with the repo's own Electron binary from the repo root:
//   node_modules/electron/dist/electron.exe docs/spike/menu-alt-probe.cjs --user-data-dir=C:\tmp\refract-w1-alt\userdata
//
// Writes one JSON array (one object per variant) to
// C:/tmp/refract-w1-alt/result.json and exits via app.quit().

const { app, BrowserWindow, Menu } = require("electron");
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");
const { execFile } = require("node:child_process");
const fs = require("node:fs");

const RESULT_DIR = "C:/tmp/refract-w1-alt";
const RESULT_FILE = RESULT_DIR + "/result.json";

fs.mkdirSync(RESULT_DIR, { recursive: true });
const LOG_FILE = RESULT_DIR + "/trace.log";
function trace(msg) {
  fs.appendFileSync(LOG_FILE, `[${Date.now()}] ${msg}\n`);
}
fs.writeFileSync(LOG_FILE, "");
trace("script start");
process.on("uncaughtException", (err) => {
  trace("uncaughtException: " + ((err && err.stack) || err));
});

const template = [
  { label: "File", submenu: [{ label: "Probe File Item", click: () => { } }] },
  { label: "Edit", submenu: [{ label: "Probe Edit Item", click: () => { } }] },
  { label: "View", submenu: [{ label: "Probe View Item", click: () => { } }] },
  { label: "Window", submenu: [{ label: "Probe Window Item", click: () => { } }] },
];
Menu.setApplicationMenu(Menu.buildFromTemplate(template));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tapAlt() {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", "(New-Object -ComObject WScript.Shell).SendKeys('%')"],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function openWindow(options) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 800,
      height: 500,
      show: true,
      ...options,
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(win);
    };
    win.once("ready-to-show", finish);
    setTimeout(finish, 5000);
    win.loadURL("about:blank");
  });
}

async function runVariant(name, options) {
  trace(`[${name}] opening window`);
  const win = await openWindow(options);
  trace(`[${name}] window ready-to-show fired`);
  win.show();
  win.focus();
  await sleep(1500);

  const before = {
    isMenuBarVisible: win.isMenuBarVisible(),
    isMenuBarAutoHide: win.isMenuBarAutoHide(),
  };
  trace(`[${name}] before=${JSON.stringify(before)}`);

  await tapAlt();
  trace(`[${name}] first alt tap sent`);
  await sleep(700);
  const afterAlt = {
    isMenuBarVisible: win.isMenuBarVisible(),
    isMenuBarAutoHide: win.isMenuBarAutoHide(),
  };
  trace(`[${name}] afterAlt=${JSON.stringify(afterAlt)}`);

  await tapAlt();
  trace(`[${name}] second alt tap sent`);
  await sleep(700);
  const afterSecondAlt = {
    isMenuBarVisible: win.isMenuBarVisible(),
    isMenuBarAutoHide: win.isMenuBarAutoHide(),
  };
  trace(`[${name}] afterSecondAlt=${JSON.stringify(afterSecondAlt)}`);

  win.close();
  trace(`[${name}] window closed`);

  return { variant: name, before, afterAlt, afterSecondAlt };
}

trace("calling app.whenReady()");
app.whenReady().then(async () => {
  trace("app ready");
  const results = [];
  try {
    trace("starting control variant");
    results.push(
      await runVariant("control", {
        frame: true,
        autoHideMenuBar: true,
      })
    );
    trace("control variant done");

    trace("starting hidden-overlay variant");
    results.push(
      await runVariant("hidden-overlay", {
        titleBarStyle: "hidden",
        titleBarOverlay: true,
        autoHideMenuBar: true,
      })
    );
    trace("hidden-overlay variant done");

    fs.writeFileSync(RESULT_FILE, JSON.stringify(results, null, 2));
    trace("result written");
  } catch (err) {
    trace("error: " + ((err && err.stack) || err));
    fs.writeFileSync(RESULT_DIR + "/error.log", String((err && err.stack) || err));
  } finally {
    trace("quitting");
    app.quit();
  }
});
