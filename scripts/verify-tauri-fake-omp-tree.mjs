// Conversation tree for the fake `omp` serve mode (#696): answers `get_tree`, `navigate_tree`, `fork` and
// `set_label` from a seeded Conversation, with the response shapes OMP 18.22.2 returns (docs/PLAN.md #696 probe).
// `REFRACT_FAKE_OMP_TREE_SEED` names a JSON file `{ "entries": [<raw session entry>, ...] }`; the last entry is the leaf.
// Like OMP, a rewind moves only the in-memory leaf (no file write); `fork` writes a new file and switches to it.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const nowIso = () => new Date().toISOString();

const textOf = (entry) => {
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text).join('') : '';
};

export function createTree({ seedPath, file: initialFile, cwd, newPath }) {
  let entries = JSON.parse(readFileSync(seedPath, 'utf8')).entries;
  let leaf = entries.at(-1)?.id ?? null;
  let sessionId = 'sess-696-seed';
  let file = initialFile;
  let nextId = 0;
  const freshId = () => `f${(++nextId).toString(16).padStart(7, '0')}`;
  const byId = (id) => entries.find((e) => e.id === id);
  const line = (entry) => `${JSON.stringify(entry)}\n`;
  const header = (parentSession) => ({ type: 'session', version: 3, id: sessionId, timestamp: nowIso(), cwd, ...(parentSession ? { parentSession } : {}) });

  writeFileSync(file, [header(), ...entries].map(line).join(''));

  const append = (entry) => {
    entries.push(entry);
    leaf = entry.id;
    appendFileSync(file, line(entry));
  };
  const chainTo = (id) => {
    const chain = [];
    for (let e = byId(id); e; e = e.parentId ? byId(e.parentId) : null) chain.unshift(e);
    return chain;
  };
  /** Last write wins; an empty or absent label clears it (a label entry is a node of its own, like in OMP). */
  const labels = () => {
    const out = new Map();
    for (const e of entries) if (e.type === 'label') (e.label ? out.set(e.targetId, e.label) : out.delete(e.targetId));
    return out;
  };

  return {
    get file() {
      return file;
    },
    get sessionId() {
      return sessionId;
    },
    messages: () => chainTo(leaf).filter((e) => e.type === 'message').map((e) => e.message),
    addMessage(message) {
      append({ type: 'message', id: freshId(), parentId: leaf, timestamp: nowIso(), message });
    },
    getTree() {
      const marks = labels();
      const node = (entry) => ({ entry, children: entries.filter((e) => e.parentId === entry.id).map(node), ...(marks.has(entry.id) ? { label: marks.get(entry.id) } : {}) });
      return { leafId: leaf, tree: entries.filter((e) => e.parentId === null).map(node) };
    },
    /** A user target moves the leaf to its parent and hands its text back as `editorText`. */
    navigate(entryId) {
      const target = byId(entryId);
      if (!target) return { error: `Entry ${entryId} not found`, code: 'entry_not_found' };
      const isUser = target.type === 'message' && target.message?.role === 'user';
      leaf = isUser ? target.parentId : target.id;
      return { data: { cancelled: false, ...(isUser ? { editorText: textOf(target) } : {}) } };
    },
    fork(entryId) {
      const target = byId(entryId ?? leaf);
      if (!target || target.type !== 'message') return { error: `Invalid entry ID for forking: ${entryId}` };
      const chain = chainTo(target.id);
      const marks = labels();
      const source = file;
      sessionId = `sess-696-fork-${++nextId}`;
      file = newPath();
      entries = chain;
      leaf = target.id;
      writeFileSync(file, line(header(source)) + chain.map(line).join(''));
      for (const e of chain) if (marks.has(e.id)) append({ type: 'label', id: freshId(), parentId: leaf, timestamp: nowIso(), targetId: e.id, label: marks.get(e.id) });
      return { data: { cancelled: false } };
    },
    setLabel(entryId, label) {
      if (!byId(entryId)) return { error: `Entry ${entryId} not found` };
      append({ type: 'label', id: freshId(), parentId: leaf, timestamp: nowIso(), targetId: entryId, ...(label ? { label } : {}) });
      return {};
    }
  };
}
