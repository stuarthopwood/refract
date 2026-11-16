# Feature Specification: Personal Agent (single project-less Session)

**Feature Branch**: `feat/2004-personal-agent-model`
**Created**: 2026-11-16
**Status**: Draft
**Input**: Epic #2008 "Personal Agent" and its children #2004 (data model), #2005 (create and launch), #2006 (launcher button), #2007 (disable repo-only features), plus the epic grill and the #2004 grill with Stuart on 2026-11-16. Route: specify. One spec covers the whole epic; the first PR implements only the #2004 phase and the later children converge against this spec.

## Problem

Every **Session** today is bound to a **Project**, a branch and a **Worktree**. A developer who wants a general chat agent for a question or a piece of side work that belongs to no repository has to invent a throwaway Project or leave Refract. Stuart's request (2026-11-16): "Project-less sessions / chat: new type of session not linked to a project or repo, useful for general questions, chatbot-style agent sessions".

This feature adds one built-in **Personal Agent**: a **Session** with no **Project**, no branch and no **Worktree**, run from the developer's home folder, reusing the existing conversation system, and opened from a launcher button above the **Projects** list.

## Decisions

### Decided (Stuart, grill 2026-11-16)

1. **Shape.** One singleton "Personal Agent" **Session** that reuses the existing conversation system. It is not a type the developer creates many of, and it is distinct from project Sessions and side chats.
2. **Data model.** A **Session** has a kind, either `project` or `personal`. The repository, branch, base branch and **Worktree** path are present for `project` and absent only for `personal`. At most one `personal` Session exists. A registry written before this feature has no kind and every Session in it loads as `project`, unchanged.
3. **Naming.** "Personal Agent" is the glossary term and the meaning of the `personal` kind. The display name defaults to "My Agent" and can be renamed like any Session's. "My Agent" is a default label, not a second term.
4. **Lifecycle.** The Personal Agent cannot be archived or deleted: Rust rejects both with an error, and the interface shows those actions disabled (#2007). It can be stopped, started, paused, renamed, and can hold new **Conversations**.
5. **Working directory.** Nothing is stored. The repository, branch, base branch and **Worktree** path stay absent; launch (#2005) resolves the developer's home folder each time. The agent can read and write real files there; this is Stuart's explicit choice and nothing downstream may assume a sandbox.
6. **Session list.** A launcher button above the **Projects** list, then a divider, then a "Projects" label, then the project groups (#2006). The button opens the Personal Agent, creating it the first time, with no repository or branch picker (#2005).
7. **Repo-only features.** Git changes, file explorer, pull requests, diff and **Worktree** actions show disabled with an explanatory empty state in the Personal Agent. They are not hidden (#2007).
8. **Scope.** One spec for the whole epic, tasks grouped per child. Only the #2004 phase is implemented in the first PR.
9. **Priority.** The epic and all four children are p0.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The data model can hold the Personal Agent (Priority: P1) — #2004

The Session record can describe a project-less Session and refuses to hold more than one, while every existing Project Session and every existing saved registry keeps working exactly as before.

**Why this priority**: every other child depends on it, and it must land without changing anything a developer sees.

**Independent Test**: load a registry written before this feature and confirm every Session is a Project Session with its repository, branch and **Worktree** path intact; then try to add a second Personal Agent and to archive or delete the first and confirm each is refused.

**Acceptance Scenarios**:

1. **Given** a saved registry with no kind on its Sessions, **When** Refract starts, **Then** every Session loads as a Project Session with unchanged fields and the session list looks identical.
2. **Given** a registry with no Personal Agent, **When** one is added, **Then** it is accepted with no Project, branch, base branch or **Worktree** path.
3. **Given** a registry that already holds a Personal Agent, **When** a second is added, **Then** it is refused with an error and the registry is unchanged.
4. **Given** a Project Session with a missing repository, branch, base branch or **Worktree** path, **When** it is added, **Then** it is refused as it is today.
5. **Given** the Personal Agent, **When** archive or delete is requested, **Then** Rust refuses with an error and the Session is unchanged; stop, start, pause and rename are accepted.
6. **Given** any consumer of the Session model, **When** it reads a repository, branch or **Worktree** path, **Then** it handles the Personal Agent case explicitly, so a missing check is a compile error rather than a runtime crash.

---

### User Story 2 - Open the Personal Agent and chat (Priority: P1) — #2005

The developer opens the Personal Agent and has a normal chat with an agent that runs in their home folder.

**Why this priority**: this is the user value; without it the data model does nothing.

**Independent Test**: open the Personal Agent on a clean data folder, send a message, receive a reply, and confirm no **Worktree** was created and the agent's working folder is the home folder.

**Acceptance Scenarios**:

1. **Given** no Personal Agent exists, **When** the developer opens it, **Then** it is created with the default name "My Agent", the agent starts with the home folder as its working folder, and no **Worktree**, branch or repository is created or asked for.
2. **Given** the Personal Agent is running, **When** the developer sends a message, **Then** the agent replies through the existing conversation system with approvals, token guard and Conversations behaving as in any Session.
3. **Given** the Personal Agent exists, **When** it is opened again, **Then** the same Session is reused and a second is never created.
4. **Given** the Personal Agent has no **Worktree**, **When** the agent starts, **Then** it does not fail with a "worktree missing" error.
5. **Given** any Project Session, **When** it is created or launched, **Then** nothing about it changes.

---

### User Story 3 - A launcher button above the Projects list (Priority: P1) — #2006

The session list shows the Personal Agent as one launcher button at the very top, then a divider, then a "Projects" label, then the project groups.

**Why this priority**: it is the only way to reach the Personal Agent.

**Independent Test**: open the session list with and without a Personal Agent and confirm the layout, the button's states, and that no project group contains it.

**Acceptance Scenarios**:

1. **Given** the session list, **Then** from the top it shows the launcher button, a divider, a "Projects" label, then the project groups.
2. **Given** the developer activates the button, **Then** the Personal Agent opens (created if absent) and its chat is shown.
3. **Given** the Personal Agent is working, waiting or idle, **Then** the button shows that state the way a Session row does.
4. **Given** the Personal Agent has been renamed, **Then** the button shows the new name.
5. **Given** project groups, **Then** their counts, ordering and collapse behaviour are unchanged and the Personal Agent never appears inside one.
6. **Given** keyboard-only use, **Then** the button is reachable, shows a visible focus ring and its selected state, and the "Projects" label is a real heading for the group below it.

---

### User Story 4 - Repo-only features are disabled, not broken (Priority: P1) — #2007

In the Personal Agent, every feature that needs a repository is visibly disabled with an explanation instead of erroring or showing another Session's data.

**Why this priority**: without it the Personal Agent surfaces errors in the git changes, file explorer, pull request and diff panels.

**Independent Test**: open the Personal Agent and open each repo-only panel and action; confirm each shows a disabled state with an explanation, and that the same panels still work in a Project Session.

**Acceptance Scenarios**:

1. **Given** the Personal Agent is shown, **When** the git changes panel, file explorer, pull request view or diff is opened, **Then** each shows a disabled state with a short explanation (for example "No repository - the Personal Agent is not linked to a project").
2. **Given** the Personal Agent, **When** the session actions are shown, **Then** copy worktree path, reveal and recreate worktree are absent or disabled, and archive and delete are shown disabled with the reason.
3. **Given** a backend request for any repo-only data names the Personal Agent, **When** it is handled, **Then** it returns a clean empty or not-applicable result, with no panic and no error log.
4. **Given** a Project Session, **Then** every one of these features works exactly as before.
5. **Given** a disabled surface, **Then** its explanation is exposed to assistive technology as text, not conveyed by colour or a greyed control alone.

### Edge Cases

- A registry on disk already contains two Personal Agents (hand-edited or from a bug): loading must not crash; the earliest is kept as the singleton and the rest are reported, never silently deleted.
- A Project Session record that lost its repository fields on disk: it is refused or reported as today, never reinterpreted as a Personal Agent.
- The home folder cannot be resolved or no longer exists at launch: the launch fails with a visible error on the Personal Agent; no fallback directory is used.
- The Personal Agent is running when the developer asks to archive or delete it: the request is refused and the agent keeps running.
- Session cleanup (automatic archive and delete) never touches the Personal Agent.
- The agent's own Session tools (list, status, message, create, update) meet a Personal Agent as caller or target: this is an open question (see Open questions); the interim behaviour is that Project-scoped tools do not list or act on it.
- A Project the developer removes never affects the Personal Agent, which belongs to none.

## Requirements *(mandatory)*

### Functional Requirements

**Data model (#2004)**

- **FR-001**: A Session MUST have a kind, either `project` or `personal`.
- **FR-002**: For kind `project`, the repository, branch, base branch and **Worktree** path MUST all be present and a Session without them MUST be refused as today. For kind `personal` they MUST be absent.
- **FR-003**: The registry MUST hold at most one `personal` Session; adding a second MUST be refused with an error and change nothing.
- **FR-004**: A registry written before this feature (no kind) MUST load with every Session as `project` and no field changed, and the first save MUST NOT alter any Project Session's fields.
- **FR-005**: Adding a `personal` Session MUST NOT require a Project to exist or any Project to be named.
- **FR-006**: Archive and delete of the `personal` Session MUST be refused by Rust with an error naming the reason; stop, start, pause, rename and a new Conversation MUST be accepted.
- **FR-007**: The shared Session type seen by the interface MUST distinguish the two kinds so that a consumer reading a repository, branch or **Worktree** path cannot compile without handling the `personal` case.
- **FR-008**: Every existing consumer of the Session model MUST keep its current behaviour for `project` Sessions; where a consumer needs a repository and the Session is `personal`, it MUST skip or return a clean not-applicable result without a panic or an error log.
- **FR-009**: The display name of a new Personal Agent MUST default to "My Agent" and MUST be renameable by the same path as any Session, with the same validation.
- **FR-010**: Session cleanup MUST never archive or delete the Personal Agent.

**Create and launch (#2005)**

- **FR-011**: Opening the Personal Agent MUST create it when absent and return the existing one otherwise, without a repository, branch or base branch input and without creating a **Worktree**.
- **FR-012**: The Personal Agent's agent MUST start with the developer's home folder as its working folder, resolved on every launch and never stored.
- **FR-013**: The start gate that blocks a Session whose **Worktree** or Project is missing MUST NOT block the Personal Agent.
- **FR-014**: Apart from the working folder and the absent **Worktree**, the Personal Agent MUST launch through the existing machinery unchanged: the same agent process mode, approval mode, token guard, Conversations and recovery.
- **FR-015**: If omp requires a git repository for any path the Personal Agent uses, that MUST be recorded as a finding and raised upstream rather than worked around with a fake repository.
- **FR-016**: Creating and launching a Project Session MUST be unchanged.

**Launcher (#2006)**

- **FR-017**: The session list MUST show, from the top: the Personal Agent launcher button, a divider, a "Projects" label, then the project groups.
- **FR-018**: Activating the launcher MUST open the Personal Agent, creating it the first time, and select it.
- **FR-019**: The launcher MUST show the Personal Agent's current name and its active, working or waiting state the way a Session row does.
- **FR-020**: The Personal Agent MUST NOT render inside any project group, and project groups' counts, ordering and collapse state MUST be unchanged.
- **FR-021**: The launcher, the section label and the divider MUST be built from the shared reusable components, not one-off controls.

**Repo-only features (#2007)**

- **FR-022**: In the Personal Agent, the git changes panel, file explorer, pull request views and diff MUST each show a disabled state with an explanatory empty state, not an error and not another Session's data.
- **FR-023**: Worktree-only session actions (copy worktree path, reveal, recreate worktree) MUST be absent or disabled for the Personal Agent, and archive and delete MUST be shown disabled with the reason.
- **FR-024**: Backend handlers for repo-only data MUST return a clean empty or not-applicable result for the Personal Agent, with no panic and no error log.
- **FR-025**: Every repo-only feature MUST work exactly as before in a Project Session.

**Accessibility and docs**

- **FR-026**: Every new or changed surface MUST meet WCAG 2.1 AA: labelled, keyboard reachable, visible focus, state not conveyed by colour alone, explanations available as text.
- **FR-027**: Docs MUST change with the code: `CONTEXT.md` carries the **Personal Agent** term (done in this spec's first commit); `docs/PLAN.md` rows for #2008 and #2004-#2007 move with the work; the constitution's working-folder rule (Principle III) and a `docs/spike/FINDINGS.md` item record the home-folder launch (see the plan).

### Key Entities

- **Personal Agent**: defined in `CONTEXT.md`; the single built-in Session of kind `personal`, with no Project, branch, base branch or **Worktree**.
- **Session kind**: `project` or `personal`; decides which repository fields are present.
- **Launcher**: the button above the **Projects** list that opens the Personal Agent.
- **Disabled surface**: a repo-only panel or action shown inert, with an explanation as text.

## Accessibility (WCAG 2.1 AA)

The launcher is a real labelled button with a visible focus ring and a selected state that is not colour-only; the "Projects" label is a heading for its group. Disabled repo-only surfaces keep their explanation as readable text and are not hidden. Archive and delete show a reason, not just a greyed control. The data-model phase (#2004) changes no rendered surface.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A registry saved before this feature opens with every Session unchanged: same count, same names, same repository, branch and **Worktree** path (live check on a scratch copy).
- **SC-002**: A second Personal Agent, and an archive or delete of the first, are each refused with an error and leave the data unchanged.
- **SC-003**: From the launcher, a new developer reaches a working chat with the Personal Agent in one click and no questions (no repository, branch or name prompt).
- **SC-004**: The Personal Agent's agent runs in the developer's home folder and no **Worktree** exists for it on disk.
- **SC-005**: Opening each of the git changes, file explorer, pull request and diff surfaces in the Personal Agent shows an explanation and produces zero errors in the app log.
- **SC-006**: Every existing Project Session flow (create, launch, archive, delete, changes, files, pull requests, diff) behaves exactly as before.
- **SC-007**: `pnpm ci:local` passes, no touched file exceeds 600 lines, and a live `pnpm verify:tauri` run on a scratch data folder confirms the registry round trip for the #2004 phase.

## Assumptions

- Specs 124, 129 and 131 have merged: the Tool channel and the agent Session tools exist on `main`.
- A non-repository working folder is acceptable to omp for a plain chat; there is precedent for a non-repository process cwd (`ipc/readiness.rs`, `omp/login_providers.rs`). The first launch in #2005 verifies it live.
- The home folder is the one the operating system reports for the signed-in developer.
- A Personal Agent's saved conversation files live where omp keeps sessions for its working folder; no Refract-side storage of them is added.
- Windows 11 is the only supported platform (constitution).

## Out of scope

Multiple personal agents, user-created project-less Sessions, a sandbox or a folder picker for the Personal Agent, moving a Personal Agent into a Project, cross-Session agent tools for it beyond what the open questions settle, and any change to side chat.
