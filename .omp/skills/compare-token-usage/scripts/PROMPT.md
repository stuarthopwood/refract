# Token benchmark prompt (v1)

Run in a fresh session on a detached checkout of commit 0184b658, with the same model
in both tools (default: claude-opus-5.5). Paste everything below the line as the first and
only user message. Do not answer follow-up questions; if the agent asks, reply "Proceed with
your best judgement." and note it in the results.

---

This is a read-only benchmark. Do not edit, create or delete any file, do not run builds or
tests, do not use the web, do not save memories, and do not start subagents or background
agents. Use only file read and search tools, and the shell for read-only git commands.

Work in these steps, one tool step at a time, in order:

1. Read `CONTEXT.md` in full.
2. Read `src/renderer/features/chat/ChatHeader.tsx` in full.
3. Read `src/renderer/features/chat/readout/Readouts.tsx` and
   `src/renderer/features/chat/readout/ReadoutItem.tsx` in full.
4. Read `src-tauri/src/session/readout.rs` in full.
5. Read `docs/design/components.md` in full.
6. Run `git log --oneline -15 -- src/renderer/features/chat` and read the output.
7. Search the codebase for every use of the term "pull request" in `src/renderer`, and list
   the files.

Then write, in your reply only, an implementation plan of 1,200 to 1,500 words for this
feature: "The chat title bar shows a PR status badge (state, number, checks dot) and a
View PR button that opens the PR in a pinned right-pane panel." The plan must contain these
sections: Summary, Files to change (path and reason), Rust backend changes, Renderer changes,
Glossary terms used (quote each from CONTEXT.md), Risks, and a final table listing every
file you read with its line count.

End your reply with the line `BENCHMARK COMPLETE`.
