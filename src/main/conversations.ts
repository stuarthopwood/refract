// Scans an OMP session directory's `*.jsonl` Conversation files (tasks.md T027, data-model.md
// "Derived from OMP (not stored by Pinion) > Conversation"). Pure file reads: no RPC. The real
// `new_session` / `switch_session` traffic lives in `SessionAgent.startNewConversation` /
// `SessionAgent.openConversation`, since those need the live process.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ConversationInfo } from '../shared/model';

// data-model.md: "preview ... read from the first 8 KB of the file, truncated to 120 characters".
const PREVIEW_SCAN_BYTES = 8 * 1024;
const PREVIEW_MAX_LENGTH = 120;

// A Conversation file is named `<timestamp with `:`/`.` replaced by `-`>_<uuid>.jsonl`, e.g.
// `2026-09-30T18-02-07-675Z_01a0f37b-1fbb-7513-afb3-77377123bcb7.jsonl` (observed on a real
// session, verified against a live `omp` run). Reconstructs the ISO timestamp and the UUID
// without opening the file.
const FILE_NAME_RE = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z_(.+)\.jsonl$/;

function parseFileName(fileName: string): { createdAt: string; id: string } | undefined {
  const match = FILE_NAME_RE.exec(fileName);
  if (!match) return undefined;
  const [, datePart, minute, second, millis, id] = match;
  return { createdAt: `${datePart}:${minute}:${second}.${millis}Z`, id: id! };
}

async function readPreviewWindow(file: string): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(PREVIEW_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, PREVIEW_SCAN_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** The stored first line of a Conversation file (`{"type":"title","title":"...",...}`). */
interface StoredTitleLine {
  type?: unknown;
  title?: unknown;
}

/** A stored turn line (`{"type":"message","message":{"role":"user","content":[...]},...}`). */
interface StoredMessageLine {
  type?: unknown;
  message?: { role?: unknown; content?: unknown };
}

/** Extracts plain text from a stored `role: 'user'` message's `content` (string or text parts). */
function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as unknown[])
    .map((part) => (typeof part === 'object' && part !== null ? (part as { type?: unknown; text?: unknown }) : undefined))
    .filter((part): part is { type: 'text'; text: string } => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

/**
 * Reads the file's first line for `title` and the first `role: 'user'` message within the first
 * 8 KB for `preview`. Returns `undefined` when no user message is found there, which the caller
 * treats as "skip this file" (data-model.md: "files with no user message skipped").
 */
async function readConversationFile(file: string): Promise<{ title: string; preview: string } | undefined> {
  const lines = (await readPreviewWindow(file)).split('\n');
  let title = '';
  let preview: string | undefined;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // The last line in an 8 KB window may be cut off mid-record; skip it rather than throw.
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    if (index === 0) {
      const titleLine = parsed as StoredTitleLine;
      if (titleLine.type === 'title') {
        title = typeof titleLine.title === 'string' ? titleLine.title : '';
      }
      return;
    }
    if (preview !== undefined) return;
    const messageLine = parsed as StoredMessageLine;
    if (messageLine.type === 'message' && typeof messageLine.message === 'object' && messageLine.message !== null && messageLine.message.role === 'user') {
      const text = extractUserText(messageLine.message.content);
      if (text) preview = text.slice(0, PREVIEW_MAX_LENGTH);
    }
  });
  return preview === undefined ? undefined : { title, preview };
}

function sameFile(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** Lists every Conversation in `sessionDir`, newest first. `sessionDir === null` (no Conversation
 * has ever been started) and an unreadable directory both yield an empty list, never a throw. */
export async function listConversations(sessionDir: string | null, currentConversation: string | null): Promise<ConversationInfo[]> {
  if (!sessionDir) return [];
  let entries: string[];
  try {
    entries = await fs.readdir(sessionDir);
  } catch {
    return [];
  }

  const results: ConversationInfo[] = [];
  for (const entry of entries) {
    const parsedName = parseFileName(entry);
    if (!parsedName) continue;
    const file = path.join(sessionDir, entry);
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat?.isFile()) continue;
    const content = await readConversationFile(file).catch(() => undefined);
    if (!content) continue;
    results.push({
      file,
      id: parsedName.id,
      createdAt: parsedName.createdAt,
      title: content.title,
      preview: content.preview,
      isCurrent: currentConversation !== null && sameFile(file, currentConversation),
    });
  }
  results.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return results;
}
