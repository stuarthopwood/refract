import React, { useState } from 'react';
import { ChatScenario, StageItem, SubAgentItem } from '../data/chatScenarios';
import {
  CheckCircle2,
  Loader2,
  ChevronDown,
  ChevronRight,
  GitFork,
  ArrowRight,
  FileCode2,
  Target,
  Activity,
  CornerDownRight
} from 'lucide-react';

interface SubagentsChatCardProps {
  scenario: ChatScenario;
  cardView: 'redesigned' | 'original';
  setCardView: (v: 'redesigned' | 'original') => void;
}

export const SubagentsChatCard: React.FC<SubagentsChatCardProps> = ({
  scenario,
  cardView,
  setCardView,
}) => {
  const [isCardCollapsed, setIsCardCollapsed] = useState(false);
  // By default, expand parallel stages and the currently running stage so the user sees the flow immediately
  const [expandedStages, setExpandedStages] = useState<Record<string, boolean>>({
    s2: true,
    s3: false,
    s7: true,
    's1-1788': true,
    's2-1788': true,
  });

  const toggleStage = (id: string) => {
    setExpandedStages((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const completedStagesCount = scenario.stages.filter(
    (s) => s.status === 'completed'
  ).length;

  return (
    <div className="w-full rounded-lg border border-zinc-800/90 bg-[#0d0d10] text-zinc-200 shadow-lg overflow-hidden transition-all">
      {/* =====================================================================
          1. TOP HEADER BAR (Matches the exact placement & style of the app)
         ===================================================================== */}
      <div className="px-3.5 py-2.5 flex items-center justify-between gap-3 border-b border-zinc-800/80 bg-[#121216]">
        <div className="flex items-center gap-2.5 min-w-0">
          {/* Spinning emerald arc (matches screenshot) */}
          <Loader2 className="w-4 h-4 text-emerald-400 animate-spin shrink-0" />
          <span className="text-[13px] font-semibold text-zinc-100">
            Subagents
          </span>
          <span className="text-[13px] text-zinc-400 truncate">
            {scenario.headerStats}
          </span>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {/* Quick switch to compare Redesigned vs Original directly in context */}
          <div className="flex items-center bg-zinc-900 p-0.5 rounded border border-zinc-800 text-[11px]">
            <button
              onClick={() => setCardView('redesigned')}
              className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                cardView === 'redesigned'
                  ? 'bg-emerald-500/20 text-emerald-300 font-medium border border-emerald-500/30'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Redesigned Card
            </button>
            <button
              onClick={() => setCardView('original')}
              className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                cardView === 'original'
                  ? 'bg-zinc-800 text-zinc-200 font-medium'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              Original Screenshot
            </button>
          </div>

          <span className="text-xs text-zinc-400 font-mono tabular-nums">
            Running · {scenario.totalDuration}
          </span>

          <button
            onClick={() => setIsCardCollapsed(!isCardCollapsed)}
            className="p-1 text-zinc-400 hover:text-zinc-200 rounded hover:bg-zinc-800/60 cursor-pointer"
            title={isCardCollapsed ? 'Expand card' : 'Collapse card'}
          >
            <ChevronDown
              className={`w-3.5 h-3.5 transition-transform ${
                isCardCollapsed ? '-rotate-90' : ''
              }`}
            />
          </button>
        </div>
      </div>

      {!isCardCollapsed && cardView === 'redesigned' && (
        <div>
          {/* =================================================================
              2. OVERALL GOAL & PROGRESS STRIP
                 Tells the user WHY these sub-agents exist & deduplicates repo path
             ================================================================= */}
          <div className="px-3.5 py-2.5 bg-zinc-900/50 border-b border-zinc-800/60 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-start sm:items-center gap-2 min-w-0">
              <Target className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5 sm:mt-0" />
              <div className="text-xs text-zinc-300 truncate">
                <span className="text-zinc-500 font-medium mr-1.5">Goal:</span>
                <span className="font-medium text-zinc-100">
                  {scenario.overallGoal}
                </span>
              </div>
            </div>

            {/* Segmented Stage Progress Pill */}
            <div className="flex items-center gap-2 shrink-0">
              <div className="flex items-center gap-1">
                {scenario.stages.map((st) => (
                  <div
                    key={st.id}
                    className={`h-1.5 rounded-full transition-all ${
                      st.status === 'running'
                        ? 'w-5 bg-emerald-400 animate-pulse'
                        : 'w-2.5 bg-emerald-500/60'
                    }`}
                    title={`Stage ${st.number}: ${st.cleanTitle}`}
                  />
                ))}
              </div>
              <span className="text-[11px] font-mono text-zinc-400 tabular-nums">
                {completedStagesCount}/{scenario.stages.length} done
              </span>
            </div>
          </div>

          {/* =================================================================
              3. SIMPLIFIED STAGE & SUB-AGENT EXECUTION FLOW
                 Connects each stage & sub-agent to what it achieved or is doing
             ================================================================= */}
          <div className="p-3.5 space-y-2">
            {scenario.stages.map((stage, idx) => {
              const isRunning = stage.status === 'running';
              const isExpanded = !!expandedStages[stage.id];
              const isLast = idx === scenario.stages.length - 1;
              const isSingleAgent = stage.agents.length === 1;
              const singleAgent = isSingleAgent ? stage.agents[0] : null;

              return (
                <div key={stage.id} className="relative pl-5">
                  {/* Vertical Execution Spine Line connecting stages */}
                  {!isLast && (
                    <div className="absolute left-[7px] top-4 bottom-[-10px] w-[1.5px] bg-zinc-800" />
                  )}

                  {/* Stage Status Node on the Spine */}
                  <div className="absolute left-0 top-1.5 flex items-center justify-center">
                    {isRunning ? (
                      <Loader2 className="w-4 h-4 text-emerald-400 animate-spin bg-[#0d0d10]" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500 bg-[#0d0d10]" />
                    )}
                  </div>

                  {/* STAGE ROW / CARD */}
                  <div
                    className={`rounded-md border transition-colors ${
                      isRunning
                        ? 'border-emerald-500/35 bg-emerald-950/10'
                        : 'border-zinc-800/70 bg-zinc-900/30 hover:bg-zinc-900/60'
                    }`}
                  >
                    {/* Clickable Stage Header */}
                    <div
                      onClick={() => toggleStage(stage.id)}
                      className="px-3 py-2 flex items-start sm:items-center justify-between gap-3 cursor-pointer select-none"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 shrink-0">
                          {isExpanded ? (
                            <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />
                          )}
                          <span
                            className={`text-xs font-mono font-medium ${
                              isRunning ? 'text-emerald-300' : 'text-emerald-400/90'
                            }`}
                          >
                            Stage {stage.number}
                          </span>
                          <span className="text-zinc-600">·</span>
                          <span className="text-xs font-medium text-zinc-100">
                            {stage.cleanTitle}
                          </span>
                        </div>

                        {/* If single-agent stage, show the agent badge right inline */}
                        {isSingleAgent && singleAgent && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-mono text-zinc-400 bg-zinc-900 px-1.5 py-0.5 rounded border border-zinc-800 w-fit">
                            <span className="text-emerald-400/90">
                              {singleAgent.name}
                            </span>
                            {singleAgent.triggeredBy && (
                              <span className="text-zinc-500 text-[10px]">
                                (from {singleAgent.triggeredBy})
                              </span>
                            )}
                          </span>
                        )}

                        {/* If parallel multi-agent stage, show clear parallel badge */}
                        {stage.isParallel && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-mono text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 w-fit">
                            <GitFork className="w-3 h-3 rotate-90" />
                            <span>{stage.agents.length} parallel</span>
                          </span>
                        )}
                      </div>

                      {/* Stage Duration */}
                      <span
                        className={`text-xs font-mono tabular-nums shrink-0 ${
                          isRunning ? 'text-emerald-400 font-medium' : 'text-zinc-400'
                        }`}
                      >
                        {stage.duration}
                      </span>
                    </div>

                    {/* Stage Outcome Summary (Always visible so user understands what happened even when collapsed!) */}
                    <div className="px-3 pb-2 pl-8 text-xs text-zinc-400 flex items-center justify-between gap-2">
                      <span>{stage.outcomeSummary}</span>
                    </div>

                    {/* EXPANDED SUB-AGENTS / LIVE PROGRESS */}
                    {isExpanded && (
                      <div className="px-3 pb-2.5 pt-2 pl-8 border-t border-zinc-800/60 bg-black/20 space-y-2">
                        {/* Parallel or Single Sub-Agents Breakdown */}
                        <div
                          className={
                            stage.isParallel
                              ? 'grid grid-cols-1 sm:grid-cols-2 gap-1.5'
                              : 'space-y-1.5'
                          }
                        >
                          {stage.agents.map((agent) => (
                            <div
                              key={agent.id}
                              className={`p-2 rounded border text-xs ${
                                agent.status === 'running'
                                  ? 'bg-zinc-900/90 border-emerald-500/30'
                                  : 'bg-zinc-900/50 border-zinc-800/80'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2 mb-1">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  {agent.status === 'running' ? (
                                    <Loader2 className="w-3 h-3 text-emerald-400 animate-spin shrink-0" />
                                  ) : (
                                    <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" />
                                  )}
                                  <span className="font-mono font-semibold text-zinc-200 truncate">
                                    {agent.name}
                                  </span>
                                  <span className="text-[11px] text-zinc-400 truncate">
                                    · {agent.role}
                                  </span>
                                </div>
                                <span className="font-mono text-[11px] text-zinc-400 tabular-nums shrink-0">
                                  {agent.duration}
                                </span>
                              </div>

                              {/* What this specific sub-agent did / found */}
                              <p className="text-[11px] text-zinc-300 leading-relaxed pl-4">
                                {agent.whatItDid}
                              </p>

                              {/* Causal link or modified files */}
                              {(agent.triggeredBy ||
                                (agent.filesChanged &&
                                  agent.filesChanged.length > 0)) && (
                                <div className="mt-1.5 pl-4 flex flex-wrap items-center gap-2 text-[10px] font-mono text-zinc-500">
                                  {agent.triggeredBy && (
                                    <span className="flex items-center gap-0.5 text-zinc-400">
                                      <CornerDownRight className="w-2.5 h-2.5 text-emerald-500" />
                                      <span>fixes issue from {agent.triggeredBy}</span>
                                    </span>
                                  )}
                                  {agent.filesChanged?.map((file) => (
                                    <span
                                      key={file}
                                      className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded bg-zinc-950 border border-zinc-800 text-zinc-400"
                                    >
                                      <FileCode2 className="w-2.5 h-2.5 text-zinc-500" />
                                      {file}
                                    </span>
                                  ))}
                                </div>
                              )}

                              {/* LIVE SUB-STEP PROGRESS (For Running Sub-Agents — prevents "How is it hanging?") */}
                              {agent.status === 'running' && (
                                <div className="mt-2.5 pt-2 border-t border-zinc-800/80 pl-4 space-y-1.5">
                                  {agent.liveDetail && (
                                    <div className="flex items-center gap-1.5 text-[11px] text-emerald-300 font-medium">
                                      <Activity className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                      <span>{agent.liveDetail}</span>
                                    </div>
                                  )}

                                  {agent.subSteps && (
                                    <div className="space-y-1 pt-0.5">
                                      {agent.subSteps.map((step, sIdx) => (
                                        <div
                                          key={sIdx}
                                          className="flex items-center gap-2 text-[11px] font-mono"
                                        >
                                          {step.status === 'done' ? (
                                            <span className="text-emerald-500">✓</span>
                                          ) : step.status === 'running' ? (
                                            <Loader2 className="w-3 h-3 text-emerald-400 animate-spin shrink-0" />
                                          ) : (
                                            <span className="text-zinc-600">○</span>
                                          )}
                                          <span
                                            className={
                                              step.status === 'running'
                                                ? 'text-zinc-100 font-medium'
                                                : 'text-zinc-400'
                                            }
                                          >
                                            {step.label}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* =====================================================================
          ORIGINAL SCREENSHOT TREE VIEW (For instant 1:1 comparison)
         ===================================================================== */}
      {!isCardCollapsed && cardView === 'original' && (
        <div className="p-3.5 font-sans text-[13px] space-y-2.5 bg-[#0a0a0c]">
          {scenario.stages.map((stage) => (
            <div key={stage.id} className="space-y-1">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2 min-w-0">
                  {stage.status === 'running' ? (
                    <Loader2 className="w-3.5 h-3.5 text-emerald-400 animate-spin shrink-0" />
                  ) : (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                  )}
                  <span
                    className={`truncate ${
                      stage.status === 'running'
                        ? 'text-zinc-200'
                        : 'text-emerald-400'
                    }`}
                  >
                    {stage.rawLabel}
                  </span>
                </div>
                {stage.status === 'completed' && (
                  <span className="text-xs text-zinc-400 font-mono tabular-nums shrink-0">
                    {stage.duration}
                  </span>
                )}
              </div>

              <div className="pl-5 space-y-1">
                {stage.agents.map((ag) => (
                  <div key={ag.id} className="flex items-center gap-2">
                    {ag.status === 'running' ? (
                      <Loader2 className="w-3.5 h-3.5 text-emerald-400 animate-spin shrink-0" />
                    ) : (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    )}
                    <span
                      className={
                        ag.status === 'running'
                          ? 'text-zinc-200'
                          : 'text-emerald-400'
                      }
                    >
                      {ag.name}
                    </span>
                    <span className="text-xs text-zinc-400 font-mono tabular-nums">
                      {ag.status === 'running' ? 'Running' : ag.duration}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
