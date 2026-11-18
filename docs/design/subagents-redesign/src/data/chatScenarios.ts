export interface SubAgentItem {
  id: string;
  name: string;
  role: string; // Short human-readable role, e.g. "A11y & WCAG Audit"
  whatItDid: string; // Clear outcome or current action in plain English
  status: 'completed' | 'running';
  duration: string;
  triggeredBy?: string; // e.g., "GateA11y757m"
  filesChanged?: string[];
  liveDetail?: string; // Answers "How is it hanging?" when running
  subSteps?: { label: string; status: 'done' | 'running' | 'pending' }[];
}

export interface StageItem {
  id: string;
  number: number;
  rawLabel: string; // What the original screenshot showed
  cleanTitle: string; // Human-readable intent in relation to the goal
  outcomeSummary: string; // 1-line summary of what this stage accomplished
  status: 'completed' | 'running';
  duration: string;
  isParallel?: boolean;
  agents: SubAgentItem[];
}

export interface ChatScenario {
  id: 'port-757' | 'pr-1788';
  tabLabel: string;
  subtitle: string;
  overallGoal: string;
  repoContext: string;
  headerStats: string;
  totalDuration: string;
  preCardText?: string;
  preCardBullet?: string;
  userQuestion?: string;
  agentReplyIntro?: string;
  agentReplyBullets?: string[];
  agentReplyFooter?: string;
  footerWaitLabel?: string;
  footerRunningAgent?: string;
  footerRunningTime?: string;
  stages: StageItem[];
}

export const SCENARIOS: Record<'port-757' | 'pr-1788', ChatScenario> = {
  'port-757': {
    id: 'port-757',
    tabLabel: 'Screenshot 1: PORT-757 (7 Stages, 13 Agents)',
    subtitle: 'Complex multi-stage quality gate & auto-remediation',
    overallGoal: 'Pass app-wide quality gates & fix all detected defects for Patient Activation (PORT-757)',
    repoContext: 'pinion-worktrees/fdb.patient.activation',
    headerStats: '7 stages, 13 agents, 1 running',
    totalDuration: '41m 54s',
    preCardText:
      'Running end-of-work quality gates across the patient activation worktree, automatically fixing flagged gate issues, and verifying WCAG 320px reflow.',
    userQuestion: 'What have all these sub-agents actually done so far, and what is Stage 7 doing?',
    agentReplyIntro:
      'Stages 1–6 completed all code, SQL, and test remediations. Stage 7 is on the final accessibility defect:',
    agentReplyBullets: [
      'Stage 2 ran 4 quality gates in parallel and caught 3 issues: raw SQL in the handler, a test coverage gap, and a 320px WCAG reflow overflow.',
      'Stages 3–5 fixed the SQL split, added integration tests, and passed the dual re-review.',
      'ZoomReflowFix757 (Stage 7) is currently refactoring the fixed-width modal container and running the Playwright 320px zoom check.'
    ],
    footerRunningAgent: 'ZoomReflowFix757',
    footerRunningTime: '12m 30s',
    footerWaitLabel: 'Waiting for 1 subagent',
    stages: [
      {
        id: 's1',
        number: 1,
        rawLabel: 'Stage 1 · Repo C:/Repos/Work/pinion-worktrees/fdb.patient.activation/r...',
        cleanTitle: 'Align ADR sequence for PORT-757',
        outcomeSummary: 'Renumbered conflicting architecture record to ADR-0757',
        status: 'completed',
        duration: '1m 29s',
        agents: [
          {
            id: 'AdrRenumber757',
            name: 'AdrRenumber757',
            role: 'ADR Indexer',
            whatItDid: 'Renumbered ADR-0756B → ADR-0757 and verified clean worktree state',
            status: 'completed',
            duration: '1m 29s',
            filesChanged: ['docs/adr/0757-patient-activation.md']
          }
        ]
      },
      {
        id: 's2',
        number: 2,
        rawLabel: 'Stage 2 · End-of-work quality gate (APP-WIDE, FULL APPLICATION) for th...',
        cleanTitle: 'Run app-wide quality gates',
        outcomeSummary: 'Audited tests, code, security & a11y in parallel → flagged 3 items to fix',
        status: 'completed',
        duration: '2m 15s',
        isParallel: true,
        agents: [
          {
            id: 'GateTests757m',
            name: 'GateTests757m',
            role: 'Test Suite Gate',
            whatItDid: 'Ran 482 test suites · flagged missing branch coverage on feature flags',
            status: 'completed',
            duration: '2m 15s'
          },
          {
            id: 'GateCode757m',
            name: 'GateCode757m',
            role: 'Code & AST Gate',
            whatItDid: 'Flagged inline SQL query in handler that needs repository extraction',
            status: 'completed',
            duration: '1m 44s'
          },
          {
            id: 'GateSec757m',
            name: 'GateSec757m',
            role: 'Security Gate',
            whatItDid: 'Passed SAST & dependency scan with 0 vulnerabilities',
            status: 'completed',
            duration: '47s'
          },
          {
            id: 'GateA11y757m',
            name: 'GateA11y757m',
            role: 'Accessibility Gate',
            whatItDid: 'Flagged 1 minor badge contrast issue & 1 medium WCAG 320px reflow defect',
            status: 'completed',
            duration: '1m 9s'
          }
        ]
      },
      {
        id: 's3',
        number: 3,
        rawLabel: 'Stage 3 · PORT-757 quality-gate fixes, repo C:/Repos/Work/pinion-workt...',
        cleanTitle: 'Apply code, a11y & doc fixes from gate',
        outcomeSummary: 'Extracted handler SQL, fixed badge contrast, and updated flag docs in parallel',
        status: 'completed',
        duration: '53s',
        isParallel: true,
        agents: [
          {
            id: 'HandlerSqlSplit757',
            name: 'HandlerSqlSplit757',
            role: 'SQL Refactor',
            whatItDid: 'Moved raw SQL joins into patientActivation.repository.ts',
            triggeredBy: 'GateCode757m',
            status: 'completed',
            duration: '53s',
            filesChanged: ['activation.handler.ts', 'patientActivation.repository.ts']
          },
          {
            id: 'FollowUpA11yFix757',
            name: 'FollowUpA11yFix757',
            role: 'Contrast Fix',
            whatItDid: 'Bumped status badge contrast from 3.8:1 to 5.4:1 (WCAG AA)',
            triggeredBy: 'GateA11y757m',
            status: 'completed',
            duration: '48s',
            filesChanged: ['ActivationBadge.tsx']
          },
          {
            id: 'FlagDocRows757',
            name: 'FlagDocRows757',
            role: 'Flag Docs',
            whatItDid: 'Documented new activation retry flags in FEATURE_FLAGS.md',
            status: 'completed',
            duration: '35s',
            filesChanged: ['FEATURE_FLAGS.md']
          }
        ]
      },
      {
        id: 's4',
        number: 4,
        rawLabel: 'Stage 4 · PORT-757 gate fixes (test gaps), repo C:/Repos/Work/pinion-w...',
        cleanTitle: 'Close unit test coverage gaps',
        outcomeSummary: 'Added 8 integration tests for split SQL handler (coverage 79% → 88.5%)',
        status: 'completed',
        duration: '1m 41s',
        agents: [
          {
            id: 'FlagWiringTests757',
            name: 'FlagWiringTests757',
            role: 'Test Author',
            whatItDid: 'Wrote integration tests for flag wiring & repository queries',
            triggeredBy: 'GateTests757m',
            status: 'completed',
            duration: '1m 41s',
            filesChanged: ['activation.spec.ts']
          }
        ]
      },
      {
        id: 's5',
        number: 5,
        rawLabel: 'Stage 5 · Step 6 re-review of PORT-757 gate fixes in repo C:/Repos/Wor...',
        cleanTitle: 'Re-review code & test stability',
        outcomeSummary: 'Verified clean architecture diff and 3/3 deterministic test runs',
        status: 'completed',
        duration: '1m 52s',
        isParallel: true,
        agents: [
          {
            id: 'FixReviewCode757',
            name: 'FixReviewCode757',
            role: 'Code Reviewer',
            whatItDid: 'Reviewed all 4 modified files — approved with 0 warnings',
            status: 'completed',
            duration: '1m 0s'
          },
          {
            id: 'FixReviewTests757',
            name: 'FixReviewTests757',
            role: 'Test Reviewer',
            whatItDid: 'Ran 3x flakiness stress check across 490 tests — all passed',
            status: 'completed',
            duration: '1m 52s'
          }
        ]
      },
      {
        id: 's6',
        number: 6,
        rawLabel: 'Stage 6 · Prepare (do NOT run) a throwaway Playwright check for PORT-7...',
        cleanTitle: 'Prepare Playwright 320px zoom check',
        outcomeSummary: 'Generated throwaway 400% zoom reflow test spec for Stage 7',
        status: 'completed',
        duration: '47s',
        agents: [
          {
            id: 'ZoomCheckPrep757',
            name: 'ZoomCheckPrep757',
            role: 'Playwright Prep',
            whatItDid: 'Created e2e/wcag-reflow-port757.spec.ts targeting 320px width',
            status: 'completed',
            duration: '47s',
            filesChanged: ['tests/e2e/wcag-reflow-port757.spec.ts']
          }
        ]
      },
      {
        id: 's7',
        number: 7,
        rawLabel: 'Stage 7 · Fix a WCAG reflow defect (PORT-757 gate, a11y Medium) in rep...',
        cleanTitle: 'Fix WCAG 320px modal reflow defect',
        outcomeSummary: 'Replacing fixed 520px width in PatientActivationModal & running Playwright check',
        status: 'running',
        duration: 'Running · 12m 30s',
        agents: [
          {
            id: 'ZoomReflowFix757',
            name: 'ZoomReflowFix757',
            role: 'WCAG Reflow Fixer',
            whatItDid: 'Replaced min-w-[480px] with responsive flex-wrap in PatientActivationModal.tsx',
            triggeredBy: 'GateA11y757m',
            status: 'running',
            duration: '12m 30s',
            filesChanged: ['PatientActivationModal.tsx'],
            liveDetail: 'Running Playwright 320px viewport assertion (4/5 layout checks passed, 0px horizontal scroll)',
            subSteps: [
              { label: 'Reproduce horizontal scroll at 320px width', status: 'done' },
              { label: 'Refactor PatientActivationModal.tsx to responsive flex', status: 'done' },
              { label: 'Verify 400% zoom reflow via ZoomCheckPrep757 spec', status: 'running' }
            ]
          }
        ]
      }
    ]
  },

  'pr-1788': {
    id: 'pr-1788',
    tabLabel: 'Screenshot 2: #1788 Delete Hardening (2 Stages, 2 Agents)',
    subtitle: 'The "How is it hanging?" chat scenario from your 2nd screenshot',
    overallGoal: 'Harden session DeleteDialog (#1788) & verify all 6 live-check scenarios pass',
    repoContext: 'src/renderer/features/sessions/DeleteDialog.tsx',
    headerStats: '2 stages, 2 agents, 1 running',
    totalDuration: '1h 39m',
    preCardText:
      '#1788 (#1159, delete hardening) is still being verified. Verify1788 is rerunning all six live-check scenarios, getting a Retry verdict with attempt timings, running ci:local and updating the PR body. Its report comes back automatically.',
    preCardBullet:
      'I confirmed that Retry bug in DeleteDialog.tsx:222 (confirmDisabled={loading}) ignores refreshing before passing it on.',
    userQuestion: 'How is it hanging?',
    agentReplyIntro:
      "It isn't hanging, monkeyboy. It's on the last scenario, (f), and everything so far has passed:",
    agentReplyBullets: [
      '(a), (b), (e): pass, covering full delete, the unregistered leftover folder, and the leftover summary.',
      '(c): "Rechecking..." with a spinner, the Retry label and the visible DialogError all pass.',
      '(d): the refusal names the real holder (PowerShell, pid 29944). The first Retry deletes it.'
    ],
    agentReplyFooter:
      "It's slow for two reasons. The rebuild took 2 minutes, and each scenario starts a real Session and waits on real git and file handles. Your other Session's cargo test on the same machine is slowing everything down too.",
    footerRunningAgent: 'Verify1788',
    footerRunningTime: '59m 24s',
    footerWaitLabel: 'Waiting for 1 subagent',
    stages: [
      {
        id: 's1-1788',
        number: 1,
        rawLabel: 'Stage 1 · Rules (HARD)',
        cleanTitle: 'Diagnose Retry race condition & path normalisation',
        outcomeSummary: 'Found Retry button stayed enabled during recheck & fixed .. path normalisation',
        status: 'completed',
        duration: '38m 50s',
        agents: [
          {
            id: 'Diag1788b',
            name: 'Diag1788b',
            role: 'Root-Cause Diagnostics',
            whatItDid: 'Identified confirmDisabled={loading} ignored refreshing state in DeleteDialog.tsx:222',
            status: 'completed',
            duration: '38m 50s',
            filesChanged: ['DeleteDialog.tsx']
          }
        ]
      },
      {
        id: 's2-1788',
        number: 2,
        rawLabel: 'Stage 2 · Rules (HARD)',
        cleanTitle: 'Run all 6 live-check delete & lock-refusal scenarios + ci:local',
        outcomeSummary: '5 of 6 scenarios passed · currently running final scenario (f)',
        status: 'running',
        duration: '59m 24s',
        agents: [
          {
            id: 'Verify1788',
            name: 'Verify1788',
            role: 'Live-Check Verifier',
            whatItDid: 'Testing real git & file-handle lock release across scenarios (a)–(f)',
            triggeredBy: 'Diag1788b',
            status: 'running',
            duration: '59m 24s',
            liveDetail: 'On scenario (f) [6/6] · Slowed by high disk I/O from parallel cargo test on host',
            subSteps: [
              { label: 'Scenarios (a), (b), (e): Full delete & leftover summary', status: 'done' },
              { label: 'Scenario (c): "Rechecking..." spinner & disabled Retry button', status: 'done' },
              { label: 'Scenario (d): Lock refusal names holder (PID 29944) & Retry deletes', status: 'done' },
              { label: 'Scenario (f): Final live-check & ci:local PR report update', status: 'running' }
            ]
          }
        ]
      }
    ]
  }
};
