# Alt-menu probe (T100, Electron hidden title bar)

**Date:** 2026-10-02
**Electron version:** 44.5.1 (`node_modules/electron/package.json`)

## Method

`docs/spike/menu-alt-probe.cjs`, run as:

```
node_modules/electron/dist/electron.exe docs/spike/menu-alt-probe.cjs --user-data-dir=C:\tmp\refract-w1-alt\userdata
```

(cwd: repo root). The script sets a 4-item application menu (File, Edit, View,
Window), then opens two 800x500 windows in sequence, each loading
`about:blank`:

- `control`: `{ frame: true, autoHideMenuBar: true }`
- `hidden-overlay`: `{ titleBarStyle: 'hidden', titleBarOverlay: true, autoHideMenuBar: true }`

For each window it waits 1500ms after `ready-to-show`, records
`isMenuBarVisible()`/`isMenuBarAutoHide()` as `before`, sends an Alt key tap
via PowerShell `SendKeys('%')`, waits 700ms, records `afterAlt`, taps Alt
again, waits 700ms, records `afterSecondAlt`.

GPU acceleration had to be disabled (`app.disableHardwareAcceleration()` plus
the `disable-gpu`/`disable-software-rasterizer` switches) for `ready-to-show`
to fire at all in this remote/headless Windows session; without it the
windows never finished compositing and the script hung indefinitely.

## Raw result

`C:/tmp/refract-w1-alt/result.json`:

```json
[
  {
    "variant": "control",
    "before": { "isMenuBarVisible": false, "isMenuBarAutoHide": true },
    "afterAlt": { "isMenuBarVisible": false, "isMenuBarAutoHide": true },
    "afterSecondAlt": { "isMenuBarVisible": false, "isMenuBarAutoHide": true }
  },
  {
    "variant": "hidden-overlay",
    "before": { "isMenuBarVisible": false, "isMenuBarAutoHide": true },
    "afterAlt": { "isMenuBarVisible": false, "isMenuBarAutoHide": true },
    "afterSecondAlt": { "isMenuBarVisible": false, "isMenuBarAutoHide": true }
  }
]
```

## Conclusion

**probe inconclusive: SendKeys did not register, see raw JSON**

The `control` variant (an ordinary framed, auto-hide-menu window, which is
known to show its native menu on Alt) shows no `before`/`afterAlt` change
either (`isMenuBarVisible` stays `false` through both Alt taps). Since the
baseline itself doesn't move, the probe cannot distinguish "hidden title bar
blocks the Alt reveal" from "the simulated Alt keystroke never reached the
window" in this execution environment (remote/headless Windows session,
GPU acceleration disabled to let the windows render at all). No conclusion
about `titleBarStyle: 'hidden'` + `titleBarOverlay: true` behaviour should be
drawn from this run; T100 should re-run this exact script on a normal
interactive desktop session (not remote/headless) to get a real baseline
before drawing any conclusion.
