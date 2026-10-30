// Spec 060 (#1331, ADR 0006): Refract's own usage database, fed from OMP's session files.

//
// The IPC layer calls: `UsageService` (`new`, `start`, `stop`, `status`, `nudge`, `last_error`),
// `open_reader`, `queries::*`, `budget::budget`, `schema::{prefs_get, prefs_set}` and `paths::*`.

pub mod budget;
pub mod credits;
pub mod frustration;
pub mod ingest;
pub mod paths;
pub mod project_label;
pub mod queries;
pub mod queries_tables;
pub mod rollup;
pub mod scan;
pub mod schema;
pub mod service;
pub mod timeutil;

pub use service::{open_reader, ProjectsProvider, StatusEmit, UsageService, UsageStatus};
