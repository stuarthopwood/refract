// Persists window position, size and maximised state to `window-state.json` in `data_dir()`.
// Uses the crate's own atomic JSON helper, not `tauri-plugin-window-state`, which keys off `identifier`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use serde::{Deserialize, Serialize};
use tauri::{PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow, WindowEvent};

use crate::store::atomic_json::{read_json_file, write_json_file};

const FILE_NAME: &str = "window-state.json";
const DEFAULT_WIDTH: u32 = 1280;
const DEFAULT_HEIGHT: u32 = 800;
// Clamped to a sane minimum size.
const MIN_WIDTH: u32 = 800;
const MIN_HEIGHT: u32 = 500;
// Drop a saved position with too little of the window on any display, so it cannot be lost off-screen.
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

/// A display's work area in physical pixels, so `resolve_bounds` stays testable without `tauri::Monitor`.
#[derive(Debug, Clone, Copy, PartialEq)]
struct WorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// Whether the title bar overlaps `area`, so a window can always be dragged back into view.
/// Saturating arithmetic, so a corrupted saved value cannot overflow.
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

/// The display a saved position lands on, used as the size clamp; `None` if it is off every display.
fn landing_area<'a>(saved: Option<&WindowState>, areas: &'a [WorkArea]) -> Option<&'a WorkArea> {
    let saved = saved?;
    areas
        .iter()
        .find(|a| visible_on(saved.x, saved.y, saved.width, saved.height, a))
}

struct Resolved {
    width: u32,
    height: u32,
    /// `Some` restores the saved position; `None` centres the window instead.
    position: Option<(i32, i32)>,
    maximized: bool,
}

/// Pure resolver with no Tauri types or I/O, so it is unit-testable.
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

/// Applies persisted state at startup (or centres at default size) and returns the saving tracker.
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
        // Full screen is not restored; an off-screen position centres on the primary display.
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

/// Tracks the last normal position and size, and the maximised flag, for the run's final save.
pub struct Tracker {
    state: StdMutex<WindowState>,
    data_dir: PathBuf,
    /// Bumped on every move or resize, so only the last save in a 500 ms burst writes.
    generation: AtomicU64,
}

impl Tracker {
    /// Called for every window event; only move, resize and close are acted on.
    pub fn on_window_event(self: &Arc<Self>, window: &WebviewWindow, event: &WindowEvent) {
        match event {
            // Skip minimised (Windows reports -32000) and maximised positions, which are not restorable.
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
            // Keep the maximised flag current, but never store the transient maximised size as normal.
            WindowEvent::Resized(size) if !window.is_minimized().unwrap_or(false) => {
                let mut state = self.state.lock().expect("window-state mutex poisoned");
                state.maximized = window.is_maximized().unwrap_or(state.maximized);
                if !state.maximized {
                    state.width = size.width;
                    state.height = size.height;
                }
                drop(state);
                self.schedule_debounced_save();
            }
            // Capture the maximised flag here: the window is gone by the time `save()` runs after a close.
            WindowEvent::CloseRequested { .. } => {
                let mut state = self.state.lock().expect("window-state mutex poisoned");
                state.maximized = window.is_maximized().unwrap_or(state.maximized);
            }
            _ => {}
        }
    }

    /// Saves after a 500 ms debounce, so a crash right after a move still keeps the position.
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

    /// Final write at quit, awaited so the process does not exit first.
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
        // Only the left 150px remains on screen, still over the minimum visible width.
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
        // The title bar is off screen even though the body overlaps, so it must be rejected.
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
