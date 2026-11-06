// Window shell, chrome, notifications, single instance and window state.

#[cfg(windows)]
pub mod alarm_toast;
pub mod alarms;
pub mod app_identity;
pub mod memory;
pub mod menu;
pub mod notifications;
pub mod quit_guard;
pub mod single_instance;
pub mod window_state;
pub mod zoom;
