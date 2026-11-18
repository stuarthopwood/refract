/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Sparkles,
  CheckSquare,
  MessageSquarePlus,
  RotateCcw,
  Code2,
  Eye,
  Layers,
  SplitSquareVertical,
  Image as ImageIcon,
} from 'lucide-react';
import {
  INITIAL_OMP_QUESTIONS,
  INITIAL_ANSWERED_RECORDS,
  AskQuestionItem,
  AnsweredQuestionRecord,
} from './data/ompQuestions';
import { AskToolCard } from './components/AskToolCard';
import { SessionQACard } from './components/SessionQACard';
import { OmpBackgroundWatermark } from './components/OmpBackgroundWatermark';
import { HtmlExportModal } from './components/HtmlExportModal';

type WorkspaceViewMode =
  | 'interactive-session'
  | 'dual-ask-cards'
  | 'collapsible-comparison'
  | 'before-after';

export default function App() {
  const [questions, setQuestions] = useState<AskQuestionItem[]>(
    INITIAL_OMP_QUESTIONS
  );
  const [answeredRecords, setAnsweredRecords] = useState<
    Record<string, AnsweredQuestionRecord>
  >(INITIAL_ANSWERED_RECORDS);

  const [currentStepIndex, setCurrentStepIndex] = useState<number>(1);
  const [viewMode, setViewMode] = useState<WorkspaceViewMode>(
    'interactive-session'
  );
  const [isExportModalOpen, setIsExportModalOpen] = useState<boolean>(false);
  const [imgError1, setImgError1] = useState<boolean>(false);
  const [imgError2, setImgError2] = useState<boolean>(false);

  const handleUpdateAnswer = (
    questionId: string,
    selectedOptionIds: string[],
    notesByOptionId: Record<string, string>,
    customText: string
  ) => {
    setAnsweredRecords((prev) => ({
      ...prev,
      [questionId]: {
        questionId,
        selectedOptionIds,
        notesByOptionId,
        customText,
        answeredAt: '12m 50s',
      },
    }));
  };

  const handleToggleQuestionMode = (
    questionId: string,
    newMode: 'single' | 'multi'
  ) => {
    setQuestions((prev) =>
      prev.map((q) => (q.id === questionId ? { ...q, mode: newMode } : q))
    );
  };

  const handleResetDemo = () => {
    setQuestions(INITIAL_OMP_QUESTIONS);
    setAnsweredRecords(INITIAL_ANSWERED_RECORDS);
    setCurrentStepIndex(1);
  };

  const activeQuestion = questions[currentStepIndex] || questions[0];
  const multiSelectQuestion =
    questions.find((q) => q.id === 'q-notch-fields') || questions[3];
  const singleSelectQuestion =
    questions.find((q) => q.id === 'q-preview-data') || questions[1];

  return (
    <div className="min-h-screen bg-[#090A0C] text-[#E6E8EC] flex flex-col relative overflow-x-hidden">
      {/* Subtle OMP Isometric Cube Watermark in the right background */}
      <OmpBackgroundWatermark className="fixed right-[-40px] bottom-[-20px] z-0" />

      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="relative z-10 flex items-center justify-between gap-8 px-5 py-2.5 bg-[#0C0E12] border-b border-[#1D2028]">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setViewMode('interactive-session');
          }}
          className="text-sm font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          OMP Agentic Ask UI
        </a>

        {/* Zone 2: 4 concise single-line text navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-xs font-medium text-neutral-400">
          <button
            type="button"
            onClick={() => setViewMode('interactive-session')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              viewMode === 'interactive-session'
                ? 'text-white underline underline-offset-8 decoration-emerald-500'
                : ''
            }`}
          >
            Live Session Flow
          </button>
          <button
            type="button"
            onClick={() => setViewMode('dual-ask-cards')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              viewMode === 'dual-ask-cards'
                ? 'text-white underline underline-offset-8 decoration-emerald-500'
                : ''
            }`}
          >
            Single vs Multi-Select
          </button>
          <button
            type="button"
            onClick={() => setViewMode('collapsible-comparison')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              viewMode === 'collapsible-comparison'
                ? 'text-white underline underline-offset-8 decoration-emerald-500'
                : ''
            }`}
          >
            Collapsible Q&amp;A States
          </button>
          <button
            type="button"
            onClick={() => setViewMode('before-after')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              viewMode === 'before-after'
                ? 'text-white underline underline-offset-8 decoration-emerald-500'
                : ''
            }`}
          >
            Original Screenshots
          </button>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setIsExportModalOpen(true)}
            className="px-3 py-1 text-xs font-medium text-neutral-950 bg-emerald-400 hover:bg-emerald-300 rounded transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5"
          >
            <Code2 className="w-3.5 h-3.5" />
            <span>Export HTML</span>
          </button>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="relative z-10 flex-1 w-full max-w-[1320px] mx-auto px-4 sm:px-5 py-4 space-y-4">
        {/* Compact Workspace Toolbar */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3 border-b border-[#1B1E26]">
          <div className="space-y-0.5">
            <h1 className="text-base sm:text-lg font-semibold text-white tracking-tight">
              Agentic Ask Tool &amp; Collapsible Session Q&amp;A
            </h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-neutral-400">
              <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                <Sparkles className="w-3 h-3" />
                <span>Recommended action indicator</span>
              </span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1 text-neutral-300">
                <CheckSquare className="w-3 h-3 text-emerald-400" />
                <span>Multi-select mode</span>
              </span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1 text-neutral-300">
                <MessageSquarePlus className="w-3 h-3 text-amber-400" />
                <span>Press &apos;N&apos; for option note</span>
              </span>
              <span aria-hidden="true">·</span>
              <span>Collapsible Q&amp;A transcript</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <div
              role="group"
              aria-label="Quick view presets"
              className="inline-flex items-center bg-[#111318] border border-[#232730] rounded p-0.5 gap-0.5"
            >
              <button
                type="button"
                onClick={() => {
                  setViewMode('interactive-session');
                  setCurrentStepIndex(1);
                }}
                className={`px-2 py-1 rounded-[3px] text-xs font-medium transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1 ${
                  viewMode === 'interactive-session' && currentStepIndex !== 3
                    ? 'bg-[#21252F] text-white'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <Eye className="w-3 h-3 text-emerald-400" />
                <span>Single-Select</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setViewMode('interactive-session');
                  setCurrentStepIndex(3);
                }}
                className={`px-2 py-1 rounded-[3px] text-xs font-medium transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1 ${
                  viewMode === 'interactive-session' && currentStepIndex === 3
                    ? 'bg-[#21252F] text-white'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <CheckSquare className="w-3 h-3 text-emerald-400" />
                <span>Multi-Select + Note</span>
              </button>

              <button
                type="button"
                onClick={() => setViewMode('dual-ask-cards')}
                className={`px-2 py-1 rounded-[3px] text-xs font-medium transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1 ${
                  viewMode === 'dual-ask-cards'
                    ? 'bg-[#21252F] text-white'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <Layers className="w-3 h-3 text-emerald-400" />
                <span>Compare Ask Cards</span>
              </button>

              <button
                type="button"
                onClick={() => setViewMode('collapsible-comparison')}
                className={`px-2 py-1 rounded-[3px] text-xs font-medium transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1 ${
                  viewMode === 'collapsible-comparison'
                    ? 'bg-[#21252F] text-white'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <SplitSquareVertical className="w-3 h-3 text-emerald-400" />
                <span>Collapsed vs Expanded</span>
              </button>
            </div>

            <button
              type="button"
              onClick={handleResetDemo}
              className="px-2 py-1 rounded bg-[#13161C] hover:bg-[#1A1E26] border border-[#242832] text-xs text-neutral-400 hover:text-white transition-colors inline-flex items-center gap-1 whitespace-nowrap shrink-0"
              title="Reset answers and notes to initial screenshot state"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset</span>
            </button>
          </div>
        </div>

        {/* VIEW 1: Interactive Agentic Session Flow */}
        {viewMode === 'interactive-session' && (
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
            {/* Left Column (7 cols): Active HTML Ask Tool Card */}
            <div className="xl:col-span-7 space-y-2">
              <div className="text-xs text-neutral-400 flex items-center justify-between">
                <span>
                  Active Ask Tool Card (Press{' '}
                  <kbd className="px-1 py-0.5 text-[10px] font-mono bg-[#151820] border border-[#2C313D] rounded text-emerald-300">
                    N
                  </kbd>{' '}
                  for Note,{' '}
                  <kbd className="px-1 py-0.5 text-[10px] font-mono bg-[#151820] border border-[#2C313D] rounded text-emerald-300">
                    ↵
                  </kbd>{' '}
                  to Confirm)
                </span>
                <span className="text-[11px] text-neutral-500 font-mono">
                  {activeQuestion.mode === 'multi'
                    ? 'Multi-Select'
                    : 'Single-Select'}
                </span>
              </div>

              <AskToolCard
                questionItem={activeQuestion}
                totalQuestions={questions.length}
                currentStepIndex={currentStepIndex}
                existingRecord={answeredRecords[activeQuestion.id]}
                onSelectStep={setCurrentStepIndex}
                onSubmitAnswer={handleUpdateAnswer}
                onToggleQuestionMode={handleToggleQuestionMode}
                isKeyboardActive={true}
              />
            </div>

            {/* Right Column (5 cols): Read-Only Collapsible Session Q&A Transcript */}
            <div className="xl:col-span-5 space-y-3">
              <div className="space-y-1.5">
                <div className="text-xs text-neutral-400">
                  Session Q&amp;A Display — Collapsed Digest:
                </div>
                <SessionQACard
                  questions={questions}
                  answeredRecords={answeredRecords}
                  defaultCollapsed={true}
                />
              </div>

              <div className="space-y-1.5">
                <div className="text-xs text-neutral-400">
                  Session Q&amp;A Display — Expanded Full Transcript:
                </div>
                <SessionQACard
                  questions={questions}
                  answeredRecords={answeredRecords}
                  defaultCollapsed={false}
                />
              </div>
            </div>
          </div>
        )}

        {/* VIEW 2: Side-by-Side Single-Select vs Multi-Select Ask Tool Cards */}
        {viewMode === 'dual-ask-cards' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
            <div className="space-y-2">
              <div className="text-xs font-medium text-neutral-300">
                Single-Select Ask Card (Screenshot 2 Redesign)
              </div>
              <AskToolCard
                questionItem={singleSelectQuestion}
                totalQuestions={questions.length}
                currentStepIndex={1}
                existingRecord={answeredRecords[singleSelectQuestion.id]}
                onSelectStep={(idx) => {
                  setCurrentStepIndex(idx);
                  setViewMode('interactive-session');
                }}
                onSubmitAnswer={handleUpdateAnswer}
                onToggleQuestionMode={handleToggleQuestionMode}
                isKeyboardActive={false}
              />
            </div>

            <div className="space-y-2">
              <div className="text-xs font-medium text-neutral-300">
                Multi-Select Ask Card + Attached Option Note (&apos;N&apos;)
              </div>
              <AskToolCard
                questionItem={multiSelectQuestion}
                totalQuestions={questions.length}
                currentStepIndex={3}
                existingRecord={answeredRecords[multiSelectQuestion.id]}
                onSelectStep={(idx) => {
                  setCurrentStepIndex(idx);
                  setViewMode('interactive-session');
                }}
                onSubmitAnswer={handleUpdateAnswer}
                onToggleQuestionMode={handleToggleQuestionMode}
                isKeyboardActive={true}
              />
            </div>
          </div>
        )}

        {/* VIEW 3: Collapsible Session Q&A Card Comparison */}
        {viewMode === 'collapsible-comparison' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
            <div className="space-y-2">
              <div className="text-xs font-medium text-neutral-300">
                Collapsed State (Scannable question &amp; answer digest)
              </div>
              <SessionQACard
                questions={questions}
                answeredRecords={answeredRecords}
                defaultCollapsed={true}
              />
            </div>

            <div className="space-y-2">
              <div className="text-xs font-medium text-neutral-300">
                Expanded State (Full verbatim session transcript)
              </div>
              <SessionQACard
                questions={questions}
                answeredRecords={answeredRecords}
                defaultCollapsed={false}
              />
            </div>
          </div>
        )}

        {/* VIEW 4: Original Screenshots vs Redesigned Architecture Reference */}
        {viewMode === 'before-after' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="rounded-md bg-[#101216] border border-[#22252E] p-4 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-white">
                  Original Ask Tool Card (Uploaded Screenshot)
                </span>
                <span className="text-neutral-500 font-mono">Before</span>
              </div>

              {!imgError2 ? (
                <img
                  src="/assets/aistudio/Screenshot_2026-11-13_123957_6c480349.png"
                  alt="Original OMP Ask Tool Card Screenshot"
                  referrerPolicy="no-referrer"
                  onError={() => setImgError2(true)}
                  className="w-full rounded border border-[#23262F] object-contain bg-black"
                />
              ) : (
                <div className="p-4 rounded border border-[#23262F] bg-[#0B0C0E] flex items-center gap-2 text-xs text-neutral-400">
                  <ImageIcon className="w-4 h-4 text-neutral-500 shrink-0" />
                  <span>Original Ask Tool Card reference preview</span>
                </div>
              )}
            </div>

            <div className="rounded-md bg-[#101216] border border-[#22252E] p-4 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-white">
                  Original Session Q&amp;A Card (Uploaded image.png)
                </span>
                <span className="text-neutral-500 font-mono">Before</span>
              </div>

              {!imgError1 ? (
                <img
                  src="/assets/aistudio/image_fd915511.png"
                  alt="Original Questions from the agent transcript screenshot"
                  referrerPolicy="no-referrer"
                  onError={() => setImgError1(true)}
                  className="w-full rounded border border-[#23262F] object-contain bg-black"
                />
              ) : (
                <div className="p-4 rounded border border-[#23262F] bg-[#0B0C0E] flex items-center gap-2 text-xs text-neutral-400">
                  <ImageIcon className="w-4 h-4 text-neutral-500 shrink-0" />
                  <span>Original Session Q&amp;A Card reference preview</span>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* HTML / CSS Export Modal */}
      <HtmlExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
      />
    </div>
  );
}
