# A Session message carries its sender in a fixed text envelope

Status: Accepted. Date: 2026-11-12. Decider: Stuart.

Slice 2 of the agent sessions epic (#1858) adds `send_session_message`, which lets one Session's agent send a turn to another Session. The receiving agent and the developer reading the transcript both need to know the turn did not come from the developer.

Rules:
- **Envelope.** Refract wraps the text as `<session-message from="<name>" session="<id>">…</session-message>`. Any envelope tag inside the message text is escaped, so a message cannot close or forge the envelope.
- **Parsing.** The transcript parser recognises the envelope on load and sets a source on the user item, so the UI shows who sent it.

**Why:** omp's session file is the source of truth for the transcript, so the label must live in the text to survive a reload. The target model also reads that text, so the envelope is the only way it can tell the turn is not from the developer.

**Alternatives rejected:**
- A plain-text prefix. It is forgeable and the turn still reads as the developer's.
- Refract-side metadata only. It is lost on reload, and the model cannot see it.

**Consequences:** the envelope format is persisted in omp session files. Changing it later needs the parser to accept both the old and the new form.
