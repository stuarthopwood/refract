import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Check,
  Sparkles,
  MessageSquarePlus,
} from 'lucide-react';
import {
  AskQuestionItem,
  AnsweredQuestionRecord,
} from '../data/ompQuestions';

interface SessionQACardProps {
  questions: AskQuestionItem[];
  answeredRecords: Record<string, AnsweredQuestionRecord>;
  defaultCollapsed?: boolean;
}

export const SessionQACard: React.FC<SessionQACardProps> = ({
  questions,
  answeredRecords,
  defaultCollapsed = false,
}) => {
  const [isCollapsed, setIsCollapsed] = useState<boolean>(defaultCollapsed);
  const [peekQuestionId, setPeekQuestionId] = useState<string | null>(null);

  const getQuestionAnswerData = (q: AskQuestionItem) => {
    const rec = answeredRecords[q.id];
    const selectedIds = rec?.selectedOptionIds ?? q.defaultSelectedIds;
    const notes = rec?.notesByOptionId ?? q.defaultNotes;
    const customText = rec?.customText ?? q.defaultCustomText ?? '';

    const selectedOptions = q.options.filter((o) => selectedIds.includes(o.id));
    const includesOther = selectedIds.includes('other');

    const fullLabels: string[] = selectedOptions.map((o) => o.label);
    if (includesOther) {
      fullLabels.push(
        customText ? `Custom: "${customText}"` : 'Other (custom response)'
      );
    }

    const shortSummaries: string[] = selectedOptions.map((o) => o.shortSummary);
    if (includesOther) {
      shortSummaries.push(customText ? customText : 'Custom response');
    }

    const recIds = q.options.filter((o) => o.isRecommended).map((o) => o.id);
    const matchedRecommended =
      recIds.length > 0 && recIds.every((id) => selectedIds.includes(id));

    const noteEntries = Object.entries(notes).map(([optId, noteText]) => {
      const opt = q.options.find((o) => o.id === optId);
      return {
        optionId: optId,
        optionShort: opt?.shortSummary ?? 'Custom',
        noteText,
      };
    });

    return {
      selectedIds,
      selectedOptions,
      includesOther,
      fullLabels,
      shortSummaries,
      matchedRecommended,
      noteEntries,
    };
  };

  return (
    <div className="w-full rounded-md bg-[#101216] border border-[#22252E] overflow-hidden text-[13px]">
      {/* Compact Header Bar */}
      <div
        onClick={() => setIsCollapsed((prev) => !prev)}
        className="px-3.5 py-2 bg-[#13151B] border-b border-[#1D2028] flex items-center justify-between gap-3 cursor-pointer select-none hover:bg-[#161920] transition-colors"
      >
        <div className="flex items-center gap-2 text-xs">
          <Check className="w-3.5 h-3.5 text-emerald-400 stroke-[2.5] shrink-0" />
          <span className="font-medium text-neutral-200">
            Questions from the agent
          </span>
          <span aria-hidden="true" className="text-neutral-600">
            ·
          </span>
          <span className="text-neutral-400 font-mono tabular-nums">
            {questions.length} answered
          </span>
        </div>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsCollapsed((prev) => !prev);
          }}
          className="px-2 py-0.5 rounded text-[11px] font-medium text-neutral-400 hover:text-neutral-200 hover:bg-white/5 transition-colors inline-flex items-center gap-1 whitespace-nowrap shrink-0"
        >
          <span>{isCollapsed ? 'Expand' : 'Collapse'}</span>
          {isCollapsed ? (
            <ChevronDown className="w-3 h-3 text-neutral-400" />
          ) : (
            <ChevronUp className="w-3 h-3 text-neutral-400" />
          )}
        </button>
      </div>

      {/* COLLAPSED VIEW: Compact Scannable Digest of Questions & Chosen Answers */}
      {isCollapsed ? (
        <div className="divide-y divide-[#181B22]">
          {questions.map((q) => {
            const {
              shortSummaries,
              fullLabels,
              matchedRecommended,
              noteEntries,
            } = getQuestionAnswerData(q);
            const isPeeking = peekQuestionId === q.id;

            return (
              <div
                key={q.id}
                onClick={() =>
                  setPeekQuestionId((prev) => (prev === q.id ? null : q.id))
                }
                className="px-3.5 py-1.5 hover:bg-[#14171E] transition-colors cursor-pointer"
              >
                <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
                  {/* Question */}
                  <span className="font-medium text-neutral-300 truncate sm:max-w-[44%] shrink-0">
                    {q.question}
                  </span>

                  {/* Concise Answer + Note + Recommended mark */}
                  <div className="flex items-baseline justify-end gap-2 min-w-0 flex-1 sm:text-right">
                    <span className="text-neutral-400 truncate">
                      <span className="text-neutral-600 mr-1" aria-hidden="true">
                        →
                      </span>
                      <span className="text-neutral-200">
                        {shortSummaries.join(' + ')}
                      </span>
                      {noteEntries.length > 0 && (
                        <span className="ml-1.5 text-amber-300/90">
                          ({noteEntries[0].noteText})
                        </span>
                      )}
                    </span>

                    {matchedRecommended && (
                      <span
                        title="Recommended option selected"
                        className="shrink-0 translate-y-0.5"
                      >
                        <Sparkles className="w-3 h-3 text-emerald-400" />
                      </span>
                    )}
                  </div>
                </div>

                {/* Single-row inline peek on click */}
                {isPeeking && (
                  <div className="mt-1.5 pt-1.5 border-t border-[#1D2028] text-xs text-neutral-300 space-y-1">
                    {fullLabels.map((lbl, i) => (
                      <p key={i} className="leading-snug text-neutral-300">
                        {fullLabels.length > 1 ? `• ${lbl}` : lbl}
                      </p>
                    ))}
                    {noteEntries.map((ne) => (
                      <p
                        key={ne.optionId}
                        className="text-amber-300/90 font-mono text-[11px]"
                      >
                        Note: {ne.noteText}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        /* EXPANDED VIEW: Compact Full Q&A Transcript matching Screenshot 1 */
        <div className="px-3.5 py-3 space-y-3">
          {questions.map((q) => {
            const {
              fullLabels,
              matchedRecommended,
              noteEntries,
              selectedIds,
            } = getQuestionAnswerData(q);

            return (
              <div key={q.id} className="space-y-0.5">
                {/* Question Header */}
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-[13px] font-semibold text-neutral-100 leading-snug">
                    {q.question}
                  </h3>

                  <div className="flex items-center gap-2 text-[11px] shrink-0">
                    {matchedRecommended && (
                      <span className="text-emerald-400/90 inline-flex items-center gap-1">
                        <Sparkles className="w-2.5 h-2.5" />
                        <span>Recommended</span>
                      </span>
                    )}
                    {q.mode === 'multi' && selectedIds.length > 1 && (
                      <span className="text-neutral-500 font-mono tabular-nums">
                        {selectedIds.length} selected
                      </span>
                    )}
                  </div>
                </div>

                {/* User's Selected Answer(s) */}
                <div className="space-y-1">
                  {fullLabels.length === 1 ? (
                    <p className="text-[13px] text-neutral-300 leading-normal">
                      {fullLabels[0]}
                    </p>
                  ) : (
                    <ul className="space-y-0.5 text-[13px] text-neutral-300 leading-normal">
                      {fullLabels.map((lbl, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <Check className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />
                          <span>{lbl}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Attached Option Notes (Added via 'N' shortcut) */}
                  {noteEntries.map((ne) => (
                    <div
                      key={ne.optionId}
                      className="flex items-baseline gap-1.5 text-xs text-amber-300/95 pt-0.5"
                    >
                      <MessageSquarePlus className="w-3 h-3 text-amber-400 shrink-0 translate-y-0.5" />
                      <span>
                        <strong className="font-medium text-amber-300">
                          Note:
                        </strong>{' '}
                        <span className="text-neutral-300">{ne.noteText}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
