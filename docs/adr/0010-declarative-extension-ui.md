# Declarative extension UI

Status: Accepted. Date: 2026-11-19. Deciders: Stuart (grill 2026-11-19), Skippy (delegated).

Epic #2093 lets OMP extensions add left pane items, composer pills, right pane panels, and Settings pages to Refract. This record covers how an extension describes that UI and how Refract receives it.

**Context:**
- OMP's RPC mode gives a host only dialogs, `setStatus`, string-array `setWidget`, and `setTitle`. `custom()` is unsupported over RPC, so an extension cannot hand Refract a component.
- The constitution (`.specify/memory/constitution.md:114-118`, `:122-123`, `:139-140`) forbids a webview plugin API, remote content, and raw HTML, so Refract cannot embed extension HTML or script.

**Decision:**
- **Declarative data blocks.** An extension sends versioned JSON that describes what to show. Refract validates the payload and draws it with its own components. No extension HTML or script runs in the window, and the constitution stays unchanged.
- **SDK over `setWidget`.** A Refract SDK, used inside the extension, sends the JSON through OMP `setWidget` under reserved `refract.` keys.
- **Extension host.** A background OMP process with no model and no chat supplies the app-wide contributions (left pane items, Settings pages). A Session supplies its own contributions (right pane panels, composer pills) through its own OMP process.
- **Per-extension opt-in.** Contributions appear only after you enable the extension in Settings > Extensions.
- **Buttons run slash commands.** A button in a contribution runs one of the extension's own slash commands.
- **Settings storage.** Extension settings live in `~/.omp/agent/extensions/<id>.settings.json`.

**Alternatives rejected:**
- **Sandboxed HTML frames.** They need a constitution amendment. That work stays with #1194 (sandboxed Copilot canvas extensions in the right pane).
- **A static manifest.** It needs a second file next to every extension and cannot describe live state.
- **Waiting on upstream OMP.** It blocks the epic on a change Refract does not control.

**Consequences:**
- Extensions cannot draw arbitrary UI. They are limited to the block types Refract implements.
- The payload schema is versioned, and Refract must keep reading older versions or reject them with a visible error.
- Refract runs one extra idle OMP process for the Extension host.

See #2093 and its slices #2094 to #2099.
