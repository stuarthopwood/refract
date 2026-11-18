import React, { useState, useEffect, useRef } from 'react';
import {
  Check,
  Sparkles,
  MessageSquarePlus,
  CornerDownLeft,
  ChevronLeft,
  ChevronRight,
  CheckSquare,
  Square,
  CircleDot,
  Circle,
  X,
  Pencil,
} from 'lucide-react';
import { AskQuestionItem, AnsweredQuestionRecord } from '../data/ompQuestions';

interface AskToolCardProps {
  questionItem: AskQuestionItem;
  totalQuestions: number;
  currentStepIndex: number;
  existingRecord?: AnsweredQuestionRecord;
  onSelectStep: (index: number) => void;
  onSubmitAnswer: (
    questionId: string,
    selectedOptionIds: string[],
    notesByOptionId: Record<string, string>,
    customText: string
  ) => void;
  onToggleQuestionMode?: (questionId: string, newMode: 'single' | 'multi') => void;
  isKeyboardActive?: boolean;
  elapsedTime?: string;
}

export const AskToolCard: React.FC<AskToolCardProps> = ({
  questionItem,
  totalQuestions,
  currentStepIndex,
  existingRecord,
  onSelectStep,
  onSubmitAnswer,
  onToggleQuestionMode,
  isKeyboardActive = true,
  elapsedTime = '12m 50s',
}) => {
  const [selectedIds, setSelectedIds] = useState<string[]>(
    existingRecord?.selectedOptionIds ?? questionItem.defaultSelectedIds
  );
  const [notesByOption, setNotesByOption] = useState<Record<string, string>>(
    existingRecord?.notesByOptionId ?? questionItem.defaultNotes
  );
  const [customText, setCustomText] = useState<string>(
    existingRecord?.customText ?? questionItem.defaultCustomText ?? ''
  );
  const [focusedOptionId, setFocusedOptionId] = useState<string>(() => {
    const firstSelected =
      existingRecord?.selectedOptionIds?.[0] ??
      questionItem.defaultSelectedIds?.[0];
    if (firstSelected) return firstSelected;
    const recommended = questionItem.options.find((o) => o.isRecommended);
    return recommended ? recommended.id : questionItem.options[0]?.id || 'other';
  });

  const [editingNoteOptionId, setEditingNoteOptionId] = useState<string | null>(
    null
  );
  const [noteDraft, setNoteDraft] = useState<string>('');
  const [justSubmittedFlash, setJustSubmittedFlash] = useState<boolean>(false);

  const noteInputRef = useRef<HTMLInputElement | null>(null);
  const customInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const nextSelected =
      existingRecord?.selectedOptionIds ?? questionItem.defaultSelectedIds;
    setSelectedIds(nextSelected);
    setNotesByOption(
      existingRecord?.notesByOptionId ?? questionItem.defaultNotes
    );
    setCustomText(
      existingRecord?.customText ?? questionItem.defaultCustomText ?? ''
    );
    setEditingNoteOptionId(null);

    const rec = questionItem.options.find((o) => o.isRecommended);
    setFocusedOptionId(
      nextSelected[0] ?? rec?.id ?? questionItem.options[0]?.id ?? 'other'
    );
  }, [questionItem, existingRecord]);

  useEffect(() => {
    if (editingNoteOptionId && noteInputRef.current) {
      noteInputRef.current.focus();
    }
  }, [editingNoteOptionId]);

  const allOptionIds = [...questionItem.options.map((o) => o.id), 'other'];
  const recommendedOptionIds = questionItem.options
    .filter((o) => o.isRecommended)
    .map((o) => o.id);

  const targetOptionForNote = selectedIds.includes(focusedOptionId)
    ? focusedOptionId
    : selectedIds[0] || focusedOptionId || questionItem.options[0]?.id;

  const openNoteEditorFor = (optionId: string) => {
    if (!optionId) return;
    if (!selectedIds.includes(optionId)) {
      if (questionItem.mode === 'single') {
        setSelectedIds([optionId]);
      } else {
        setSelectedIds((prev) => [...prev, optionId]);
      }
    }
    setFocusedOptionId(optionId);
    setNoteDraft(notesByOption[optionId] ?? '');
    setEditingNoteOptionId(optionId);
  };

  const saveNoteForOption = (optionId: string) => {
    const trimmed = noteDraft.trim();
    const updatedNotes = { ...notesByOption };
    if (trimmed) {
      updatedNotes[optionId] = trimmed;
    } else {
      delete updatedNotes[optionId];
    }
    setNotesByOption(updatedNotes);
    setEditingNoteOptionId(null);
    onSubmitAnswer(questionItem.id, selectedIds, updatedNotes, customText);
  };

  const removeNoteForOption = (optionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updatedNotes = { ...notesByOption };
    delete updatedNotes[optionId];
    setNotesByOption(updatedNotes);
    if (editingNoteOptionId === optionId) {
      setEditingNoteOptionId(null);
    }
    onSubmitAnswer(questionItem.id, selectedIds, updatedNotes, customText);
  };

  const handleOptionToggle = (optionId: string) => {
    setFocusedOptionId(optionId);
    let nextSelected: string[];

    if (questionItem.mode === 'single') {
      nextSelected = [optionId];
    } else {
      if (selectedIds.includes(optionId)) {
        nextSelected = selectedIds.filter((id) => id !== optionId);
      } else {
        nextSelected = [...selectedIds, optionId];
      }
    }

    setSelectedIds(nextSelected);
    onSubmitAnswer(questionItem.id, nextSelected, notesByOption, customText);

    if (optionId === 'other') {
      setTimeout(() => customInputRef.current?.focus(), 30);
    }
  };

  const handleAcceptRecommended = () => {
    if (recommendedOptionIds.length === 0) return;
    const nextSelected =
      questionItem.mode === 'single'
        ? [recommendedOptionIds[0]]
        : recommendedOptionIds;
    setSelectedIds(nextSelected);
    setFocusedOptionId(nextSelected[0]);
    onSubmitAnswer(questionItem.id, nextSelected, notesByOption, customText);
    triggerFlashAndAdvance();
  };

  const handleConfirmSubmission = () => {
    onSubmitAnswer(questionItem.id, selectedIds, notesByOption, customText);
    triggerFlashAndAdvance();
  };

  const triggerFlashAndAdvance = () => {
    setJustSubmittedFlash(true);
    setTimeout(() => {
      setJustSubmittedFlash(false);
      if (currentStepIndex < totalQuestions - 1) {
        onSelectStep(currentStepIndex + 1);
      }
    }, 150);
  };

  useEffect(() => {
    if (!isKeyboardActive) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInputFocused =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;

      if (isInputFocused) return;

      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        openNoteEditorFor(targetOptionForNote);
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        const idx = allOptionIds.indexOf(focusedOptionId);
        const nextIdx = (idx + 1) % allOptionIds.length;
        const nextId = allOptionIds[nextIdx];
        setFocusedOptionId(nextId);
        if (questionItem.mode === 'single') {
          setSelectedIds([nextId]);
          onSubmitAnswer(questionItem.id, [nextId], notesByOption, customText);
        }
        return;
      }

      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        const idx = allOptionIds.indexOf(focusedOptionId);
        const prevIdx = (idx - 1 + allOptionIds.length) % allOptionIds.length;
        const prevId = allOptionIds[prevIdx];
        setFocusedOptionId(prevId);
        if (questionItem.mode === 'single') {
          setSelectedIds([prevId]);
          onSubmitAnswer(questionItem.id, [prevId], notesByOption, customText);
        }
        return;
      }

      if (e.key === ' ' && questionItem.mode === 'multi') {
        e.preventDefault();
        handleOptionToggle(focusedOptionId);
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        handleConfirmSubmission();
        return;
      }

      const num = parseInt(e.key, 10);
      if (!isNaN(num) && num >= 1 && num <= allOptionIds.length) {
        e.preventDefault();
        const chosenId = allOptionIds[num - 1];
        handleOptionToggle(chosenId);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  const isRecommendedCurrentlySelected =
    recommendedOptionIds.length > 0 &&
    recommendedOptionIds.every((id) => selectedIds.includes(id));

  return (
    <div className="w-full">
      {/* Compact Top Status Row matching OMP */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5 px-0.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1 font-medium text-emerald-400">
            <Check className="w-3.5 h-3.5 stroke-[2.5]" />
            <span>Answered</span>
          </span>
          <span className="text-neutral-600" aria-hidden="true">
            ·
          </span>
          <span className="text-neutral-400 font-mono tabular-nums">
            {currentStepIndex + 1}/{totalQuestions}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {onToggleQuestionMode && (
            <div
              role="group"
              aria-label="Selection mode"
              className="inline-flex items-center bg-[#121418] border border-[#232730] rounded p-0.5 text-[11px]"
            >
              <button
                type="button"
                onClick={() => onToggleQuestionMode(questionItem.id, 'single')}
                className={`px-2 py-0.5 rounded-[3px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  questionItem.mode === 'single'
                    ? 'bg-[#222631] text-white'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                Single
              </button>
              <button
                type="button"
                onClick={() => onToggleQuestionMode(questionItem.id, 'multi')}
                className={`px-2 py-0.5 rounded-[3px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  questionItem.mode === 'multi'
                    ? 'bg-[#222631] text-white'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                Multi-select
              </button>
            </div>
          )}

          <div className="inline-flex items-center bg-[#121418] border border-[#232730] rounded p-0.5">
            <button
              type="button"
              disabled={currentStepIndex === 0}
              onClick={() => onSelectStep(Math.max(0, currentStepIndex - 1))}
              className="p-0.5 text-neutral-400 hover:text-white disabled:opacity-35 disabled:pointer-events-none transition-colors"
              title="Previous question"
              aria-label="Previous question"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <div className="flex items-center gap-0.5 px-1">
              {Array.from({ length: totalQuestions }).map((_, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => onSelectStep(idx)}
                  aria-label={`Go to question ${idx + 1}`}
                  className={`w-4 h-4 rounded-[3px] text-[10px] font-mono tabular-nums transition-colors ${
                    idx === currentStepIndex
                      ? 'bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/40'
                      : 'text-neutral-400 hover:text-neutral-200 hover:bg-[#1C1F26]'
                  }`}
                >
                  {idx + 1}
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={currentStepIndex === totalQuestions - 1}
              onClick={() =>
                onSelectStep(Math.min(totalQuestions - 1, currentStepIndex + 1))
              }
              className="p-0.5 text-neutral-400 hover:text-white disabled:opacity-35 disabled:pointer-events-none transition-colors"
              title="Next question"
              aria-label="Next question"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Main Compact OMP Ask Tool Card Container */}
      <div
        className={`relative rounded-md bg-[#101216] border transition-colors duration-150 ${
          justSubmittedFlash ? 'border-emerald-500/70' : 'border-[#22252E]'
        } p-3.5`}
      >
        {/* Question Header + Fast Recommended Action */}
        <div className="flex items-center justify-between gap-3 mb-2.5">
          <div className="flex flex-wrap items-baseline gap-2 min-w-0">
            <h2 className="text-[14px] font-semibold text-neutral-100 leading-snug">
              {questionItem.question}
            </h2>
            {questionItem.mode === 'multi' && (
              <span className="text-[11px] text-neutral-400">
                Select all that apply
              </span>
            )}
          </div>

          {recommendedOptionIds.length > 0 && (
            <button
              type="button"
              onClick={handleAcceptRecommended}
              className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1 border ${
                isRecommendedCurrentlySelected
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/25'
                  : 'bg-emerald-600 text-white border-emerald-500 hover:bg-emerald-500'
              }`}
            >
              <Sparkles className="w-3 h-3" />
              <span>
                {isRecommendedCurrentlySelected
                  ? 'Recommended'
                  : 'Use Recommended'}
              </span>
              <kbd className="ml-0.5 px-1 text-[10px] font-mono bg-black/30 rounded text-emerald-200">
                ↵
              </kbd>
            </button>
          )}
        </div>

        {/* Compact Options Stack */}
        <div
          className="space-y-1.5"
          role={questionItem.mode === 'multi' ? 'group' : 'radiogroup'}
        >
          {questionItem.options.map((option) => {
            const isSelected = selectedIds.includes(option.id);
            const isFocused = focusedOptionId === option.id;
            const attachedNote = notesByOption[option.id];
            const isEditingThisNote = editingNoteOptionId === option.id;

            return (
              <div
                key={option.id}
                onClick={() => handleOptionToggle(option.id)}
                className={`group relative rounded border transition-colors duration-150 cursor-pointer select-none ${
                  option.isRecommended
                    ? isSelected
                      ? 'bg-[#13221C] border-emerald-500/55'
                      : 'bg-[#131918] hover:bg-[#17211E] border-emerald-500/25'
                    : isSelected
                    ? 'bg-[#1B1F27] border-[#3B4252]'
                    : 'bg-[#16181D] hover:bg-[#1B1E25] border-[#22262F]'
                } ${isFocused ? 'ring-1 ring-emerald-500/30' : ''}`}
              >
                <div className="px-3 py-2 flex items-start justify-between gap-2.5">
                  <div className="flex items-start gap-2.5 min-w-0 flex-1">
                    {/* Selection Indicator */}
                    <div className="pt-0.5 shrink-0">
                      {questionItem.mode === 'multi' ? (
                        isSelected ? (
                          <CheckSquare className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <Square className="w-3.5 h-3.5 text-neutral-500 group-hover:text-neutral-300" />
                        )
                      ) : isSelected ? (
                        <CircleDot className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Circle className="w-3.5 h-3.5 text-neutral-500 group-hover:text-neutral-300" />
                      )}
                    </div>

                    {/* Option Copy & Recommended Tag */}
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="text-[13px] leading-snug">
                        <span
                          className={
                            isSelected
                              ? 'text-white font-medium'
                              : 'text-neutral-200 group-hover:text-white'
                          }
                        >
                          {option.label}
                        </span>
                      </div>

                      {option.isRecommended && (
                        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
                          <span className="inline-flex items-center gap-1 font-medium text-emerald-400">
                            <Sparkles className="w-2.5 h-2.5 shrink-0" />
                            <span>Recommended</span>
                          </span>
                          {option.recommendationReason && (
                            <>
                              <span
                                aria-hidden="true"
                                className="text-neutral-600"
                              >
                                ·
                              </span>
                              <span className="text-neutral-400">
                                {option.recommendationReason}
                              </span>
                            </>
                          )}
                        </div>
                      )}

                      {/* Attached User Note */}
                      {attachedNote && !isEditingThisNote && (
                        <div
                          onClick={(e) => {
                            e.stopPropagation();
                            openNoteEditorFor(option.id);
                          }}
                          className="mt-1.5 pt-1.5 border-t border-white/10 flex items-center justify-between gap-2 text-xs text-amber-300/95"
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <MessageSquarePlus className="w-3 h-3 text-amber-400 shrink-0" />
                            <span className="font-medium text-amber-300 shrink-0">
                              Note:
                            </span>
                            <span className="text-neutral-200 truncate">
                              {attachedNote}
                            </span>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openNoteEditorFor(option.id);
                              }}
                              className="px-1 py-0.5 text-[11px] text-neutral-400 hover:text-white rounded hover:bg-white/5 inline-flex items-center gap-1"
                            >
                              <Pencil className="w-2.5 h-2.5" />
                              <span>Edit</span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => removeNoteForOption(option.id, e)}
                              className="p-0.5 text-neutral-500 hover:text-rose-400 rounded hover:bg-white/5"
                              title="Remove note"
                              aria-label="Remove note"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Inline Note Editor */}
                      {isEditingThisNote && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="mt-1.5 pt-1.5 border-t border-white/10 flex items-center gap-1.5"
                        >
                          <input
                            ref={noteInputRef}
                            type="text"
                            value={noteDraft}
                            onChange={(e) => setNoteDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                saveNoteForOption(option.id);
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setEditingNoteOptionId(null);
                              }
                            }}
                            placeholder="Add note to this option (Enter to save)..."
                            className="flex-1 bg-[#0C0E12] border border-[#2E3440] focus:border-emerald-500/70 rounded px-2.5 py-1 text-xs text-white placeholder-neutral-500 outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => saveNoteForOption(option.id)}
                            className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingNoteOptionId(null)}
                            className="px-2 py-1 bg-[#1C2028] hover:bg-[#252A34] text-neutral-300 text-xs rounded transition-colors whitespace-nowrap shrink-0"
                          >
                            Esc
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Quick Note Trigger on Selected/Hovered Option */}
                  {!isEditingThisNote && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openNoteEditorFor(option.id);
                      }}
                      className={`px-1.5 py-0.5 rounded text-[11px] transition-colors inline-flex items-center gap-1 whitespace-nowrap shrink-0 ${
                        isSelected
                          ? 'text-neutral-300 hover:text-white bg-white/5 hover:bg-white/10'
                          : 'opacity-0 group-hover:opacity-100 focus:opacity-100 text-neutral-400 hover:text-neutral-200 bg-white/5'
                      }`}
                      title="Add or edit a note for this option (Shortcut: N)"
                    >
                      <span>{attachedNote ? 'Edit note' : 'Note'}</span>
                      <kbd className="px-1 text-[10px] font-mono bg-black/40 border border-white/10 rounded text-neutral-300">
                        N
                      </kbd>
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {/* "Other (type your own)" Row */}
          {(() => {
            const isOtherSelected = selectedIds.includes('other');
            const isOtherFocused = focusedOptionId === 'other';
            const otherNote = notesByOption['other'];

            return (
              <div
                onClick={() => handleOptionToggle('other')}
                className={`group rounded border transition-colors duration-150 cursor-pointer ${
                  isOtherSelected
                    ? 'bg-[#1B1F27] border-[#3B4252]'
                    : 'bg-[#16181D] hover:bg-[#1B1E25] border-[#22262F]'
                } ${isOtherFocused ? 'ring-1 ring-emerald-500/30' : ''}`}
              >
                <div className="px-3 py-2 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2.5">
                    <div className="flex items-center gap-2.5">
                      {questionItem.mode === 'multi' ? (
                        isOtherSelected ? (
                          <CheckSquare className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        ) : (
                          <Square className="w-3.5 h-3.5 text-neutral-500 group-hover:text-neutral-300 shrink-0" />
                        )
                      ) : isOtherSelected ? (
                        <CircleDot className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      ) : (
                        <Circle className="w-3.5 h-3.5 text-neutral-500 group-hover:text-neutral-300 shrink-0" />
                      )}
                      <span
                        className={`text-[13px] ${
                          isOtherSelected
                            ? 'text-white font-medium'
                            : 'text-neutral-300'
                        }`}
                      >
                        Other (type your own)
                      </span>
                    </div>

                    {otherNote && (
                      <span className="text-xs text-amber-300 font-mono">
                        Note: {otherNote}
                      </span>
                    )}
                  </div>

                  {isOtherSelected && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="pl-6 flex items-center gap-2"
                    >
                      <input
                        ref={customInputRef}
                        type="text"
                        value={customText}
                        onChange={(e) => {
                          setCustomText(e.target.value);
                          onSubmitAnswer(
                            questionItem.id,
                            selectedIds,
                            notesByOption,
                            e.target.value
                          );
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleConfirmSubmission();
                          }
                        }}
                        placeholder="Type custom response..."
                        className="flex-1 bg-[#0C0E12] border border-[#2E3440] focus:border-emerald-500/70 rounded px-2.5 py-1 text-xs text-white placeholder-neutral-500 outline-none"
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
        </div>

        {/* Compact Footer: "Press 'N' to add a note to selected option" + Cancel / Confirm */}
        <div className="mt-2.5 pt-2.5 border-t border-[#1C1F27] flex flex-wrap items-center justify-between gap-2 text-xs">
          <button
            type="button"
            onClick={() => openNoteEditorFor(targetOptionForNote)}
            className="inline-flex items-center gap-1.5 text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            <MessageSquarePlus className="w-3.5 h-3.5 text-emerald-400" />
            <span>
              Press{' '}
              <kbd className="px-1 py-0.5 text-[10px] font-mono font-semibold bg-[#0B0D11] border border-[#323846] rounded text-emerald-300">
                N
              </kbd>{' '}
              to add a note to selected option
            </span>
          </button>

          <div className="flex items-center gap-2 ml-auto">
            {questionItem.mode === 'multi' && (
              <span className="text-[11px] text-neutral-500 font-mono tabular-nums">
                {selectedIds.length} selected
              </span>
            )}

            <button
              type="button"
              onClick={() => {
                setSelectedIds(questionItem.defaultSelectedIds);
                setNotesByOption(questionItem.defaultNotes);
                setEditingNoteOptionId(null);
              }}
              className="px-2.5 py-1 text-xs text-neutral-400 hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Cancel
            </button>

            <button
              type="button"
              disabled={selectedIds.length === 0}
              onClick={handleConfirmSubmission}
              className="px-2.5 py-1 text-xs font-medium bg-neutral-100 hover:bg-white text-neutral-950 disabled:opacity-40 rounded transition-colors inline-flex items-center gap-1 whitespace-nowrap shrink-0"
            >
              <span>Confirm</span>
              <CornerDownLeft className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      {/* Bottom Elapsed Session Time matching Screenshot 2 ("12m 50s") */}
      <div className="mt-1.5 px-0.5 text-[11px] text-neutral-500 font-mono tabular-nums">
        {elapsedTime}
      </div>
    </div>
  );
};
