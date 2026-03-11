import React, { useState, useEffect, useCallback } from 'react'

const API = '/api'

function App() {
  const [tab, setTab] = useState('live')
  const [settings, setSettings] = useState(null)
  const [logs, setLogs] = useState([])
  const [analytics, setAnalytics] = useState(null)
  const [deferList, setDeferList] = useState([])
  const [syncLogs, setSyncLogs] = useState([])
  const [expandedLog, setExpandedLog] = useState(null)
  const [period, setPeriod] = useState('today')
  const [syncing, setSyncing] = useState(false)
  const [knowledge, setKnowledge] = useState(null)
  const [filterStats, setFilterStats] = useState(null)
  const [filterPeriod, setFilterPeriod] = useState('today')
  const [learningStats, setLearningStats] = useState(null)
  const [learningRunning, setLearningRunning] = useState(false)

  // Knowledge base browsing
  const [kbStats, setKbStats] = useState(null)
  const [kbChunks, setKbChunks] = useState(null)
  const [kbSource, setKbSource] = useState('')
  const [kbPage, setKbPage] = useState(1)
  const [kbSearch, setKbSearch] = useState('')

  // Fetch data
  const fetchSettings = useCallback(async () => {
    const res = await fetch(`${API}/settings`)
    if (res.ok) setSettings(await res.json())
  }, [])

  const fetchLogs = useCallback(async () => {
    const res = await fetch(`${API}/logs?limit=100`)
    if (res.ok) setLogs(await res.json())
  }, [])

  const fetchAnalytics = useCallback(async () => {
    const res = await fetch(`${API}/analytics?period=${period}`)
    if (res.ok) setAnalytics(await res.json())
  }, [period])

  const fetchDeferList = useCallback(async () => {
    const res = await fetch(`${API}/defer-list`)
    if (res.ok) setDeferList(await res.json())
  }, [])

  const fetchSyncLogs = useCallback(async () => {
    const res = await fetch(`${API}/sync/logs`)
    if (res.ok) setSyncLogs(await res.json())
  }, [])

  const fetchKnowledge = useCallback(async () => {
    const res = await fetch(`${API}/knowledge/download`)
    if (res.ok) setKnowledge(await res.json())
  }, [])

  const fetchFilterStats = useCallback(async () => {
    const res = await fetch(`${API}/filters/stats?period=${filterPeriod}`)
    if (res.ok) setFilterStats(await res.json())
  }, [filterPeriod])

  const fetchLearningStats = useCallback(async () => {
    const res = await fetch(`${API}/learning/stats`)
    if (res.ok) setLearningStats(await res.json())
  }, [])

  const fetchKbStats = useCallback(async () => {
    const res = await fetch(`${API}/knowledge/stats`)
    if (res.ok) setKbStats(await res.json())
  }, [])

  const fetchKbChunks = useCallback(async (source = '', page = 1, search = '') => {
    const params = new URLSearchParams({ page, pageSize: 20 })
    if (source) params.set('source', source)
    if (search) params.set('search', search)
    const res = await fetch(`${API}/knowledge/chunks?${params}`)
    if (res.ok) setKbChunks(await res.json())
  }, [])

  const triggerLearningRun = async () => {
    setLearningRunning(true)
    try {
      await fetch(`${API}/learning/run`, { method: 'POST' })
      await fetchLearningStats()
    } finally {
      setLearningRunning(false)
    }
  }

  const [backlogProgress, setBacklogProgress] = useState(null)

  const triggerBacklog = async () => {
    const res = await fetch(`${API}/learning/backlog`, { method: 'POST' })
    if (res.ok) {
      setBacklogProgress({ status: 'running', batchNumber: 0, totalReviewed: 0, totalCorrections: 0 })
      // Poll for progress every 5 seconds
      const poll = setInterval(async () => {
        const pRes = await fetch(`${API}/learning/backlog/progress`)
        if (pRes.ok) {
          const progress = await pRes.json()
          setBacklogProgress(progress)
          if (progress.status === 'complete' || progress.status === 'failed') {
            clearInterval(poll)
            fetchLearningStats()
          }
        }
      }, 5000)
    }
  }

  // Dynamic Pre-AI filter management
  const [dbFilters, setDbFilters] = useState([])

  const fetchDbFilters = useCallback(async () => {
    try {
      const res = await fetch(`${API}/filters`)
      if (res.ok) setDbFilters(await res.json())
    } catch { /* DB might not be ready */ }
  }, [])

  const [historyPullProgress, setHistoryPullProgress] = useState(null)
  const [pulledPairsData, setPulledPairsData] = useState(null)
  const [pulledPairsPage, setPulledPairsPage] = useState(1)
  const [pulledPairsFilter, setPulledPairsFilter] = useState({ category: '', result: '' })

  const fetchPulledPairs = useCallback(async (page = 1, category = '', result = '') => {
    const params = new URLSearchParams({ page, pageSize: 50 })
    if (category) params.set('category', category)
    if (result) params.set('result', result)
    const res = await fetch(`${API}/learning/pulled-pairs?${params}`)
    if (res.ok) setPulledPairsData(await res.json())
  }, [])

  const triggerHistoryPull = async (limit = 500) => {
    const res = await fetch(`${API}/learning/history-pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit }),
    })
    if (res.ok) {
      setHistoryPullProgress({ status: 'running', phase: 'fetching', fetched: 0, stored: 0, reviewed: 0, corrections: 0 })
      const poll = setInterval(async () => {
        const pRes = await fetch(`${API}/learning/history-pull/progress`)
        if (pRes.ok) {
          const progress = await pRes.json()
          setHistoryPullProgress(progress)
          if (progress.status === 'complete' || progress.status === 'failed') {
            clearInterval(poll)
            fetchLearningStats()
          }
        }
      }, 5000)
    }
  }

  const toggleLearning = async (enabled) => {
    await fetch(`${API}/learning/toggle`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    await fetchSettings()
    await fetchLearningStats()
  }

  useEffect(() => {
    fetchSettings()
    fetchLogs()
    fetchAnalytics()
    // Auto-refresh logs every 5 seconds
    const interval = setInterval(fetchLogs, 5000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => { fetchAnalytics() }, [period])

  // Update settings
  const updateSetting = async (key, value) => {
    const res = await fetch(`${API}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    })
    if (res.ok) setSettings(await res.json())
  }

  // Sync
  const triggerSync = async () => {
    setSyncing(true)
    try {
      await fetch(`${API}/sync/all`, { method: 'POST' })
      await fetchSyncLogs()
      await fetchKnowledge()
      await fetchSettings()
    } finally {
      setSyncing(false)
    }
  }

  // Delete defer item
  const deleteDefer = async (id) => {
    await fetch(`${API}/defer-list/${id}`, { method: 'DELETE' })
    fetchDeferList()
  }

  // Download knowledge base
  const downloadKnowledge = () => {
    window.open(`${API}/knowledge/download`, '_blank')
  }

  if (!settings) return <div style={styles.loading}>Loading...</div>

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>Digital Ketu — AI Dashboard</h1>
        <div style={styles.headerControls}>
          <span style={{ ...styles.statusDot, background: settings.isActive ? '#22c55e' : '#ef4444' }} />
          <button
            style={{ ...styles.toggleBtn, background: settings.isActive ? '#22c55e' : '#ef4444' }}
            onClick={() => updateSetting('isActive', !settings.isActive)}
          >
            {settings.isActive ? 'AI ON' : 'AI OFF'}
          </button>
        </div>
      </header>

      {/* Tabs */}
      <nav style={styles.tabs}>
        {['live', 'knowledge', 'analytics', 'defer', 'filters', 'learning', 'settings', 'sync', 'catalog', 'replies', 'stylepairs'].map(t => (
          <button
            key={t}
            data-tab={t}
            style={{ ...styles.tab, ...(tab === t ? styles.activeTab : {}) }}
            onClick={() => {
              setTab(t)
              if (t === 'defer') fetchDeferList()
              if (t === 'sync') { fetchSyncLogs(); fetchKnowledge() }
              if (t === 'analytics') fetchAnalytics()
              if (t === 'filters') { fetchFilterStats(); fetchDbFilters() }
              if (t === 'learning') fetchLearningStats()
              if (t === 'knowledge') { fetchKbStats(); fetchKbChunks('', 1, '') }
            }}
          >
            {{live:'Live Monitor', knowledge:'Knowledge Base', analytics:'Analytics', defer:'Defer to Ketu', filters:'Pre-AI Filters', learning:'Learning', settings:'Settings', sync:'Sync', catalog:'Catalog', replies:'Replies', stylepairs:'Style Pairs'}[t]}
          </button>
        ))}
      </nav>

      {/* Daily Budget Bar */}
      <DailyBudgetBar settings={settings} />

      {/* Tab Content */}
      <main style={styles.main}>
        {tab === 'live' && <LiveMonitor logs={logs} expandedLog={expandedLog} setExpandedLog={setExpandedLog} />}
        {tab === 'knowledge' && <KnowledgeBasePanel stats={kbStats} chunks={kbChunks} source={kbSource} page={kbPage} search={kbSearch} onSourceChange={(s) => { setKbSource(s); setKbPage(1); fetchKbChunks(s, 1, kbSearch) }} onPageChange={(p) => { setKbPage(p); fetchKbChunks(kbSource, p, kbSearch) }} onSearch={(s) => { setKbSearch(s); setKbPage(1); fetchKbChunks(kbSource, 1, s) }} onRefresh={() => { fetchKbStats(); fetchKbChunks(kbSource, kbPage, kbSearch) }} />}
        {tab === 'analytics' && <Analytics analytics={analytics} period={period} setPeriod={setPeriod} />}
        {tab === 'defer' && <DeferManager list={deferList} onDelete={deleteDefer} settings={settings} updateSetting={updateSetting} />}
        {tab === 'filters' && <PreAIFilters stats={filterStats} period={filterPeriod} setPeriod={setFilterPeriod} onRefresh={() => { fetchFilterStats(); fetchDbFilters() }} dbFilters={dbFilters} />}
        {tab === 'learning' && <LearningPanel stats={learningStats} settings={settings} onRun={triggerLearningRun} running={learningRunning} onToggle={toggleLearning} onRefresh={fetchLearningStats} onBacklog={triggerBacklog} backlogProgress={backlogProgress} onHistoryPull={triggerHistoryPull} historyPullProgress={historyPullProgress} />}
{tab === 'settings' && <SettingsPanel settings={settings} updateSetting={updateSetting} onDownload={downloadKnowledge} />}
        {tab === 'sync' && <SyncPanel logs={syncLogs} settings={settings} onSync={triggerSync} syncing={syncing} knowledge={knowledge} />}
        {tab === 'catalog' && <CatalogTab />}
        {tab === 'replies' && <ReplyTemplatesTab />}
        {tab === 'stylepairs' && <StylePairsTab />}
      </main>
    </div>
  )
}

// ===========================================
// Components
// ===========================================

function DailyBudgetBar({ settings }) {
  const spentInr = (settings.dailySpentUsd * 85).toFixed(0)
  const pct = Math.min(100, (spentInr / settings.dailyBudgetInr) * 100)
  const isWarning = pct >= 80
  return (
    <div style={styles.budgetBar}>
      <div style={styles.budgetLabel}>
        Daily: Rs.{spentInr} / Rs.{settings.dailyBudgetInr} ({pct.toFixed(0)}%)
      </div>
      <div style={styles.budgetTrack}>
        <div style={{ ...styles.budgetFill, width: `${pct}%`, background: isWarning ? '#f59e0b' : '#3b82f6' }} />
      </div>
    </div>
  )
}

function LiveMonitor({ logs, expandedLog, setExpandedLog }) {
  return (
    <div>
      <h2 style={styles.sectionTitle}>Live Message Log</h2>
      {logs.length === 0 && <p style={styles.empty}>No messages yet</p>}
      {logs.map(log => (
        <div key={log.id} style={{ ...styles.logCard, borderLeft: `4px solid ${statusColor(log.status)}` }}>
          <div style={styles.logHeader} onClick={() => setExpandedLog(expandedLog === log.id ? null : log.id)}>
            <div>
              <span style={{ ...styles.statusBadge, background: statusColor(log.status) }}>{log.status}</span>
              <span style={styles.logPhone}>{log.conversation?.whatsappNumber || '—'}</span>
              {log.deferReason && <span style={styles.logReason}>({log.deferReason})</span>}
            </div>
            <div style={styles.logMeta}>
              {log.totalTokens && <span>{log.totalTokens} tok</span>}
              {log.costUsd != null && <span> / Rs.{(log.costUsd * 85).toFixed(2)}</span>}
              {log.processingMs && <span> / {log.processingMs}ms</span>}
              <span style={styles.logTime}>{new Date(log.createdAt).toLocaleTimeString('en-IN')}</span>
            </div>
          </div>
          <div style={styles.logBody}>
            <div style={styles.logMessage}><strong>Buyer:</strong> {log.buyerMessage}</div>
            {log.aiReply && <div style={styles.logReply}><strong>AI Reply:</strong> {log.aiReply}</div>}
          </div>
          {expandedLog === log.id && <ProcessPipeline log={log} />}
        </div>
      ))}
    </div>
  )
}

function ProcessPipeline({ log }) {
  const [showPrompt, setShowPrompt] = useState(null) // 'system' | 'user' | null
  const [showSection, setShowSection] = useState({})
  const toggleSec = (key) => setShowSection(prev => ({ ...prev, [key]: !prev[key] }))
  const prompt = log.promptSent || {}
  const chunks = log.knowledgeChunks || []
  const catalogChunks = chunks.filter(c => c.source === 'CATALOG')
  const otherChunks = chunks.filter(c => c.source !== 'CATALOG')
  const costInr = log.costUsd ? (log.costUsd * 85).toFixed(2) : null

  // Extract style examples from system prompt
  const hasStyleExamples = prompt.system && prompt.system.includes('STYLE EXAMPLES')
  const styleExamplesText = hasStyleExamples
    ? prompt.system.split('STYLE EXAMPLES')[1]?.split('IMPORTANT:')[0]?.trim() || ''
    : ''

  // Extract conversation history from user prompt
  const hasConvoHistory = prompt.user && prompt.user.includes('RECENT CONVERSATION:')
  const convoHistoryText = hasConvoHistory
    ? prompt.user.split('RECENT CONVERSATION:')[1]?.split("BUYER'S NEW MESSAGE:")[0]?.trim() || ''
    : ''

  return (
    <div style={styles.pipeline}>
      {/* Step 1: Incoming */}
      <div style={styles.pipeStep}>
        <div style={styles.pipeStepHeader}>
          <span style={{ ...styles.pipeStepNum, background: '#3b82f6' }}>1</span>
          <span style={styles.pipeStepTitle}>INCOMING MESSAGE</span>
          <span style={styles.pipeStepMeta}>{new Date(log.createdAt).toLocaleString('en-IN')}</span>
        </div>
        <div style={styles.pipeStepBody}>
          <div style={{ padding: '8px 12px', background: '#1e293b', borderRadius: '6px', borderLeft: '3px solid #3b82f6' }}>
            {log.buyerMessage}
          </div>
          <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>
            From: {log.conversation?.whatsappNumber || '—'} | {log.isMedia ? 'Media message' : 'Text message'}
          </div>
        </div>
      </div>

      <div style={styles.pipeArrow}>↓</div>

      {/* Step 2: Checks */}
      <div style={styles.pipeStep}>
        <div style={styles.pipeStepHeader}>
          <span style={{ ...styles.pipeStepNum, background: log.status === 'SKIPPED' || log.status === 'COOLDOWN' ? '#ef4444' : '#22c55e' }}>2</span>
          <span style={styles.pipeStepTitle}>CHECKS PIPELINE</span>
          <span style={styles.pipeStepMeta}>{log.status === 'SKIPPED' || log.status === 'COOLDOWN' ? 'STOPPED HERE' : 'ALL PASSED'}</span>
        </div>
        <div style={styles.pipeStepBody}>
          {log.deferReason === 'off_hours' && <div style={styles.pipeCheckFail}>STOPPED: System OFF or outside schedule</div>}
          {log.deferReason === 'daily_limit' && <div style={styles.pipeCheckFail}>STOPPED: Daily budget exceeded</div>}
          {log.deferReason === 'media_only' && <div style={styles.pipeCheckFail}>STOPPED: Media-only message → sent media reply</div>}
          {log.deferReason === 'spam' && <div style={styles.pipeCheckFail}>STOPPED: Empty/spam message</div>}
          {log.deferReason === 'cooldown' && <div style={styles.pipeCheckFail}>STOPPED: Om intervened → cooldown active</div>}
          {log.deferReason === 'post_defer_ack' && <div style={styles.pipeCheckFail}>STOPPED: Buyer acknowledged previous defer (ok/thanks)</div>}
          {log.deferReason === 'defer_to_ketu' && (
            <div style={styles.pipeCheckFail}>
              STOPPED: Matched defer-to-ketu rule (similarity: {log.similarityScore ? (log.similarityScore * 100).toFixed(1) + '%' : 'N/A'})
            </div>
          )}
          {log.deferReason === 'low_confidence' && (
            <div style={styles.pipeCheckFail}>
              STOPPED: Vector match too low ({log.similarityScore ? (log.similarityScore * 100).toFixed(1) + '%' : 'N/A'}) — deferred to Ketu
            </div>
          )}
          {log.deferReason === 'empty_knowledge_base' && <div style={styles.pipeCheckFail}>STOPPED: Knowledge base empty</div>}
          {log.deferReason === 'welcome_bypass' && (
            <div style={{ padding: '6px 10px', background: '#1e3a5f', borderRadius: '4px', color: '#93c5fd', fontSize: '12px' }}>
              WELCOME BYPASS: First-time buyer or returning after 7+ days → sent welcome message directly (0 tokens, 0 cost)
            </div>
          )}
          {(log.status === 'REPLIED' && !log.deferReason?.includes('welcome') && !log.deferReason?.includes('media')) && log.promptTokens && (
            <div style={{ fontSize: '12px', color: '#86efac' }}>All checks passed → proceeded to Claude API</div>
          )}
          {log.deferReason === 'claude_deferred' && (
            <div style={{ fontSize: '12px', color: '#86efac' }}>All checks passed → proceeded to Claude API</div>
          )}
        </div>
      </div>

      {/* Only show steps 3-6 if Claude was actually called */}
      {(log.promptTokens || log.promptSent) && (
        <>
          <div style={styles.pipeArrow}>↓</div>

          {/* Step 3: EVERYTHING sent to Claude */}
          <div style={styles.pipeStep}>
            <div style={styles.pipeStepHeader}>
              <span style={{ ...styles.pipeStepNum, background: '#a78bfa' }}>3</span>
              <span style={styles.pipeStepTitle}>EVERYTHING SENT TO CLAUDE</span>
              <span style={styles.pipeStepMeta}>{chunks.length} chunks + instructions + history</span>
            </div>
            <div style={styles.pipeStepBody}>

              {/* A: Style Instructions */}
              <div style={styles.pipeSectionBox}>
                <div style={styles.pipeSectionHeader} onClick={() => toggleSec('style')}>
                  <span style={{ color: '#f59e0b', fontWeight: '600' }}>A. STYLE INSTRUCTIONS (System Prompt)</span>
                  <span style={{ color: '#64748b', fontSize: '11px' }}>{showSection.style ? '▼' : '▶ tap to view'}</span>
                </div>
                <div style={{ fontSize: '12px', color: '#94a3b8', padding: '4px 0' }}>
                  Rules: language matching, natural reply length (from style pairs), friendly tone, no AI reveal, [DEFER] when unsure
                </div>
                {showSection.style && prompt.system && (
                  <div style={{ ...styles.promptBlock, maxHeight: '250px', overflow: 'auto', marginTop: '6px' }}>
                    {prompt.system.split('STYLE EXAMPLES')[0].trim()}
                  </div>
                )}
              </div>

              {/* B: Vector-matched Style Pairs */}
              <div style={styles.pipeSectionBox}>
                <div style={styles.pipeSectionHeader} onClick={() => toggleSec('examples')}>
                  <span style={{ color: '#f97316', fontWeight: '600' }}>B. STYLE PAIRS (vector-matched to this question)</span>
                  <span style={{ color: '#64748b', fontSize: '11px' }}>{showSection.examples ? '▼' : '▶ tap to view'}</span>
                </div>
                {hasStyleExamples ? (
                  <>
                    <div style={{ fontSize: '12px', color: '#94a3b8', padding: '4px 0' }}>
                      Om's real replies to similar questions — Claude matches this tone + length
                    </div>
                    {showSection.examples && (
                      <div style={{ ...styles.promptBlock, maxHeight: '200px', overflow: 'auto', marginTop: '6px' }}>
                        {styleExamplesText}
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ fontSize: '12px', color: '#64748b', padding: '4px 0' }}>
                    No matching style pairs found for this question
                  </div>
                )}
              </div>

              {/* C: Vector Search Results */}
              <div style={styles.pipeSectionBox}>
                <div style={styles.pipeSectionHeader} onClick={() => toggleSec('chunks')}>
                  <span style={{ color: '#a78bfa', fontWeight: '600' }}>C. VECTOR SEARCH RESULTS ({chunks.length} matches)</span>
                  <span style={{ color: '#64748b', fontSize: '11px' }}>{showSection.chunks ? '▼' : '▶ tap to view'}</span>
                </div>
                {log.similarityScore != null && (
                  <div style={{ fontSize: '12px', color: '#94a3b8', padding: '4px 0' }}>
                    Best match: <span style={{ color: log.similarityScore >= 0.85 ? '#22c55e' : '#f59e0b', fontWeight: 600 }}>
                      {(log.similarityScore * 100).toFixed(1)}%
                    </span>
                    {log.similarityScore >= (0.80) ? ' — AI answered' : ' — below threshold, deferred'}
                  </div>
                )}
                {chunks.length > 0 && (
                  <div style={{ marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    {chunks.map((c, i) => {
                      const simPct = c.similarity ? `${(Number(c.similarity) * 100).toFixed(0)}%` : ''
                      const bgColor = c.source === 'CATALOG' ? '#14532d' : c.source === 'POLICY' ? '#422006' : c.source === 'STYLE_PAIR' ? '#1e1b4b' : '#1e293b'
                      const textColor = c.source === 'CATALOG' ? '#86efac' : c.source === 'POLICY' ? '#fbbf24' : c.source === 'STYLE_PAIR' ? '#c4b5fd' : '#cbd5e1'
                      return (
                        <span key={i} style={{ ...styles.colorChip, background: bgColor, color: textColor }}>
                          [{c.source}] {c.title} {simPct && <span style={{ color: '#64748b', marginLeft: 4 }}>({simPct})</span>}
                        </span>
                      )
                    })}
                  </div>
                )}
                {showSection.chunks && prompt.user && (
                  <div style={{ ...styles.promptBlock, maxHeight: '300px', overflow: 'auto', marginTop: '6px' }}>
                    {prompt.user.split('RECENT CONVERSATION:')[0]?.split("BUYER'S NEW MESSAGE:")[0]?.trim() || prompt.user}
                  </div>
                )}
              </div>

              {/* D: Conversation History */}
              <div style={styles.pipeSectionBox}>
                <div style={styles.pipeSectionHeader} onClick={() => toggleSec('history')}>
                  <span style={{ color: '#06b6d4', fontWeight: '600' }}>D. CONVERSATION HISTORY (last 5 replies)</span>
                  <span style={{ color: '#64748b', fontSize: '11px' }}>{showSection.history ? '▼' : '▶ tap to view'}</span>
                </div>
                {hasConvoHistory ? (
                  <>
                    <div style={{ fontSize: '12px', color: '#94a3b8', padding: '4px 0' }}>
                      Previous messages from this buyer included for context
                    </div>
                    {showSection.history && (
                      <div style={{ ...styles.promptBlock, maxHeight: '200px', overflow: 'auto', marginTop: '6px' }}>
                        {convoHistoryText}
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ fontSize: '12px', color: '#64748b', padding: '4px 0' }}>
                    No conversation history — this is the buyer's first AI interaction
                  </div>
                )}
              </div>

              {/* E: Buyer's message */}
              <div style={styles.pipeSectionBox}>
                <span style={{ color: '#3b82f6', fontWeight: '600', fontSize: '12px' }}>E. BUYER'S MESSAGE:</span>
                <span style={{ color: '#cbd5e1', fontSize: '12px', marginLeft: '8px' }}>"{log.buyerMessage}"</span>
              </div>

            </div>
          </div>

          <div style={styles.pipeArrow}>↓</div>

          {/* Step 4: Claude API call */}
          <div style={styles.pipeStep}>
            <div style={styles.pipeStepHeader}>
              <span style={{ ...styles.pipeStepNum, background: '#f59e0b' }}>4</span>
              <span style={styles.pipeStepTitle}>CLAUDE API CALL</span>
              <span style={styles.pipeStepMeta}>Haiku 4.5</span>
            </div>
            <div style={styles.pipeStepBody}>
              {/* Token breakdown */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '8px', marginBottom: '8px' }}>
                <div style={styles.tokenBox}>
                  <div style={{ fontSize: '18px', fontWeight: '700', color: '#60a5fa' }}>{log.promptTokens?.toLocaleString() || '—'}</div>
                  <div style={{ fontSize: '10px', color: '#64748b' }}>Input Tokens</div>
                </div>
                <div style={styles.tokenBox}>
                  <div style={{ fontSize: '18px', fontWeight: '700', color: '#a78bfa' }}>{log.completionTokens?.toLocaleString() || '—'}</div>
                  <div style={{ fontSize: '10px', color: '#64748b' }}>Output Tokens</div>
                </div>
                <div style={styles.tokenBox}>
                  <div style={{ fontSize: '18px', fontWeight: '700', color: '#f8fafc' }}>{log.totalTokens?.toLocaleString() || '—'}</div>
                  <div style={{ fontSize: '10px', color: '#64748b' }}>Total Tokens</div>
                </div>
                <div style={styles.tokenBox}>
                  <div style={{ fontSize: '18px', fontWeight: '700', color: '#22c55e' }}>Rs.{costInr || '—'}</div>
                  <div style={{ fontSize: '10px', color: '#64748b' }}>Cost</div>
                </div>
                <div style={styles.tokenBox}>
                  <div style={{ fontSize: '18px', fontWeight: '700', color: '#fbbf24' }}>{log.processingMs || '—'}ms</div>
                  <div style={{ fontSize: '10px', color: '#64748b' }}>Processing Time</div>
                </div>
              </div>

              {/* Full raw prompt buttons */}
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  style={{ ...styles.btnSecondary, marginLeft: 0, background: showPrompt === 'system' ? '#1e293b' : 'transparent', fontSize: '11px' }}
                  onClick={() => setShowPrompt(showPrompt === 'system' ? null : 'system')}
                >
                  {showPrompt === 'system' ? 'Hide' : 'Raw'} System Prompt
                </button>
                <button
                  style={{ ...styles.btnSecondary, marginLeft: 0, background: showPrompt === 'user' ? '#1e293b' : 'transparent', fontSize: '11px' }}
                  onClick={() => setShowPrompt(showPrompt === 'user' ? null : 'user')}
                >
                  {showPrompt === 'user' ? 'Hide' : 'Raw'} User Prompt
                </button>
              </div>
              {showPrompt === 'system' && prompt.system && (
                <div style={{ ...styles.promptBlock, maxHeight: '300px', overflow: 'auto', marginTop: '8px' }}>{prompt.system}</div>
              )}
              {showPrompt === 'user' && prompt.user && (
                <div style={{ ...styles.promptBlock, maxHeight: '400px', overflow: 'auto', marginTop: '8px' }}>{prompt.user}</div>
              )}
            </div>
          </div>

          <div style={styles.pipeArrow}>↓</div>

          {/* Step 5: Output */}
          <div style={styles.pipeStep}>
            <div style={styles.pipeStepHeader}>
              <span style={{ ...styles.pipeStepNum, background: log.status === 'REPLIED' ? '#22c55e' : '#f59e0b' }}>5</span>
              <span style={styles.pipeStepTitle}>
                {log.status === 'REPLIED' ? 'AI REPLY SENT' : log.deferReason === 'claude_deferred' ? 'CLAUDE DEFERRED' : 'OUTPUT'}
              </span>
              <span style={styles.pipeStepMeta}>{log.sentViaWwbun ? 'Sent via wwbun' : 'Not sent'}</span>
            </div>
            <div style={styles.pipeStepBody}>
              {log.deferReason === 'claude_deferred' && (
                <div style={{ padding: '8px 12px', background: '#422006', borderRadius: '6px', borderLeft: '3px solid #f59e0b', fontSize: '13px', color: '#fbbf24', marginBottom: '8px' }}>
                  Claude responded with [DEFER] — didn't have enough knowledge to answer. Defer message sent instead.
                </div>
              )}
              {log.aiReply && (
                <div style={{ padding: '8px 12px', background: '#1e293b', borderRadius: '6px', borderLeft: '3px solid #22c55e', fontSize: '13px', color: '#86efac' }}>
                  {log.aiReply}
                </div>
              )}
              {log.wwbunMessageId && (
                <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>wwbun message ID: {log.wwbunMessageId}</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ===========================================
// Knowledge Base Panel
// ===========================================

const SOURCE_LABELS = {
  STYLE_PAIR: 'Quality Pairs (Om\'s Real Replies)',
  SAVED_REPLY: 'Reply Templates (from wwbun)',
  CATALOG: 'Product Catalog',
  POLICY: 'Business Policies',
  STYLE_GUIDE: 'Om\'s Style Guide (extracted)',
  FAQ: 'FAQ',
}

const SOURCE_COLORS = {
  STYLE_PAIR: '#c4b5fd',
  SAVED_REPLY: '#60a5fa',
  CATALOG: '#86efac',
  POLICY: '#fbbf24',
  STYLE_GUIDE: '#f97316',
  FAQ: '#94a3b8',
}

const SOURCE_BG = {
  STYLE_PAIR: '#1e1b4b',
  SAVED_REPLY: '#172554',
  CATALOG: '#14532d',
  POLICY: '#422006',
  STYLE_GUIDE: '#431407',
  FAQ: '#1e293b',
}

function KnowledgeBasePanel({ stats, chunks, source, page, search, onSourceChange, onPageChange, onSearch, onRefresh }) {
  const [expandedChunk, setExpandedChunk] = useState(null)
  const [searchInput, setSearchInput] = useState(search || '')

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={styles.sectionTitle}>Knowledge Base (Vector DB)</h2>
        <button style={styles.btnPrimary} onClick={onRefresh}>Refresh</button>
      </div>

      {/* Stats Overview */}
      {stats && (
        <div style={{ background: '#1e293b', borderRadius: 10, padding: 16, marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
            <div style={{ background: '#0f172a', borderRadius: 8, padding: 12, textAlign: 'center' }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: '#f1f5f9' }}>{stats.total}</div>
              <div style={{ fontSize: 11, color: '#64748b' }}>Total Chunks</div>
            </div>
            <div style={{ background: '#0f172a', borderRadius: 8, padding: 12, textAlign: 'center' }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: '#22c55e' }}>{stats.withEmbedding}</div>
              <div style={{ fontSize: 11, color: '#64748b' }}>With Embeddings</div>
            </div>
            <div style={{ background: '#0f172a', borderRadius: 8, padding: 12, textAlign: 'center' }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: '#f59e0b' }}>{stats.deferToKetuItems}</div>
              <div style={{ fontSize: 11, color: '#64748b' }}>Defer-to-Ketu Rules</div>
            </div>
          </div>

          {/* Per-source breakdown */}
          <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.entries(stats.sources || {}).map(([src, count]) => (
              <div
                key={src}
                style={{
                  background: SOURCE_BG[src] || '#1e293b',
                  borderRadius: 8,
                  padding: '8px 14px',
                  cursor: 'pointer',
                  border: source === src ? '2px solid ' + (SOURCE_COLORS[src] || '#94a3b8') : '2px solid transparent',
                }}
                onClick={() => onSourceChange(source === src ? '' : src)}
              >
                <div style={{ fontSize: 18, fontWeight: 700, color: SOURCE_COLORS[src] || '#f1f5f9' }}>{count}</div>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>{SOURCE_LABELS[src] || src}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search + Filter Bar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search knowledge base..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSearch(searchInput)}
          style={{ ...styles.input, flex: 1 }}
        />
        <button style={styles.btnSecondary} onClick={() => onSearch(searchInput)}>Search</button>
        {(source || search) && (
          <button style={{ ...styles.btnSecondary, color: '#ef4444' }} onClick={() => { setSearchInput(''); onSourceChange(''); onSearch('') }}>Clear</button>
        )}
      </div>

      {/* Active filter indicator */}
      {source && (
        <div style={{ marginBottom: 12, padding: '6px 12px', background: SOURCE_BG[source] || '#1e293b', borderRadius: 6, fontSize: 13, color: SOURCE_COLORS[source] || '#f1f5f9' }}>
          Showing: {SOURCE_LABELS[source] || source} ({chunks?.total || 0} items)
        </div>
      )}

      {/* Chunks list */}
      {chunks && chunks.chunks?.length > 0 ? (
        <>
          {chunks.chunks.map(chunk => (
            <div
              key={chunk.id}
              style={{
                background: '#0f172a',
                borderRadius: 8,
                padding: 12,
                marginBottom: 8,
                borderLeft: `3px solid ${SOURCE_COLORS[chunk.source] || '#64748b'}`,
                cursor: 'pointer',
              }}
              onClick={() => setExpandedChunk(expandedChunk === chunk.id ? null : chunk.id)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontSize: 11, color: SOURCE_COLORS[chunk.source] || '#94a3b8', fontWeight: 600 }}>
                    [{chunk.source}]
                  </span>
                  <span style={{ fontSize: 13, color: '#f1f5f9', marginLeft: 8 }}>
                    {chunk.title || 'Untitled'}
                  </span>
                </div>
                <span style={{ fontSize: 11, color: '#64748b' }}>
                  {new Date(chunk.updatedAt).toLocaleDateString('en-IN')}
                </span>
              </div>

              {expandedChunk === chunk.id && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 12, color: '#cbd5e1', background: '#1e293b', borderRadius: 6, padding: 10, whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' }}>
                    {chunk.content}
                  </div>
                  {chunk.metadata && (
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
                      {chunk.source === 'STYLE_PAIR' && chunk.metadata.buyerMessage && (
                        <div>
                          <span style={{ color: '#94a3b8' }}>Buyer:</span> "{chunk.metadata.buyerMessage}"
                          <br />
                          <span style={{ color: '#86efac' }}>Om:</span> "{chunk.metadata.omReply}"
                        </div>
                      )}
                      {chunk.source === 'CATALOG' && chunk.metadata.bulkPrice && (
                        <div>Price: ₹{chunk.metadata.bulkPrice}/pc | Colors: {(chunk.metadata.colors || []).length} | Sizes: {(chunk.metadata.sizes || []).join(', ')}</div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {/* Pagination */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
            <button
              style={styles.btnSecondary}
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
            >← Prev</button>
            <span style={{ color: '#94a3b8', fontSize: 13, alignSelf: 'center' }}>
              Page {chunks.page} of {Math.ceil(chunks.total / chunks.pageSize)}
            </span>
            <button
              style={styles.btnSecondary}
              disabled={page * chunks.pageSize >= chunks.total}
              onClick={() => onPageChange(page + 1)}
            >Next →</button>
          </div>
        </>
      ) : chunks ? (
        <p style={styles.empty}>No chunks found. Click "Sync" tab to sync data from wwbun and catalog.</p>
      ) : (
        <p style={styles.empty}>Loading...</p>
      )}
    </div>
  )
}

function Analytics({ analytics, period, setPeriod }) {
  if (!analytics) return <p style={styles.empty}>Loading analytics...</p>
  return (
    <div>
      <div style={styles.periodSelector}>
        {['today', 'week', 'month'].map(p => (
          <button key={p} style={{ ...styles.periodBtn, ...(period === p ? styles.activePeriod : {}) }} onClick={() => setPeriod(p)}>
            {p === 'today' ? 'Today' : p === 'week' ? 'This Week' : 'This Month'}
          </button>
        ))}
      </div>
      <div style={styles.statsGrid}>
        <StatCard label="Total Messages" value={analytics.totalMessages} />
        <StatCard label="AI Replied" value={analytics.totalReplied} />
        <StatCard label="Deferred" value={analytics.totalDeferred} />
        <StatCard label="Skipped" value={analytics.totalSkipped} />
        <StatCard label="Total Tokens" value={analytics.tokens.total.toLocaleString()} />
        <StatCard label="Total Cost" value={`Rs.${(analytics.tokens.totalCostUsd * 85).toFixed(2)}`} />
        <StatCard label="Avg Tokens/Reply" value={analytics.tokens.avgTokensPerReply} />
        <StatCard label="Avg Cost/Reply" value={`Rs.${((analytics.tokens.avgCostPerReply || 0) * 85).toFixed(2)}`} />
        <StatCard label="Avg Processing" value={`${analytics.tokens.avgProcessingMs}ms`} />
        <StatCard label="Intervention Rate" value={analytics.interventionRate} />
      </div>
    </div>
  )
}

function StatCard({ label, value }) {
  return (
    <div style={styles.statCard}>
      <div style={styles.statValue}>{value}</div>
      <div style={styles.statLabel}>{label}</div>
    </div>
  )
}

function DeferManager({ list, onDelete, settings, updateSetting }) {
  const [editingMsg, setEditingMsg] = useState(false)
  const [msgDraft, setMsgDraft] = useState(settings.deferMessage)
  return (
    <div>
      <h2 style={styles.sectionTitle}>Defer to Ketu List</h2>

      {/* Editable defer message */}
      <div style={styles.deferMsgBox}>
        <label style={styles.label}>Defer message (sent to buyers):</label>
        {editingMsg ? (
          <div>
            <textarea style={styles.textarea} value={msgDraft} onChange={e => setMsgDraft(e.target.value)} rows={3} />
            <button style={styles.btnPrimary} onClick={() => { updateSetting('deferMessage', msgDraft); setEditingMsg(false) }}>Save</button>
            <button style={styles.btnSecondary} onClick={() => setEditingMsg(false)}>Cancel</button>
          </div>
        ) : (
          <div>
            <p style={styles.deferMsgText}>{settings.deferMessage}</p>
            <button style={styles.btnSecondary} onClick={() => setEditingMsg(true)}>Edit Message</button>
          </div>
        )}
      </div>

      {list.length === 0 && <p style={styles.empty}>No deferred questions yet</p>}
      {list.map(item => (
        <div key={item.id} style={styles.deferCard}>
          <div style={styles.deferQuestion}><strong>Buyer asked:</strong> {item.buyerQuestion}</div>
          {item.aiWrongReply && <div style={styles.deferWrong}><strong>AI wrong reply:</strong> {item.aiWrongReply}</div>}
          <div style={styles.deferCorrect}><strong>Correct reply:</strong> {item.correctReply}</div>
          <div style={styles.deferFooter}>
            <span>Triggered {item.triggerCount} times | Added {new Date(item.createdAt).toLocaleDateString('en-IN')}</span>
            <button style={styles.btnDanger} onClick={() => onDelete(item.id)}>Remove</button>
          </div>
        </div>
      ))}
    </div>
  )
}

// (Old keyword constants removed — now using vector search)

function SettingsPanel({ settings, updateSetting, onDownload }) {
  return (
    <div>
      <h2 style={styles.sectionTitle}>Settings</h2>

      <div style={styles.settingsGrid}>
        <SettingRow label="AI Active" type="toggle" value={settings.isActive} onChange={v => updateSetting('isActive', v)} />
        <SettingRow label="Daily Budget (INR)" type="number" value={settings.dailyBudgetInr} onChange={v => updateSetting('dailyBudgetInr', Number(v))} />
        <SettingRow label="Match Threshold (≥ this → AI answers, below → defer)" type="number" value={settings.confidenceThreshold} onChange={v => updateSetting('confidenceThreshold', Number(v))} step="0.05" />
        <SettingRow label="Message Merge Window (ms)" type="number" value={settings.mergeWindowMs} onChange={v => updateSetting('mergeWindowMs', Number(v))} />
        <SettingRow label="Cooldown Minutes" type="number" value={settings.cooldownMinutes} onChange={v => updateSetting('cooldownMinutes', Number(v))} />
        <SettingRow label="Learning Budget (INR)" type="number" value={Math.round((settings.learningDailyBudgetUsd || 0) * 85)} onChange={v => updateSetting('learningDailyBudgetUsd', Number(v) / 85)} />
        <SettingRow label="Schedule Enabled" type="toggle" value={settings.scheduleEnabled} onChange={v => updateSetting('scheduleEnabled', v)} />
        {settings.scheduleEnabled && (
          <>
            <SettingRow label="Schedule Start (IST)" type="text" value={settings.scheduleStart || '09:00'} onChange={v => updateSetting('scheduleStart', v)} />
            <SettingRow label="Schedule End (IST)" type="text" value={settings.scheduleEnd || '21:00'} onChange={v => updateSetting('scheduleEnd', v)} />
          </>
        )}
      </div>

      <h3 style={{ ...styles.sectionTitle, fontSize: '16px', marginTop: '24px' }}>Messages</h3>
      <div style={styles.settingsGrid}>
        <SettingTextarea label="Media Reply Message" value={settings.mediaMessage} onChange={v => updateSetting('mediaMessage', v)} />
        <SettingTextarea label="Defer Reply Message" value={settings.deferMessage} onChange={v => updateSetting('deferMessage', v)} />
      </div>

      <h3 style={{ ...styles.sectionTitle, fontSize: '16px', marginTop: '24px' }}>Vector Search</h3>
      <p style={{ color: '#94a3b8', fontSize: 13, margin: '0 0 12px' }}>
        One simple rule: if the best vector match is ≥ {Math.round((settings.confidenceThreshold || 0.80) * 100)}%, AI answers. Below that, defer to Ketu.
      </p>
      <div style={{ background: '#1e293b', borderRadius: 10, padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13, textAlign: 'center' }}>
          <div style={{ background: '#14532d', borderRadius: 8, padding: 12 }}>
            <div style={{ color: '#22c55e', fontWeight: 700, fontSize: 18 }}>≥ {Math.round((settings.confidenceThreshold || 0.80) * 100)}%</div>
            <div style={{ color: '#86efac', marginTop: 4 }}>AI answers → sends to Claude</div>
          </div>
          <div style={{ background: '#450a0a', borderRadius: 8, padding: 12 }}>
            <div style={{ color: '#ef4444', fontWeight: 700, fontSize: 18 }}>{'<'} {Math.round((settings.confidenceThreshold || 0.80) * 100)}%</div>
            <div style={{ color: '#fca5a5', marginTop: 4 }}>Defer to Ketu (0 tokens)</div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: '24px' }}>
        <button style={styles.btnPrimary} onClick={onDownload}>Download Knowledge Base</button>
      </div>
    </div>
  )
}

function SettingRow({ label, type, value, onChange, step }) {
  if (type === 'toggle') {
    return (
      <div style={styles.settingRow}>
        <label style={styles.settingLabel}>{label}</label>
        <button
          style={{ ...styles.toggleSmall, background: value ? '#22c55e' : '#6b7280' }}
          onClick={() => onChange(!value)}
        >
          {value ? 'ON' : 'OFF'}
        </button>
      </div>
    )
  }
  return (
    <div style={styles.settingRow}>
      <label style={styles.settingLabel}>{label}</label>
      <input
        style={styles.input}
        type={type}
        value={value}
        step={step}
        onChange={e => onChange(e.target.value)}
      />
    </div>
  )
}

function SettingTextarea({ label, value, onChange, rows = 3 }) {
  return (
    <div style={styles.settingRow}>
      <label style={styles.settingLabel}>{label}</label>
      <textarea style={styles.textarea} value={value} onChange={e => onChange(e.target.value)} rows={rows} />
    </div>
  )
}

function PreAIFilters({ stats, period, setPeriod, onRefresh, dbFilters }) {
  const [expandedFilter, setExpandedFilter] = useState(null)
  const [newKeyword, setNewKeyword] = useState('')

  useEffect(() => { onRefresh() }, [period])

  const typeColors = {
    system: '#3b82f6',
    message: '#8b5cf6',
    keyword: '#f59e0b',
    user: '#10b981',
    'auto-reply': '#06b6d4',
    'ai-match': '#ec4899',
    'post-ai': '#ef4444',
  }

  const typeLabels = {
    system: 'System',
    message: 'Message Type',
    keyword: 'Keyword Match',
    user: 'User Action',
    'auto-reply': 'Auto Reply',
    'ai-match': 'AI Match',
    'post-ai': 'Post-AI',
  }

  // --- Keyword management handlers ---
  const removeKeyword = async (filterId, keyword) => {
    await fetch(`${API}/filters/${filterId}/keywords/${encodeURIComponent(keyword)}`, { method: 'DELETE' })
    onRefresh()
  }

  const addKeyword = async (filterId) => {
    if (!newKeyword.trim()) return
    await fetch(`${API}/filters/${filterId}/keywords`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: newKeyword.trim() }),
    })
    setNewKeyword('')
    onRefresh()
  }

  const toggleFilter = async (filterId, enabled) => {
    await fetch(`${API}/filters/${filterId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    onRefresh()
  }

  if (!stats) return <div style={{ padding: 20, color: '#94a3b8' }}>Loading filter stats...</div>

  const totalSaved = stats.totalFiltered
  const totalMessages = stats.totalMessages
  const savedPct = totalMessages > 0 ? ((totalSaved / totalMessages) * 100).toFixed(1) : '0'

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, color: '#f1f5f9', fontSize: 18 }}>Pre-AI Filters</h2>
          <p style={{ margin: '4px 0 0', color: '#94a3b8', fontSize: 13 }}>
            All rules that run BEFORE Claude is called — 0 tokens consumed
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {['today', 'week', 'month'].map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              style={{
                padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13,
                background: period === p ? '#3b82f6' : '#334155', color: period === p ? '#fff' : '#94a3b8',
              }}
            >
              {p === 'today' ? 'Today' : p === 'week' ? '7 Days' : '30 Days'}
            </button>
          ))}
        </div>
      </div>

      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
        <div style={{ background: '#1e293b', borderRadius: 10, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#22c55e' }}>{totalSaved}</div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>Messages Filtered</div>
          <div style={{ fontSize: 11, color: '#64748b' }}>(0 tokens used)</div>
        </div>
        <div style={{ background: '#1e293b', borderRadius: 10, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#3b82f6' }}>{stats.totalReachedClaude}</div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>Reached Claude</div>
          <div style={{ fontSize: 11, color: '#64748b' }}>(tokens consumed)</div>
        </div>
        <div style={{ background: '#1e293b', borderRadius: 10, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#f59e0b' }}>{savedPct}%</div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>Filtered Rate</div>
          <div style={{ fontSize: 11, color: '#64748b' }}>({totalSaved} of {totalMessages})</div>
        </div>
      </div>

      {/* Pipeline Flow */}
      <div style={{ background: '#1e293b', borderRadius: 10, padding: 16, marginBottom: 20 }}>
        <h3 style={{ margin: '0 0 12px', color: '#f1f5f9', fontSize: 14 }}>Message Pipeline Flow</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
          <span style={{ background: '#334155', padding: '4px 10px', borderRadius: 6, color: '#f1f5f9' }}>Incoming Message</span>
          <span style={{ color: '#64748b' }}>→</span>
          {stats.filters.filter(f => f.type !== 'post-ai').map((f, i) => (
            <React.Fragment key={f.id}>
              <span style={{
                background: f.triggered > 0 ? typeColors[f.type] + '22' : '#334155',
                border: `1px solid ${typeColors[f.type] || '#475569'}`,
                padding: '4px 10px', borderRadius: 6, color: typeColors[f.type] || '#94a3b8', fontSize: 11,
              }}>
                {f.name.length > 15 ? f.name.substring(0, 15) + '...' : f.name}
                {typeof f.triggered === 'number' && f.triggered > 0 && (
                  <span style={{ marginLeft: 4, background: typeColors[f.type], color: '#fff', borderRadius: 10, padding: '1px 6px', fontSize: 10 }}>{f.triggered}</span>
                )}
              </span>
              {i < stats.filters.filter(f2 => f2.type !== 'post-ai').length - 1 && <span style={{ color: '#64748b' }}>→</span>}
            </React.Fragment>
          ))}
          <span style={{ color: '#64748b' }}>→</span>
          <span style={{ background: '#22c55e22', border: '1px solid #22c55e', padding: '4px 10px', borderRadius: 6, color: '#22c55e' }}>Claude AI</span>
        </div>
      </div>

      {/* Filter List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {stats.filters.map((filter) => {
          const isDbFilter = !!filter.dbFilterId
          return (
          <div
            key={filter.id}
            style={{
              background: '#1e293b', borderRadius: 10, padding: '14px 16px', cursor: 'pointer',
              border: expandedFilter === filter.id ? `1px solid ${typeColors[filter.type] || '#475569'}` : '1px solid transparent',
              opacity: filter.enabled === false ? 0.5 : 1,
            }}
            onClick={() => setExpandedFilter(expandedFilter === filter.id ? null : filter.id)}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{
                  background: typeColors[filter.type] || '#475569', color: '#fff', fontSize: 10,
                  padding: '2px 8px', borderRadius: 10, fontWeight: 600, textTransform: 'uppercase',
                }}>
                  {typeLabels[filter.type] || filter.type}
                </span>
                <span style={{ color: '#f1f5f9', fontSize: 14, fontWeight: 500 }}>{filter.name}</span>
                {filter.isSystem === false && (
                  <span style={{ background: '#7c3aed22', color: '#a78bfa', fontSize: 9, padding: '1px 6px', borderRadius: 4 }}>CUSTOM</span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {/* Enable/Disable toggle for DB filters */}
                {isDbFilter && (
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleFilter(filter.dbFilterId, !filter.enabled) }}
                    style={{
                      padding: '3px 10px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 11,
                      background: filter.enabled ? '#22c55e33' : '#ef444433',
                      color: filter.enabled ? '#22c55e' : '#ef4444',
                    }}
                  >
                    {filter.enabled ? 'ON' : 'OFF'}
                  </button>
                )}
                <span style={{
                  color: typeof filter.triggered === 'number' && filter.triggered > 0 ? '#f59e0b' : '#64748b',
                  fontSize: 13, fontWeight: 600,
                }}>
                  {typeof filter.triggered === 'number' ? filter.triggered : filter.triggered}x
                </span>
                <span style={{
                  color: filter.tokens === 0 ? '#22c55e' : '#ef4444', fontSize: 12,
                  background: filter.tokens === 0 ? '#22c55e22' : '#ef444422',
                  padding: '2px 8px', borderRadius: 6,
                }}>
                  {filter.tokens === 0 ? '0 tokens' : 'Uses tokens'}
                </span>
              </div>
            </div>

            {expandedFilter === filter.id && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #334155' }} onClick={(e) => e.stopPropagation()}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13 }}>
                  <div>
                    <span style={{ color: '#64748b' }}>Description: </span>
                    <span style={{ color: '#cbd5e1' }}>{filter.description}</span>
                  </div>
                  <div>
                    <span style={{ color: '#64748b' }}>Current State: </span>
                    <span style={{ color: '#cbd5e1' }}>{filter.currentState}</span>
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <span style={{ color: '#64748b' }}>Action: </span>
                    <span style={{ color: '#cbd5e1' }}>{filter.action}</span>
                  </div>
                </div>

                {/* Editable Keywords for DB filters */}
                {isDbFilter && filter.keywords && filter.keywords.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ color: '#64748b', fontSize: 12 }}>Keywords ({filter.keywords.length}): </span>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                      {filter.keywords.map(kw => (
                        <span key={kw} style={{
                          background: '#334155', color: '#94a3b8', padding: '2px 8px',
                          borderRadius: 4, fontSize: 11, display: 'flex', alignItems: 'center', gap: 4,
                        }}>
                          {kw}
                          <span
                            onClick={() => removeKeyword(filter.dbFilterId, kw)}
                            style={{ color: '#ef4444', cursor: 'pointer', marginLeft: 2, fontWeight: 700, fontSize: 13 }}
                            title="Remove keyword"
                          >x</span>
                        </span>
                      ))}
                      {/* Add keyword input */}
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input
                          type="text"
                          placeholder="+ add keyword"
                          value={expandedFilter === filter.id ? newKeyword : ''}
                          onChange={(e) => setNewKeyword(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { addKeyword(filter.dbFilterId); e.preventDefault() } }}
                          style={{
                            background: '#0f172a', color: '#f1f5f9', border: '1px solid #475569',
                            borderRadius: 4, padding: '2px 8px', fontSize: 11, width: 100,
                          }}
                        />
                        <button
                          onClick={() => addKeyword(filter.dbFilterId)}
                          style={{ background: '#22c55e33', color: '#22c55e', border: 'none', borderRadius: 4, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }}
                        >+</button>
                      </span>
                    </div>
                  </div>
                )}

                {/* Non-DB filter keywords (read-only) */}
                {!isDbFilter && filter.keywords && (
                  <div style={{ marginTop: 10 }}>
                    <span style={{ color: '#64748b', fontSize: 12 }}>Keywords: </span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                      {filter.keywords.map(kw => (
                        <span key={kw} style={{
                          background: '#334155', color: '#94a3b8', padding: '2px 8px',
                          borderRadius: 4, fontSize: 11,
                        }}>
                          {kw}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Honorific suffixes */}
                {stats.honorificSuffixes && filter.matchType === 'exact' && (
                  <div style={{ marginTop: 8 }}>
                    <span style={{ color: '#64748b', fontSize: 12 }}>Also matches with trailing: </span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                      {stats.honorificSuffixes.map(s => (
                        <span key={s} style={{
                          background: '#3b2f1e', color: '#f59e0b', padding: '2px 8px',
                          borderRadius: 4, fontSize: 11,
                        }}>
                          + {s}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

              </div>
            )}
          </div>
        )})}
      </div>


      {/* Legend */}
      <div style={{ marginTop: 20, background: '#1e293b', borderRadius: 10, padding: 14 }}>
        <h4 style={{ margin: '0 0 8px', color: '#94a3b8', fontSize: 12, textTransform: 'uppercase' }}>Filter Types</h4>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {Object.entries(typeLabels).map(([type, label]) => (
            <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: typeColors[type] }} />
              <span style={{ color: '#94a3b8', fontSize: 12 }}>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// (PulledPairsPanel removed — old keyword-based system)

function _PulledPairsPanelRemoved() {
  const [view, setView] = useState('summary')

  if (!data) return <div style={{ padding: 20, color: '#94a3b8' }}>Loading pulled pairs...</div>

  const { pairs, total, summary } = data
  const totalPages = Math.ceil(total / (data.pageSize || 50))

  return (
    <div style={{ padding: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ color: '#f1f5f9', margin: 0, fontSize: 18 }}>Pulled Pairs — Verification</h2>
        <div style={{ display: 'flex', gap: 4, background: '#1e293b', borderRadius: 8, padding: 3 }}>
          {['summary', 'details'].map(v => (
            <button key={v} onClick={() => setView(v)} style={{
              padding: '6px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13,
              background: view === v ? '#3b82f6' : 'transparent', color: view === v ? '#fff' : '#94a3b8',
            }}>
              {v === 'summary' ? 'Summary' : 'All Pairs'}
            </button>
          ))}
        </div>
      </div>

      {summary.totalPulled === 0 ? (
        <div style={{ color: '#64748b', fontSize: 14, padding: 40, textAlign: 'center', background: '#1e293b', borderRadius: 8 }}>
          No pairs pulled yet. Go to the Learning tab and click "Test 20 Pairs" first to verify, then "Pull 1000 Pairs" for full analysis.
        </div>
      ) : view === 'summary' ? (
        /* ===== SUMMARY VIEW ===== */
        <div>
          {/* Top-level stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 20 }}>
            {[
              { label: 'Total Pulled', value: summary.totalPulled, color: '#3b82f6' },
              { label: 'Reviewed', value: summary.reviewed, color: '#f1f5f9' },
              { label: 'Corrections Added', value: summary.corrections, color: '#ef4444' },
              { label: 'AI Would Handle', value: summary.aiHandled, color: '#22c55e' },
              { label: 'Skipped', value: summary.skipped, color: '#64748b' },
            ].map(s => (
              <div key={s.label} style={{ background: '#1e293b', borderRadius: 8, padding: 14 }}>
                <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 4 }}>{s.label}</div>
                <div style={{ color: s.color, fontSize: 22, fontWeight: 700 }}>{s.value}</div>
              </div>
            ))}
          </div>

          {/* What AI learned - big picture */}
          <div style={{ background: '#1e293b', borderRadius: 8, padding: 16, marginBottom: 20 }}>
            <h3 style={{ color: '#f1f5f9', margin: '0 0 12px', fontSize: 15 }}>What AI Learned from These Pairs</h3>
            <div style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.7 }}>
              <p style={{ margin: '0 0 8px' }}>
                Out of <strong style={{ color: '#f1f5f9' }}>{summary.totalPulled}</strong> buyer→Ketu pairs pulled from WhatsApp history:
              </p>
              <ul style={{ margin: '0 0 8px', paddingLeft: 20 }}>
                <li><strong style={{ color: '#ef4444' }}>{summary.corrections}</strong> pairs — AI would NOT have handled correctly. These have been added to <strong style={{ color: '#f1f5f9' }}>Defer to Ketu</strong> as corrections, so next time a similar question comes, your correct reply is used directly.</li>
                <li><strong style={{ color: '#22c55e' }}>{summary.aiHandled}</strong> pairs — AI already knows how to handle these correctly. No action needed.</li>
                {summary.skipped > 0 && <li><strong style={{ color: '#64748b' }}>{summary.skipped}</strong> pairs — skipped (too short or unclear to review).</li>}
              </ul>
              <p style={{ margin: '0 0 4px' }}>
                <strong style={{ color: '#f1f5f9' }}>{summary.categories.length} categories</strong> were identified across your conversations:
              </p>
            </div>
          </div>

          {/* Category breakdown */}
          <div style={{ background: '#1e293b', borderRadius: 8, padding: 16, marginBottom: 20 }}>
            <h3 style={{ color: '#f1f5f9', margin: '0 0 12px', fontSize: 15 }}>Category Breakdown</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {summary.categories.map(cat => {
                const pct = summary.totalPulled > 0 ? (cat.total / summary.totalPulled * 100).toFixed(1) : 0
                const failPct = cat.total > 0 ? (cat.corrections / cat.total * 100).toFixed(0) : 0
                const color = CATEGORY_COLORS[cat.name] || '#94a3b8'
                return (
                  <div key={cat.name} style={{ background: '#0f172a', borderRadius: 8, padding: 12, borderLeft: `3px solid ${color}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <div>
                        <span style={{ color: '#f1f5f9', fontSize: 14, fontWeight: 600 }}>{CATEGORY_LABELS[cat.name] || cat.name}</span>
                        <span style={{ color: '#64748b', fontSize: 12, marginLeft: 8 }}>{cat.total} pairs ({pct}%)</span>
                      </div>
                      <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
                        <span style={{ color: '#ef4444' }}>{cat.corrections} corrections</span>
                        <span style={{ color: '#64748b' }}>{failPct}% fail rate</span>
                      </div>
                    </div>
                    <div style={{ background: '#334155', borderRadius: 4, height: 6, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4 }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Verdict */}
          <div style={{ background: '#1e293b', borderRadius: 8, padding: 16 }}>
            <h3 style={{ color: '#f1f5f9', margin: '0 0 8px', fontSize: 15 }}>Verdict</h3>
            <div style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.7 }}>
              {summary.corrections > 0 ? (
                <p style={{ margin: 0 }}>
                  AI's biggest weakness is in <strong style={{ color: '#f1f5f9' }}>
                    {summary.categories.filter(c => c.corrections > 0).sort((a, b) => b.corrections - a.corrections).slice(0, 3).map(c => CATEGORY_LABELS[c.name] || c.name).join(', ')}
                  </strong> — these categories had the most corrections. The corrections are now stored and will be used to handle future similar questions automatically.
                </p>
              ) : (
                <p style={{ margin: 0 }}>No corrections were needed — AI would handle all these queries correctly.</p>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* ===== DETAILS VIEW ===== */
        <div>
          {/* Filters */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <select value={filter.category} onChange={e => onFilterChange({ ...filter, category: e.target.value })} style={{
              padding: '6px 12px', borderRadius: 6, border: '1px solid #334155', background: '#1e293b', color: '#f1f5f9', fontSize: 13,
            }}>
              <option value="">All Categories</option>
              {summary.categories.map(c => (
                <option key={c.name} value={c.name}>{CATEGORY_LABELS[c.name] || c.name} ({c.total})</option>
              ))}
            </select>
            <select value={filter.result} onChange={e => onFilterChange({ ...filter, result: e.target.value })} style={{
              padding: '6px 12px', borderRadius: 6, border: '1px solid #334155', background: '#1e293b', color: '#f1f5f9', fontSize: 13,
            }}>
              <option value="">All Results</option>
              <option value="correction_added">Correction Added ({summary.corrections})</option>
              <option value="ai_would_handle">AI Would Handle ({summary.aiHandled})</option>
              <option value="skipped">Skipped ({summary.skipped})</option>
            </select>
            <span style={{ color: '#64748b', fontSize: 13, alignSelf: 'center' }}>
              Showing {pairs.length} of {total} pairs (page {page}/{totalPages || 1})
            </span>
          </div>

          {/* Pairs list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pairs.map((p, i) => {
              const resultColor = RESULT_COLORS[p.reviewResult] || '#64748b'
              const catColor = CATEGORY_COLORS[p.category] || '#94a3b8'
              return (
                <div key={p.id} style={{ background: '#1e293b', borderRadius: 8, padding: 14, borderLeft: `3px solid ${resultColor}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ color: '#64748b', fontSize: 11 }}>#{(page - 1) * 50 + i + 1}</span>
                      {p.category && (
                        <span style={{ background: catColor + '22', color: catColor, fontSize: 11, padding: '2px 8px', borderRadius: 10, border: `1px solid ${catColor}44` }}>
                          {CATEGORY_LABELS[p.category] || p.category}
                        </span>
                      )}
                      <span style={{ background: resultColor + '22', color: resultColor, fontSize: 11, padding: '2px 8px', borderRadius: 10, border: `1px solid ${resultColor}44` }}>
                        {p.reviewResult === 'correction_added' ? 'Correction Added' : p.reviewResult === 'ai_would_handle' ? 'AI OK' : p.reviewResult || 'Pending'}
                      </span>
                    </div>
                    <span style={{ color: '#64748b', fontSize: 11 }}>{new Date(p.createdAt).toLocaleString('en-IN')}</span>
                  </div>
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ color: '#64748b', fontSize: 11, marginBottom: 2 }}>Buyer Message:</div>
                    <div style={{ color: '#f1f5f9', fontSize: 13, background: '#0f172a', padding: 8, borderRadius: 6 }}>{p.buyerMessage}</div>
                  </div>
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ color: '#64748b', fontSize: 11, marginBottom: 2 }}>Ketu's Reply:</div>
                    <div style={{ color: '#22c55e', fontSize: 13, background: '#0f172a', padding: 8, borderRadius: 6 }}>{p.ketuReply}</div>
                  </div>
                  {p.reviewNote && (
                    <div>
                      <div style={{ color: '#64748b', fontSize: 11, marginBottom: 2 }}>AI's Assessment:</div>
                      <div style={{ color: '#f59e0b', fontSize: 12, background: '#0f172a', padding: 8, borderRadius: 6, fontStyle: 'italic' }}>{p.reviewNote}</div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
              <button onClick={() => onPageChange(page - 1)} disabled={page <= 1} style={{
                padding: '6px 14px', borderRadius: 6, border: 'none', cursor: page <= 1 ? 'default' : 'pointer',
                background: '#334155', color: page <= 1 ? '#475569' : '#f1f5f9', fontSize: 13,
              }}>Previous</button>
              <span style={{ color: '#94a3b8', fontSize: 13, alignSelf: 'center' }}>Page {page} of {totalPages}</span>
              <button onClick={() => onPageChange(page + 1)} disabled={page >= totalPages} style={{
                padding: '6px 14px', borderRadius: 6, border: 'none', cursor: page >= totalPages ? 'default' : 'pointer',
                background: '#334155', color: page >= totalPages ? '#475569' : '#f1f5f9', fontSize: 13,
              }}>Next</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function LearningPanel({ stats, settings, onRun, running, onToggle, onRefresh, onBacklog, backlogProgress, onHistoryPull, historyPullProgress }) {
  if (!stats) return <div style={{ padding: 20, color: '#94a3b8' }}>Loading learning stats...</div>

  const costInr = (stats.dailyCost.spent * 85).toFixed(1)
  const budgetInr = (stats.dailyCost.budget * 85).toFixed(0)

  return (
    <div style={{ padding: 16 }}>
      {/* Header with toggle */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ color: '#f1f5f9', margin: 0, fontSize: 18 }}>Self-Learning AI</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={onRun}
            disabled={running || !settings?.learningEnabled}
            style={{
              padding: '6px 14px', borderRadius: 6, border: 'none', cursor: running ? 'wait' : 'pointer',
              background: '#3b82f6', color: '#fff', fontSize: 13, opacity: running ? 0.6 : 1,
            }}
          >
            {running ? 'Running...' : 'Run Now'}
          </button>
          <button
            onClick={() => onToggle(!settings?.learningEnabled)}
            style={{
              padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
              background: settings?.learningEnabled ? '#22c55e' : '#ef4444', color: '#fff', fontSize: 13,
            }}
          >
            {settings?.learningEnabled ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      {/* Cost bar */}
      <div style={{ background: '#1e293b', borderRadius: 8, padding: 12, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ color: '#94a3b8', fontSize: 13 }}>Today's Learning Cost</span>
          <span style={{ color: '#f1f5f9', fontSize: 13 }}>Rs {costInr} / Rs {budgetInr}</span>
        </div>
        <div style={{ background: '#334155', borderRadius: 4, height: 6, overflow: 'hidden' }}>
          <div style={{
            width: `${Math.min((stats.dailyCost.spent / stats.dailyCost.budget) * 100, 100)}%`,
            height: '100%', background: stats.dailyCost.spent >= stats.dailyCost.budget ? '#ef4444' : '#3b82f6',
            borderRadius: 4, transition: 'width 0.3s',
          }} />
        </div>
        {stats.lastReviewAt && (
          <div style={{ color: '#64748b', fontSize: 11, marginTop: 4 }}>
            Last review: {new Date(stats.lastReviewAt).toLocaleString('en-IN')}
          </div>
        )}
      </div>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 16 }}>
        {[
          { label: 'Total Corrections', value: stats.stats.totalCorrections, color: '#3b82f6' },
          { label: 'From Interventions', value: stats.stats.interventionCorrections, color: '#f59e0b' },
          { label: 'From Reviewer', value: stats.stats.reviewerCorrections, color: '#8b5cf6' },
          { label: 'From Manual Pairs', value: stats.stats.manualPairCorrections, color: '#06b6d4' },
          { label: 'AI Replies Reviewed', value: stats.stats.totalAiReviewed, color: '#22c55e' },
          { label: 'Avg Rating', value: stats.stats.avgRating ? stats.stats.avgRating.toFixed(1) + '/5' : 'N/A', color: '#f1f5f9' },
          { label: 'Pending Manual Pairs', value: stats.stats.pendingManualPairs, color: '#94a3b8' },
          { label: 'Learned Today', value: stats.stats.todayCorrections, color: '#22c55e' },
        ].map(s => (
          <div key={s.label} style={{ background: '#1e293b', borderRadius: 8, padding: 12 }}>
            <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 4 }}>{s.label}</div>
            <div style={{ color: s.color, fontSize: 20, fontWeight: 600 }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Reset manual pairs for re-review */}
      {stats.stats.totalManualReviewed > 0 && (
        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={async () => {
              if (!confirm(`Reset ${stats.stats.totalManualReviewed} reviewed manual pairs for re-review with Opus 4.6?`)) return
              const res = await fetch(`${API}/learning/reset-manual-pairs`, { method: 'POST' })
              if (res.ok) {
                const data = await res.json()
                alert(data.message)
                onRefresh()
              } else {
                alert('Failed to reset pairs')
              }
            }}
            style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #f59e0b', background: 'transparent', color: '#f59e0b', cursor: 'pointer', fontSize: 12 }}
          >
            Reset {stats.stats.totalManualReviewed} Reviewed Pairs for Re-review
          </button>
          <span style={{ color: '#64748b', fontSize: 11 }}>Pairs reviewed by wrong model can be re-reviewed with Opus 4.6</span>
        </div>
      )}

      {/* What I learned today */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ color: '#f1f5f9', margin: 0, fontSize: 15 }}>What I Learned (Last 24h)</h3>
          <button onClick={onRefresh} style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: 12 }}>Refresh</button>
        </div>
        {stats.recentLearnings.length === 0 ? (
          <div style={{ color: '#64748b', fontSize: 13, padding: 16, textAlign: 'center', background: '#1e293b', borderRadius: 8 }}>
            No new learnings in the last 24 hours
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {stats.recentLearnings.map(l => (
              <div key={l.id} style={{ background: '#1e293b', borderRadius: 8, padding: 12, borderLeft: '3px solid #3b82f6' }}>
                <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 4 }}>
                  {new Date(l.createdAt).toLocaleString('en-IN')}
                  {l.aiWrongReply === '[AI would not know]' ? ' — Learned from your manual reply' : ' — Fixed wrong AI reply'}
                </div>
                <div style={{ color: '#f1f5f9', fontSize: 13, marginBottom: 4 }}>
                  <strong>Buyer:</strong> {l.buyerQuestion}
                </div>
                {l.aiWrongReply && l.aiWrongReply !== '[AI would not know]' && (
                  <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 2 }}>
                    AI said (wrong): {l.aiWrongReply}
                  </div>
                )}
                <div style={{ color: '#22c55e', fontSize: 12 }}>
                  Correct reply: {l.correctReply}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Backlog review */}
      <div style={{ background: '#1e293b', borderRadius: 8, padding: 12, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div>
            <div style={{ color: '#f1f5f9', fontSize: 14, fontWeight: 600 }}>Review All Past Replies</div>
            <div style={{ color: '#64748b', fontSize: 12 }}>One-time review of your entire message history. Bootstraps corrections instantly.</div>
          </div>
          <button
            onClick={onBacklog}
            disabled={backlogProgress?.status === 'running'}
            style={{
              padding: '8px 16px', borderRadius: 6, border: 'none', cursor: backlogProgress?.status === 'running' ? 'wait' : 'pointer',
              background: '#8b5cf6', color: '#fff', fontSize: 13, opacity: backlogProgress?.status === 'running' ? 0.6 : 1,
            }}
          >
            {backlogProgress?.status === 'running' ? 'Running...' : 'Start Backlog Review'}
          </button>
        </div>
        {backlogProgress && (
          <div style={{ background: '#0f172a', borderRadius: 6, padding: 10, marginTop: 8 }}>
            <div style={{ color: backlogProgress.status === 'complete' ? '#22c55e' : backlogProgress.status === 'failed' ? '#ef4444' : '#f59e0b', fontSize: 13, marginBottom: 4 }}>
              {backlogProgress.status === 'running' ? `Batch ${backlogProgress.batchNumber} processing...` :
               backlogProgress.status === 'complete' ? 'Backlog review complete!' :
               `Failed: ${backlogProgress.error}`}
            </div>
            <div style={{ display: 'flex', gap: 16, color: '#94a3b8', fontSize: 12 }}>
              <span>Reviewed: {backlogProgress.totalReviewed}</span>
              <span>Corrections: {backlogProgress.totalCorrections}</span>
              <span>Cost: Rs {((backlogProgress.totalCostUsd || 0) * 85).toFixed(1)}</span>
              {backlogProgress.batches && <span>Batches: {backlogProgress.batches}</span>}
            </div>
          </div>
        )}
      </div>

      {/* History Pull from wwbun */}
      <div style={{ background: '#1e293b', borderRadius: 8, padding: 12, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div>
            <div style={{ color: '#f1f5f9', fontSize: 14, fontWeight: 600 }}>Pull History from WhatsApp</div>
            <div style={{ color: '#64748b', fontSize: 12 }}>Uses Opus 4.6 (best model) for reviewing pairs + cross-validates keywords across multiple messages.</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => onHistoryPull((stats?.stats?.pendingManualPairs || 0) + 10)}
              disabled={historyPullProgress?.status === 'running'}
              style={{
                padding: '8px 12px', borderRadius: 6, border: '1px solid #f59e0b', cursor: historyPullProgress?.status === 'running' ? 'wait' : 'pointer',
                background: 'transparent', color: '#f59e0b', fontSize: 12, opacity: historyPullProgress?.status === 'running' ? 0.6 : 1,
              }}
            >
              Test {(stats?.stats?.pendingManualPairs || 0) + 10} Pairs
            </button>
            <button
              onClick={() => onHistoryPull(1000)}
              disabled={historyPullProgress?.status === 'running'}
              style={{
                padding: '8px 16px', borderRadius: 6, border: 'none', cursor: historyPullProgress?.status === 'running' ? 'wait' : 'pointer',
                background: '#0ea5e9', color: '#fff', fontSize: 13, opacity: historyPullProgress?.status === 'running' ? 0.6 : 1,
              }}
            >
              {historyPullProgress?.status === 'running' ? 'Pulling...' : 'Pull 1000 Pairs'}
            </button>
          </div>
        </div>
        {historyPullProgress && (
          <div style={{ background: '#0f172a', borderRadius: 6, padding: 10, marginTop: 8 }}>
            <div style={{ color: historyPullProgress.status === 'complete' ? '#22c55e' : historyPullProgress.status === 'failed' ? '#ef4444' : '#f59e0b', fontSize: 13, marginBottom: 4 }}>
              {historyPullProgress.status === 'running'
                ? historyPullProgress.phase === 'fetching' ? 'Fetching pairs from WhatsApp...'
                : historyPullProgress.phase === 'stored' ? `Stored ${historyPullProgress.stored} pairs, starting review...`
                : historyPullProgress.phase === 'discovering_keywords' ? 'Discovering keywords for Pre-AI filters...'
                : `Reviewing batch ${historyPullProgress.batchNumber}...`
                : historyPullProgress.status === 'complete' ? 'History pull complete!'
                : `Failed: ${historyPullProgress.error}`}
            </div>
            <div style={{ display: 'flex', gap: 16, color: '#94a3b8', fontSize: 12, flexWrap: 'wrap' }}>
              <span>Fetched: {historyPullProgress.fetched || 0}</span>
              <span>Stored: {historyPullProgress.stored || 0}</span>
              <span>Reviewed: {historyPullProgress.totalReviewed || historyPullProgress.reviewed || 0}</span>
              <span>Corrections: {historyPullProgress.totalCorrections || historyPullProgress.corrections || 0}</span>
              <span>Cost: Rs {((historyPullProgress.totalCostUsd || historyPullProgress.costUsd || 0) * 85).toFixed(1)}</span>
            </div>
            {historyPullProgress.categories && Object.keys(historyPullProgress.categories).length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 4 }}>Categories found:</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {Object.entries(historyPullProgress.categories).sort((a, b) => b[1] - a[1]).map(([cat, count]) => (
                    <span key={cat} style={{ background: '#334155', color: '#e2e8f0', fontSize: 11, padding: '2px 8px', borderRadius: 10 }}>
                      {cat}: {count}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Keyword Discovery Results */}
            {historyPullProgress.keywordsDiscovered && (historyPullProgress.keywordsDiscovered.autoAdded > 0 || historyPullProgress.keywordsDiscovered.pending > 0) && (
              <div style={{ marginTop: 10, padding: 10, background: '#7c3aed15', borderRadius: 6, border: '1px solid #7c3aed33' }}>
                <div style={{ color: '#a78bfa', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                  Keywords Discovered for Pre-AI Filters
                </div>
                <div style={{ display: 'flex', gap: 16, color: '#cbd5e1', fontSize: 12 }}>
                  <span style={{ color: '#22c55e' }}>{historyPullProgress.keywordsDiscovered.autoAdded} auto-added</span>
                  <span style={{ color: '#f59e0b' }}>{historyPullProgress.keywordsDiscovered.pending} need your review</span>
                </div>
                {historyPullProgress.keywordsDiscovered.pending > 0 && historyPullProgress.status === 'complete' && (
                  <button
                    onClick={() => {
                      // Switch to Pre-AI Filters tab (parent handles this via a callback)
                      // For now, just inform the user
                      document.querySelector('[data-tab="filters"]')?.click()
                    }}
                    style={{
                      marginTop: 8, padding: '5px 14px', borderRadius: 6, border: '1px solid #7c3aed',
                      background: 'transparent', color: '#a78bfa', fontSize: 12, cursor: 'pointer',
                    }}
                  >
                    View in Pre-AI Filters →
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* How it works */}
      <div style={{ background: '#1e293b', borderRadius: 8, padding: 12, color: '#64748b', fontSize: 12 }}>
        <strong style={{ color: '#94a3b8' }}>How Self-Learning Works:</strong>
        <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
          <li>When AI is ON and you intervene — AI's wrong reply + your correct reply auto-saved (free, instant)</li>
          <li>When AI is OFF — your manual replies are stored and reviewed every {settings?.learningIntervalHours || 4} hours by Sonnet 4.6</li>
          <li>Sonnet decides if AI would have handled it. If not, adds your reply as a correction</li>
          <li>Next time a similar question comes, the correction is used directly (0 tokens)</li>
        </ul>
      </div>
    </div>
  )
}

function SyncPanel({ logs, settings, onSync, syncing, knowledge }) {
  const [showSection, setShowSection] = useState({ instructions: true, conditionalRules: false, policies: false, catalog: false, replies: false, styleGuide: false, stylePairs: false, deferList: false, history: false })
  const toggle = (key) => setShowSection(prev => ({ ...prev, [key]: !prev[key] }))

  // Export premium pairs state
  const [exportFromDate, setExportFromDate] = useState('')
  const [exportToDate, setExportToDate] = useState(new Date().toISOString().split('T')[0])
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState(null)
  const [exportError, setExportError] = useState(null)
  const [templateExporting, setTemplateExporting] = useState(false)
  const [templateResult, setTemplateResult] = useState(null)
  const [templateError, setTemplateError] = useState(null)

  const handleExportPairs = async () => {
    if (!exportFromDate || !exportToDate) return
    setExporting(true)
    setExportError(null)
    setExportResult(null)
    try {
      const res = await fetch('/api/export/premium-pairs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromDate: exportFromDate, toDate: exportToDate }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Export failed')
      setExportResult(data)
    } catch (err) {
      setExportError(err.message)
    } finally {
      setExporting(false)
    }
  }

  const downloadExport = () => {
    if (!exportResult?.textExport) return
    const blob = new Blob([exportResult.textExport], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `premium-pairs-${exportFromDate}-to-${exportToDate}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  const catalogItems = knowledge?.chunks?.CATALOG || []
  const savedReplies = knowledge?.chunks?.SAVED_REPLY || []
  const policies = knowledge?.chunks?.POLICY || []
  const stylePairs = knowledge?.chunks?.STYLE_PAIR || []
  const styleGuides = knowledge?.chunks?.STYLE_GUIDE || []
  const deferItems = knowledge?.deferToKetuList || []
  const kbSettings = knowledge?.settings || {}

  return (
    <div>
      <h2 style={styles.sectionTitle}>Complete Knowledge Base</h2>

      <div style={styles.syncInfo}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
          <div>
            <p style={{ margin: '0 0 4px' }}><strong>Last sync:</strong> {settings.lastSyncAt ? new Date(settings.lastSyncAt).toLocaleString('en-IN') : 'Never'}</p>
            <p style={{ margin: '0 0 4px' }}><strong>Next sync:</strong> {settings.nextSyncAt ? new Date(settings.nextSyncAt).toLocaleString('en-IN') : 'Not scheduled'}</p>
            <p style={{ margin: 0, color: '#94a3b8', fontSize: '13px' }}>
              <strong>Total:</strong> {knowledge?.totalChunks || 0} chunks — {catalogItems.length} products, {savedReplies.length} saved replies, {styleGuides.length > 0 ? '1 style guide' : '0 style guide'} ({stylePairs.length} pairs), {policies.length} policies, {deferItems.length} defer rules
            </p>
          </div>
          <button style={styles.btnPrimary} onClick={onSync} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
        </div>
      </div>

      {/* Export Premium Pairs */}
      <div style={{ ...styles.syncInfo, marginTop: '12px', borderColor: '#854d0e' }}>
        <div style={{ fontWeight: '600', color: '#fbbf24', fontSize: '14px', marginBottom: '8px' }}>Export Premium Style Pairs</div>
        <p style={{ margin: '0 0 8px', color: '#94a3b8', fontSize: '12px' }}>
          Extract high-quality buyer→Om reply pairs (Rules 1-4: thought bundling, 4+ words, non-context, permanent only). Downloads as text file.
        </p>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ color: '#94a3b8', fontSize: '12px' }}>From:</label>
          <input type="date" value={exportFromDate} onChange={e => setExportFromDate(e.target.value)}
            style={{ background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: '4px', padding: '4px 8px', fontSize: '13px' }} />
          <label style={{ color: '#94a3b8', fontSize: '12px' }}>To:</label>
          <input type="date" value={exportToDate} onChange={e => setExportToDate(e.target.value)}
            style={{ background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: '4px', padding: '4px 8px', fontSize: '13px' }} />
          <button style={{ ...styles.btnPrimary, background: '#854d0e' }} onClick={handleExportPairs} disabled={exporting || !exportFromDate}>
            {exporting ? 'Exporting...' : 'Export Pairs'}
          </button>
          {exportResult && (
            <button style={{ ...styles.btnPrimary, background: '#166534' }} onClick={downloadExport}>
              Download ({exportResult.totalPremium} pairs)
            </button>
          )}
        </div>
        {exportResult && (
          <p style={{ margin: '8px 0 0', color: '#4ade80', fontSize: '12px' }}>
            {exportResult.totalMechanical} mechanical pairs → {exportResult.totalPremium} premium (skipped {exportResult.totalSkipped} context/temporary)
          </p>
        )}
        {exportError && <p style={{ margin: '8px 0 0', color: '#f87171', fontSize: '12px' }}>{exportError}</p>}
      </div>

      {/* Export Cleaned Reply Templates */}
      <div style={{ ...styles.syncInfo, marginTop: '12px', borderColor: '#166534' }}>
        <div style={{ fontWeight: '600', color: '#4ade80', fontSize: '14px', marginBottom: '8px' }}>Export Cleaned Reply Templates</div>
        <p style={{ margin: '0 0 8px', color: '#94a3b8', fontSize: '12px' }}>
          Saved reply templates cleaned for AI: removes catalog-redundant links, duplicates, temporary content. Each template tagged with category.
        </p>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <button style={{ ...styles.btnPrimary, background: '#166534' }} onClick={async () => {
            setTemplateExporting(true); setTemplateError(null); setTemplateResult(null)
            try {
              const res = await fetch('/api/export/cleaned-templates')
              const data = await res.json()
              if (!res.ok) throw new Error(data.error || 'Export failed')
              setTemplateResult(data)
            } catch (err) { setTemplateError(err.message) }
            finally { setTemplateExporting(false) }
          }} disabled={templateExporting}>
            {templateExporting ? 'Exporting...' : 'Export Templates'}
          </button>
          {templateResult && (
            <button style={{ ...styles.btnPrimary, background: '#854d0e' }} onClick={() => {
              const blob = new Blob([templateResult.textExport], { type: 'text/plain' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a'); a.href = url
              a.download = `reply-templates-clean-${new Date().toISOString().split('T')[0]}.txt`
              a.click(); URL.revokeObjectURL(url)
            }}>
              Download ({templateResult.totalClean} templates)
            </button>
          )}
        </div>
        {templateResult && (
          <p style={{ margin: '8px 0 0', color: '#4ade80', fontSize: '12px' }}>
            {templateResult.totalClean} cleaned templates ready for download
          </p>
        )}
        {templateError && <p style={{ margin: '8px 0 0', color: '#f87171', fontSize: '12px' }}>{templateError}</p>}
      </div>

      {/* AI Instructions (System Prompt) */}
      <div style={styles.kbSection}>
        <div style={styles.kbHeader} onClick={() => toggle('instructions')}>
          <span style={styles.kbHeaderTitle}>AI Instructions (System Prompt)</span>
          <span style={{ color: '#64748b' }}>{showSection.instructions ? '▼' : '▶'}</span>
        </div>
        {showSection.instructions && (
          <div style={styles.kbContent}>
            <div style={styles.kbCard}>
              <div style={{ fontWeight: '600', color: '#f59e0b', fontSize: '13px', marginBottom: '8px' }}>SYSTEM PROMPT — sent with every message to Claude</div>
              <div style={styles.promptBlock}>
                {`You are Ketu's assistant — an AI that replies to WhatsApp buyers for a wholesale blank t-shirt business (BulkPlainTshirt.com / sale91.com).

RULES:
- Reply in the buyer's language. Hindi → Hindi, English → English, Hinglish → Hinglish.
- Be friendly, professional, and helpful. Sound like a real person, not a robot.
- Keep replies SHORT — max 10-15 words. Quick, direct, to the point.
- Match Ketu's style from STYLE EXAMPLES (pulled from Defer-to-Ketu corrections).
- Never make up information. Only use the knowledge provided.
- If not enough info → respond with EXACTLY: [DEFER]
- Do NOT make up prices, product details, or policies.
- Never reveal you are an AI. You are Ketu's assistant.
- Natural greetings (Namaste, Hello, Hi, etc.).

STYLE EXAMPLES — dynamically loaded from Om's Defer-to-Ketu corrections
(up to 10 real examples of how Ketu replies, teaching tone + length + word choice)`}
              </div>
              <div style={{ marginTop: '8px', padding: '8px', background: '#422006', borderRadius: '4px', fontSize: '12px', color: '#fbbf24' }}>
                For first-time buyers: MUST include sale91.com/catalog link in reply
              </div>
            </div>

            <div style={styles.kbCard}>
              <div style={{ fontWeight: '600', color: '#a78bfa', fontSize: '13px', marginBottom: '8px' }}>HOW KNOWLEDGE IS SENT (OPTIMIZED)</div>
              <div style={{ fontSize: '12px', color: '#94a3b8', lineHeight: '1.6' }}>
                <div style={{ marginBottom: '4px', color: '#93c5fd' }}>0. First-time / 7-day inactive → welcome message sent directly (0 tokens!)</div>
                <div style={{ marginBottom: '4px' }}>1. Smart filtering picks only relevant chunks (~2-3K tokens instead of 8K)</div>
                <div style={{ marginBottom: '4px' }}>2. Product keywords → sends catalog + policies</div>
                <div style={{ marginBottom: '4px' }}>3. Logistics keywords → sends matching saved replies + policies</div>
                <div style={{ marginBottom: '4px' }}>4. Policies always included (small, always relevant)</div>
                <div style={{ marginBottom: '4px' }}>5. Last 5 conversation messages included for context</div>
                <div style={{ marginBottom: '4px' }}>6. Om's style examples (from corrections) included in system prompt</div>
              </div>
            </div>

            <div style={styles.kbCard}>
              <div style={{ fontWeight: '600', color: '#f87171', fontSize: '13px', marginBottom: '8px' }}>PROCESSING PIPELINE</div>
              <div style={{ fontSize: '12px', color: '#94a3b8', lineHeight: '1.8' }}>
                <div>Message received from WhatsApp (via wwbun)</div>
                <div style={{ color: '#475569' }}>  ↓ 3-sec merge window (multiple messages = one thought)</div>
                <div>Check 1: Is system ON? → skip if OFF</div>
                <div>Check 2: Working hours? → skip if outside {settings.scheduleStart || '09:00'}-{settings.scheduleEnd || '21:00'} IST</div>
                <div>Check 3: Daily budget? → skip if over Rs.{settings.dailyBudgetInr}</div>
                <div>Check 4: Media only? → send media message</div>
                <div>Check 5: Empty/spam? → skip</div>
                <div>Check 6: Cooldown? → skip if Om intervened (last {settings.cooldownMinutes} min)</div>
                <div>Check 7: Post-defer ack? → skip "ok/thanks/theek hai" after defer</div>
                <div style={{ color: '#93c5fd', fontWeight: '600' }}>Check 8: WELCOME BYPASS → first-time or 7+ days inactive → send /welcome directly (0 tokens!)</div>
                <div>Check 9: Greeting? → skip defer check for hi/hello</div>
                <div>Check 10: Defer-to-Ketu match? → use correction or defer (threshold: {Math.round((settings.confidenceThreshold || 0.80) * 100)}%)</div>
                <div>Check 11: KB empty? → defer if no knowledge</div>
                <div style={{ color: '#475569' }}>  ↓</div>
                <div style={{ color: '#22c55e' }}>Smart filtering: only relevant chunks sent (~2-3K tokens instead of 8K)</div>
                <div style={{ color: '#22c55e' }}>+ system prompt + style examples + conversation history → Claude Haiku 4.5</div>
                <div style={{ color: '#475569' }}>  ↓</div>
                <div>If [DEFER] in reply → send defer message to buyer</div>
                <div style={{ color: '#22c55e' }}>Otherwise → send AI reply via wwbun → log tokens + cost</div>
              </div>
            </div>

            <div style={styles.kbCard}>
              <div style={{ fontWeight: '600', color: '#60a5fa', fontSize: '13px', marginBottom: '8px' }}>CONFIGURED MESSAGES</div>
              <div style={{ fontSize: '12px', marginBottom: '6px' }}>
                <span style={{ color: '#64748b' }}>Defer message:</span>
                <div style={{ color: '#fbbf24', marginTop: '2px' }}>{kbSettings.deferMessage || settings.deferMessage}</div>
              </div>
              <div style={{ fontSize: '12px' }}>
                <span style={{ color: '#64748b' }}>Media message:</span>
                <div style={{ color: '#fbbf24', marginTop: '2px' }}>{kbSettings.mediaMessage || settings.mediaMessage}</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Conditional Rules (situational — only sent when keywords match) */}
      <div style={styles.kbSection}>
        <div style={styles.kbHeader} onClick={() => toggle('conditionalRules')}>
          <span style={styles.kbHeaderTitle}>Conditional Rules (Situational)</span>
          <span style={{ color: '#64748b' }}>{showSection.conditionalRules ? '▼' : '▶'}</span>
        </div>
        {showSection.conditionalRules && (
          <div style={styles.kbContent}>
            <div style={{ padding: '8px 12px', background: '#1e293b', borderRadius: '6px', fontSize: '12px', color: '#94a3b8', marginBottom: '12px' }}>
              These rules are <strong style={{ color: '#f59e0b' }}>NOT sent with every message</strong>. They are only included when the buyer's message matches specific keywords.
            </div>

            <div style={styles.kbCard}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <div style={{ fontWeight: '600', color: '#22c55e', fontSize: '13px' }}>DISPATCH RULE</div>
                <div style={{ fontSize: '11px', color: '#64748b', background: '#1e293b', padding: '2px 8px', borderRadius: '4px' }}>Conditional</div>
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '8px' }}>
                <div style={{ color: '#60a5fa', marginBottom: '4px' }}>Trigger keywords:</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '8px' }}>
                  {['dispatch', 'nikal', 'bhej', 'ship', 'send', 'deliver', 'courier'].map(kw => (
                    <span key={kw} style={{ background: '#1e3a5f', color: '#93c5fd', padding: '2px 6px', borderRadius: '3px', fontSize: '11px' }}>{kw}</span>
                  ))}
                </div>
                <div style={{ color: '#60a5fa', marginBottom: '4px' }}>OR payment + urgency combo:</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '4px' }}>
                  {['payment', 'paid', 'pay', 'paisa', 'paise', 'amount', 'transfer'].map(kw => (
                    <span key={kw} style={{ background: '#3b2f1a', color: '#fbbf24', padding: '2px 6px', borderRadius: '3px', fontSize: '11px' }}>{kw}</span>
                  ))}
                </div>
                <div style={{ fontSize: '11px', color: '#64748b', margin: '2px 0' }}>+</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {['abhi', 'aaj', 'now', 'today', 'jaldi', 'asap', 'urgent', 'turant'].map(kw => (
                    <span key={kw} style={{ background: '#3b1a1a', color: '#fca5a5', padding: '2px 6px', borderRadius: '3px', fontSize: '11px' }}>{kw}</span>
                  ))}
                </div>
              </div>
              <div style={{ ...styles.promptBlock, marginTop: '8px' }}>
                {`DISPATCH RULE (sent to Claude when triggered):
- When buyer's intention is "payment done, please dispatch" or "abhi nikal do" or "aaj hi chahiye" → reassure: "Abhi nikal raha hu sir, thoda time dijiye"
- Do NOT say "kal nikal jaayega" or give future dates. Just confirm immediate dispatch.
- If buyer keeps asking too many follow-up dispatch questions → [DEFER] to Ketu.`}
              </div>
            </div>

            <div style={styles.kbCard}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <div style={{ fontWeight: '600', color: '#22c55e', fontSize: '13px' }}>SALE91 RULE</div>
                <div style={{ fontSize: '11px', color: '#64748b', background: '#1e293b', padding: '2px 8px', borderRadius: '4px' }}>Conditional</div>
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '8px' }}>
                <div style={{ color: '#60a5fa', marginBottom: '4px' }}>Trigger keywords (buying intent):</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {['price', 'rate', 'cost', 'kitna', 'kitne', 'bhav', 'daam', 'order', 'buy', 'kharidna', 'lena', 'chahiye', 'moq', 'minimum', 'bulk', 'wholesale', 'sample', 'catalog'].map(kw => (
                    <span key={kw} style={{ background: '#1e3a5f', color: '#93c5fd', padding: '2px 6px', borderRadius: '3px', fontSize: '11px' }}>{kw}</span>
                  ))}
                </div>
              </div>
              <div style={{ ...styles.promptBlock, marginTop: '8px' }}>
                {`SALE91 RULE (sent to Claude when triggered):
- Mention sale91.com ONLY ONCE. Check conversation history — if already shared in a previous reply, do NOT repeat it. Just answer the buyer's question directly. Don't force it.`}
              </div>
            </div>

            <div style={styles.kbCard}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <div style={{ fontWeight: '600', color: '#22c55e', fontSize: '13px' }}>PRICE NEGOTIATION RULE</div>
                <div style={{ fontSize: '11px', color: '#64748b', background: '#1e293b', padding: '2px 8px', borderRadius: '4px' }}>Conditional</div>
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '8px' }}>
                <div style={{ color: '#60a5fa', marginBottom: '4px' }}>Trigger keywords (price negotiation):</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {['price jada', 'price zyada', 'mehnga', 'costly', 'expensive', 'sasta', 'kam karo', 'discount', 'offer', 'deal', 'thoda kam', 'rate kam'].map(kw => (
                    <span key={kw} style={{ background: '#3b1a1a', color: '#fca5a5', padding: '2px 6px', borderRadius: '3px', fontSize: '11px' }}>{kw}</span>
                  ))}
                </div>
              </div>
              <div style={{ ...styles.promptBlock, marginTop: '8px' }}>
                {`PRICE NEGOTIATION RULE (sent to Claude when triggered):
- Prices are FIXED. We work on very low margins (kam margin pe kaam karte hai).
- Do NOT offer any discount or negotiate. Politely tell them price is fixed.
- Understand buyer's intention and reply naturally — don't copy-paste the same line.
- Example tone: "Sir, price hamara fix hota hai. Hum log kafi kam margin pe kaam karte hai."`}
              </div>
            </div>

            <div style={{ padding: '8px 12px', background: '#422006', borderRadius: '6px', fontSize: '12px', color: '#fbbf24', marginTop: '8px' }}>
              FIRST-TIME BUYER RULE: When buyer messages for the first time ever → "MUST include sale91.com/catalog link in reply" (always added for first-time buyers)
            </div>
          </div>
        )}
      </div>

      {/* Business Policies */}
      <div style={styles.kbSection}>
        <div style={styles.kbHeader} onClick={() => toggle('policies')}>
          <span style={styles.kbHeaderTitle}>Business Policies ({policies.length})</span>
          <span style={{ color: '#64748b' }}>{showSection.policies ? '▼' : '▶'}</span>
        </div>
        {showSection.policies && (
          <div style={styles.kbContent}>
            {policies.length === 0 && <p style={styles.empty}>No policies synced yet</p>}
            {policies.map((item, i) => (
              <div key={i} style={styles.kbCard}>
                <div style={{ fontWeight: '600', color: '#f8fafc', fontSize: '14px', marginBottom: '8px' }}>{item.title}</div>
                <div style={{ fontSize: '13px', color: '#cbd5e1', whiteSpace: 'pre-wrap', lineHeight: '1.5' }}>
                  {item.content}
                </div>
                <div style={{ marginTop: '4px', fontSize: '11px', color: '#475569' }}>
                  Synced: {new Date(item.updatedAt).toLocaleString('en-IN')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Synced Catalog */}
      <div style={styles.kbSection}>
        <div style={styles.kbHeader} onClick={() => toggle('catalog')}>
          <span style={styles.kbHeaderTitle}>Synced Catalog ({catalogItems.length} products)</span>
          <span style={{ color: '#64748b' }}>{showSection.catalog ? '▼' : '▶'}</span>
        </div>
        {showSection.catalog && (
          <div style={styles.kbContent}>
            {catalogItems.length === 0 && <p style={styles.empty}>No catalog products synced yet</p>}
            {catalogItems.map((item, i) => (
              <div key={i} style={styles.kbCard}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ fontWeight: '600', color: '#f8fafc', fontSize: '14px' }}>{item.title}</div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {item.metadata?.bulkPrice && <span style={styles.priceBadge}>Bulk ₹{item.metadata.bulkPrice}</span>}
                    {item.metadata?.samplePrice && <span style={{ ...styles.priceBadge, background: '#1e3a5f' }}>Sample ₹{item.metadata.samplePrice}</span>}
                  </div>
                </div>
                {item.metadata?.gsm && <div style={styles.kbMeta}>{item.metadata.gsm}gsm | {item.metadata.category || ''}</div>}
                <div style={{ marginTop: '6px', fontSize: '12px', color: '#94a3b8' }}>
                  {item.content.split('\n').find(l => l.startsWith('Description:'))?.replace('Description: ', '') || ''}
                </div>
                {item.metadata?.colors && (
                  <div style={{ marginTop: '6px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {item.metadata.colors.map((c, j) => (
                      <span key={j} style={styles.colorChip}>{c}</span>
                    ))}
                  </div>
                )}
                {item.metadata?.sizes && (
                  <div style={{ marginTop: '4px', fontSize: '12px', color: '#64748b' }}>
                    Sizes: {item.metadata.sizes.join(', ')}
                  </div>
                )}
                <div style={{ marginTop: '4px', fontSize: '11px', color: '#475569' }}>
                  Synced: {new Date(item.updatedAt).toLocaleString('en-IN')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Synced Saved Replies */}
      <div style={styles.kbSection}>
        <div style={styles.kbHeader} onClick={() => toggle('replies')}>
          <span style={styles.kbHeaderTitle}>Synced Saved Replies ({savedReplies.length})</span>
          <span style={{ color: '#64748b' }}>{showSection.replies ? '▼' : '▶'}</span>
        </div>
        {showSection.replies && (
          <div style={styles.kbContent}>
            {savedReplies.length === 0 && <p style={styles.empty}>No saved replies synced yet</p>}
            {savedReplies.map((item, i) => (
              <div key={i} style={styles.kbCard}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: '600', color: '#60a5fa', fontSize: '14px' }}>{item.title}</span>
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    {item.metadata?.mediaType && <span style={styles.mediaBadge}>{item.metadata.mediaType}</span>}
                  </div>
                </div>
                <div style={{ marginTop: '6px', fontSize: '13px', color: '#cbd5e1', whiteSpace: 'pre-wrap', lineHeight: '1.4' }}>
                  {item.content}
                </div>
                <div style={{ marginTop: '4px', fontSize: '11px', color: '#475569' }}>
                  Synced: {new Date(item.updatedAt).toLocaleString('en-IN')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Om's Style Guide (extracted from real replies — this is what Claude uses) */}
      <div style={styles.kbSection}>
        <div style={styles.kbHeader} onClick={() => toggle('styleGuide')}>
          <span style={styles.kbHeaderTitle}>Om's Style Guide {styleGuides.length > 0 ? '(Active)' : '(Not extracted yet)'}</span>
          <span style={{ color: '#64748b' }}>{showSection.styleGuide ? '▼' : '▶'}</span>
        </div>
        {showSection.styleGuide && (
          <div style={styles.kbContent}>
            {styleGuides.length === 0 && <p style={styles.empty}>No style guide yet — click "Sync Now" to extract from WhatsApp conversations</p>}
            <div style={{ marginBottom: '8px', padding: '8px', background: '#1a1a2e', borderRadius: '6px', fontSize: '12px', color: '#94a3b8' }}>
              Compact style guide extracted by AI from {styleGuides[0]?.metadata?.pairsAnalyzed || 0} real WhatsApp reply pairs. This is injected into every Claude prompt (~150-200 tokens instead of sending raw pairs).
            </div>
            {styleGuides.map((item, i) => (
              <div key={i} style={styles.kbCard}>
                <div style={{ fontWeight: '600', color: '#f59e0b', fontSize: '13px', marginBottom: '8px' }}>STYLE GUIDE — sent with every message to Claude</div>
                <div style={styles.promptBlock}>{item.content}</div>
                {item.metadata?.extractedAt && (
                  <div style={{ marginTop: '6px', fontSize: '11px', color: '#475569' }}>
                    Extracted: {new Date(item.metadata.extractedAt).toLocaleString('en-IN')} | Based on {item.metadata.pairsAnalyzed} pairs | {item.metadata.extractionTokens} tokens used for extraction
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Om's Real WhatsApp Reply Pairs (raw data — for monitoring) */}
      <div style={styles.kbSection}>
        <div style={styles.kbHeader} onClick={() => toggle('stylePairs')}>
          <span style={styles.kbHeaderTitle}>Om's Real Replies ({stylePairs.length})</span>
          <span style={{ color: '#64748b' }}>{showSection.stylePairs ? '▼' : '▶'}</span>
        </div>
        {showSection.stylePairs && (
          <div style={styles.kbContent}>
            {stylePairs.length === 0 && <p style={styles.empty}>No style pairs synced yet — click "Sync Now" to export from WhatsApp</p>}
            <div style={{ marginBottom: '8px', padding: '8px', background: '#1a1a2e', borderRadius: '6px', fontSize: '12px', color: '#94a3b8' }}>
              Raw buyer→Om reply pairs from WhatsApp. These were analyzed to create the Style Guide above. Shown here for your monitoring.
            </div>
            {stylePairs.map((item, i) => (
              <div key={i} style={styles.kbCard}>
                <div style={{ fontSize: '13px', marginBottom: '4px' }}>
                  <span style={{ color: '#60a5fa' }}>Buyer:</span> {item.metadata?.buyerMessage || item.content?.split('\n')[0]?.replace('Buyer: "', '').replace('"', '')}
                </div>
                <div style={{ fontSize: '13px', color: '#86efac' }}>
                  <span style={{ color: '#22c55e' }}>Om:</span> {item.metadata?.omReply || item.content?.split('\n')[1]?.replace("Om's reply: \"", '').replace('"', '')}
                </div>
                {item.metadata?.timestamp && (
                  <div style={{ marginTop: '4px', fontSize: '11px', color: '#475569' }}>
                    {new Date(item.metadata.timestamp).toLocaleDateString('en-IN')}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Defer-to-Ketu Rules */}
      <div style={styles.kbSection}>
        <div style={styles.kbHeader} onClick={() => toggle('deferList')}>
          <span style={styles.kbHeaderTitle}>Defer-to-Ketu Rules ({deferItems.length})</span>
          <span style={{ color: '#64748b' }}>{showSection.deferList ? '▼' : '▶'}</span>
        </div>
        {showSection.deferList && (
          <div style={styles.kbContent}>
            {deferItems.length === 0 && <p style={styles.empty}>No defer rules yet (Om hasn't corrected any replies)</p>}
            {deferItems.map((item, i) => (
              <div key={i} style={styles.kbCard}>
                <div style={{ fontSize: '13px', marginBottom: '4px' }}><span style={{ color: '#f87171' }}>Q:</span> {item.buyerQuestion}</div>
                <div style={{ fontSize: '13px', color: '#86efac' }}><span style={{ color: '#22c55e' }}>Correct:</span> {item.correctReply}</div>
                <div style={{ marginTop: '4px', fontSize: '11px', color: '#475569' }}>
                  Added: {new Date(item.createdAt).toLocaleDateString('en-IN')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sync History */}
      <div style={styles.kbSection}>
        <div style={styles.kbHeader} onClick={() => toggle('history')}>
          <span style={styles.kbHeaderTitle}>Sync History</span>
          <span style={{ color: '#64748b' }}>{showSection.history ? '▼' : '▶'}</span>
        </div>
        {showSection.history && (
          <div style={styles.kbContent}>
            {logs.length === 0 && <p style={styles.empty}>No sync history yet</p>}
            {logs.map(log => (
              <div key={log.id} style={{ ...styles.logCard, borderLeft: `4px solid ${log.status === 'success' ? '#22c55e' : '#ef4444'}` }}>
                <div style={styles.logHeader}>
                  <span><strong>{log.syncType}</strong> — {log.status}</span>
                  <span>{new Date(log.createdAt).toLocaleString('en-IN')}</span>
                </div>
                <div style={styles.logBody}>
                  {log.itemsFound > 0 && <span>Found: {log.itemsFound} | New: {log.itemsNew} | Updated: {log.itemsUpdated}</span>}
                  {log.durationMs && <span> | {log.durationMs}ms</span>}
                  {log.error && <div style={styles.errorText}>{log.error}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ===========================================
// Helpers
// ===========================================

function statusColor(status) {
  switch (status) {
    case 'REPLIED': return '#22c55e'
    case 'DEFERRED': return '#f59e0b'
    case 'COOLDOWN': return '#8b5cf6'
    case 'SKIPPED': return '#6b7280'
    case 'FAILED': return '#ef4444'
    case 'PROCESSING': return '#3b82f6'
    default: return '#6b7280'
  }
}

// ===========================================
// Styles (inline for zero-dependency setup)
// ===========================================

const styles = {
  container: { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', maxWidth: '1200px', margin: '0 auto', padding: '16px', background: '#0f172a', color: '#e2e8f0', minHeight: '100vh' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 0', borderBottom: '1px solid #1e293b' },
  title: { fontSize: '20px', fontWeight: '700', color: '#f8fafc', margin: 0 },
  headerControls: { display: 'flex', alignItems: 'center', gap: '8px' },
  statusDot: { width: '10px', height: '10px', borderRadius: '50%', display: 'inline-block' },
  toggleBtn: { padding: '8px 20px', border: 'none', borderRadius: '6px', color: '#fff', fontWeight: '600', cursor: 'pointer', fontSize: '14px' },
  tabs: { display: 'flex', gap: '4px', marginTop: '16px', borderBottom: '1px solid #1e293b', paddingBottom: '0', overflowX: 'auto', whiteSpace: 'nowrap' },
  tab: { padding: '10px 16px', border: 'none', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: '14px', borderBottom: '2px solid transparent', flexShrink: 0 },
  activeTab: { color: '#3b82f6', borderBottom: '2px solid #3b82f6' },
  main: { marginTop: '20px' },
  loading: { display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', color: '#94a3b8' },
  empty: { color: '#64748b', textAlign: 'center', padding: '40px' },

  // Budget bar
  budgetBar: { marginTop: '16px', padding: '12px', background: '#1e293b', borderRadius: '8px' },
  budgetLabel: { fontSize: '13px', color: '#94a3b8', marginBottom: '6px' },
  budgetTrack: { height: '6px', background: '#334155', borderRadius: '3px', overflow: 'hidden' },
  budgetFill: { height: '100%', borderRadius: '3px', transition: 'width 0.3s' },

  // Log cards
  logCard: { background: '#1e293b', borderRadius: '8px', marginBottom: '8px', overflow: 'hidden' },
  logHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', cursor: 'pointer' },
  logBody: { padding: '0 16px 12px', fontSize: '13px', color: '#cbd5e1' },
  logMessage: { marginBottom: '4px' },
  logReply: { color: '#86efac', marginTop: '4px' },
  logPhone: { marginLeft: '8px', color: '#94a3b8', fontSize: '13px' },
  logReason: { marginLeft: '6px', color: '#64748b', fontSize: '12px' },
  logMeta: { display: 'flex', gap: '8px', fontSize: '12px', color: '#64748b' },
  logTime: { marginLeft: '8px' },
  logExpanded: { padding: '12px 16px', borderTop: '1px solid #334155', fontSize: '12px', color: '#94a3b8' },
  pre: { background: '#0f172a', padding: '8px', borderRadius: '4px', overflow: 'auto', fontSize: '11px', maxHeight: '200px' },
  statusBadge: { padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: '600', color: '#fff' },

  // Stats
  statsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '12px', marginTop: '16px' },
  statCard: { background: '#1e293b', padding: '16px', borderRadius: '8px', textAlign: 'center' },
  statValue: { fontSize: '24px', fontWeight: '700', color: '#f8fafc' },
  statLabel: { fontSize: '12px', color: '#64748b', marginTop: '4px' },
  periodSelector: { display: 'flex', gap: '8px' },
  periodBtn: { padding: '6px 16px', border: '1px solid #334155', borderRadius: '6px', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: '13px' },
  activePeriod: { background: '#3b82f6', color: '#fff', border: '1px solid #3b82f6' },

  // Defer
  deferMsgBox: { background: '#1e293b', padding: '16px', borderRadius: '8px', marginBottom: '16px' },
  deferMsgText: { color: '#94a3b8', fontStyle: 'italic' },
  deferCard: { background: '#1e293b', padding: '16px', borderRadius: '8px', marginBottom: '8px' },
  deferQuestion: { marginBottom: '4px' },
  deferWrong: { color: '#fca5a5', marginBottom: '4px', fontSize: '13px' },
  deferCorrect: { color: '#86efac', marginBottom: '8px', fontSize: '13px' },
  deferFooter: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', color: '#64748b' },

  // Settings
  sectionTitle: { fontSize: '18px', fontWeight: '600', color: '#f8fafc', marginBottom: '12px' },
  settingsGrid: { display: 'flex', flexDirection: 'column', gap: '12px' },
  settingRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1e293b', padding: '12px 16px', borderRadius: '8px' },
  settingLabel: { fontSize: '14px', color: '#cbd5e1' },
  input: { padding: '6px 12px', border: '1px solid #334155', borderRadius: '6px', background: '#0f172a', color: '#f8fafc', fontSize: '14px', width: '120px' },
  textarea: { padding: '8px 12px', border: '1px solid #334155', borderRadius: '6px', background: '#0f172a', color: '#f8fafc', fontSize: '13px', width: '100%', resize: 'vertical', boxSizing: 'border-box' },
  toggleSmall: { padding: '4px 12px', border: 'none', borderRadius: '4px', color: '#fff', cursor: 'pointer', fontWeight: '600', fontSize: '12px' },
  label: { fontSize: '14px', color: '#cbd5e1', marginBottom: '8px', display: 'block' },

  // Sync
  syncInfo: { background: '#1e293b', padding: '16px', borderRadius: '8px', marginBottom: '16px' },
  errorText: { color: '#fca5a5', marginTop: '4px' },

  // Knowledge base viewer
  kbSection: { background: '#1e293b', borderRadius: '8px', marginBottom: '12px', overflow: 'hidden' },
  kbHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', cursor: 'pointer', userSelect: 'none' },
  kbHeaderTitle: { fontWeight: '600', color: '#f8fafc', fontSize: '15px' },
  kbContent: { padding: '0 16px 16px', maxHeight: '500px', overflowY: 'auto' },
  kbCard: { background: '#0f172a', padding: '12px', borderRadius: '6px', marginBottom: '8px', border: '1px solid #334155' },
  kbMeta: { fontSize: '12px', color: '#64748b', marginTop: '2px' },
  priceBadge: { padding: '2px 8px', borderRadius: '4px', background: '#14532d', color: '#86efac', fontSize: '12px', fontWeight: '600' },
  colorChip: { padding: '1px 6px', borderRadius: '3px', background: '#334155', color: '#cbd5e1', fontSize: '11px' },
  mediaBadge: { padding: '1px 6px', borderRadius: '3px', background: '#7c3aed', color: '#fff', fontSize: '10px', fontWeight: '600' },

  // Pipeline viewer
  pipeline: { padding: '16px', borderTop: '1px solid #334155', background: '#0f172a' },
  pipeStep: { background: '#1e293b', borderRadius: '8px', overflow: 'hidden', marginBottom: '0' },
  pipeStepHeader: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', background: '#1e293b' },
  pipeStepNum: { width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '11px', fontWeight: '700', flexShrink: 0 },
  pipeStepTitle: { fontWeight: '700', fontSize: '12px', color: '#f8fafc', letterSpacing: '0.5px' },
  pipeStepMeta: { marginLeft: 'auto', fontSize: '11px', color: '#64748b' },
  pipeStepBody: { padding: '8px 14px 12px', fontSize: '13px', color: '#cbd5e1' },
  pipeArrow: { textAlign: 'center', color: '#475569', fontSize: '16px', padding: '2px 0' },
  pipeCheckFail: { padding: '6px 10px', background: '#7f1d1d', borderRadius: '4px', color: '#fca5a5', fontSize: '12px' },
  pipeSectionBox: { padding: '8px 10px', background: '#0f172a', borderRadius: '6px', border: '1px solid #334155', marginBottom: '6px' },
  pipeSectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', fontSize: '12px' },
  tokenBox: { background: '#0f172a', padding: '10px', borderRadius: '6px', textAlign: 'center', border: '1px solid #334155' },
  promptBlock: { padding: '10px', background: '#0f172a', borderRadius: '6px', border: '1px solid #334155', fontSize: '12px', color: '#94a3b8', whiteSpace: 'pre-wrap', lineHeight: '1.5', fontFamily: 'monospace' },

  // Buttons
  btnPrimary: { padding: '8px 20px', border: 'none', borderRadius: '6px', background: '#3b82f6', color: '#fff', fontWeight: '600', cursor: 'pointer', fontSize: '14px' },
  btnSecondary: { padding: '6px 16px', border: '1px solid #334155', borderRadius: '6px', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: '13px', marginLeft: '8px' },
  btnDanger: { padding: '4px 12px', border: '1px solid #ef4444', borderRadius: '4px', background: 'transparent', color: '#ef4444', cursor: 'pointer', fontSize: '12px' },
}

// ===========================================
// Static Data: Reply Templates (from reply_templates_clean.json)
// ===========================================
const REPLY_TEMPLATES = [
  { shortcut: "Bags", content: "Bags from Mumbai - wa.me/917066316315, bol dena Ketu ne number diya hai, acche rate dedenge", mediaType: null, category: "bags_referral" },
  { shortcut: "Gst number", content: "Add GST number to our website - https://youtube.com/shorts/LoLw9InfKNc?feature=share", mediaType: null, category: "gst_guide" },
  { shortcut: "ShirtsHimanshu", content: "Shirts ke liye inse baat karlo , bol dena Ketu ne number diya hai, acche rates dedenge -wa.me/919953321193", mediaType: null, category: "shirts_referral" },
  { shortcut: "Embroidary", content: "We sell plain tshirts only. You can talk to him for Embroidary - Wa.me/919266306545", mediaType: null, category: "embroidery_referral" },
  { shortcut: "Boom", content: "https://wa.me/919350848723\n\nMachine ke liye inse baat kar lo. Bol dena Ketu ne number diya hai, theek rate lag jaayenge.\n\nInki website - https://boomenterprise.in", mediaType: null, category: "machine_referral" },
  { shortcut: "Printercordinate", content: "How do I cordinate with printer - https://youtube.com/shorts/Vwg-lChShx4", mediaType: null, category: "printer_coordination" },
  { shortcut: "Train", content: "https://youtube.com/shorts/hwetf1NFVME\n\nWatch this for train process", mediaType: null, category: "train_shipping_guide" },
  { shortcut: "Create", content: "Click create a new account >> Use same mail which you used while ordering >> Enter any password and click create account.\n\nThen login through same mail and password. Everything will sync", mediaType: "IMAGE", category: "account_creation" },
  { shortcut: "Differ", content: "True Bio Rneck - double biowash\nBio Rneck - single biowash\nNon bio - no biowash", mediaType: null, category: "product_comparison" },
  { shortcut: "Paypal", content: "https://www.paypal.me/ankitgupta780\n\nYou can pay here and share screenshot.", mediaType: null, category: "international_payment" },
  { shortcut: "Mukesh", content: "9953532428 - Mukesh ji\n\nBol dena Ketu ne number diya hai, will give better rates.", mediaType: null, category: "caps_referral" },
  { shortcut: "140gsm", content: "This product is one time use and throw purpose.\n\nProduction time 60 days.\n\nSamples not available for this product.", mediaType: null, category: "product_info" },
  { shortcut: "Custom", content: "Custom order ke liye inse baat kar lo, bol dena Ketu ne number diya hai, acche rates laga denge - https://wa.me/917808284808", mediaType: null, category: "custom_order_referral" },
  { shortcut: "Tiruppur", content: "Tiruppur only production unit sir.. Visit allowed in delhi warehouse only.", mediaType: null, category: "factory_location" },
  { shortcut: "Notification", content: "Stock Alert ko enable kar lo website open karke - sale91.com\n\nStock aate hi notification aa jaayega.", mediaType: "IMAGE", category: "stock_alerts" },
  { shortcut: "Sizechart", content: "Size chart - https://www.bulkplaintshirt.com/?q=SizeChart", mediaType: null, category: "size_chart" },
  { shortcut: "Nepal", content: "Bhansar (custom)\n\nTshirt - 180 Nepali Rupee\nSweatshirt - 250 Nepali Rupee\nHoodie - 400 Nepali Rupee\n\nNo shipping charges upto Kathmandu", mediaType: null, category: "nepal_pricing" },
  { shortcut: "Bill", content: "Here order details - https://youtube.com/shorts/-Swb30-I7nA?feature=share", mediaType: "IMAGE", category: "order_details_guide" },
  { shortcut: "welcome", content: "https://sale91.com/catalog\n\nCheck rates, color and buy\n\nNote: Launching Womens OS (Oversize), Womens RF (Regular Fit), Baby Rompers, AcidWash 6 colors in March.", mediaType: null, category: "welcome_message" },
  { shortcut: "Pickup", content: "Ketu - 7048954134\n\nF-120, Tshirt wala godown, Gujiar Chowk Khanpur, South Delhi, 110062\n\nhttps://maps.app.goo.gl/dGpvUxcMLg5MJmtS9", mediaType: null, category: "warehouse_location" },
  { shortcut: "Drive", content: "https://drive.google.com/drive/folders/1URpaQH-BI3YWcp5iql3DaaQJd2fMheQR\n\nDownload photos here", mediaType: null, category: "general" },
  { shortcut: "Calculator", content: "Shipping calculator - https://www.bulkplaintshirt.com/calc/shipping-calculator.html", mediaType: null, category: "shipping_calculator" },
  { shortcut: "Dropshipping", content: "Dropshipping option available on website sir - https://youtube.com/shorts/Z1zB5CIDpfA?si=7v9Lmqsb2Ml2ffn-", mediaType: "IMAGE", category: "dropshipping_service" },
  { shortcut: "Tracking", content: "Tracking aayi hogi aapko, jo number order ke time diya tha uspe. \n\nWebsite (sale91.com) pe bhi track ka button hota hai. https://youtube.com/shorts/-Swb30-I7nA?feature=share", mediaType: "IMAGE", category: "tracking_guide" },
  { shortcut: "Discount", content: "Extra 2rs per pc discount on website - sale91.com", mediaType: null, category: "pricing_policy" },
  { shortcut: "Website", content: "Order from website sir, instant will dispatch - sale91.com", mediaType: "IMAGE", category: "website_ordering" },
  { shortcut: "How", content: "How to order - https://youtube.com/shorts/F-zdRRSs370?feature=share", mediaType: null, category: "ordering_guide" },
  { shortcut: "Printer", content: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726", mediaType: null, category: "print_referral" },
  { shortcut: "Photos", content: "HD Photos - https://www.bulkplaintshirt.com/?q=HDphoto", mediaType: null, category: "hd_photos" },
  { shortcut: "Catalog", content: "https://sale91.com/catalog\n\nCheck rates and color once sir", mediaType: null, category: "catalog_link" },
  { shortcut: "Payment", content: "1. Google Pay - 9336695049\n\n2. UPI - ownknitted@hdfcbank\n\n3. Bank Transfer -\nAccount Holder: OWN KNITTED BLANK WEARS\nAccount Number: 50200052063992\nIFSC: HDFC0000043\nBranch: SAKET\nAccount Type: CURRENT", mediaType: "IMAGE", category: "payment_methods" },
  { shortcut: "Address", content: "Sunday - 11am to 4pm\nRest days - 10am to 6pm\n\nhttps://maps.app.goo.gl/dGpvUxcMLg5MJmtS9 (Ask for TSHIRT WALA GODAM after reaching at location, call if required -7048954134)\n\nKindly visit for a limited duration of 5 to 10 minutes.", mediaType: "AUDIO", category: "business_hours_location" },
]

// ===========================================
// Static Data: Catalog Products
// ===========================================
const CATALOG_PRODUCTS = [
  { name: "Oversize 210gsm", category: "Oversized Tees", gsm: "210gsm", description: "Oversized Drop Shoulder 210gsm, Terry Cotton Loopknit Heavy Gauge, 100% Cotton Supercombed Red Lable Premium Fabric", bulk: 175, sample: 210, colors: ["Black","White","Lavender","Beige","Red","Sage Green","Brown","Off-white","Orange","Navy"], sizes: "S, M, L, XL, XXL" },
  { name: "Oversize 240gsm", category: "Oversized Tees", gsm: "240gsm", description: "Oversized Drop-shoulder, 240gsm, Terry cotton/Loopknit Heavy Gauge, 100% Cotton Premium Quality Biowash Fabric", bulk: 180, sample: 222, colors: ["Black","White","Red","Maroon","Off-white","Beige","Lavender","Brown","Rose Pink","Charcoal","Army Green","Powder Blue"], sizes: "XS, S, M, L, XL, XXL" },
  { name: "Oversize 180gsm", category: "Oversized Tees", gsm: "180gsm", description: "Oversized Drop-shoulder 180gsm, 100% Cotton Supercombed Premium Quality Red Lable Fabric", bulk: 165, sample: 198, colors: ["Black","White"], sizes: "S, M, L, XL, XXL" },
  { name: "Boxy Fit", category: "Oversized Tees", gsm: "180gsm", description: "Boxy Fit Drop-shoulder Tshirt, 180gsm, 100% Cotton Supercombed Premium Quality Red Lable Fabric", bulk: 175, sample: 204, colors: ["Black","White"], sizes: "XS, S, M, L, XL, XXL" },
  { name: "AcidWash Oversize", category: "Oversized Tees", gsm: "240gsm", description: "AcidWash OS (Oversize Fit), 240gsm, 100% cotton Biowash French Terry Loopknit", bulk: 220, sample: 264, colors: ["Black"], sizes: "XS, S, M, L, XL, XXL" },
  { name: "True Biowash Round Neck", category: "Round Neck Tees", gsm: "180gsm", description: "Regular Fit, True Biowash Round neck, 180gsm, 100% Cotton Supercombed Premium Quality Red Lable Fabric", bulk: 140, sample: 174, colors: ["Black","White","Maroon","Navy","Mustard Yellow","Red","Bottle Green","Beige","Royal Blue","Lavender","Sky","Grey","Bhagwa"], sizes: "36, 38, 40, 42, 44, 46" },
  { name: "Biowash Round Neck", category: "Round Neck Tees", gsm: "180gsm", description: "Regular Fit, Biowash Round neck, 180gsm, 100% Cotton Premium Quality Fabric", bulk: 130, sample: 162, colors: ["Black","White","Navy","Red","Brown","Maroon","Charcoal","Off-white","Rose Pink"], sizes: "36, 38, 40, 42, 44, 46" },
  { name: "Non Bio Round Neck", category: "Round Neck Tees", gsm: "180gsm", description: "Non Bio Round neck, 180gsm, 88% Cotton, 12% Polyester", bulk: 102, sample: 129, colors: ["Black"], sizes: "36, 38, 40, 42, 44, 46" },
  { name: "Sublimation T-Shirt", category: "Round Neck Tees", gsm: "200gsm", description: "Regular Fit Round neck, 200gsm, Cotton Feel Polyester Sublimation tshirt", bulk: 115, sample: 144, colors: ["White"], sizes: "36, 38, 40, 42, 44, 46" },
  { name: "Premium Polo", category: "Polo T-Shirts", gsm: "220gsm", description: "Most Premium Honeycomb Polo, 220gsm, 100% Cotton Supercombed Red Lable Fabric", bulk: 220, sample: 270, colors: ["Black","White","Navy","Maroon"], sizes: "36, 38, 40, 42, 44, 46" },
  { name: "Cotton Polo", category: "Polo T-Shirts", gsm: "220gsm", description: "Cotton Matty Polo neck, 220gsm, 88% Cotton, 12% Polyester", bulk: 180, sample: 222, colors: ["Black","White","Navy","Grey","Maroon","Charcoal"], sizes: "36, 38, 40, 42, 44, 46" },
  { name: "Zip Hoodie", category: "Hoodies", gsm: "320gsm", description: "Zipper Hoodie, 320gsm, Cotton Brushed Loopknit, 88% cotton, 12% polyester", bulk: 325, sample: 390, colors: ["Black"], sizes: "S, M, L, XL, XXL" },
  { name: "Hoodie 320gsm (Black)", category: "Hoodies", gsm: "320gsm", description: "Non-zipper Hoodie, 320gsm, Cotton Brushed Loopknit, 88% cotton, 12% polyester", bulk: 295, sample: 366, colors: ["Black"], sizes: "S, M, L, XL, XXL" },
  { name: "Hoodie 320gsm", category: "Hoodies", gsm: "320gsm", description: "Non-zipper Hoodie, 320gsm, Cotton Brushed Loopknit, 88% cotton, 12% polyester", bulk: 325, sample: 402, colors: ["White","Navy","Army Green","Off-white","Maroon","Grey","Red"], sizes: "S, M, L, XL, XXL" },
  { name: "Dropshoulder Hoodie 430gsm", category: "Hoodies", gsm: "430gsm", description: "Most Heavy Non-zipper Dropshoulder Hoodie, 430gsm, Cotton Brushed Loopknit, 88% cotton, 12% polyester", bulk: 380, sample: 468, colors: ["Black"], sizes: "S, M, L, XL, XXL" },
  { name: "Hoodie 430gsm", category: "Hoodies", gsm: "430gsm", description: "Most Heavy Non-zipper Dropshoulder Hoodie, 430gsm, Cotton Brushed Loopknit, 88% cotton, 12% polyester", bulk: 418, sample: 502, colors: ["Navy","White","Off-white"], sizes: "S, M, L, XL, XXL" },
  { name: "Sweatshirt", category: "Sweatshirts & Jackets", gsm: "320gsm", description: "Sweatshirt, 320gsm, Cotton Brushed Loopknit, 88% cotton, 12% polyester", bulk: 225, sample: 276, colors: ["Black","Navy","Grey","Army Green"], sizes: "S, M, L, XL, XXL" },
  { name: "Sweatshirt 2", category: "Sweatshirts & Jackets", gsm: "320gsm", description: "Sweatshirt, 320gsm, Cotton Brushed Loopknit, 88% cotton, 12% polyester", bulk: 240, sample: 288, colors: ["Maroon","White","Off-white"], sizes: "S, M, L, XL, XXL" },
  { name: "Varsity Jacket", category: "Sweatshirts & Jackets", gsm: "320gsm", description: "Varsity Jacket, 320gsm, Cotton Brushed Loopknit, White Sleeve/Black Body, 88% cotton, 12% polyester", bulk: 335, sample: 402, colors: ["Black"], sizes: "XS, S, M, L, XL, XXL" },
  { name: "Kids Round Neck", category: "Kids & Bottomwear", gsm: "180gsm", description: "True Biowash Kids Round neck, 180gsm, 100% Cotton Supercombed Premium Quality Red Lable Fabric", bulk: 110, sample: 144, colors: ["Black","White","Red","Baby Pink","Mustard Yellow"], sizes: "20, 22, 24, 26, 28, 30, 32, 34" },
  { name: "Shorts", category: "Kids & Bottomwear", gsm: "240gsm", description: "240gsm, Terry cotton/Loopknit Heavy Gauge, 100% Cotton Supercombed Premium Quality Red Lable Fabric, (Zipper Left and Right pocket, 1 back pocket)", bulk: 205, sample: 246, colors: ["Black","Off-white","Lavender","Beige"], sizes: "XS, S, M, L, XL" },
]

// ===========================================
// Static Data: Style Pairs (from style-pairs-final.txt)
// ===========================================
const STYLE_PAIRS = [
  { buyer: "Any minimum quantity", om: "Any quantity you can buy" },
  { buyer: "Kya aap custom order bhi lete ho?", om: "Custom order we dont take sir. Ready stock mai hi sell karte hai" },
  { buyer: "On order bna sakte ho?", om: "On order we dont make sir" },
  { buyer: "Custom order le sakte ho?", om: "Custom order we dont make" },
  { buyer: "Can you make custom design?", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Printing bhi hoti hai kya?", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Print karwa sakte hai?", om: "We sell plain only. Printing ke liye inse baat kar lo - wa.me/918810256726" },
  { buyer: "Kya aap printing bhi karte ho?", om: "We sell plain tshirts only sir. Printing ke liye printer se baat kar lo" },
  { buyer: "Do you do embroidery?", om: "We sell plain tshirts only. You can talk to him for Embroidary - Wa.me/919266306545" },
  { buyer: "Embroidery karte ho?", om: "We sell plain tshirts only. You can talk to him for Embroidary - Wa.me/919266306545" },
  { buyer: "Kya return policy hai?", om: "Return, replacement not allowed sir" },
  { buyer: "Return ho sakta hai?", om: "No return sir" },
  { buyer: "Agar defective aaya toh?", om: "If there is genuine factory defect then we will consider" },
  { buyer: "COD available hai?", om: "Only prepaid we do sir" },
  { buyer: "Cash on delivery hota hai?", om: "Only prepaid sir" },
  { buyer: "Payment kaise karu?", om: "Website se order karo sir - sale91.com. Online payment prepaid only" },
  { buyer: "UPI se payment ho jayega?", om: "Yes sir, website pe UPI option hai" },
  { buyer: "Shipping charges kitna hai?", om: "Shipping calculator use karo - https://www.bulkplaintshirt.com/calc/shipping-calculator.html" },
  { buyer: "Delivery kitne din mai hogi?", om: "4 to 5 days sir courier se" },
  { buyer: "Kab tak aa jayega?", om: "4-5 working days normally" },
  { buyer: "Which courier do you use?", om: "Delhivery or Blue Dart mostly" },
  { buyer: "Train se bhej sakte ho?", om: "Yes train shipping available. Watch this - https://youtube.com/shorts/hwetf1NFVME" },
  { buyer: "Wholesale rate kya hai?", om: "Website pe sab rates hai sir - sale91.com/catalog. 10 pcs se bulk rate" },
  { buyer: "Bulk rate kya hai?", om: "10 pcs se bulk rate start hota hai sir. Check website - sale91.com" },
  { buyer: "10 piece se kam le sakte hai?", om: "Yes sir any quantity. Sample rate lagega" },
  { buyer: "Sample rate kya hai?", om: "Website pe sample rate mentioned hai sir - sale91.com/catalog" },
  { buyer: "Website kya hai?", om: "sale91.com sir" },
  { buyer: "Website se order kaise karu?", om: "How to order - https://youtube.com/shorts/F-zdRRSs370?feature=share" },
  { buyer: "Website pe discount milega?", om: "Extra 2rs per pc discount on website - sale91.com" },
  { buyer: "GST number add kaise karu?", om: "Add GST number to our website - https://youtube.com/shorts/LoLw9InfKNc?feature=share" },
  { buyer: "GST bill milega?", om: "Yes sir, GST invoice milega. Website pe GST number add kar lo" },
  { buyer: "Factory kahan hai?", om: "Tiruppur only production unit sir.. Visit allowed in delhi warehouse only" },
  { buyer: "Visit kar sakte hai?", om: "Delhi warehouse visit kar sakte ho sir" },
  { buyer: "Delhi godown kahan hai?", om: "F-120, Tshirt wala godown, Gujiar Chowk Khanpur, South Delhi, 110062" },
  { buyer: "Kab visit kar sakte hai?", om: "Sunday - 11am to 4pm. Rest days - 10am to 6pm" },
  { buyer: "Size chart kahan hai?", om: "Size chart - https://www.bulkplaintshirt.com/?q=SizeChart" },
  { buyer: "Photos kahan milenge?", om: "HD Photos - https://www.bulkplaintshirt.com/?q=HDphoto" },
  { buyer: "HD photos chahiye", om: "HD Photos - https://www.bulkplaintshirt.com/?q=HDphoto" },
  { buyer: "Stock available hai?", om: "Website pe check kar lo sir - sale91.com. Jo available hai wo dikha dega" },
  { buyer: "Out of stock kab aayega?", om: "Stock Alert ko enable kar lo website open karke - sale91.com. Stock aate hi notification aa jaayega" },
  { buyer: "Nepal mai ship karte ho?", om: "Yes sir Nepal delivery available. Bhansar custom extra lagta hai" },
  { buyer: "Nepal shipping charges?", om: "Tshirt - 180 Nepali Rupee, Sweatshirt - 250 Nepali Rupee, Hoodie - 400 Nepali Rupee bhansar. No shipping charges upto Kathmandu" },
  { buyer: "Bags kahan milenge?", om: "Bags from Mumbai - wa.me/917066316315, bol dena Ketu ne number diya hai" },
  { buyer: "Shirts milte hai?", om: "Shirts ke liye inse baat karlo - wa.me/919953321193, bol dena Ketu ne number diya hai" },
  { buyer: "Cap supplier hai?", om: "9953532428 - Mukesh ji. Bol dena Ketu ne number diya hai" },
  { buyer: "Machine kahan se lu?", om: "wa.me/919350848723 - Machine ke liye inse baat kar lo. Bol dena Ketu ne number diya hai. Website - https://boomenterprise.in" },
  { buyer: "Dropshipping available hai?", om: "Dropshipping option available on website sir - https://youtube.com/shorts/Z1zB5CIDpfA" },
  { buyer: "Tracking kahan check karu?", om: "Website (sale91.com) pe track ka button hota hai" },
  { buyer: "Order ka status kaise check karu?", om: "Website pe login karo same mail se. Everything will sync" },
  { buyer: "Account kaise banau?", om: "Click create a new account >> Use same mail which you used while ordering >> Enter any password and click create account" },
  { buyer: "210gsm aur 240gsm mai kya farak hai?", om: "240gsm thoda heavy hota hai sir. Dono oversized hai" },
  { buyer: "Biowash aur non-bio mai kya farak hai?", om: "True Bio Rneck - double biowash. Bio Rneck - single biowash. Non bio - no biowash" },
  { buyer: "140gsm kaisa hai?", om: "This product is one time use and throw purpose. Production time 60 days. Samples not available" },
  { buyer: "Printer se kaise coordinate karu?", om: "How do I coordinate with printer - https://youtube.com/shorts/Vwg-lChShx4" },
  { buyer: "PayPal se payment ho jayega?", om: "https://www.paypal.me/ankitgupta780 - You can pay here and share screenshot" },
  { buyer: "Bill download kaise karu?", om: "Here order details - https://youtube.com/shorts/-Swb30-I7nA?feature=share" },
  { buyer: "Google Drive photos link?", om: "https://drive.google.com/drive/folders/1URpaQH-BI3YWcp5iql3DaaQJd2fMheQR - Download photos here" },
  { buyer: "Women's tshirt hai?", om: "Launching Womens OS (Oversize), Womens RF (Regular Fit), Baby Rompers, AcidWash 6 colors in March" },
  { buyer: "New products kab aayenge?", om: "Launching new products in March sir. Women's range and more acid wash colors" },
  { buyer: "Catalog link?", om: "https://sale91.com/catalog - Check rates and color once sir" },
]

// ===========================================
// Catalog Tab Component
// ===========================================
function CatalogTab() {
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(null)
  const categories = [...new Set(CATALOG_PRODUCTS.map(p => p.category))]

  const filtered = CATALOG_PRODUCTS.filter(p =>
    !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.description.toLowerCase().includes(search.toLowerCase()) || p.category.toLowerCase().includes(search.toLowerCase())
  )

  const groupedFiltered = categories.map(cat => ({
    name: cat,
    products: filtered.filter(p => p.category === cat)
  })).filter(g => g.products.length > 0)

  return (
    <div>
      <h2 style={styles.sectionTitle}>Product Catalog ({CATALOG_PRODUCTS.length} products)</h2>
      <div style={{ margin: '12px 0' }}>
        <input type="text" placeholder="Search products..." value={search} onChange={e => setSearch(e.target.value)}
          style={{ width: '100%', padding: '10px 14px', border: '1px solid #334155', borderRadius: '8px', background: '#1e293b', color: '#f8fafc', fontSize: '14px', boxSizing: 'border-box' }} />
      </div>
      {groupedFiltered.map(group => (
        <div key={group.name} style={styles.kbSection}>
          <div style={styles.kbHeader} onClick={() => setExpanded(expanded === group.name ? null : group.name)}>
            <span style={styles.kbHeaderTitle}>{group.name} ({group.products.length})</span>
            <span style={{ color: '#64748b' }}>{expanded === group.name ? '\u25BC' : '\u25B6'}</span>
          </div>
          {expanded === group.name && (
            <div style={styles.kbContent}>
              {group.products.map((p, i) => (
                <div key={i} style={styles.kbCard}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '8px' }}>
                    <div>
                      <div style={{ fontSize: '15px', fontWeight: '600', color: '#f8fafc' }}>{p.name}</div>
                      <div style={styles.kbMeta}>{p.gsm} | {p.category}</div>
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <span style={{ ...styles.priceBadge, background: '#14532d' }}>Bulk {'\u20B9'}{p.bulk}</span>
                      <span style={{ ...styles.priceBadge, background: '#854d0e' }}>Sample {'\u20B9'}{p.sample}</span>
                    </div>
                  </div>
                  <div style={{ fontSize: '13px', color: '#94a3b8', marginTop: '6px' }}>{p.description}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                    {p.colors.map((c, ci) => <span key={ci} style={styles.colorChip}>{c}</span>)}
                  </div>
                  <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>Sizes: {p.sizes}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ===========================================
// Reply Templates Tab Component
// ===========================================
function ReplyTemplatesTab() {
  const [search, setSearch] = useState('')
  const filtered = REPLY_TEMPLATES.filter(t =>
    !search || t.shortcut.toLowerCase().includes(search.toLowerCase()) || t.content.toLowerCase().includes(search.toLowerCase()) || t.category.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div>
      <h2 style={styles.sectionTitle}>Saved Reply Templates ({REPLY_TEMPLATES.length})</h2>
      <div style={{ margin: '12px 0' }}>
        <input type="text" placeholder="Search by shortcut, content, or category..." value={search} onChange={e => setSearch(e.target.value)}
          style={{ width: '100%', padding: '10px 14px', border: '1px solid #334155', borderRadius: '8px', background: '#1e293b', color: '#f8fafc', fontSize: '14px', boxSizing: 'border-box' }} />
      </div>
      {filtered.map((t, i) => (
        <div key={i} style={styles.kbCard}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
            <span style={{ padding: '2px 10px', borderRadius: '4px', background: '#3b82f6', color: '#fff', fontSize: '12px', fontWeight: '600' }}>/{t.shortcut}</span>
            {t.mediaType && <span style={styles.mediaBadge}>{t.mediaType}</span>}
            <span style={{ marginLeft: 'auto', fontSize: '11px', color: '#475569', background: '#1e293b', padding: '2px 8px', borderRadius: '3px' }}>{t.category.replace(/_/g, ' ')}</span>
          </div>
          <div style={{ fontSize: '13px', color: '#cbd5e1', whiteSpace: 'pre-wrap', lineHeight: '1.5' }}>{t.content}</div>
        </div>
      ))}
      {filtered.length === 0 && <p style={styles.empty}>No matching templates</p>}
    </div>
  )
}

// ===========================================
// Style Pairs Tab Component
// ===========================================
function StylePairsTab() {
  const [search, setSearch] = useState('')
  const filtered = STYLE_PAIRS.filter(p =>
    !search || p.buyer.toLowerCase().includes(search.toLowerCase()) || p.om.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div>
      <h2 style={styles.sectionTitle}>Style Pairs ({STYLE_PAIRS.length} pairs)</h2>
      <p style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '12px' }}>Buyer question &rarr; Om reply pairs. These define how Ketu should respond.</p>
      <div style={{ margin: '0 0 12px' }}>
        <input type="text" placeholder="Search style pairs..." value={search} onChange={e => setSearch(e.target.value)}
          style={{ width: '100%', padding: '10px 14px', border: '1px solid #334155', borderRadius: '8px', background: '#1e293b', color: '#f8fafc', fontSize: '14px', boxSizing: 'border-box' }} />
      </div>
      {filtered.map((p, i) => (
        <div key={i} style={{ background: '#1e293b', padding: '12px 14px', borderRadius: '8px', marginBottom: '6px' }}>
          <div style={{ fontSize: '13px', marginBottom: '4px' }}>
            <span style={{ color: '#f87171', fontWeight: '600' }}>Buyer:</span> <span style={{ color: '#e2e8f0' }}>{p.buyer}</span>
          </div>
          <div style={{ fontSize: '13px' }}>
            <span style={{ color: '#22c55e', fontWeight: '600' }}>Om:</span> <span style={{ color: '#86efac' }}>{p.om}</span>
          </div>
        </div>
      ))}
      {filtered.length === 0 && <p style={styles.empty}>No matching pairs</p>}
    </div>
  )
}

export default App
