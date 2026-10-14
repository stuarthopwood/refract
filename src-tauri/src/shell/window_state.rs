// Window position/size/maximised persistence (issue #623, lane R10b issue #793). Electron never
// built this (the issue is open against both builds; PLAN.md's own Phase R table scopes it to
// R10b specifically, so this is new work, not a port of a bug-fixed TypeScript implementation --
// the design below follows #623's own acceptance criteria directly).
//
// Stored as `window-state.json` in `crate::data_dir()` -- the SAME pinned folder as
// `registry.json`/`settings.json` -- via the same atomic-write helper those stores use
// (`store::atomic_json`). Deliberately NOT the official `tauri-plugin-window-state` crate: it
// defaults to Tauri's own `app_config_dir()`, a location keyed off `tauri.conf.json`'s
// `identifier` -- exactly the coupling `lib.rs`'s own `data_dir()` doc comment explains this
// build deliberately avoids for every other persisted file (and its own `on_event(RunEvent::Exit)`
// save hook would never fire here anyway: `lib.rs`'s `ExitRequested` handler calls
// `std::process::exit(0)` itself once `session_manager.stop_all()` settles, pre-empting Tauri's
// own normal exit path).
//
// Values are PHYSICAL pixels throughout: what `WebviewWindow::outer_position()`/`inner_size()`
// return, and what `set_position()`/`set_size()` accept via `Position::Physical`/`Size::Physical`
// -- no logical/DPI conversion needed anywhere in this file.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use serde::{Deserialize, Serialize};
use tauri::{PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow, WindowEvent};

use crate::store::atomic_json::{read_json_file, write_json_file};

const FILE_NAME: &str = "window-state.json";
const DEFAULT_WIDTH: u32 = 1280;
const DEFAULT_HEIGHT: u32 = 800;
// Issue #623: "clamped to a sane minimum (for example 800 by 500)".
const MIN_WIDTH: u32 = 800;
const MIN_HEIGHT: u32 = 500;
// Issue #623: "if less than a usable strip (for example 100 by 40 DIP, including the title bar)
// of the window intersects any connected display's work area... drop the position". Applied here
// in physical pixels -- the more conservative reading of the two (requires MORE of the window
// visible than the DIP figure would at a scale factor above 100%, never less).
const MIN_VISIBLE_WIDTH: i32 = 100;
const MIN_VISIBLE_HEIGHT: i32 = 40;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

fn file_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join(FILE_NAME)
}

/// A display's work area, in physical pixels -- the pure-data shape `resolve_bounds` (and its
/// own helpers below) operate on, decoupled from `tauri::Monitor` (whose fields are private, so
/// it cannot be constructed directly in a unit test) per issue #623's own design: "validate
/// before applying, as one pure function".
#[derive(Debug, Clone, Copy, PartialEq)]
struct WorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// Whether the window's TITLE-BAR BAND (its top `MIN_VISIBLE_HEIGHT` rows, capped at the
/// window's own height) overlaps `area` by at least `MIN_VISIBLE_WIDTH`-by-`MIN_VISIBLE_HEIGHT`
/// -- not just any part of the window (gate fix: a window whose BODY is on-screen but whose
/// title bar is off the top of every display cannot be dragged back into view, issue #623's own
/// "including the title bar"). Saturating arithmetic throughout: an extreme saved `x`/`y`/
/// `width`/`height` (a hand-edited or corrupted file) must never panic on overflow.
fn visible_on(x: i32, y: i32, width: u32, height: u32, area: &WorkArea) -> bool {
    let to_i32 = |v: u32| v.min(i32::MAX as u32) as i32;
    let band_height = MIN_VISIBLE_HEIGHT.min(to_i32(height)).max(0);
    let left = area.x;
    let top = area.y;
    let right = area.x.saturating_add(to_i32(area.width));
    let bottom = area.y.saturating_add(to_i32(area.height));
    let win_right = x.saturating_add(to_i32(width));
    let band_bottom = y.saturating_add(band_height);
    let overlap_w = win_right.min(right).saturating_sub(x.max(left));
    let overlap_h = band_bottom.min(bottom).saturating_sub(y.max(top));
    overlap_w >= MIN_VISIBLE_WIDTH && overlap_h >= band_height
}

/// The display a saved position/size would actually land on (the first connected one it is at
/// least minimally visible on), used as the clamp ceiling for size. `None` when there is no
/// saved state, or the saved position is off every connected display (a monitor was unplugged, or
/// the resolution changed) -- the caller centres on the primary display in that case instead.
fn landing_area<'a>(saved: Option<&WindowState>, areas: &'a [WorkArea]) -> Option<&'a WorkArea> {
    let saved = saved?;
    areas
        .iter()
        .find(|a| visible_on(saved.x, saved.y, saved.width, saved.height, a))
}

struct Resolved {
    width: u32,
    height: u32,
    /// `Some` to restore the saved position; `None` to centre instead (no saved state, or the
    /// saved position is off every connected display).
    position: Option<(i32, i32)>,
    maximized: bool,
}

/// Issue #623's own "one pure function": no Tauri types, no I/O -- `apply_on_startup` below is
/// the only caller, mapping `window.available_monitors()`/`primary_monitor()` to `WorkArea`
/// first so this stays unit-testable with no running app.
fn resolve_bounds(
    saved: Option<WindowState>,
    areas: &[WorkArea],
    primary: Option<&WorkArea>,
) -> Resolved {
    let landing = landing_area(saved.as_ref(), areas).or(primary);
    let (max_w, max_h) = landing
        .map(|a| (a.width, a.height))
        .unwrap_or((DEFAULT_WIDTH, DEFAULT_HEIGHT));
    let (width, height) = match saved {
        Some(s) => (s.width, s.height),
        None => (DEFAULT_WIDTH, DEFAULT_HEIGHT),
    };
    let width = width.clamp(MIN_WIDTH, max_w.max(MIN_WIDTH));
    let height = height.clamp(MIN_HEIGHT, max_h.max(MIN_HEIGHT));
    let position = saved
        .filter(|s| {
            areas
                .iter()
                .any(|a| visible_on(s.x, s.y, s.width, s.height, a))
        })
        .map(|s| (s.x, s.y));
    Resolved {
        width,
        height,
        position,
        maximized: saved.map(|s| s.maximized).unwrap_or(false),
    }
}

/// Reads and applies the persisted state, or centres at the default size when none exists or it
/// is unusable (`atomic_json::read_json_file`'s own contract: a missing or corrupt file silently
/// becomes `None` here, never a launch error). Call once, right after the window is built
/// (`lib.rs`'s `setup`), before the very first paint -- applying bounds after `show()` would
/// flash at the wrong size first.
///
/// Returns the tracker that keeps this state current for the rest of the run (`on_window_event`)
/// and flushes the final value at quit (`save`).
pub async fn apply_on_startup(data_dir: &Path, window: &WebviewWindow) -> Arc<Tracker> {
    let saved: Option<WindowState> = read_json_file(&file_path(data_dir), || None)
        .await
        .unwrap_or_else(|err| {
            log::warn!("refract-tauri: failed to read window-state.json: {err}");
            None
        });
    let areas: Vec<WorkArea> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| WorkArea {
            x: m.work_area().position.x,
            y: m.work_area().position.y,
            width: m.work_area().size.width,
            height: m.work_area().size.height,
        })
        .collect();
    let primary_area = window.primary_monitor().ok().flatten().map(|m| WorkArea {
        x: m.work_area().position.x,
        y: m.work_area().position.y,
        width: m.work_area().size.width,
        height: m.work_area().size.height,
    });
    let resolved = resolve_bounds(saved, &areas, primary_area.as_ref());

    let _ = window.set_size(Size::Physical(PhysicalSize {
        width: resolved.width,
        height: resolved.height,
    }));
    match resolved.position {
        Some((x, y)) => {
            let _ = window.set_position(Position::Physical(PhysicalPosition { x, y }));
        }
        // Full screen is not restored (issue #623's own note); a missing/off-screen saved
        // position centres on the primary display instead, keeping the clamped size.
        None => {
            let _ = window.center();
        }
    }
    if resolved.maximized {
        let _ = window.maximize();
    }

    let (x, y) = resolved.position.unwrap_or((0, 0));
    Arc::new(Tracker {
        state: StdMutex::new(WindowState {
            x,
            y,
            width: resolved.width,
            height: resolved.height,
            maximized: resolved.maximized,
        }),
        data_dir: data_dir.to_path_buf(),
        generation: AtomicU64::new(0),
    })
}

/// Keeps the last known normal (non-minimised, non-maximised) position/size current across the
/// run, and the last known maximised flag at quit -- mirrors `tauri-plugin-window-state`'s own
/// `update_state` logic (read, not depended on; see this file's own top comment for why).
pub struct Tracker {
    state: StdMutex<WindowState>,
    data_dir: PathBuf,
    /// Debounce generation (gate fix): bumped on every `Moved`/`Resized`, so a save scheduled
    /// 500ms out that finds a NEWER generation already in flight skips itself -- only the last
    /// one in a burst actually writes.
    generation: AtomicU64,
}

impl Tracker {
    /// `lib.rs`'s own `WebviewWindow::on_window_event` listener calls this for every event
    /// unfiltered; only `Moved`/`Resized`/`CloseRequested` are ever acted on.
    pub fn on_window_event(self: &Arc<Self>, window: &WebviewWindow, event: &WindowEvent) {
        match event {
            // Never store a position read while minimised (issue #623: Windows reports
            // `-32000`) or maximised (Windows moves the window to the monitor's origin while
            // maximised; that is not a position to restore into).
            WindowEvent::Moved(position)
                if !window.is_minimized().unwrap_or(false)
                    && !window.is_maximized().unwrap_or(false) =>
            {
                {
                    let mut state = self.state.lock().expect("window-state mutex poisoned");
                    state.x = position.x;
                    state.y = position.y;
                }
                self.schedule_debounced_save();
            }
            // Never store the transient maximised size as the "normal" size to restore into --
            // `state.maximized` is captured fresh below, not read from a `Resized` event.
            WindowEvent::Resized(size)
                if !window.is_minimized().unwrap_or(false)
                    && !window.is_maximized().unwrap_or(false) =>
            {
                {
                    let mut state = self.state.lock().expect("window-state mutex poisoned");
                    state.width = size.width;
                    state.height = size.height;
                }
                self.schedule_debounced_save();
            }
            // CRITICAL gate fix: a user-initiated close (the X button, Alt+F4) destroys the
            // window before `lib.rs`'s own `ExitRequested` handler ever runs -- `save()` calling
            // `window.is_maximized()` there found no window at all, and the maximised flag (and
            // whatever a 500ms debounce had not yet flushed) was silently lost. `CloseRequested`
            // fires while the window is still alive, so the maximised flag is captured here,
            // synchronously, and `save()` below never needs a window handle at all.
            WindowEvent::CloseRequested { .. } => {
                let mut state = self.state.lock().expect("window-state mutex poisoned");
                state.maximized = window.is_maximized().unwrap_or(state.maximized);
            }
            _ => {}
        }
    }

    /// Issue #623: "a resize or move made less than 500 ms before closing is still saved" --
    /// without this, only the explicit `ExitRequested`-time `save()` call below ever reached
    /// disk, which a hard crash (killed process, power loss) never triggers at all. Bumps the
    /// generation first so an in-flight older debounce (scheduled by an earlier `Moved`/
    /// `Resized` in the same burst) no-ops when it wakes.
    fn schedule_debounced_save(self: &Arc<Self>) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if this.generation.load(Ordering::SeqCst) == generation {
                this.save().await;
            }
        });
    }

    /// The final write (issue #623: "the final write must be awaited or synchronous... hook it
    /// into the existing before-quit gate"). `lib.rs`'s own `ExitRequested` handler awaits this
    /// before calling `std::process::exit(0)` -- the maximised flag it writes was already
    /// captured fresh at `CloseRequested` time above (gate fix), not read from a window handle
    /// that may no longer exist by the time this runs.
    pub async fn save(&self) {
        let state = *self.state.lock().expect("window-state mutex poisoned");
        if let Err(err) = write_json_file(&file_path(&self.data_dir), &state).await {
            log::warn!("refract-tauri: failed to write window-state.json: {err}");
        }
    }
}

#[cfg(test)]
mod resolve_bounds_tests {
    use super::*;

    const PRIMARY: WorkArea = WorkArea {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };

    #[test]
    fn missing_state_centres_at_the_default_size() {
        let resolved = resolve_bounds(None, &[PRIMARY], Some(&PRIMARY));
        assert_eq!(resolved.width, DEFAULT_WIDTH);
        assert_eq!(resolved.height, DEFAULT_HEIGHT);
        assert_eq!(resolved.position, None);
        assert!(!resolved.maximized);
    }

    #[test]
    fn off_screen_position_is_dropped_but_size_and_maximized_survive() {
        let saved = WindowState {
            x: -50_000,
            y: -50_000,
            width: 1000,
            height: 700,
            maximized: true,
        };
        let resolved = resolve_bounds(Some(saved), &[PRIMARY], Some(&PRIMARY));
        assert_eq!(resolved.position, None);
        assert_eq!(resolved.width, 1000);
        assert_eq!(resolved.height, 700);
        assert!(resolved.maximized);
    }

    #[test]
    fn a_usable_strip_still_on_screen_keeps_the_position() {
        // Only the left 150px of a 1000-wide window remains on the primary display -- still
        // over `MIN_VISIBLE_WIDTH` (100) by issue #623's own example figure.
        let saved = WindowState {
            x: -850,
            y: 100,
            width: 1000,
            height: 700,
            maximized: false,
        };
        let resolved = resolve_bounds(Some(saved), &[PRIMARY], Some(&PRIMARY));
        assert_eq!(resolved.position, Some((-850, 100)));
    }

    #[test]
    fn oversized_saved_dimensions_are_clamped_to_the_landing_display() {
        let small = WorkArea {
            x: 0,
            y: 0,
            width: 1024,
            height: 768,
        };
        let saved = WindowState {
            x: 10,
            y: 10,
            width: 4000,
            height: 3000,
            maximized: false,
        };
        let resolved = resolve_bounds(Some(saved), &[small], Some(&small));
        assert_eq!(resolved.width, 1024);
        assert_eq!(resolved.height, 768);
    }

    #[test]
    fn undersized_saved_dimensions_are_clamped_to_the_minimum() {
        let saved = WindowState {
            x: 10,
            y: 10,
            width: 10,
            height: 10,
            maximized: false,
        };
        let resolved = resolve_bounds(Some(saved), &[PRIMARY], Some(&PRIMARY));
        assert_eq!(resolved.width, MIN_WIDTH);
        assert_eq!(resolved.height, MIN_HEIGHT);
    }

    #[test]
    fn multi_display_lands_on_the_secondary_and_clamps_to_its_work_area() {
        let secondary = WorkArea {
            x: 1920,
            y: 0,
            width: 1280,
            height: 800,
        };
        let saved = WindowState {
            x: 2000,
            y: 50,
            width: 5000,
            height: 5000,
            maximized: false,
        };
        let resolved = resolve_bounds(Some(saved), &[PRIMARY, secondary], Some(&PRIMARY));
        assert_eq!(resolved.position, Some((2000, 50)));
        assert_eq!(resolved.width, 1280);
        assert_eq!(resolved.height, 800);
    }

    #[test]
    fn maximized_flag_round_trips_regardless_of_position_validity() {
        let saved = WindowState {
            x: 10,
            y: 10,
            width: 1000,
            height: 700,
            maximized: true,
        };
        let resolved = resolve_bounds(Some(saved), &[PRIMARY], Some(&PRIMARY));
        assert!(resolved.maximized);
    }
}

#[cfg(test)]
mod visible_on_tests {
    use super::*;

    #[test]
    fn width_boundary_100_is_visible_99_is_not() {
        let area_100 = WorkArea {
            x: 0,
            y: 0,
            width: 100,
            height: 1040,
        };
        let area_99 = WorkArea {
            x: 0,
            y: 0,
            width: 99,
            height: 1040,
        };
        assert!(visible_on(0, 0, 1000, 700, &area_100));
        assert!(!visible_on(0, 0, 1000, 700, &area_99));
    }

    #[test]
    fn title_bar_band_height_boundary_40_is_visible_39_is_not() {
        let area_40 = WorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 40,
        };
        let area_39 = WorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 39,
        };
        assert!(visible_on(0, 0, 1000, 700, &area_40));
        assert!(!visible_on(0, 0, 1000, 700, &area_39));
    }

    #[test]
    fn title_bar_off_top_is_not_visible_even_with_the_body_on_screen() {
        // Body (y=-900..100) overlaps the display by 100 rows -- enough for the OLD (whole-
        // window) check to call this visible -- but the title-bar band itself (y=-900..-860)
        // never touches the display at all, so the user could never drag it back into view.
        let area = WorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };
        assert!(!visible_on(0, -900, 1000, 1000, &area));
    }

    #[test]
    fn extreme_saved_values_never_panic() {
        let area = WorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };
        assert!(!visible_on(i32::MIN, i32::MIN, u32::MAX, u32::MAX, &area));
        assert!(!visible_on(i32::MAX, i32::MAX, u32::MAX, u32::MAX, &area));
    }
}
