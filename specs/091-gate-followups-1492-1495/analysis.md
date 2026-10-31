# Analysis (spec 091)

Every FR maps to a task (T1 to T7). No FR touches a Lane AA file. FR-003 changes every `IconButton` that passes `shortcut`; the only caller that must not advertise a chord (RepositoryGroup Ctrl+N) opts out. FR-008 changes `CompactList` truncation to wrapping for all callers (usage panels); only `callToListItem` sets `title`.
