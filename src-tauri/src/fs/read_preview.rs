// Receives only an already-contained, realpath'd path; the caller owns containment checks.

use std::path::Path;

use serde::Serialize;
use tokio::io::AsyncReadExt;

/// Files over this size are `TooLarge`, never partially read.
const MAX_PREVIEW_BYTES: u64 = 1024 * 1024;

/// Duplicates `git::diff_stat`'s private sniff to avoid widening its visibility.
const BINARY_SNIFF_BYTES: usize = 8000;

fn is_binary(buf: &[u8]) -> bool {
    let len = buf.len().min(BINARY_SNIFF_BYTES);
    buf[..len].contains(&0)
}

const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown"];

/// Same shape as `src/shared/model.ts`'s `FilePreviewKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FilePreviewKind {
    Text,
    Markdown,
    Image,
    Binary,
    TooLarge,
    Deleted,
    ReadError,
}

/// Same shape as `src/shared/model.ts`'s `FilePreview`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub path: String,
    pub kind: FilePreviewKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

impl FilePreview {
    fn bare(path: &str, kind: FilePreviewKind) -> Self {
        Self {
            path: path.to_string(),
            kind,
            size: None,
            content: None,
            base64: None,
            mime_type: None,
        }
    }

    fn sized(path: &str, kind: FilePreviewKind, size: u64) -> Self {
        Self {
            path: path.to_string(),
            kind,
            size: Some(size),
            content: None,
            base64: None,
            mime_type: None,
        }
    }
}

/// Sniffs leading magic bytes, never the extension.
fn sniff_image_mime_type(buf: &[u8]) -> Option<&'static str> {
    if buf.len() >= 8 && buf[0..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] {
        return Some("image/png");
    }
    if buf.len() >= 3 && buf[0] == 0xff && buf[1] == 0xd8 && buf[2] == 0xff {
        return Some("image/jpeg");
    }
    if buf.len() >= 6
        && buf[0..3] == [0x47, 0x49, 0x46]
        && buf[3] == 0x38
        && (buf[4] == 0x37 || buf[4] == 0x39)
        && buf[5] == 0x61
    {
        return Some("image/gif");
    }
    if buf.len() >= 12
        && buf[0..4] == [0x52, 0x49, 0x46, 0x46]
        && buf[8..12] == [0x57, 0x45, 0x42, 0x50]
    {
        return Some("image/webp");
    }
    // BMP is checked last: a bare "BM" prefix would match ordinary text files.
    if buf.len() >= 18 && buf[0] == 0x42 && buf[1] == 0x4d {
        let file_size_field = u32::from_le_bytes([buf[2], buf[3], buf[4], buf[5]]);
        let header_size = u32::from_le_bytes([buf[14], buf[15], buf[16], buf[17]]);
        const KNOWN_DIB_HEADER_SIZES: &[u32] = &[12, 40, 52, 56, 108, 124];
        if file_size_field as usize == buf.len() && KNOWN_DIB_HEADER_SIZES.contains(&header_size) {
            return Some("image/bmp");
        }
    }
    None
}

/// Reads at most `buf.len()` bytes, looping until the buffer is full or EOF (a single `read()`
/// call is not guaranteed to fill the whole buffer even for a regular file).
async fn read_fully(file: &mut tokio::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut total = 0usize;
    while total < buf.len() {
        let n = file.read(&mut buf[total..]).await?;
        if n == 0 {
            break;
        }
        total += n;
    }
    Ok(total)
}

/// Reads one file's preview. Stat and read use the same handle, so a swap between checks cannot happen.
pub async fn read_preview(absolute_path: &Path, relative_path: &str) -> FilePreview {
    let mut file = match tokio::fs::File::open(absolute_path).await {
        Ok(f) => f,
        Err(err) => {
            let kind = if err.kind() == std::io::ErrorKind::NotFound {
                FilePreviewKind::Deleted
            } else {
                FilePreviewKind::ReadError
            };
            return FilePreview::bare(relative_path, kind);
        }
    };

    let stat = match file.metadata().await {
        Ok(s) => s,
        Err(err) => {
            let kind = if err.kind() == std::io::ErrorKind::NotFound {
                FilePreviewKind::Deleted
            } else {
                FilePreviewKind::ReadError
            };
            return FilePreview::bare(relative_path, kind);
        }
    };

    // A directory or device node is `ReadError`, not `Deleted`; the path still exists.
    if !stat.is_file() {
        return FilePreview::bare(relative_path, FilePreviewKind::ReadError);
    }
    if stat.len() > MAX_PREVIEW_BYTES {
        return FilePreview::sized(relative_path, FilePreviewKind::TooLarge, stat.len());
    }

    let cap = (stat.len().min(MAX_PREVIEW_BYTES) + 1) as usize;
    let mut buf = vec![0u8; cap];
    let bytes_read = match read_fully(&mut file, &mut buf).await {
        Ok(n) => n as u64,
        Err(err) => {
            let kind = if err.kind() == std::io::ErrorKind::NotFound {
                FilePreviewKind::Deleted
            } else {
                FilePreviewKind::ReadError
            };
            return FilePreview::bare(relative_path, kind);
        }
    };
    if bytes_read > MAX_PREVIEW_BYTES {
        return FilePreview::sized(relative_path, FilePreviewKind::TooLarge, stat.len());
    }
    // Reading more than stat reported means the file grew mid-read.
    if bytes_read > stat.len() {
        return FilePreview::bare(relative_path, FilePreviewKind::ReadError);
    }
    let content = &buf[..bytes_read as usize];

    if let Some(mime_type) = sniff_image_mime_type(content) {
        return FilePreview {
            path: relative_path.to_string(),
            kind: FilePreviewKind::Image,
            size: Some(bytes_read),
            content: None,
            base64: Some(crate::omp::images::base64_encode(content)),
            mime_type: Some(mime_type.to_string()),
        };
    }
    if is_binary(content) {
        return FilePreview::sized(relative_path, FilePreviewKind::Binary, bytes_read);
    }
    let ext = Path::new(relative_path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let kind = if MARKDOWN_EXTENSIONS.contains(&ext.as_str()) {
        FilePreviewKind::Markdown
    } else {
        FilePreviewKind::Text
    };
    FilePreview {
        path: relative_path.to_string(),
        kind,
        size: Some(bytes_read),
        content: Some(String::from_utf8_lossy(content).into_owned()),
        base64: None,
        mime_type: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn plain_text_file_is_kind_text() {
        let dir =
            std::env::temp_dir().join(format!("refract-preview-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("a.txt");
        tokio::fs::write(&path, b"hello world").await.unwrap();
        let preview = read_preview(&path, "a.txt").await;
        assert_eq!(preview.kind, FilePreviewKind::Text);
        assert_eq!(preview.content.as_deref(), Some("hello world"));
    }

    #[tokio::test]
    async fn markdown_extension_is_kind_markdown() {
        let dir =
            std::env::temp_dir().join(format!("refract-preview-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("a.md");
        tokio::fs::write(&path, b"# hi").await.unwrap();
        let preview = read_preview(&path, "a.md").await;
        assert_eq!(preview.kind, FilePreviewKind::Markdown);
    }

    #[tokio::test]
    async fn nul_byte_content_is_kind_binary() {
        let dir =
            std::env::temp_dir().join(format!("refract-preview-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("a.bin");
        tokio::fs::write(&path, [1u8, 0, 2, 3]).await.unwrap();
        let preview = read_preview(&path, "a.bin").await;
        assert_eq!(preview.kind, FilePreviewKind::Binary);
    }

    #[tokio::test]
    async fn png_magic_bytes_are_kind_image() {
        let dir =
            std::env::temp_dir().join(format!("refract-preview-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("a.png");
        let mut bytes = vec![0x89u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.extend_from_slice(&[0u8; 10]);
        tokio::fs::write(&path, &bytes).await.unwrap();
        let preview = read_preview(&path, "a.png").await;
        assert_eq!(preview.kind, FilePreviewKind::Image);
        assert_eq!(preview.mime_type.as_deref(), Some("image/png"));
    }

    #[tokio::test]
    async fn over_cap_file_is_kind_too_large() {
        let dir =
            std::env::temp_dir().join(format!("refract-preview-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("big.txt");
        let bytes = vec![b'a'; (MAX_PREVIEW_BYTES + 10) as usize];
        tokio::fs::write(&path, &bytes).await.unwrap();
        let preview = read_preview(&path, "big.txt").await;
        assert_eq!(preview.kind, FilePreviewKind::TooLarge);
        assert_eq!(preview.size, Some(MAX_PREVIEW_BYTES + 10));
        assert!(preview.content.is_none());
    }

    #[tokio::test]
    async fn missing_file_is_kind_deleted() {
        let dir =
            std::env::temp_dir().join(format!("refract-preview-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("nope.txt");
        let preview = read_preview(&path, "nope.txt").await;
        assert_eq!(preview.kind, FilePreviewKind::Deleted);
    }

    #[tokio::test]
    async fn a_directory_target_is_kind_read_error() {
        let dir =
            std::env::temp_dir().join(format!("refract-preview-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let preview = read_preview(&dir, "subdir").await;
        assert_eq!(preview.kind, FilePreviewKind::ReadError);
    }

    #[test]
    fn bmp_requires_matching_file_size_and_known_header_size() {
        let mut bytes = vec![0u8; 18];
        let len = bytes.len() as u32;
        bytes[0] = 0x42;
        bytes[1] = 0x4d;
        bytes[2..6].copy_from_slice(&len.to_le_bytes());
        bytes[14..18].copy_from_slice(&40u32.to_le_bytes());
        assert_eq!(sniff_image_mime_type(&bytes), Some("image/bmp"));
    }

    #[test]
    fn a_text_file_starting_with_bm_is_not_misdetected_as_bmp() {
        let bytes = b"BMW is a car brand, not a bitmap file at all here".to_vec();
        assert_eq!(sniff_image_mime_type(&bytes), None);
    }
}
