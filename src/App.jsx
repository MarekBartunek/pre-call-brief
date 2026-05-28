import { useState, useRef } from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MODEL   = 'claude-sonnet-4-6'
const API_URL = 'https://api.anthropic.com/v1/messages'

const LOADING_STEPS = [
  { label: 'Initialising research agent',  detail: 'Preparing your intelligence pipeline…'       },
  { label: 'Searching the web',            detail: 'Finding recent news, funding, and signals…'  },
  { label: 'Reading their online presence',detail: 'Website, LinkedIn, press — the full picture…'},
  { label: 'Identifying pain points',      detail: 'Mapping what they likely struggle with…'     },
  { label: 'Crafting your brief',          detail: 'Writing questions and call strategy…'        },
]

// ─────────────────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────────────────

const buildSystemPrompt = (company, url, context) => `
You are an elite sales intelligence analyst. Your job is to research a company before a sales call and produce a tight, actionable briefing document.

Use the web_search tool to find real, up-to-date information about the company. Search for:
- Their website and LinkedIn
- Recent news, funding rounds, product launches, or leadership changes
- Their main product or service and who they sell to
- Any public pain points: hiring freezes, complaints, slow growth, competition pressure
- Reviews on G2, Glassdoor, or similar

OUTPUT FORMAT — MANDATORY:
Your entire response must be a single raw JSON object. Start with { and end with }. No markdown. No code fences. No explanation. Just the JSON.

The JSON must have exactly these keys:
{
  "company_name": "string — the canonical name of the company",
  "tagline": "string — one sentence describing what they do in plain English",
  "overview": "string — 2-3 sentences: what they do, who their customers are, rough size/stage",
  "recent_signals": ["string", "string", "string"] — 3-5 bullet strings of recent news or notable events (funding, new hires, product launches, pivots, layoffs, press). If none found, make a note of that.,
  "pain_points": ["string", "string", "string"] — 3-5 likely pain points based on their industry, size, and any public signals. Be specific and realistic.,
  "call_questions": ["string", "string", "string", "string", "string"] — 5 sharp, open-ended questions to ask on the call. Each should tie to a specific pain point or signal. Avoid generic questions.,
  "red_flags": ["string"] — 1-3 things to watch out for (e.g. recent leadership churn, shrinking headcount, heavy competitor pressure, niche market). If none, return an empty array.,
  "sources_searched": ["string"] — list of domains or search queries used
}

Company to research: ${company}
${url ? `Their website/LinkedIn: ${url}` : ''}
${context ? `Extra context from the user: ${context}` : ''}
`.trim()

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function extractJSON(text) {
  // Strategy 1: response is a clean JSON object
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed) } catch { /* fall through */ }
  }

  // Strategy 2: JSON object somewhere inside the response
  const m = trimmed.match(/\{[\s\S]*\}/)
  if (m) {
    try { return JSON.parse(m[0]) } catch { /* fall through */ }
  }

  // Strategy 3: JSON inside a markdown code block
  const fence = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fence && fence[1].trim().startsWith('{')) {
    try { return JSON.parse(fence[1].trim()) } catch { /* fall through */ }
  }

  throw new Error('Could not parse the brief from the response. Try again.')
}

async function runAgent(apiKey, company, url, context, onStep) {
  const tools     = [{ type: 'web_search_20250305', name: 'web_search' }]
  const sysPrompt = buildSystemPrompt(company, url, context)

  // Seed the conversation
  let messages = [{ role: 'user', content: 'Research the company and return the JSON brief.' }]

  let stepIdx = 0
  onStep(stepIdx)

  for (let turn = 0; turn < 15; turn++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Required for direct browser-to-Anthropic calls (bypasses CORS restriction)
        'anthropic-dangerous-direct-browser-access': 'true',
        // Required to unlock the built-in web_search tool
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: 3000,
        system:     sysPrompt,
        tools,
        messages,
      }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.message || `API error ${res.status}`)
    }

    const data = await res.json()

    if (data.stop_reason === 'end_turn') {
      const textBlock = data.content.find(b => b.type === 'text')
      if (!textBlock) throw new Error('No text in final response')
      return extractJSON(textBlock.text)
    }

    if (data.stop_reason === 'tool_use') {
      // Claude ran a web search — advance loading indicator
      stepIdx = Math.min(stepIdx + 1, LOADING_STEPS.length - 1)
      onStep(stepIdx)

      // Rebuild messages: add Claude's response, then acknowledge the tool result.
      // Anthropic's servers already executed the search — content can be empty string.
      //
      // IMPORTANT: strip thinking blocks and large search result content from the
      // assistant message before storing it. We only need the tool_use blocks in
      // history — keeping everything causes the input token count to explode across
      // turns and hit rate limits.
      const toolUseBlocks = data.content.filter(b => b.type === 'tool_use')

      messages = [
        ...messages,
        { role: 'assistant', content: toolUseBlocks },
        {
          role: 'user',
          content: toolUseBlocks.map(tu => ({
            type:        'tool_result',
            tool_use_id: tu.id,
            content:     '',
          })),
        },
      ]
      continue
    }

    // Unexpected stop reason
    break
  }

  throw new Error('Agent did not return a result within the turn limit. Try again.')
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function SectionLabel({ children }) {
  return (
    <p className="text-[10px] font-semibold tracking-[0.15em] uppercase text-indigo-400 mb-2">
      {children}
    </p>
  )
}

function BulletList({ items, color = 'text-slate-300' }) {
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5 text-sm leading-relaxed">
          <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-indigo-500 flex-shrink-0" />
          <span className={color}>{item}</span>
        </li>
      ))}
    </ul>
  )
}

function RedFlagList({ items }) {
  if (!items || items.length === 0) {
    return <p className="text-sm text-slate-500 italic">No major red flags identified.</p>
  }
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5 text-sm leading-relaxed">
          <span className="mt-0.5 text-amber-400 flex-shrink-0">⚠</span>
          <span className="text-amber-200/80">{item}</span>
        </li>
      ))}
    </ul>
  )
}

function QuestionList({ items }) {
  return (
    <ol className="space-y-3">
      {items.map((q, i) => (
        <li key={i} className="flex gap-3 text-sm leading-relaxed">
          <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-600/40 text-indigo-300 text-xs flex items-center justify-center font-semibold">
            {i + 1}
          </span>
          <span className="text-slate-200">{q}</span>
        </li>
      ))}
    </ol>
  )
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      onClick={copy}
      className="text-xs px-3 py-1.5 rounded-md bg-slate-700/60 hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
    >
      {copied ? '✓ Copied' : 'Copy brief'}
    </button>
  )
}

function briefToText(brief) {
  const lines = [
    `PRE-CALL BRIEF: ${brief.company_name}`,
    `"${brief.tagline}"`,
    '',
    'OVERVIEW',
    brief.overview,
    '',
    'RECENT SIGNALS',
    ...(brief.recent_signals || []).map(s => `• ${s}`),
    '',
    'PAIN POINTS',
    ...(brief.pain_points || []).map(p => `• ${p}`),
    '',
    'CALL QUESTIONS',
    ...(brief.call_questions || []).map((q, i) => `${i + 1}. ${q}`),
    '',
    'RED FLAGS',
    ...(brief.red_flags && brief.red_flags.length > 0
      ? brief.red_flags.map(r => `⚠ ${r}`)
      : ['None identified.']),
  ]
  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Main app
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [apiKey,   setApiKey]   = useState('')
  const [showKey,  setShowKey]  = useState(false)
  const [company,  setCompany]  = useState('')
  const [url,      setUrl]      = useState('')
  const [context,  setContext]  = useState('')

  const [loading,  setLoading]  = useState(false)
  const [stepIdx,  setStepIdx]  = useState(0)
  const [error,    setError]    = useState('')
  const [brief,    setBrief]    = useState(null)

  const canRun = apiKey.trim() && company.trim() && !loading

  const handleRun = async () => {
    if (!canRun) return
    setLoading(true)
    setError('')
    setBrief(null)
    setStepIdx(0)

    try {
      const result = await runAgent(apiKey, company, url, context, setStepIdx)
      setBrief(result)
    } catch (err) {
      setError(err.message || 'Something went wrong.')
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRun()
  }

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-slate-200" onKeyDown={handleKeyDown}>

      {/* ── Header ── */}
      <header className="border-b border-slate-800/60 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-sm">
            B
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-100 leading-none">Pre-Call Brief</p>
            <p className="text-[11px] text-slate-500 mt-0.5">AI-powered sales intelligence</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] px-2 py-1 rounded-full bg-indigo-600/15 text-indigo-400 border border-indigo-500/20 font-medium tracking-wide">
            claude-sonnet-4-6
          </span>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-5 py-10">

        {/* ── Intro ── */}
        {!brief && !loading && (
          <div className="mb-8">
            <h1 className="text-2xl font-semibold text-slate-100 mb-2">
              Know them before the call.
            </h1>
            <p className="text-slate-400 text-sm leading-relaxed">
              Enter a company name and Claude will research them in real time — surfacing signals,
              pain points, and sharp questions so you walk in prepared.
            </p>
          </div>
        )}

        {/* ── Input form ── */}
        {!brief && (
          <div className="space-y-4">

            {/* API key */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                Anthropic API key
              </label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder="sk-ant-…"
                  className="w-full bg-slate-900 border border-slate-700/60 rounded-lg px-4 py-2.5 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500/60 focus:ring-1 focus:ring-indigo-500/30 transition pr-20"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(s => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500 hover:text-slate-300 transition"
                >
                  {showKey ? 'hide' : 'show'}
                </button>
              </div>
              <p className="text-[11px] text-slate-600 mt-1">
                Sent directly to Anthropic. Never stored.
              </p>
            </div>

            {/* Company name */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                Company name <span className="text-indigo-400">*</span>
              </label>
              <input
                type="text"
                value={company}
                onChange={e => setCompany(e.target.value)}
                placeholder="e.g. Notion, Rippling, Monzo"
                className="w-full bg-slate-900 border border-slate-700/60 rounded-lg px-4 py-2.5 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500/60 focus:ring-1 focus:ring-indigo-500/30 transition"
              />
            </div>

            {/* URL */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                Website or LinkedIn <span className="text-slate-600">(optional)</span>
              </label>
              <input
                type="text"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://notion.so or linkedin.com/company/notion"
                className="w-full bg-slate-900 border border-slate-700/60 rounded-lg px-4 py-2.5 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500/60 focus:ring-1 focus:ring-indigo-500/30 transition"
              />
            </div>

            {/* Context */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                What are you selling them? <span className="text-slate-600">(optional)</span>
              </label>
              <textarea
                rows={2}
                value={context}
                onChange={e => setContext(e.target.value)}
                placeholder="e.g. AI-powered HR software for mid-market SaaS companies"
                className="w-full bg-slate-900 border border-slate-700/60 rounded-lg px-4 py-2.5 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500/60 focus:ring-1 focus:ring-indigo-500/30 transition resize-none"
              />
              <p className="text-[11px] text-slate-600 mt-1">
                Helps Claude tailor pain points and questions to your offer.
              </p>
            </div>

            {/* Run button */}
            <button
              onClick={handleRun}
              disabled={!canRun}
              className="w-full mt-2 py-3 rounded-lg font-medium text-sm transition-all
                bg-indigo-600 hover:bg-indigo-500 text-white
                disabled:opacity-40 disabled:cursor-not-allowed
                focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
            >
              Generate Brief
              <span className="ml-2 text-indigo-300 font-normal text-xs">⌘ Enter</span>
            </button>

            {error && (
              <div className="mt-2 p-3 rounded-lg bg-red-950/40 border border-red-800/40 text-red-300 text-sm">
                {error}
              </div>
            )}
          </div>
        )}

        {/* ── Loading state ── */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-24 gap-6">
            <div className="relative">
              <div className="w-12 h-12 rounded-full border-2 border-slate-800" />
              <div className="spinner absolute inset-0 w-12 h-12 rounded-full border-2 border-transparent border-t-indigo-500" />
            </div>
            <div className="text-center">
              <p className="text-slate-200 font-medium text-sm">
                {LOADING_STEPS[stepIdx]?.label}
              </p>
              <p className="text-slate-500 text-xs mt-1">
                {LOADING_STEPS[stepIdx]?.detail}
              </p>
            </div>
            {/* Step dots */}
            <div className="flex gap-1.5">
              {LOADING_STEPS.map((_, i) => (
                <div
                  key={i}
                  className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${
                    i <= stepIdx ? 'bg-indigo-500' : 'bg-slate-700'
                  }`}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── Brief output ── */}
        {brief && !loading && (
          <div className="fade-up">

            {/* Brief header */}
            <div className="mb-8 pb-6 border-b border-slate-800/60">
              <div className="flex items-start justify-between gap-4 mb-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-600/15 text-emerald-400 border border-emerald-500/20 font-medium">
                      Brief ready
                    </span>
                  </div>
                  <h2 className="text-xl font-semibold text-slate-100">
                    {brief.company_name}
                  </h2>
                  <p className="text-slate-400 text-sm mt-0.5 italic">
                    "{brief.tagline}"
                  </p>
                </div>
                <CopyButton text={briefToText(brief)} />
              </div>
            </div>

            {/* Overview */}
            <div className="mb-7 fade-up" style={{ animationDelay: '0ms' }}>
              <SectionLabel>Overview</SectionLabel>
              <p className="text-sm text-slate-300 leading-relaxed">{brief.overview}</p>
            </div>

            {/* Recent signals */}
            <div className="mb-7 fade-up" style={{ animationDelay: '60ms' }}>
              <SectionLabel>Recent signals</SectionLabel>
              <BulletList items={brief.recent_signals || []} />
            </div>

            {/* Pain points */}
            <div className="mb-7 p-4 rounded-xl bg-slate-900/50 border border-slate-800/60 fade-up" style={{ animationDelay: '120ms' }}>
              <SectionLabel>Likely pain points</SectionLabel>
              <BulletList items={brief.pain_points || []} color="text-slate-200" />
            </div>

            {/* Call questions */}
            <div className="mb-7 p-4 rounded-xl bg-indigo-950/20 border border-indigo-900/30 fade-up" style={{ animationDelay: '180ms' }}>
              <SectionLabel>Questions to ask</SectionLabel>
              <QuestionList items={brief.call_questions || []} />
            </div>

            {/* Red flags */}
            <div className="mb-8 p-4 rounded-xl bg-amber-950/10 border border-amber-900/20 fade-up" style={{ animationDelay: '240ms' }}>
              <SectionLabel>Red flags</SectionLabel>
              <RedFlagList items={brief.red_flags} />
            </div>

            {/* Sources */}
            {brief.sources_searched && brief.sources_searched.length > 0 && (
              <div className="mb-8 fade-up" style={{ animationDelay: '300ms' }}>
                <SectionLabel>Sources searched</SectionLabel>
                <div className="flex flex-wrap gap-1.5">
                  {brief.sources_searched.map((s, i) => (
                    <span key={i} className="text-[11px] px-2 py-1 rounded-md bg-slate-800/60 text-slate-500 font-mono">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* New brief button */}
            <button
              onClick={() => { setBrief(null); setError('') }}
              className="w-full py-2.5 rounded-lg text-sm font-medium text-slate-400 hover:text-slate-200 border border-slate-800 hover:border-slate-700 transition-all"
            >
              ← Research another company
            </button>
          </div>
        )}

      </main>
    </div>
  )
}
