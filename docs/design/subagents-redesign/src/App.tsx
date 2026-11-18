/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { SCENARIOS } from './data/chatScenarios';
import { SubagentsChatCard } from './components/SubagentsChatCard';
import {
  ChevronRight,
  FileText,
  Brain,
  Loader2,
  ListTodo,
  FileDiff,
  Gauge,
  Users,
  Eye,
  Clock,
  Sliders,
  Zap,
  Sparkles,
  GitBranch,
  Paperclip,
  ArrowUp,
  Square,
  Download
} from 'lucide-react';

export default function App() {
  const [activeScenarioId, setActiveScenarioId] = useState<'port-757' | 'pr-1788'>('port-757');
  const [cardView, setCardView] = useState<'redesigned' | 'original'>('redesigned');

  const scenario = SCENARIOS[activeScenarioId];

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-200 flex flex-col font-sans selection:bg-emerald-500/30 selection:text-emerald-200">
      {/* =====================================================================
          SIMPLE TOP DEMO SWITCHER BAR
          Lets you switch between Screenshot 1 (7 stages, 13 agents) and Screenshot 2 (2 stages, 2 agents)
         ===================================================================== */}
      <header className="sticky top-0 z-30 bg-[#111115]/95 backdrop-blur border-b border-zinc-800/80 px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
            Chat Card UX Redesign
          </span>
          <a
            href="/subagents-chat-card-redesign.zip"
            download="subagents-chat-card-redesign.zip"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs transition-colors shadow-xs"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download Code (.zip)</span>
          </a>
        </div>

        {/* Scenario Switcher */}
        <div className="flex items-center gap-1.5 bg-zinc-900 p-1 rounded-lg border border-zinc-800 text-xs">
          <button
            onClick={() => setActiveScenarioId('port-757')}
            className={`px-3 py-1 rounded-md transition-colors cursor-pointer ${
              activeScenarioId === 'port-757'
                ? 'bg-zinc-800 text-zinc-100 font-medium shadow-2xs'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Screenshot 1: PORT-757 (7 stages, 13 agents)
          </button>
          <button
            onClick={() => setActiveScenarioId('pr-1788')}
            className={`px-3 py-1 rounded-md transition-colors cursor-pointer ${
              activeScenarioId === 'pr-1788'
                ? 'bg-zinc-800 text-zinc-100 font-medium shadow-2xs'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Screenshot 2: #1788 (2 stages, "How is it hanging?")
          </button>
        </div>
      </header>

      {/* =====================================================================
          AUTHENTIC AGENT CHAT STREAM (Matching Screenshot 2's exact UI)
         ===================================================================== */}
      <main className="flex-1 w-full max-w-[920px] mx-auto px-4 sm:px-6 pt-5 pb-10 flex flex-col justify-between">
        <div className="space-y-4">
          {/* Top collapsed tool/advisory rows (just like Screenshot 2) */}
          <div className="space-y-1.5 text-xs text-zinc-400">
            <div className="flex items-center justify-between py-1 px-2 rounded hover:bg-zinc-900/60 cursor-pointer transition-colors">
              <div className="flex items-center gap-2 truncate">
                <FileText className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                <span className="text-indigo-400 font-medium shrink-0">
                  Main agent to {scenario.footerRunningAgent}
                </span>
                <span className="text-zinc-400 truncate">
                  {activeScenarioId === 'pr-1788'
                    ? 'From the director, one more fix for this PR (verified in the code). In src/renderer/features/sessions/DeleteDial...'
                    : 'Run app-wide quality gate across fdb.patient.activation, remediate findings, and verify 320px WCAG reflow...'}
                </span>
              </div>
              <ChevronRight className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
            </div>

            <div className="flex items-center justify-between py-1 px-2 rounded hover:bg-zinc-900/60 cursor-pointer transition-colors">
              <div className="flex items-center gap-2 truncate">
                <FileText className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="text-zinc-300 font-medium shrink-0">Note</span>
                <span className="text-zinc-400 truncate">
                  {activeScenarioId === 'pr-1788'
                    ? "The advisory is right, and I've sent the fix to Verify1788."
                    : 'Quality gate agents spawned in parallel; routing accessibility and SQL fixes to dedicated sub-agents.'}
                </span>
              </div>
              <ChevronRight className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
            </div>
          </div>

          {/* Agent Context Prose before the Card */}
          <div className="text-[13.5px] text-zinc-200 leading-relaxed space-y-2.5 pt-1">
            <p>{scenario.preCardText}</p>
            {scenario.preCardBullet && (
              <div className="space-y-1.5">
                <div className="text-zinc-400 text-xs">Side notes:</div>
                <div className="flex items-start gap-2 text-xs text-zinc-300">
                  <span className="text-amber-500 mt-0.5">•</span>
                  <span>{scenario.preCardBullet}</span>
                </div>
              </div>
            )}
          </div>

          {/* =================================================================
              THE SUBAGENTS CHAT CARD (Redesigned vs Original toggle inside)
             ================================================================= */}
          <div className="my-4">
            <SubagentsChatCard
              key={scenario.id}
              scenario={scenario}
              cardView={cardView}
              setCardView={setCardView}
            />
          </div>

          {/* Timestamp Divider & User Follow-up Question (from Screenshot 2) */}
          <div className="relative flex items-center justify-center my-6">
            <div className="border-t border-zinc-800/80 w-full" />
            <span className="bg-[#09090b] px-3 text-[11px] text-zinc-500 whitespace-nowrap">
              11 Nov 2026, 11:57
            </span>
            <div className="border-t border-zinc-800/80 w-full" />
          </div>

          {/* User Message Bubble on the Right */}
          <div className="flex items-end justify-end gap-2.5">
            <div className="bg-[#18181c] border border-zinc-800/90 rounded-xl px-4 py-2.5 max-w-md text-right">
              <div className="text-[11px] font-semibold text-zinc-400 mb-0.5">
                Stuart Hopwood
              </div>
              <div className="text-[13.5px] text-zinc-100">
                {scenario.userQuestion}
              </div>
            </div>
            <div className="w-7 h-7 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-xs font-bold text-zinc-300 shrink-0">
              SH
            </div>
          </div>

          {/* Agent Thought & Explanation (Note how the redesigned card above ALREADY answered this!) */}
          <div className="space-y-1 text-xs text-zinc-400 pt-2">
            <div className="flex items-center justify-between py-0.5 px-1">
              <div className="flex items-center gap-2">
                <FileText className="w-3.5 h-3.5 text-zinc-500" />
                <span>Read ×2</span>
              </div>
              <span className="text-[11px] text-zinc-500 font-mono">1ms &gt;</span>
            </div>
            <div className="flex items-center justify-between py-0.5 px-1">
              <div className="flex items-center gap-2">
                <Brain className="w-3.5 h-3.5 text-zinc-500" />
                <span>Thought for 7s</span>
              </div>
              <span className="text-[11px] text-zinc-500 font-mono">&gt;</span>
            </div>
          </div>

          <div className="text-[13.5px] text-zinc-200 leading-relaxed space-y-2.5 pt-1">
            <p>{scenario.agentReplyIntro}</p>
            {scenario.agentReplyBullets && (
              <ul className="space-y-1.5 pl-1">
                {scenario.agentReplyBullets.map((b, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13px] text-zinc-300">
                    <span className="text-amber-500 mt-0.5">•</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            )}
            {scenario.agentReplyFooter && (
              <p className="text-[13px] text-zinc-300 pt-1">
                {scenario.agentReplyFooter}
              </p>
            )}
          </div>
        </div>

        {/* =====================================================================
            AUTHENTIC HARNESS BOTTOM STATUS & INPUT BAR (Matches Screenshot 2)
           ===================================================================== */}
        <div className="mt-8 pt-3 border-t border-zinc-800/80 space-y-2.5">
          {/* Active Subagent Status Line */}
          <div className="flex items-center justify-between text-xs px-1">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 text-emerald-400 animate-spin" />
                <span className="text-zinc-400">Running</span>
                <span className="text-zinc-100 font-medium">
                  {scenario.footerRunningAgent}
                </span>
              </div>
              <div className="flex items-center gap-2 text-amber-500 text-[11px]">
                <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" />
                <span>{scenario.footerWaitLabel}</span>
              </div>
            </div>

            <div className="flex items-center gap-3 text-xs text-zinc-400 font-mono">
              <span>{scenario.footerRunningTime}</span>
              <span className="text-zinc-300 cursor-pointer hover:underline">
                Show
              </span>
            </div>
          </div>

          {/* Telemetry Strip */}
          <div className="flex flex-wrap items-center gap-4 text-[11px] text-zinc-400 py-1.5 px-1 border-t border-zinc-900">
            <span className="flex items-center gap-1.5">
              <ListTodo className="w-3.5 h-3.5 text-zinc-500" />
              <span>Todo 7/13</span>
            </span>
            <span className="flex items-center gap-1.5">
              <FileDiff className="w-3.5 h-3.5 text-zinc-500" />
              <span>10 files changed</span>
              <span className="text-emerald-400 font-mono">+186</span>
              <span className="text-red-400 font-mono">-21</span>
            </span>
            <span className="flex items-center gap-1.5">
              <Gauge className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-emerald-400 font-mono underline">
                148.7k/328k (45%)
              </span>
            </span>
            <span>1,021 credits</span>
            <span className="flex items-center gap-1.5 text-zinc-200">
              <Users className="w-3.5 h-3.5 text-zinc-400" />
              <span>1 subagent running</span>
            </span>
            <span className="flex items-center gap-1.5">
              <Eye className="w-3.5 h-3.5 text-zinc-500" />
              <span>Advisor</span>
            </span>
            <span className="flex items-center gap-1.5 font-mono">
              <Clock className="w-3.5 h-3.5 text-zinc-500" />
              <span>12:20</span>
            </span>
          </div>

          {/* Message Input Box */}
          <div className="rounded-lg border border-amber-900/40 bg-[#111114] p-3 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-500">
                Message the agent &nbsp; <code className="text-zinc-400">/</code> for commands &nbsp; <code className="text-zinc-400">T</code> Markdown supported
              </span>
              <div className="flex items-center gap-1.5">
                <button className="p-1 rounded bg-zinc-800 text-zinc-300">
                  <Square className="w-3 h-3 fill-current" />
                </button>
                <button className="p-1 rounded-full bg-amber-600/80 text-white">
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-[11px] text-zinc-400 pt-1">
              <span className="flex items-center gap-1">
                <Sliders className="w-3 h-3" /> Interactive
              </span>
              <span className="flex items-center gap-1">
                <Zap className="w-3 h-3" /> Auto
              </span>
              <span className="flex items-center gap-1">
                <Sparkles className="w-3 h-3" /> temporary · Opus 5.5
              </span>
              <span>Medium</span>
              <span className="flex items-center gap-1">
                <GitBranch className="w-3 h-3" /> daring-plover
              </span>
              <Paperclip className="w-3 h-3" />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
