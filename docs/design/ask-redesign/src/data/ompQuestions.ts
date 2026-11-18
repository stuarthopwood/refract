export interface AskOption {
  id: string;
  label: string;
  shortSummary: string;
  isRecommended?: boolean;
  recommendationReason?: string;
}

export interface AskQuestionItem {
  id: string;
  stepNumber: number;
  topicLabel: string;
  question: string;
  contextHint?: string;
  mode: 'single' | 'multi';
  options: AskOption[];
  defaultSelectedIds: string[];
  defaultNotes: Record<string, string>;
  defaultCustomText?: string;
}

export interface AnsweredQuestionRecord {
  questionId: string;
  selectedOptionIds: string[];
  notesByOptionId: Record<string, string>;
  customText: string;
  answeredAt: string;
}

export const INITIAL_OMP_QUESTIONS: AskQuestionItem[] = [
  {
    id: 'q-preview-arch',
    stepNumber: 1,
    topicLabel: 'Preview architecture',
    question: 'How should the preview work?',
    contextHint: 'Settings > Chat / Appearance / Status-line live preview container',
    mode: 'single',
    options: [
      {
        id: 'opt-holistic-live',
        label:
          'One holistic live preview: reuse the real TranscriptRow + ComposerStatusLine with a canned sample, pinned atop the Chat/Appearance/Status-line sections, updating live as any option changes.',
        shortSummary: 'Holistic live preview (TranscriptRow + ComposerStatusLine pinned)',
        isRecommended: true,
        recommendationReason:
          'Reuses production components with zero layout drift across all three settings sections.',
      },
      {
        id: 'opt-per-section-mini',
        label:
          'Separate mini-previews embedded inside each individual section (Chat, Appearance, and Status-line rendered independently).',
        shortSummary: 'Separate per-section mini-previews',
      },
      {
        id: 'opt-modal-drawer',
        label:
          'On-demand preview drawer toggled via a header button so settings rows keep maximum vertical space.',
        shortSummary: 'On-demand toggleable preview drawer',
      },
    ],
    defaultSelectedIds: ['opt-holistic-live'],
    defaultNotes: {},
  },
  {
    id: 'q-preview-data',
    stepNumber: 2,
    topicLabel: 'Preview data source',
    question: 'What does the preview show?',
    contextHint: 'Matches Screenshot 2 active ask tool prompt',
    mode: 'single',
    options: [
      {
        id: 'opt-canned-sample',
        label:
          'A fixed canned sample conversation + status line. Deterministic, always present.',
        shortSummary: 'Fixed canned sample conversation + status line (Deterministic)',
        isRecommended: true,
        recommendationReason:
          'Guarantees immediate visual feedback even on a fresh install with no prior session history.',
      },
      {
        id: 'opt-mirror-session',
        label:
          "Mirror the user's current/last real session. More real, but empty when there's no session.",
        shortSummary: "Mirror user's current/last real session",
      },
    ],
    defaultSelectedIds: ['opt-canned-sample'],
    defaultNotes: {},
  },
  {
    id: 'q-slider-control',
    stepNumber: 3,
    topicLabel: 'Scale control input',
    question: 'Slider alone, or slider plus a number field?',
    contextHint: 'Threshold percentage controls in Settings',
    mode: 'single',
    options: [
      {
        id: 'opt-slider-plus-num',
        label:
          'Slider (notched at 5%) paired with a small number field for exact entry, kept in step — the pattern ScaleControl already uses.',
        shortSummary: 'Slider (5% notches) + synced number field (ScaleControl pattern)',
        isRecommended: true,
        recommendationReason:
          'Maintains UI consistency with existing ScaleControl and allows both fast drag and exact 1% keyboard entry.',
      },
      {
        id: 'opt-slider-only',
        label:
          'Notched slider alone with a live percentage value label on hover/drag.',
        shortSummary: 'Notched slider alone with value label',
      },
      {
        id: 'opt-number-stepper',
        label:
          'Compact numeric stepper input with ±5% increment buttons and no horizontal track.',
        shortSummary: 'Numeric stepper input (±5% buttons)',
      },
    ],
    defaultSelectedIds: ['opt-slider-plus-num'],
    defaultNotes: {},
  },
  {
    id: 'q-notch-fields',
    stepNumber: 4,
    topicLabel: '5% notch targets & behavior',
    question: 'Which fields, and how do the 5% notches behave?',
    contextHint: 'Multi-select enabled — select all rules that should apply to threshold fields',
    mode: 'multi',
    options: [
      {
        id: 'opt-two-clean-fields',
        label:
          'Convert the two clean 1–99% fields (compaction threshold, idle threshold-as-%); snap to 5% with ticks.',
        shortSummary: 'Convert compaction & idle % fields (snap to 5% with ticks)',
        isRecommended: true,
        recommendationReason:
          'Both fields are pure 1–99% ratios with no overloaded unit semantics.',
      },
      {
        id: 'opt-skip-per-model',
        label:
          'Skip the per-model table (it also accepts token caps).',
        shortSummary: 'Skip per-model table (accepts raw token caps)',
        isRecommended: true,
        recommendationReason:
          'Avoids breaking hybrid percentage/token-cap inputs in per-model overrides.',
      },
      {
        id: 'opt-force-round-existing',
        label:
          'Immediately round any existing off-5% user config values to the nearest 5% increment on load.',
        shortSummary: 'Force-round existing off-5% values on load',
      },
    ],
    defaultSelectedIds: ['opt-two-clean-fields', 'opt-skip-per-model'],
    defaultNotes: {
      'opt-two-clean-fields': 'Existing off-5% values preserved until moved.',
    },
  },
  {
    id: 'q-priorities',
    stepNumber: 5,
    topicLabel: 'Issue priorities',
    question: 'Priorities',
    contextHint: 'Linear / issue tracker priority assignment for preview & slider tasks',
    mode: 'single',
    options: [
      {
        id: 'opt-both-p2',
        label: 'Both p2.',
        shortSummary: 'Both p2',
        isRecommended: true,
        recommendationReason:
          'Matches current sprint polish tier without blocking P0/P1 runtime regressions.',
      },
      {
        id: 'opt-preview-p1-slider-p2',
        label: 'Live preview p1, notched slider controls p2.',
        shortSummary: 'Preview p1, slider controls p2',
      },
      {
        id: 'opt-both-p3',
        label: 'Both p3 (backlog polish).',
        shortSummary: 'Both p3',
      },
    ],
    defaultSelectedIds: ['opt-both-p2'],
    defaultNotes: {},
  },
];

export const INITIAL_ANSWERED_RECORDS: Record<string, AnsweredQuestionRecord> = {
  'q-preview-arch': {
    questionId: 'q-preview-arch',
    selectedOptionIds: ['opt-holistic-live'],
    notesByOptionId: {},
    customText: '',
    answeredAt: '12m 50s',
  },
  'q-preview-data': {
    questionId: 'q-preview-data',
    selectedOptionIds: ['opt-canned-sample'],
    notesByOptionId: {},
    customText: '',
    answeredAt: '12m 50s',
  },
  'q-slider-control': {
    questionId: 'q-slider-control',
    selectedOptionIds: ['opt-slider-plus-num'],
    notesByOptionId: {},
    customText: '',
    answeredAt: '12m 50s',
  },
  'q-notch-fields': {
    questionId: 'q-notch-fields',
    selectedOptionIds: ['opt-two-clean-fields', 'opt-skip-per-model'],
    notesByOptionId: {
      'opt-two-clean-fields': 'Existing off-5% values preserved until moved.',
    },
    customText: '',
    answeredAt: '12m 50s',
  },
  'q-priorities': {
    questionId: 'q-priorities',
    selectedOptionIds: ['opt-both-p2'],
    notesByOptionId: {},
    customText: '',
    answeredAt: '12m 50s',
  },
};
