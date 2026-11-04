// Recomputes the stored Project label of every session file from its cwd (or session folder).

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection};

use super::project_label::{folder_name_fallback, ProjectIndex, Resolved};
use super::rollup;

struct Row {
    file: String,
    cwd: Option<String>,
    label: String,
}

impl Row {
    fn cwd(&self) -> Option<&str> {
        self.cwd.as_deref().map(str::trim).filter(|c| !c.is_empty())
    }
}

/// Moves rows whose label changed (a Project added or removed, or an older labelling rule) and
/// leaves totals alone: rows are only ever relabelled, never dropped.
pub fn relabel(
    conn: &mut Connection,
    root: &Path,
    projects: &ProjectIndex,
) -> rusqlite::Result<()> {
    let rows = load_rows(conn)?;
    let mut resolved = resolve_all(&rows, root, projects);
    merge_folder_case(&mut resolved);
    for (row, new) in rows.iter().zip(resolved) {
        let new = new.into_label();
        if new == row.label {
            continue;
        }
        let tx = conn.transaction()?;
        rollup::relabel_file(&tx, &row.file, &new)?;
        tx.execute(
            "UPDATE file_offsets SET project_label = ?1 WHERE session_file = ?2",
            params![new, row.file],
        )?;
        tx.commit()?;
    }
    Ok(())
}

fn load_rows(conn: &Connection) -> rusqlite::Result<Vec<Row>> {
    let mut stmt = conn.prepare("SELECT session_file, cwd, project_label FROM file_offsets")?;
    let mapped = stmt.query_map([], |r| {
        Ok(Row {
            file: r.get(0)?,
            cwd: r.get(1)?,
            label: r.get(2)?,
        })
    })?;
    mapped.collect()
}

/// A file with no cwd borrows the answer of a sibling in the same session folder that has one,
/// since the encoded folder name alone loses hyphens.
fn resolve_all(rows: &[Row], root: &Path, projects: &ProjectIndex) -> Vec<Resolved> {
    let mut by_folder: HashMap<String, Resolved> = HashMap::new();
    for row in rows {
        if let Some(cwd) = row.cwd() {
            let folder = folder_name_fallback(Path::new(&row.file), root);
            if folder != "unknown" {
                by_folder
                    .entry(folder)
                    .or_insert_with(|| projects.resolve(cwd));
            }
        }
    }
    rows.iter()
        .map(|row| match row.cwd() {
            Some(cwd) => projects.resolve(cwd),
            None => {
                let folder = folder_name_fallback(Path::new(&row.file), root);
                by_folder
                    .get(&folder)
                    .cloned()
                    .unwrap_or_else(|| projects.resolve_folder(&folder))
            }
        })
        .collect()
}

/// Folder names that differ only by case become one row, shown with the smallest spelling.
fn merge_folder_case(resolved: &mut [Resolved]) {
    let mut canonical: HashMap<String, String> = HashMap::new();
    for item in resolved.iter() {
        if let Resolved::Folder(name) = item {
            canonical
                .entry(name.to_lowercase())
                .and_modify(|best| {
                    if name.as_str() < best.as_str() {
                        *best = name.clone();
                    }
                })
                .or_insert_with(|| name.clone());
        }
    }
    for item in resolved.iter_mut() {
        if let Resolved::Folder(name) = item {
            if let Some(best) = canonical.get(&name.to_lowercase()) {
                *name = best.clone();
            }
        }
    }
}

#[cfg(test)]
#[path = "relabel.test.rs"]
mod tests;
