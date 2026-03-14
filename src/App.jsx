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
  const [knowledgeStats, setKnowledgeStats] = useState(null)

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
  const fetchKnowledgeStats = useCallback(async () => {
    const res = await fetch(`${API}/knowledge/stats`)
    if (res.ok) setKnowledgeStats(await res.json())
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
  useEffect(() => { fetchKnowledgeStats() }, [])

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
            onClick={async () => {
              const newStatus = !settings.isActive
              const body = { isActive: newStatus }
              if (newStatus) body.partialAiEnabled = false // auto-OFF partial when AI turns ON
              const res = await fetch(`${API}/settings`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              })
              if (res.ok) setSettings(await res.json())
            }}
          >
            {settings.isActive ? 'AI ON' : 'AI OFF'}
          </button>
          <button
            style={{ ...styles.toggleBtn, background: settings.partialAiEnabled ? '#f59e0b' : '#6b7280', marginLeft: 8 }}
            onClick={() => updateSetting('partialAiEnabled', !settings.partialAiEnabled)}
          >
            {settings.partialAiEnabled ? 'Partial ON' : 'Partial OFF'}
          </button>
        </div>
      </header>

      {/* Tabs */}
      <nav style={styles.tabs}>
        {['live', 'analytics', 'defer', 'filters', 'pipeline', 'learning', 'settings', 'sync'].map(t => (
          <button
            key={t}
            data-tab={t}
            style={{ ...styles.tab, ...(tab === t ? styles.activeTab : {}) }}
            onClick={() => {
              setTab(t)
              if (t === 'defer') fetchDeferList()
              if (t === 'sync') { fetchSyncLogs(); fetchKnowledge() }
              if (t === 'analytics') fetchAnalytics()
              if (t === 'pipeline') { fetchKnowledgeStats(); fetchFilterStats() }
              if (t === 'filters') { fetchFilterStats(); fetchDbFilters() }
              if (t === 'learning') fetchLearningStats()
            }}
          >
            {{live:'Live Monitor', analytics:'Analytics', defer:'Corrections', filters:'Pre-AI Filters', pipeline:'Pipeline', learning:'Learning', settings:'Settings', sync:'Sync'}[t]}
          </button>
        ))}
      </nav>

      {/* Daily Budget Bar */}
      <DailyBudgetBar settings={settings} />

      {/* Tab Content */}
      <main style={styles.main}>
        {tab === 'live' && <LiveMonitor logs={logs} expandedLog={expandedLog} setExpandedLog={setExpandedLog} />}
        {tab === 'analytics' && <Analytics analytics={analytics} period={period} setPeriod={setPeriod} />}
        {tab === 'defer' && <DeferManager list={deferList} onDelete={deleteDefer} settings={settings} updateSetting={updateSetting} />}
        {tab === 'filters' && <PreAIFilters stats={filterStats} period={filterPeriod} setPeriod={setFilterPeriod} onRefresh={() => { fetchFilterStats(); fetchDbFilters() }} dbFilters={dbFilters} />}
        {tab === 'pipeline' && <PipelineGraph knowledgeStats={knowledgeStats} filterStats={filterStats} settings={settings} />}
        {tab === 'learning' && <LearningPanel stats={learningStats} settings={settings} onRun={triggerLearningRun} running={learningRunning} onToggle={toggleLearning} onRefresh={fetchLearningStats} onBacklog={triggerBacklog} backlogProgress={backlogProgress} onHistoryPull={triggerHistoryPull} historyPullProgress={historyPullProgress} />}
{tab === 'settings' && <SettingsPanel settings={settings} updateSetting={updateSetting} onDownload={downloadKnowledge} />}
        {tab === 'sync' && <SyncPanel logs={syncLogs} settings={settings} updateSetting={updateSetting} onSync={triggerSync} syncing={syncing} knowledge={knowledge} />}
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
  const [editingId, setEditingId] = useState(null)
  const [editDraft, setEditDraft] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [editedReplies, setEditedReplies] = useState({})

  const startEdit = (log) => {
    setEditingId(log.id)
    setEditDraft(log.aiReply || '')
  }
  const saveEdit = async (log) => {
    setEditSaving(true)
    try {
      await fetch('/api/correction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buyerQuestion: log.buyerMessage,
          aiWrongReply: log.aiReply || '',
          correctReply: editDraft,
        }),
      })
      setEditedReplies(prev => ({ ...prev, [log.id]: editDraft }))
      setEditingId(null)
    } catch (err) {
      alert('Failed to save correction: ' + err.message)
    }
    setEditSaving(false)
  }

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
            {editingId === log.id ? (
              <div style={{ marginTop: '6px' }}>
                <textarea style={{ ...styles.textarea, fontSize: '13px', width: '100%' }} value={editDraft} onChange={e => setEditDraft(e.target.value)} rows={3} />
                <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                  <button style={{ ...styles.btnPrimary, padding: '4px 12px', fontSize: '12px' }} onClick={() => saveEdit(log)} disabled={editSaving}>
                    {editSaving ? 'Saving...' : 'Save Correction'}
                  </button>
                  <button style={{ ...styles.btnSecondary, padding: '4px 12px', fontSize: '12px' }} onClick={() => setEditingId(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                <div style={styles.logReply}>
                  <strong>AI Reply:</strong> {editedReplies[log.id] || log.aiReply}
                  {editedReplies[log.id] && <span style={{ color: '#22c55e', fontSize: '11px', marginLeft: '6px' }}>(corrected)</span>}
                </div>
                {log.aiReply && (
                  <button style={{ ...styles.btnSecondary, padding: '2px 8px', fontSize: '11px', whiteSpace: 'nowrap', flexShrink: 0 }} onClick={(e) => { e.stopPropagation(); startEdit(log) }}>
                    Edit
                  </button>
                )}
              </div>
            )}
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
                    {prompt.system.trim()}
                  </div>
                )}
              </div>

              {/* B: Style Pairs info */}
              <div style={styles.pipeSectionBox}>
                <div style={styles.pipeSectionHeader}>
                  <span style={{ color: '#f97316', fontWeight: '600' }}>B. STYLE PAIRS (included in knowledge base)</span>
                </div>
                <div style={{ fontSize: '12px', color: '#94a3b8', padding: '4px 0' }}>
                  Om's 337 real Q&A pairs are searched alongside catalog & templates. Matching pairs appear in the top 5 knowledge results above.
                </div>
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
  return (
    <div>
      <h2 style={styles.sectionTitle}>Corrections</h2>
      <p style={{ color: '#94a3b8', fontSize: 13, margin: '0 0 16px' }}>
        When you edit an AI reply, the buyer's question + your correct reply become a correction pair. These are searched alongside Catalog, Reply Templates, and Style Pairs in the unified vector search.
      </p>

      {list.length === 0 && <p style={styles.empty}>No corrections yet</p>}
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

function PipelineGraph({ knowledgeStats, filterStats, settings }) {
  const box = (bg, border, color) => ({
    padding: '12px 16px', borderRadius: 10, textAlign: 'center', fontSize: 13, fontWeight: 600,
    background: bg, border: `2px solid ${border}`, color,
  })
  const label = { fontSize: 10, color: '#94a3b8', marginTop: 4, fontWeight: 400 }
  const arrow = { color: '#475569', fontSize: 22, display: 'flex', alignItems: 'center', justifyContent: 'center' }
  const arrowDown = { ...arrow, padding: '4px 0' }
  const section = { background: '#1e293b', borderRadius: 12, padding: 20, marginBottom: 20 }
  const sourceBox = (borderColor, titleColor) => ({
    background: '#0f172a', borderRadius: 8, padding: '12px 14px', borderLeft: `3px solid ${borderColor}`,
  })

  const sources = knowledgeStats?.sources || {}
  const filters = filterStats?.filters || []

  return (
    <div>
      <h2 style={{ color: '#f1f5f9', fontSize: 18, marginBottom: 4 }}>AI Pipeline — How Messages Are Processed</h2>
      <p style={{ color: '#64748b', fontSize: 13, marginBottom: 20 }}>Every buyer message goes through this pipeline. Each step is explained below.</p>

      {/* =================== STEP 1: INCOMING =================== */}
      <div style={section}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span style={{ background: '#334155', color: '#f1f5f9', padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>STEP 1</span>
          <span style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600 }}>Buyer Sends a Message</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={box('#334155', '#64748b', '#f1f5f9')}>
            Buyer Message
            <div style={label}>from WhatsApp via wwbun</div>
          </div>
          <div style={arrow}>→</div>
          <div style={{ background: '#0f172a', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#94a3b8', flex: 1, minWidth: 200 }}>
            <div style={{ color: '#cbd5e1', fontWeight: 600, marginBottom: 4 }}>Message Merge (3 sec window)</div>
            If buyer sends multiple messages quickly (e.g. "Hi" then "rate batao"), they get merged into one message before processing.
          </div>
        </div>
      </div>

      {/* =================== STEP 2: PRE-AI FILTERS =================== */}
      <div style={{ textAlign: 'center' }}><div style={arrowDown}>↓</div></div>
      <div style={section}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span style={{ background: '#7c3aed', color: '#fff', padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>STEP 2</span>
          <span style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600 }}>Pre-AI Filters</span>
          <span style={{ color: '#22c55e', fontSize: 12 }}>(0 tokens — free)</span>
        </div>
        <p style={{ color: '#94a3b8', fontSize: 12, margin: '0 0 14px' }}>
          Simple keyword/rule checks BEFORE Claude is called. Catches messages that don't need AI — saves money.
          If any filter matches, the message is handled immediately and does NOT go to Claude.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          <div style={sourceBox('#22c55e')}>
            <div style={{ color: '#22c55e', fontWeight: 700, fontSize: 13 }}>Acknowledgment</div>
            <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 4 }}>
              "ok", "thanks", "theek hai", "done", "haan", "shukriya"
            </div>
            <div style={{ color: '#64748b', fontSize: 10, marginTop: 4 }}>Action: Silent skip — no reply sent</div>
          </div>
          <div style={sourceBox('#3b82f6')}>
            <div style={{ color: '#3b82f6', fontWeight: 700, fontSize: 13 }}>Greeting</div>
            <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 4 }}>
              "hi", "hello", "namaste", "good morning"
            </div>
            <div style={{ color: '#64748b', fontSize: 10, marginTop: 4 }}>Action: Sends welcome message + catalog link</div>
          </div>
          <div style={sourceBox('#f59e0b')}>
            <div style={{ color: '#f59e0b', fontWeight: 700, fontSize: 13 }}>Informing / Status Update</div>
            <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 4 }}>
              "payment done", "order kiya", "will buy later"
            </div>
            <div style={{ color: '#64748b', fontSize: 10, marginTop: 4 }}>Action: Auto-reply "Noted, Ketu will check"</div>
          </div>
          <div style={sourceBox('#ef4444')}>
            <div style={{ color: '#ef4444', fontWeight: 700, fontSize: 13 }}>Angry Buyer</div>
            <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 4 }}>
              "bakwas", "scam", "fraud", "worst", "complaint"
            </div>
            <div style={{ color: '#64748b', fontSize: 10, marginTop: 4 }}>Action: Defers to Ketu (you handle personally)</div>
          </div>
          <div style={sourceBox('#06b6d4')}>
            <div style={{ color: '#06b6d4', fontWeight: 700, fontSize: 13 }}>Website Issue</div>
            <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 4 }}>
              "site not opening", "sale91 error"
            </div>
            <div style={{ color: '#64748b', fontSize: 10, marginTop: 4 }}>Action: Auto-reply with troubleshooting</div>
          </div>
          <div style={sourceBox('#a78bfa')}>
            <div style={{ color: '#a78bfa', fontWeight: 700, fontSize: 13 }}>Others</div>
            <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 4 }}>
              System ON/OFF, working hours, daily budget, emoji reactions, media-only, repeat messages, order IDs
            </div>
            <div style={{ color: '#64748b', fontSize: 10, marginTop: 4 }}>Action: Various (skip, defer, auto-reply)</div>
          </div>
        </div>
        <div style={{ background: '#14532d22', border: '1px solid #22c55e', borderRadius: 8, padding: '10px 14px', marginTop: 12, fontSize: 12, color: '#86efac' }}>
          Auto-learn: When Claude later detects a conversation ender ([SKIP]), that phrase gets auto-added here so next time it's caught for free.
        </div>
      </div>

      {/* =================== STEP 3: VECTOR SEARCH =================== */}
      <div style={{ textAlign: 'center' }}><div style={arrowDown}>↓ message passed all filters</div></div>
      <div style={section}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span style={{ background: '#0ea5e9', color: '#fff', padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>STEP 3</span>
          <span style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600 }}>Vector Search — Find Relevant Knowledge</span>
        </div>
        <p style={{ color: '#94a3b8', fontSize: 12, margin: '0 0 14px' }}>
          The buyer's message is converted into a vector (Voyage AI) and matched against all knowledge in the database.
          The <strong style={{ color: '#7dd3fc' }}>top 5 most relevant</strong> results are selected and sent to Claude as context.
        </p>

        <div style={{ fontSize: 13, fontWeight: 600, color: '#7dd3fc', marginBottom: 10 }}>5 Knowledge Sources Searched:</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 12 }}>
          <div style={sourceBox('#22c55e')}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ color: '#22c55e', fontWeight: 700, fontSize: 14 }}>CATALOG</div>
              <span style={{ background: '#22c55e22', color: '#22c55e', padding: '1px 8px', borderRadius: 10, fontSize: 11 }}>{sources.CATALOG || 0} items</span>
            </div>
            <div style={{ color: '#cbd5e1', fontSize: 12, marginTop: 6 }}>Product information — name, GSM, price, colors, sizes</div>
            <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 4 }}>Example: "Black 240 GSM Oversize T-Shirt — Rs 180/pc bulk, Rs 222 sample. Colors: Black, White, Navy. Sizes: XS-XXL"</div>
            <div style={{ color: '#64748b', fontSize: 10, marginTop: 6, borderTop: '1px solid #1e293b', paddingTop: 6 }}>Source: products.json from catalog repo (auto-syncs every 2 days)</div>
          </div>

          <div style={sourceBox('#3b82f6')}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ color: '#3b82f6', fontWeight: 700, fontSize: 14 }}>SAVED REPLIES</div>
              <span style={{ background: '#3b82f622', color: '#3b82f6', padding: '1px 8px', borderRadius: 10, fontSize: 11 }}>{sources.SAVED_REPLY || 0} templates</span>
            </div>
            <div style={{ color: '#cbd5e1', fontSize: 12, marginTop: 6 }}>Pre-made reply templates & FAQ answers</div>
            <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 4 }}>Example: "MOQ 24 pcs hai. Sample bhi available Rs 222/pc. Order sale91.com se karein"</div>
            <div style={{ color: '#64748b', fontSize: 10, marginTop: 6, borderTop: '1px solid #1e293b', paddingTop: 6 }}>Source: wwbun saved replies (synced on import)</div>
          </div>

          <div style={sourceBox('#a78bfa')}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ color: '#a78bfa', fontWeight: 700, fontSize: 14 }}>STYLE PAIRS</div>
              <span style={{ background: '#a78bfa22', color: '#a78bfa', padding: '1px 8px', borderRadius: 10, fontSize: 11 }}>{sources.STYLE_PAIR || 0} pairs</span>
            </div>
            <div style={{ color: '#cbd5e1', fontSize: 12, marginTop: 6 }}>Real Om-buyer conversations for matching</div>
            <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 4 }}>Example: Buyer: "black oversize rate?" → Om: "180/pc bulk, 222 sample sir"</div>
            <div style={{ color: '#64748b', fontSize: 10, marginTop: 6, borderTop: '1px solid #1e293b', paddingTop: 6 }}>Source: wwbun chat history (337 quality pairs)</div>
          </div>

          <div style={sourceBox('#f59e0b')}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ color: '#f59e0b', fontWeight: 700, fontSize: 14 }}>CORRECTIONS</div>
              <span style={{ background: '#f59e0b22', color: '#f59e0b', padding: '1px 8px', borderRadius: 10, fontSize: 11 }}>{sources.CORRECTION || 0} corrections</span>
            </div>
            <div style={{ color: '#cbd5e1', fontSize: 12, marginTop: 6 }}>Om's corrections when AI gave wrong answer</div>
            <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 4 }}>Example: Buyer asked "kya return hota hai?" → AI said wrong → Om corrected: "7 din mein return"</div>
            <div style={{ color: '#64748b', fontSize: 10, marginTop: 6, borderTop: '1px solid #1e293b', paddingTop: 6 }}>Source: Edit button corrections (grows daily as you correct AI)</div>
          </div>

          <div style={sourceBox('#06b6d4')}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ color: '#06b6d4', fontWeight: 700, fontSize: 14 }}>POLICIES</div>
              <span style={{ background: '#06b6d422', color: '#06b6d4', padding: '1px 8px', borderRadius: 10, fontSize: 11 }}>{sources.POLICY || 0} docs</span>
            </div>
            <div style={{ color: '#cbd5e1', fontSize: 12, marginTop: 6 }}>Business rules — MOQ, GST, payment, delivery</div>
            <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 4 }}>Example: "MOQ 24 pcs. GST extra. Delhi warehouse. Delivery 4-5 days. Payment: advance/COD"</div>
            <div style={{ color: '#64748b', fontSize: 10, marginTop: 6, borderTop: '1px solid #1e293b', paddingTop: 6 }}>Source: catalog metadata (synced with catalog)</div>
          </div>
        </div>

        <div style={{ background: '#0ea5e922', border: '1px solid #0ea5e9', borderRadius: 8, padding: '10px 14px', marginTop: 12, fontSize: 12, color: '#7dd3fc' }}>
          Result: Top 5 most similar results from ALL sources are selected and passed to Claude as "KNOWLEDGE BASE" context.
        </div>
      </div>

      {/* =================== STEP 4: CLAUDE =================== */}
      <div style={{ textAlign: 'center' }}><div style={arrowDown}>↓ top 5 knowledge results ready</div></div>
      <div style={section}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span style={{ background: '#f59e0b', color: '#000', padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>STEP 4</span>
          <span style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600 }}>Claude AI — Reads Everything & Decides</span>
          <span style={{ color: '#f59e0b', fontSize: 12 }}>(Haiku 4.5 — ~Rs 0.10-0.14 per message)</span>
        </div>
        <p style={{ color: '#94a3b8', fontSize: 12, margin: '0 0 14px' }}>
          Claude receives 4 things and uses them together to craft the reply:
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 16 }}>
          <div style={{ ...sourceBox('#22c55e'), background: '#14532d15' }}>
            <div style={{ color: '#22c55e', fontWeight: 700, fontSize: 13 }}>1. System Prompt</div>
            <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 4 }}>
              All the AI behavior rules — how to reply, when to defer, politeness rules, sale91.com mention, don't be pushy, etc.
            </div>
            <div style={{ color: '#64748b', fontSize: 10, marginTop: 4 }}>Editable from: Sync tab → AI System Prompt</div>
          </div>
          <div style={{ ...sourceBox('#0ea5e9'), background: '#0ea5e915' }}>
            <div style={{ color: '#7dd3fc', fontWeight: 700, fontSize: 13 }}>2. Top 5 Knowledge Results</div>
            <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 4 }}>
              The 5 most relevant results from vector search (shown with similarity %). Claude reads these to find the answer.
            </div>
            <div style={{ color: '#64748b', fontSize: 10, marginTop: 4 }}>From: Vector search (Step 3)</div>
          </div>
          <div style={{ ...sourceBox('#c026d3'), background: '#c026d315' }}>
            <div style={{ color: '#e879f9', fontWeight: 700, fontSize: 13 }}>3. Conversation History</div>
            <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 4 }}>
              Last 5 buyer-AI messages so Claude knows what was already discussed. Prevents repeating info.
            </div>
            <div style={{ color: '#64748b', fontSize: 10, marginTop: 4 }}>From: Database message logs</div>
          </div>
          <div style={{ ...sourceBox('#f59e0b'), background: '#f59e0b15' }}>
            <div style={{ color: '#fcd34d', fontWeight: 700, fontSize: 13 }}>4. Om's Style Guide</div>
            <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 4 }}>
              Compact communication style extracted from 337 real Om replies — tone, emoji usage, language patterns.
            </div>
            <div style={{ color: '#64748b', fontSize: 10, marginTop: 4 }}>From: Auto-extracted (one-time, in system prompt)</div>
          </div>
        </div>

        {/* Claude's 3 decisions */}
        <div style={{ fontSize: 13, fontWeight: 600, color: '#fbbf24', marginBottom: 10 }}>Claude makes one of 3 decisions:</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <div style={{ background: '#14532d', borderRadius: 10, padding: '14px 16px', textAlign: 'center' }}>
            <div style={{ color: '#22c55e', fontSize: 24, fontWeight: 800 }}>Reply</div>
            <div style={{ color: '#86efac', fontSize: 12, marginTop: 6 }}>Claude has enough knowledge to answer</div>
            <div style={{ color: '#22c55e44', fontSize: 11, marginTop: 8, borderTop: '1px solid #22c55e33', paddingTop: 8 }}>
              → Reply sent to buyer via WhatsApp
            </div>
          </div>
          <div style={{ background: '#450a0a', borderRadius: 10, padding: '14px 16px', textAlign: 'center' }}>
            <div style={{ color: '#ef4444', fontSize: 24, fontWeight: 800 }}>[DEFER]</div>
            <div style={{ color: '#fca5a5', fontSize: 12, marginTop: 6 }}>Can't answer — order related, not enough info</div>
            <div style={{ color: '#ef444444', fontSize: 11, marginTop: 8, borderTop: '1px solid #ef444433', paddingTop: 8 }}>
              → "Ketu will reply shortly" sent to buyer
            </div>
          </div>
          <div style={{ background: '#1e293b', border: '2px solid #475569', borderRadius: 10, padding: '14px 16px', textAlign: 'center' }}>
            <div style={{ color: '#94a3b8', fontSize: 24, fontWeight: 800 }}>[SKIP]</div>
            <div style={{ color: '#cbd5e1', fontSize: 12, marginTop: 6 }}>Conversation ender — thanks, bye, ok done</div>
            <div style={{ color: '#64748b', fontSize: 11, marginTop: 8, borderTop: '1px solid #47556933', paddingTop: 8 }}>
              → Silent — no reply sent. Phrase auto-learned to pre-AI filter.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SettingsPanel({ settings, updateSetting, onDownload }) {
  return (
    <div>
      <h2 style={styles.sectionTitle}>Settings</h2>

      <div style={styles.settingsGrid}>
        <SettingRow label="AI Active" type="toggle" value={settings.isActive} onChange={v => updateSetting('isActive', v)} />
        <SettingRow label="Daily Budget (INR)" type="number" value={settings.dailyBudgetInr} onChange={v => updateSetting('dailyBudgetInr', Number(v))} />
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
                <li><strong style={{ color: '#ef4444' }}>{summary.corrections}</strong> pairs — AI would NOT have handled correctly. These have been added as <strong style={{ color: '#f1f5f9' }}>corrections</strong> to the knowledge base, so next time a similar question comes, Claude uses this as reference.</li>
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

function SyncPanel({ logs, settings, updateSetting, onSync, syncing, knowledge }) {
  const [showSection, setShowSection] = useState({ rules: false, catalog: false, replies: false, stylePairs: false, syncHistory: false, premiumInfo: false })
  const toggle = (key) => setShowSection(prev => ({ ...prev, [key]: !prev[key] }))
  const [replyTemplates, setReplyTemplates] = useState(REPLY_TEMPLATES)
  const deleteReplyTemplate = async (index) => {
    const t = replyTemplates[index]
    if (!confirm(`Delete "/${t.shortcut}" template?`)) return
    try {
      await fetch(`/api/knowledge/reply-template/${encodeURIComponent(t.shortcut)}`, { method: 'DELETE' })
    } catch (err) { /* silent — still remove from UI */ }
    setReplyTemplates(prev => prev.filter((_, i) => i !== index))
  }

  // Import knowledge to vector DB
  const [importing, setImporting] = useState(false)
  const [importStatus, setImportStatus] = useState(null)
  const importAllKnowledge = async () => {
    setImporting(true)
    setImportStatus('Importing reply templates...')
    try {
      const tRes = await fetch('/api/sync/import-reply-templates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templates: replyTemplates }),
      })
      const tData = await tRes.json()
      setImportStatus(`Templates: ${tData.imported || 0}. Importing ${STYLE_PAIRS.length} style pairs (may take a minute)...`)
      const sRes = await fetch('/api/sync/import-style-pairs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairs: STYLE_PAIRS }),
      })
      const sData = await sRes.json()
      setImportStatus(`Done! Templates: ${tData.imported || 0}, Style Pairs: ${sData.imported || 0} imported to vector DB`)
    } catch (err) {
      setImportStatus(`Error: ${err.message}`)
    }
    setImporting(false)
  }

  // Sync history state
  const [syncHistory, setSyncHistory] = useState([])
  const [loadingSyncHistory, setLoadingSyncHistory] = useState(false)
  const [syncHistoryFilter, setSyncHistoryFilter] = useState(null)
  const [premiumExportRunning, setPremiumExportRunning] = useState(false)
  const [trainingReport, setTrainingReport] = useState(null) // { data, type: 'train'|'rescan' }
  const fetchSyncHistory = async () => {
    setLoadingSyncHistory(true)
    try {
      const res = await fetch('/api/sync/logs')
      const data = await res.json()
      setSyncHistory(data)
    } catch (err) { console.error('Failed to fetch sync history:', err) }
    setLoadingSyncHistory(false)
  }
  useEffect(() => { fetchSyncHistory() }, [])

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
    setExporting(true); setExportError(null); setExportResult(null)
    try {
      const res = await fetch('/api/export/premium-pairs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromDate: exportFromDate, toDate: exportToDate }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Export failed')
      setExportResult(data)
    } catch (err) { setExportError(err.message) }
    finally { setExporting(false) }
  }

  const downloadExport = () => {
    if (!exportResult?.textExport) return
    const blob = new Blob([exportResult.textExport], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `premium-pairs-${exportFromDate}-to-${exportToDate}.txt`; a.click(); URL.revokeObjectURL(url)
  }

  const catalogItems = knowledge?.chunks?.CATALOG || []

  return (
    <div>
      <h2 style={styles.sectionTitle}>Knowledge Base</h2>

      {/* Summary Stats */}
      <div style={styles.syncInfo}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
          <div>
            <p style={{ margin: '0 0 4px' }}><strong>Catalog last sync:</strong> {settings.lastSyncAt ? new Date(settings.lastSyncAt).toLocaleString('en-IN') : 'Never'}</p>
            <p style={{ margin: '0 0 4px' }}><strong>Next auto-sync:</strong> {settings.nextSyncAt ? new Date(settings.nextSyncAt).toLocaleString('en-IN') : 'Not scheduled'}</p>
            <p style={{ margin: 0, color: '#94a3b8', fontSize: '13px' }}>
              <strong>Total:</strong> {catalogItems.length} products | {replyTemplates.length} saved replies
            </p>
          </div>
          <button style={styles.btnPrimary} onClick={onSync} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Sync Catalog + Replies'}
          </button>
        </div>
      </div>

      {/* AI System Prompt */}
      <div style={styles.kbSection}>
        <div style={styles.kbHeader} onClick={() => toggle('rules')}>
          <span style={styles.kbHeaderTitle}>AI System Prompt (sent to Claude)</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '11px', color: '#64748b' }}>
              {settings.systemPrompt ? `${settings.systemPrompt.trim().split(/\s+/).length} words` : ''}
              {settings.promptUpdatedAt && ` · ${new Date(settings.promptUpdatedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })}`}
            </span>
            <span style={{ color: '#64748b' }}>{showSection.rules ? '\u25BC' : '\u25B6'}</span>
          </div>
        </div>
        {showSection.rules && (
          <div style={styles.kbContent}>
            <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '8px' }}>Managed via code — auto-syncs on every deploy.</div>
            <div style={styles.kbCard}>
              <div style={styles.promptBlock}>{settings.systemPrompt || '(Loading...)'}</div>
            </div>
          </div>
        )}
      </div>

      {/* Synced Catalog */}
      <div style={styles.kbSection}>
        <div style={styles.kbHeader} onClick={() => toggle('catalog')}>
          <span style={styles.kbHeaderTitle}>Synced Catalog ({catalogItems.length} products)</span>
          <span style={{ color: '#64748b' }}>{showSection.catalog ? '\u25BC' : '\u25B6'}</span>
        </div>
        {showSection.catalog && (
          <div style={styles.kbContent}>
            {catalogItems.length === 0 && <p style={styles.empty}>No catalog products synced yet</p>}
            {catalogItems.map((item, i) => (
              <div key={i} style={styles.kbCard}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ fontWeight: '600', color: '#f8fafc', fontSize: '14px' }}>{item.title}</div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {item.metadata?.bulkPrice && <span style={styles.priceBadge}>Bulk \u20B9{item.metadata.bulkPrice}</span>}
                    {item.metadata?.samplePrice && <span style={{ ...styles.priceBadge, background: '#1e3a5f' }}>Sample \u20B9{item.metadata.samplePrice}</span>}
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

      {/* Saved Reply Templates */}
      <div style={styles.kbSection}>
        <div style={styles.kbHeader} onClick={() => toggle('replies')}>
          <span style={styles.kbHeaderTitle}>Saved Reply Templates ({replyTemplates.length})</span>
          <span style={{ color: '#64748b' }}>{showSection.replies ? '\u25BC' : '\u25B6'}</span>
        </div>
        {showSection.replies && (
          <div style={styles.kbContent}>
            {replyTemplates.map((t, i) => (
              <div key={i} style={styles.kbCard}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                  <span style={{ padding: '2px 10px', borderRadius: '4px', background: '#3b82f6', color: '#fff', fontSize: '12px', fontWeight: '600' }}>/{t.shortcut}</span>
                  {t.mediaType && <span style={styles.mediaBadge}>{t.mediaType}</span>}
                  <span style={{ marginLeft: 'auto', fontSize: '11px', color: '#475569', background: '#0f172a', padding: '2px 8px', borderRadius: '3px' }}>{t.category.replace(/_/g, ' ')}</span>
                  <button style={{ ...styles.btnDanger, padding: '2px 8px', fontSize: '11px' }} onClick={() => deleteReplyTemplate(i)}>Delete</button>
                </div>
                <div style={{ fontSize: '13px', color: '#cbd5e1', whiteSpace: 'pre-wrap', lineHeight: '1.5' }}>{t.content}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Style Pairs */}
      <div style={styles.kbSection}>
        <div style={styles.kbHeader} onClick={() => toggle('stylePairs')}>
          <span style={styles.kbHeaderTitle}>Style Pairs ({STYLE_PAIRS.length})</span>
          <span style={{ color: '#64748b' }}>{showSection.stylePairs ? '\u25BC' : '\u25B6'}</span>
        </div>
        {showSection.stylePairs && (
          <div style={styles.kbContent}>
            <div style={{ marginBottom: '8px', padding: '8px', background: '#0f172a', borderRadius: '6px', fontSize: '12px', color: '#94a3b8' }}>
              Buyer question → Om reply pairs. These define how Ketu should respond to common queries.
            </div>
            {STYLE_PAIRS.map((p, i) => (
              <div key={i} style={styles.kbCard}>
                <div style={{ fontSize: '13px', marginBottom: '4px' }}>
                  <span style={{ color: '#f87171', fontWeight: '600' }}>Buyer:</span> <span style={{ color: '#e2e8f0' }}>{p.buyer}</span>
                </div>
                <div style={{ fontSize: '13px' }}>
                  <span style={{ color: '#22c55e', fontWeight: '600' }}>Om:</span> <span style={{ color: '#86efac' }}>{p.om}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sync History */}
      <div style={styles.kbSection}>
        <div style={styles.kbHeader} onClick={() => toggle('syncHistory')}>
          <span style={styles.kbHeaderTitle}>Sync History</span>
          <span style={{ color: '#64748b' }}>{showSection.syncHistory ? '\u25BC' : '\u25B6'}</span>
        </div>
        {showSection.syncHistory && (
          <div style={styles.kbContent}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', color: '#94a3b8' }}>Last {syncHistory.length} sync operations</span>
                {['all', 'premium_export', 'catalog', 'saved_replies'].map(f => (
                  <button key={f} style={{ background: (syncHistoryFilter || 'all') === f ? '#334155' : 'none', border: '1px solid #334155', borderRadius: '4px', padding: '1px 6px', fontSize: '10px', color: f === 'premium_export' ? '#fbbf24' : f === 'catalog' ? '#60a5fa' : f === 'saved_replies' ? '#a78bfa' : '#94a3b8', cursor: 'pointer' }} onClick={() => setSyncHistoryFilter(f === 'all' ? null : f)}>{f === 'all' ? 'All' : f === 'premium_export' ? 'Premium' : f === 'catalog' ? 'Catalog' : 'Replies'}</button>
                ))}
              </div>
              <button style={{ background: 'none', border: '1px solid #334155', borderRadius: '4px', padding: '2px 8px', fontSize: '11px', color: '#60a5fa', cursor: 'pointer' }} onClick={fetchSyncHistory} disabled={loadingSyncHistory}>{loadingSyncHistory ? 'Loading...' : 'Refresh'}</button>
            </div>
            {syncHistory.length === 0 && <p style={{ color: '#64748b', fontSize: '12px' }}>No sync logs yet</p>}
            {syncHistory.filter(log => !syncHistoryFilter || log.syncType === syncHistoryFilter).map((log, i) => {
              const isPremium = log.syncType === 'premium_export'
              const typeColors = { premium_export: '#fbbf24', catalog: '#60a5fa', saved_replies: '#a78bfa', style_pairs: '#f472b6' }
              const typeColor = typeColors[log.syncType] || '#94a3b8'
              const typeLabels = { premium_export: 'Premium Export', catalog: 'Catalog', saved_replies: 'Saved Replies', style_pairs: 'Style Pairs' }
              const typeLabel = typeLabels[log.syncType] || log.syncType
              return (
                <div key={log.id || i} style={{ padding: '8px 12px', marginBottom: '6px', background: isPremium ? '#1c1305' : '#0f172a', borderRadius: '6px', borderLeft: `3px solid ${typeColor}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <span style={{ fontSize: '12px', fontWeight: '600', color: typeColor }}>{typeLabel}</span>
                      <span style={{ fontSize: '11px', color: log.status === 'success' ? '#4ade80' : '#f87171', background: log.status === 'success' ? '#052e16' : '#450a0a', padding: '1px 6px', borderRadius: '3px' }}>{log.status}</span>
                    </div>
                    <span style={{ fontSize: '11px', color: '#64748b' }}>{new Date(log.createdAt).toLocaleString('en-IN')}</span>
                  </div>
                  <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                    {isPremium ? (
                      <>
                        Scanned: {log.itemsFound} pairs | Kept: {log.itemsNew} | Rejected: {log.itemsFound - log.itemsNew}
                        {log.itemsFound > 0 && <span style={{ color: '#fbbf24', fontWeight: '600' }}> | {((log.itemsNew / log.itemsFound) * 100).toFixed(0)}% quality</span>}
                        {log.durationMs && <span> | {(log.durationMs / 1000).toFixed(1)}s</span>}
                      </>
                    ) : (
                      <>
                        Found: {log.itemsFound} | New: {log.itemsNew} | Updated: {log.itemsUpdated}
                        {log.durationMs && <span> | {(log.durationMs / 1000).toFixed(1)}s</span>}
                      </>
                    )}
                  </div>
                  {log.error && <div style={{ fontSize: '11px', color: '#f87171', marginTop: '2px' }}>{log.error}</div>}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Actions — Import & Export */}
      <div style={{ marginTop: '16px', borderTop: '1px solid #1e293b', paddingTop: '16px' }}>
        <h3 style={{ fontSize: '14px', color: '#64748b', fontWeight: '600', margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Actions</h3>

        {/* Import Knowledge to Vector DB */}
        <div style={{ ...styles.syncInfo, borderColor: '#059669' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
            <div>
              <div style={{ fontWeight: '600', color: '#22c55e', fontSize: '14px', marginBottom: '4px' }}>Import Knowledge to Vector DB</div>
              <p style={{ margin: 0, color: '#94a3b8', fontSize: '12px' }}>
                Import all {replyTemplates.length} reply templates + {STYLE_PAIRS.length} style pairs into the vector database with Voyage AI embeddings.
              </p>
              {importStatus && <p style={{ margin: '6px 0 0', color: '#60a5fa', fontSize: '12px' }}>{importStatus}</p>}
            </div>
            <button style={{ ...styles.btnPrimary, background: '#059669' }} onClick={importAllKnowledge} disabled={importing}>
              {importing ? 'Importing...' : 'Import All'}
            </button>
          </div>
        </div>

        {/* Export Premium Style Pairs */}
        <div style={{ ...styles.syncInfo, marginTop: '10px', borderColor: '#854d0e' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <div>
              <div style={{ fontWeight: '600', color: '#fbbf24', fontSize: '14px', marginBottom: '4px' }}>Export Premium Style Pairs</div>
              <p style={{ margin: 0, color: '#94a3b8', fontSize: '12px' }}>Extracts quality pairs from your chats and trains AI with your selling style.</p>
              <span onClick={() => toggle('premiumInfo')} style={{ color: '#fbbf24', fontSize: '11px', cursor: 'pointer', marginTop: '4px', display: 'inline-block' }}>{showSection.premiumInfo ? '▼' : '▶'} How it works</span>
            </div>
            <button style={{ ...styles.btnPrimary, background: '#854d0e' }} onClick={async () => {
              setPremiumExportRunning(true)
              try {
                const res = await fetch('/api/premium-export/run', { method: 'POST' })
                const data = await res.json()
                if (!res.ok) throw new Error(data.error || 'Export failed')
                setTrainingReport({ data, type: 'train' })
                fetchSyncHistory()
              } catch (err) { alert('Export failed: ' + err.message) }
              setPremiumExportRunning(false)
            }} disabled={premiumExportRunning}>{premiumExportRunning ? 'Training...' : 'Train AI Now'}</button>
          </div>
          {showSection.premiumInfo && (
            <div style={{ margin: '8px 0', padding: '12px', background: '#1a1a2e', borderRadius: '8px', border: '1px solid #854d0e', fontSize: '12px', lineHeight: '1.8' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ color: '#e2e8f0', fontWeight: '600', marginBottom: '2px' }}>WhatsApp Chats</div>
                <div style={{ color: '#fbbf24', paddingLeft: '8px' }}>{'  ↓'}</div>
                <div style={{ padding: '6px 10px', background: '#0f2a1a', borderRadius: '6px', borderLeft: '3px solid #4ade80' }}>
                  <span style={{ color: '#4ade80', fontWeight: '600' }}>Rule 1</span><span style={{ color: '#94a3b8' }}> — Thought Bundling</span>
                  <div style={{ color: '#64748b', fontSize: '11px', marginTop: '2px' }}>Messages within 5 seconds merged into one thought (wwbun)</div>
                </div>
                <div style={{ color: '#fbbf24', paddingLeft: '8px' }}>{'  ↓'}</div>
                <div style={{ padding: '6px 10px', background: '#0f2a1a', borderRadius: '6px', borderLeft: '3px solid #4ade80' }}>
                  <span style={{ color: '#4ade80', fontWeight: '600' }}>Rule 2</span><span style={{ color: '#94a3b8' }}> — Quality Filter</span>
                  <div style={{ color: '#64748b', fontSize: '11px', marginTop: '2px' }}>Keep only pairs with 4+ words on both buyer & seller side (wwbun)</div>
                </div>
                <div style={{ color: '#fbbf24', paddingLeft: '8px' }}>{'  ↓'}</div>
                <div style={{ padding: '6px 10px', background: '#1c1305', borderRadius: '6px', borderLeft: '3px solid #f59e0b' }}>
                  <span style={{ color: '#f59e0b', fontWeight: '600' }}>Rule 3</span><span style={{ color: '#94a3b8' }}> — Non-Context Only</span><span style={{ color: '#64748b', fontSize: '10px' }}> (Claude Opus)</span>
                  <div style={{ color: '#64748b', fontSize: '11px', marginTop: '2px' }}>Skip pairs about specific orders, prior conversations, or situations AI won't have context for</div>
                  <div style={{ color: '#f87171', fontSize: '10px', marginTop: '2px' }}>{"✗ \"My order hasn't arrived\" • \"Any update?\" • \"Aaj dispatch hua kya?\""}</div>
                </div>
                <div style={{ color: '#fbbf24', paddingLeft: '8px' }}>{'  ↓'}</div>
                <div style={{ padding: '6px 10px', background: '#1c1305', borderRadius: '6px', borderLeft: '3px solid #f59e0b' }}>
                  <span style={{ color: '#f59e0b', fontWeight: '600' }}>Rule 4</span><span style={{ color: '#94a3b8' }}> — Permanent Only</span><span style={{ color: '#64748b', fontSize: '10px' }}> (Claude Opus)</span>
                  <div style={{ color: '#64748b', fontSize: '11px', marginTop: '2px' }}>Skip answers that expire over time. Keep only facts that are always true.</div>
                  <div style={{ color: '#f87171', fontSize: '10px', marginTop: '2px' }}>{"✗ \"Charcoal out of stock\" • \"2-3 din mein aayega\" • \"Holiday tomorrow\""}</div>
                  <div style={{ color: '#4ade80', fontSize: '10px', marginTop: '1px' }}>{"✓ Policies, MOQ, payment methods, factory location, product details"}</div>
                </div>
                <div style={{ color: '#fbbf24', paddingLeft: '8px' }}>{'  ↓'}</div>
                <div style={{ padding: '6px 10px', background: '#0c1a3a', borderRadius: '6px', borderLeft: '3px solid #60a5fa' }}>
                  <span style={{ color: '#60a5fa', fontWeight: '600' }}>AI Knowledge Base</span>
                  <div style={{ color: '#64748b', fontSize: '11px', marginTop: '2px' }}>Kept pairs added permanently — AI learns your real selling style</div>
                </div>
              </div>
            </div>
          )}
          {settings.lastPremiumExportAt && <p style={{ margin: '0 0 4px', color: '#60a5fa', fontSize: '11px' }}>Last: {new Date(settings.lastPremiumExportAt).toLocaleString('en-IN')} ({settings.lastPremiumExportPairs || 0} pairs) | Next: {settings.nextPremiumExportAt ? new Date(settings.nextPremiumExportAt).toLocaleString('en-IN') : 'Pending'}</p>}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' }}>
            <span style={{ fontSize: '11px', color: settings.premiumExportEnabled ? '#4ade80' : '#f87171' }}>
              Weekly auto-export: {settings.premiumExportEnabled ? 'ON' : 'OFF'}
            </span>
            <button
              style={{ background: 'none', border: '1px solid #475569', borderRadius: '4px', padding: '1px 8px', fontSize: '11px', color: settings.premiumExportEnabled ? '#f87171' : '#4ade80', cursor: 'pointer' }}
              onClick={async () => {
                try {
                  await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ premiumExportEnabled: !settings.premiumExportEnabled }) })
                  window.location.reload()
                } catch (err) { console.error(err) }
              }}
            >{settings.premiumExportEnabled ? 'Disable' : 'Enable'}</button>
            <button
              style={{ background: 'none', border: '1px solid #854d0e', borderRadius: '4px', padding: '1px 8px', fontSize: '11px', color: '#fbbf24', cursor: 'pointer' }}
              onClick={async () => {
                const fromDate = prompt('Re-scan from date (YYYY-MM-DD):', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0])
                if (!fromDate) return
                setPremiumExportRunning(true)
                try {
                  const res = await fetch('/api/premium-export/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromDate }) })
                  const data = await res.json()
                  if (!res.ok) throw new Error(data.error || 'Export failed')
                  setTrainingReport({ data, type: 'rescan' })
                  fetchSyncHistory()
                } catch (err) { alert('Re-scan failed: ' + err.message) }
                setPremiumExportRunning(false)
              }}
              disabled={premiumExportRunning}
            >Re-scan</button>
          </div>
        </div>

        {/* Export Cleaned Reply Templates */}
        <div style={{ ...styles.syncInfo, marginTop: '10px', borderColor: '#166534' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
            <div>
              <div style={{ fontWeight: '600', color: '#4ade80', fontSize: '14px', marginBottom: '4px' }}>Export Cleaned Reply Templates</div>
              <p style={{ margin: 0, color: '#94a3b8', fontSize: '12px' }}>Cleaned for AI: removes catalog-redundant links, duplicates, temporary content.</p>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button style={{ ...styles.btnPrimary, background: '#166534' }} onClick={async () => {
                setTemplateExporting(true); setTemplateError(null); setTemplateResult(null)
                try {
                  const res = await fetch('/api/export/cleaned-templates')
                  const data = await res.json()
                  if (!res.ok) throw new Error(data.error || 'Export failed')
                  setTemplateResult(data)
                } catch (err) { setTemplateError(err.message) }
                finally { setTemplateExporting(false) }
              }} disabled={templateExporting}>{templateExporting ? 'Exporting...' : 'Export Templates'}</button>
              {templateResult && <button style={{ ...styles.btnPrimary, background: '#854d0e' }} onClick={() => {
                const blob = new Blob([templateResult.textExport], { type: 'text/plain' })
                const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url
                a.download = `reply-templates-clean-${new Date().toISOString().split('T')[0]}.txt`; a.click(); URL.revokeObjectURL(url)
              }}>Download ({templateResult.totalClean})</button>}
            </div>
          </div>
          {templateResult && <p style={{ margin: '8px 0 0', color: '#4ade80', fontSize: '12px' }}>{templateResult.totalClean} cleaned templates ready</p>}
          {templateError && <p style={{ margin: '8px 0 0', color: '#f87171', fontSize: '12px' }}>{templateError}</p>}
        </div>
      </div>
    </div>

    {/* Training Report Modal */}
    {trainingReport && (() => {
      const { data, type } = trainingReport
      const s = data.wwbunFilterStats || {}
      const d = data.wwbunDbDiagnostics || {}
      const samples = data.wwbunRejectedSamples || {}
      const title = type === 'rescan' ? 'Re-scan Report' : 'Training Report'
      const totalFiltered = (s.skipAi||0)+(s.skipShortWords||0)+(s.skipGreeting||0)+(s.skipAck||0)+(s.skipMedia||0)+(s.skipCatalog||0)+(s.skipProductSpec||0)+(s.skipDateRange||0)+(s.skipTemplate||0)+(s.skipEmpty||0)+(s.skipGenericOm||0)+(s.skipNoMatch||0)+(s.skipNumberOnly||0)+(s.skipUrlOnly||0)+(s.skipMediaRef||0)

      const filterRules = [
        { rule: 'AI-Generated Reply', why: 'AI replies don\'t show YOUR selling style', count: s.skipAi, key: 'ai' },
        { rule: 'Too Short (<4 words)', why: 'Both buyer & Om must have 4+ words for meaningful training', count: s.skipShortWords, key: 'shortWords' },
        { rule: 'Greeting Only', why: 'Buyer sent just "hi/hello/namaste" — no selling context', count: s.skipGreeting, key: 'greeting' },
        { rule: 'Acknowledgment Only', why: 'Buyer sent "ok/thanks/ha" — no question to learn from', count: s.skipAck, key: 'ack' },
        { rule: 'Contains Media', why: 'Image/video/audio messages can\'t be stored as text pairs', count: s.skipMedia, key: 'media' },
        { rule: 'Catalog/Welcome Reply', why: 'Generic catalog links — already in your catalog data', count: s.skipCatalog, key: 'catalog' },
        { rule: 'Generic Om Reply', why: 'Om just said "ok/thanks" back — no selling value', count: s.skipGenericOm, key: 'genericOm' },
        { rule: 'Product Specs (<15 words)', why: 'Short price/GSM replies — catalog already has this', count: s.skipProductSpec, key: 'productSpec' },
        { rule: 'Number-Only Buyer Msg', why: 'Buyer sent just a number like "50" — no context', count: s.skipNumberOnly, key: 'numberOnly' },
        { rule: 'URL-Only Message', why: 'Just a link with no conversation', count: s.skipUrlOnly, key: 'urlOnly' },
        { rule: 'Media Reference', why: 'Om said "check the image/video" — needs media we can\'t store', count: s.skipMediaRef, key: 'mediaRef' },
        { rule: 'Template/System Msg', why: 'Message starts with / or [ — not real conversation', count: s.skipTemplate, key: 'template' },
        { rule: 'No Buyer Match', why: 'Om\'s reply had no matching buyer message before it', count: s.skipNoMatch, key: 'noMatch' },
        { rule: 'Outside Date Range', why: 'Om replied outside the requested scan period', count: s.skipDateRange, key: 'dateRange' },
        { rule: 'Empty Content', why: 'Message had no text content', count: s.skipEmpty, key: 'empty' },
      ].filter(r => (r.count || 0) > 0)

      return <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, overflow: 'auto', padding: '20px' }} onClick={() => setTrainingReport(null)}>
        <div style={{ maxWidth: '700px', margin: '20px auto', background: '#1e293b', borderRadius: '12px', border: '1px solid #334155', padding: '24px' }} onClick={e => e.stopPropagation()}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h2 style={{ margin: 0, color: '#f8fafc', fontSize: '18px' }}>{title}</h2>
            <button onClick={() => setTrainingReport(null)} style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: '20px', cursor: 'pointer' }}>x</button>
          </div>

          {/* Result Summary */}
          <div style={{ padding: '12px', background: data.imported > 0 ? '#052e16' : '#1c1917', borderRadius: '8px', border: `1px solid ${data.imported > 0 ? '#166534' : '#854d0e'}`, marginBottom: '16px' }}>
            <div style={{ fontSize: '16px', fontWeight: '700', color: data.imported > 0 ? '#4ade80' : '#fbbf24' }}>
              {data.imported} quality pairs imported from {data.total} scanned ({data.skipped} rejected by Claude)
            </div>
            <div style={{ color: '#94a3b8', fontSize: '12px', marginTop: '4px' }}>Date range: {data.fromDate} to {data.toDate}</div>
          </div>

          {/* DB Overview */}
          {d.totalMsgsInRange != null && <div style={{ marginBottom: '16px' }}>
            <h3 style={{ color: '#94a3b8', fontSize: '13px', fontWeight: '600', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>WhatsApp DB Overview</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <tbody>
                <tr style={{ borderBottom: '1px solid #334155' }}>
                  <td style={{ padding: '6px 8px', color: '#94a3b8' }}>Total Messages in Range</td>
                  <td style={{ padding: '6px 8px', color: '#f8fafc', fontWeight: '600', textAlign: 'right' }}>{d.totalMsgsInRange?.toLocaleString()}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #334155' }}>
                  <td style={{ padding: '6px 8px', color: '#94a3b8' }}>Conversations</td>
                  <td style={{ padding: '6px 8px', color: '#f8fafc', fontWeight: '600', textAlign: 'right' }}>{d.totalConvsInRange}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #334155' }}>
                  <td style={{ padding: '6px 8px', color: '#94a3b8' }}>Om's Messages (SENT+READ)</td>
                  <td style={{ padding: '6px 8px', color: '#22c55e', fontWeight: '600', textAlign: 'right' }}>{(d.byStatus?.SENT||0) + (d.byStatus?.READ||0)}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #334155' }}>
                  <td style={{ padding: '6px 8px', color: '#94a3b8' }}>Buyer Messages (DELIVERED)</td>
                  <td style={{ padding: '6px 8px', color: '#3b82f6', fontWeight: '600', textAlign: 'right' }}>{d.byStatus?.DELIVERED||0}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #334155' }}>
                  <td style={{ padding: '6px 8px', color: '#94a3b8' }}>Text / Image / Audio / Other</td>
                  <td style={{ padding: '6px 8px', color: '#f8fafc', textAlign: 'right' }}>{d.byType?.TEXT||0} / {d.byType?.IMAGE||0} / {d.byType?.AUDIO||0} / {((d.byType?.VIDEO||0)+(d.byType?.DOCUMENT||0)+(d.byType?.LOCATION||0)+(d.byType?.TEMPLATE||0))}</td>
                </tr>
                <tr>
                  <td style={{ padding: '6px 8px', color: '#94a3b8' }}>Manual vs AI-Generated</td>
                  <td style={{ padding: '6px 8px', color: '#f8fafc', textAlign: 'right' }}>{d.byAiGenerated?.false||0} manual / {d.byAiGenerated?.true||0} AI</td>
                </tr>
              </tbody>
            </table>
          </div>}

          {/* Filter Pipeline */}
          <div style={{ marginBottom: '16px' }}>
            <h3 style={{ color: '#94a3b8', fontSize: '13px', fontWeight: '600', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Filter Pipeline (Rules 1 & 2 — Mechanical)</h3>
            <div style={{ padding: '8px 12px', background: '#0f172a', borderRadius: '6px', border: '1px solid #334155', marginBottom: '8px', fontSize: '12px' }}>
              <span style={{ color: '#94a3b8' }}>Conversations with Om's manual replies: </span><span style={{ color: '#f8fafc', fontWeight: '600' }}>{s.totalConvs}</span>
              <span style={{ color: '#94a3b8', margin: '0 8px' }}>|</span>
              <span style={{ color: '#94a3b8' }}>Messages loaded: </span><span style={{ color: '#f8fafc', fontWeight: '600' }}>{s.totalMsgs?.toLocaleString()}</span>
              <span style={{ color: '#94a3b8', margin: '0 8px' }}>|</span>
              <span style={{ color: '#94a3b8' }}>Thoughts bundled: </span><span style={{ color: '#f8fafc', fontWeight: '600' }}>{s.totalThoughts}</span>
              <span style={{ color: '#94a3b8', margin: '0 8px' }}>|</span>
              <span style={{ color: '#94a3b8' }}>Om replies found: </span><span style={{ color: '#fbbf24', fontWeight: '600' }}>{s.rawPairs}</span>
            </div>

            {filterRules.length > 0 && <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #334155' }}>
                  <th style={{ padding: '6px 8px', textAlign: 'left', color: '#94a3b8', fontWeight: '600' }}>Filter Rule</th>
                  <th style={{ padding: '6px 8px', textAlign: 'left', color: '#94a3b8', fontWeight: '600' }}>Why We Filter This</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right', color: '#94a3b8', fontWeight: '600' }}>Removed</th>
                </tr>
              </thead>
              <tbody>
                {filterRules.map((r, i) => <tr key={i} style={{ borderBottom: '1px solid #1e293b' }}>
                  <td style={{ padding: '5px 8px', color: '#f87171', fontWeight: '500' }}>{r.rule}</td>
                  <td style={{ padding: '5px 8px', color: '#94a3b8' }}>{r.why}</td>
                  <td style={{ padding: '5px 8px', color: '#f87171', fontWeight: '600', textAlign: 'right' }}>{r.count}</td>
                </tr>)}
                <tr style={{ borderTop: '2px solid #334155' }}>
                  <td style={{ padding: '5px 8px', color: '#f8fafc', fontWeight: '700' }}>Total Filtered</td>
                  <td></td>
                  <td style={{ padding: '5px 8px', color: '#f87171', fontWeight: '700', textAlign: 'right' }}>{totalFiltered}</td>
                </tr>
                <tr>
                  <td style={{ padding: '5px 8px', color: '#22c55e', fontWeight: '700' }}>Passed to Claude (Rules 3 & 4)</td>
                  <td></td>
                  <td style={{ padding: '5px 8px', color: '#22c55e', fontWeight: '700', textAlign: 'right' }}>{data.total}</td>
                </tr>
              </tbody>
            </table>}
          </div>

          {/* Sample Rejected Pairs */}
          {Object.keys(samples).length > 0 && <div style={{ marginBottom: '16px' }}>
            <h3 style={{ color: '#94a3b8', fontSize: '13px', fontWeight: '600', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Sample Rejected Pairs</h3>
            {Object.entries(samples).map(([category, pairs]) => <div key={category} style={{ marginBottom: '8px' }}>
              <div style={{ color: '#f87171', fontSize: '11px', fontWeight: '600', marginBottom: '4px' }}>{category}</div>
              {pairs.map((p, i) => <div key={i} style={{ padding: '4px 8px', background: '#0f172a', borderRadius: '4px', fontSize: '11px', marginBottom: '2px', display: 'flex', gap: '8px' }}>
                <span style={{ color: '#3b82f6', minWidth: '45%' }}>B: {p.buyer || '(empty)'}</span>
                <span style={{ color: '#22c55e' }}>Om: {p.om || '(empty)'}</span>
              </div>)}
            </div>)}
          </div>}

          {/* Sample Accepted Pairs */}
          {data.total > 0 && <div style={{ marginBottom: '16px' }}>
            <h3 style={{ color: '#94a3b8', fontSize: '13px', fontWeight: '600', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Quality Pairs Sent to Claude (Rules 3 & 4)</h3>
            <div style={{ color: '#94a3b8', fontSize: '11px', marginBottom: '4px' }}>Claude judges: Is it conversational? Does it teach Om's selling style?</div>
            <div style={{ padding: '6px 8px', background: '#052e16', borderRadius: '4px', fontSize: '12px', color: '#4ade80' }}>
              {data.imported} kept / {data.skipped} rejected by Claude
            </div>
          </div>}

          <button onClick={() => { setTrainingReport(null); window.location.reload() }} style={{ ...styles.btnPrimary, width: '100%', marginTop: '8px' }}>Close & Refresh</button>
        </div>
      </div>
    })()}
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
  tabs: { display: 'flex', gap: '4px', marginTop: '16px', borderBottom: '1px solid #1e293b', paddingBottom: '0', overflowX: 'auto' },
  tab: { padding: '10px 16px', border: 'none', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: '14px', borderBottom: '2px solid transparent', whiteSpace: 'nowrap' },
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
// Static Data: Style Pairs (from style-pairs-final.txt)
// ===========================================
const STYLE_PAIRS = [
  { buyer: "Aage customer ko batana h boxy fit 240 gsm ka", om: "Black and white only" },
  { buyer: "Courier se kitne din mein aaega", om: "4 to 5 days" },
  { buyer: "Aap le lo order", om: "How to order - https://youtube.com/shorts/F-zdRRSs370?feature=share" },
  { buyer: "And oversized 210 and 240 isme GSM ke alawa aur kya farak hai.?", om: "Bas gsm ka farq hai" },
  { buyer: "Hnn but kya ap order pe arrange krwa sakte ho??", om: "No sir. On order we dont make" },
  { buyer: "Polos jacquard fabric oversized regular??", om: "This only we sell sir" },
  { buyer: "Labeling and printing available h", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Contact send kar dijiye", om: "Custom order ke liye inse baat kar lo, bol dena Ketu ne number diya hai, acche rates laga denge - https://wa.me/917808284808" },
  { buyer: "But tshirt ka fabric 100 percent cotton nahi lag raha isse better quality hai apne pass??", om: "100% cotton hi hai. Aur doosra nahi milega , bas 1 hi hai 240gsm mein" },
  { buyer: "Sir, I have seen many of your videos on YouTube and I understood that, but this is my first job, so I can't understand the quality by touching it with my hands, which is a bit difficult. So if it was written, it would be a lot easier for me to understand. Sir, don't mind, I just told you about my problem.", om: "True biowash - no pilling\nBiowash - pilling may come\nNon bio- pilling will come" },
  { buyer: "Aj hum kapde purchase karne aare h bulk mai to self pickup karenge to aj he mil jiaga hame kapde?", om: "Yes mil jaayega. Agar possiblr hai to website se self pickup pe order kar do. Jab tak aaoge to ready milega." },
  { buyer: "Ye jo sublimation wala piece hai apna isme cotton kya percent hai", om: "Sublimation wala keval cotton feel hai. Hota 100% polyester hai. 1 sample check kar lo" },
  { buyer: "Ek accha rate bataiye\nKya rhega", om: "Sublimation tshirt mein mere paas bas 115rs wali hi milegi. Iska rate 105rs lagega for 80K pcs" },
  { buyer: "210gdm wali. Aur 240gsm wali?\n77 pcs chahiye mere ko", om: "Saari mil jaayegi website se order kar do" },
  { buyer: "Sir, Custom manufacturing available according to our size chart?", om: "No sir. On order we dont make" },
  { buyer: "Dilivery Charges ???\nTime duration ??? \n1day dilivery Or not ??", om: "Shipping calculator - https://www.bulkplaintshirt.com/calc/shipping-calculator.html" },
  { buyer: "Difference between bio rneck and True bio rneck", om: "True Bio Rneck - double biowash\nBio Rneck - single biowash\nNon bio - no biowash" },
  { buyer: "Bill ka Link diyega", om: "Print Safari, save this link and download all your bills here👇\n\nhttps://www.bulkplaintshirt.com/b.html#Af8Z6Wdcr6k3r\nSave kar lo ye link aap" },
  { buyer: "t shirt packing bag", om: "Not understood, what you mean sir?" },
  { buyer: "Bhai order pa aap size hmera according bna skta ho t shirts ki length", om: "Custom order we dont make sir" },
  { buyer: "Ap print karke bhi Tshirt dete hai ?", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "What's app a ek pic tha na jisme sab tha colour ek saath with model.?", om: "Wo nahi hai abhi\nhttps://drive.google.com/drive/folders/1URpaQH-BI3YWcp5iql3DaaQJd2fMheQR\n\nDownload photos here" },
  { buyer: "Thank you for your message. We're unavailable right now, but will respond as soon as possible.", om: "Same fixed price sir." },
  { buyer: "Minimum kitne T shirts order krni hogi", om: "Any quantity you can order." },
  { buyer: "Printer ka number bhej dijiyega please", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "one more thing, can I print my company logo on the cotton polo t-shirt if the quantity is 20?", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Website se hi karna pade ga sir ?", om: "Yes sir\nHow to order - https://youtube.com/shorts/F-zdRRSs370?feature=share" },
  { buyer: "True bio aur non bio round neck me kya diffrence hai", om: "True Bio Rneck - double biowash\nBio Rneck - single biowash\nNon bio - no biowash" },
  { buyer: "aapke paas printing facility bhi hai ?\nhi", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Want dtf\nStickers\nSir", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Okk, Aap surat me kisi White dragon kr k h unko de rhe?", om: "Dont know sir. Many people kkeep buying fron our website" },
  { buyer: "Minimum kitne pics ka order karna h", om: "Jo aapko chahiye mil jaayega. Order kar lo" },
  { buyer: "Aap 12 bje krna\nPossible hai?", om: "Call aayega aapke paas godam se to bata dena." },
  { buyer: "Or cod ho sakta hai kya", om: "Only prepaid we do sir." },
  { buyer: "And can you please provide your 3rd party printer detail i saw on ur yt shorts.", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Kya aap single piece delivery direct customer ko kar denge?", om: "Dropshipping mein 1 pc bhi ho jaayega" },
  { buyer: "Sir what if we stitch 500 oversized tshirt from you 240gsm...kuch discount milega", om: "Custom order we dont make sir. Ready stock we sell" },
  { buyer: "Number de dijiye woh cheap polo ka", om: "Custom order ke liye inse baat kar lo, bol dena Ketu ne number diya hai, acche rates laga denge - https://wa.me/917808284808" },
  { buyer: "Custom size moq how much?", om: "Custom order we dont take" },
  { buyer: "Share Details\nPls I need DTF painting  contect", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Print alag se ok bo apka hi bnda hai ?", om: "Nahi. Paas mein hai print wala\nHow do I cordinate with printer - https://youtube.com/shorts/Vwg-lChShx4" },
  { buyer: "Sir print kr dety ho ap ?", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Starting at lowest price", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Jo aaj kl chl rhe h", om: "Only plain we sell sir" },
  { buyer: "Whatever have in cart is it possible to do dtf print on 3 tshirts", om: "Yes\nWe only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Delivery charge Kitna lagega ahamdabad kaa", om: "Shipping calculator - https://www.bulkplaintshirt.com/calc/shipping-calculator.html" },
  { buyer: "Can I negotiate the price for acidwash tees", om: "Fixed price sir. We work with tight margin" },
  { buyer: "Return are not applicable", om: "Return, replacement not allowed sie" },
  { buyer: "Sir I am currently in Ahmedabad. Could you please provide one 240 GSM blank T-shirt to the printer? I will speak with him directly about what design to print and share my own design. Once it is ready I will collect it from you. Thank you.", om: "How do I cordinate with printer - https://youtube.com/shorts/Vwg-lChShx4" },
  { buyer: "Sir would it be possible to print one T-shirt as a sample for me? I will let you know the design", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Phon numbr is not there", om: "Same number only sir" },
  { buyer: "How much is moq", om: "Any quantity you can buy" },
  { buyer: "Apka wholesale hey mujhe customer ko sale karna padhta hey so 1 inch se tight hota hey log return karte hey", om: "Red 40 size main ek baar random pc check karta hun" },
  { buyer: "4 colors than iruka", om: "Only 5 colors we sell in kids" },
  { buyer: "What is biggest size", om: "Size chart - https://www.bulkplaintshirt.com/?q=SizeChart" },
  { buyer: "I want 7xl tshirts printer I have sell items to my customer at whole prices", om: "Not available this big sir" },
  { buyer: "140 hi krdo bhaiya", om: "Kaafi tight margin mein kaam hota hai sir. Isliye kuch possible nahi ho pata" },
  { buyer: "logo print krna h sbhi mai\ncollar per", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Sir please give me your answer", om: "We sell plain tshirts only. You can talk to him for Embroidary - Wa.me/919266306545" },
  { buyer: "Kitna moq h appka", om: "Anything you can buy sir" },
  { buyer: "Baki main dekh lunga", om: "Ok. Main kal 12,1 bajr tak parcel dilwata hun." },
  { buyer: "I wanted 3xl , 5xl\nAvailable\n?\nRound neck t shirt", om: "Not available. Max 46 chest we" },
  { buyer: "Sir contact kise kar sakte hu aap se me ek apna brand launch kar raha hu us ke liye kuch stock chahiye", om: "Catalog check kar lijiye" },
  { buyer: "Aaj time se kiya tha is kiye hi", om: "Sunday 11 to 4 we open sir" },
  { buyer: "Hi,  \nCan we customize colors as per requirement?  \nAnd what is your MOQ?", om: "No sir. On order we dont make" },
  { buyer: "Thank you for your reply. I have a few more questions before moving forward:\n\n1. I noticed the website only shows black, red, and dark blue. Do you have other color options available, such as cream or white?\n\n2. I would like the hoodies to have my brand logo printed. Do you offer printing services? If so, what printing methods are available (screen print, embroidery, etc.)?\n\n3. I see the hoodies are 320 GSM. Can you confirm if this fabric weight is consistent across all available colors?\n\n4. Could you please let me know if the fabric is environmentally friendly or sustainable in any way?\n\nThank you for your time and guidance. I look forward to your response.", om: "This only we sell sir" },
  { buyer: "Minimum kitni quality order kar sakte hai", om: "Jitna aapko chahiye kar lo" },
  { buyer: "can we talk now ?", om: "only prepaid we have sir" },
  { buyer: "Abhi sample chahiye ek", om: "Ok\nHow to order - https://youtube.com/shorts/F-zdRRSs370?feature=share" },
  { buyer: "Is this manufacturer or wholesaler ?", om: "We manufavture 22 products" },
  { buyer: "Sir sample ka photo send kar sakte ho kya", om: "Catalog check karlo. Yahi hai photos" },
  { buyer: "1 2 pice mil sak te haa kia drop shiping", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Thanks sir\n\nIt's been there in their godown since the last 3-4 days\n\nNot good service. Next time will opt Delhivery.\nThanks again", om: "Yes sir. Select delhivrry next time" },
  { buyer: "Oversized acid wash vest kro vo bhi achi demand mein h.", om: "Yes sir. Planning soon" },
  { buyer: "Agar mai ak 26 pis ka order du to kya uo aj ship hona possible hai ?", om: "Yes. Delhivery se kar dena" },
  { buyer: "Please share package photo, LR number and agent number jisse collect karna hai", om: "Sports villa, save this link and download all your bills here👇\n\nhttps://www.bulkplaintshirt.com/b.html#Af8KEsbnyn9y2" },
  { buyer: "Send your mail ID \nFor our Specifications", om: "On krder we dont make sir" },
  { buyer: "white 240 gsm t shirt is out stock", om: "Yes sir. Monday milega jo bhi sort hai" },
  { buyer: "Main wahin Yalahanka mein rehta hoon", om: "Near by delhivery warehouse search kariye map pe" },
  { buyer: "Agar location open ho jaatatoh main khud hi chaali jaati", om: "Banglore, yalahanka D -- ek baar ye batana kitna door hai?" },
  { buyer: "Products are really good sir.\nBut mai abhi small startup hu.\nIs it possible to remove gst price. Thoda relief mil jayega product order krne me.", om: "Kaafi tight margin mein kaam hota hai hamara sir." },
  { buyer: "Koi printing wala bhi h jo in t shirts pr print karde?", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Bhaiya can I get the invoice of this date\nI lost it from my device", om: "Manav, save this link and download all your bills here👇\n\nhttps://www.bulkplaintshirt.com/b.html#Afa0cyGYvb6s5" },
  { buyer: "Gsm 210 . .170 nahin hoga", om: "Fixed price sir. We work with tight margin" },
  { buyer: "Actually customer k demand regular fit k liye aa rhe\n\nAgar change karo thoda measurement me it will be really good", om: "Ok. Baaki sizing theek hai?" },
  { buyer: "Sand something have printed", om: "Only plain we sell" },
  { buyer: "also I want to know if I order 200 + t shirts to or kich price kam hoga? Like i want 210 gsm bage - s-20, m-20, l-20, xl-20, xxl-20\nBlack- s-20, m-20, l-20, xl-20, xxl-20\nOff white - s-10, m-10, l-10, xl-10, xxl-10", om: "Fixed price sir. Kaafi tight margin mein kaam hota hai" },
  { buyer: "Hi ketu  aapke online app se size chart download nahi ho raha hai as image can you please send me your size charts", om: "Size chart - https://www.bulkplaintshirt.com/?q=SizeChart" },
  { buyer: "Approx kitne baje tak?\nVrna mai 210gsm hi bhejdu", om: "But agar kahi aur se arrange ho jaaye to kar lijiye , kuch chances na aane ke bhi hai" },
  { buyer: "I wnat to return my order", om: "Return , replacement not allowed sir" },
  { buyer: "Min order?? As per size", om: "No moq. Jitna chahiye mil jaayega" },
  { buyer: "Please Round Neck Brown tshirt photo", om: "HD Photos - https://www.bulkplaintshirt.com/?q=HDphoto" },
  { buyer: "Do you do also printing?", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "30 pcs over sized round 210 gsm", om: "Shipping calculator - https://www.bulkplaintshirt.com/calc/shipping-calculator.html" },
  { buyer: "*Blank Tshirt, Hoodie : Solid Color*\nWe had delivered your order 105 days ago. If you need any assistance kindly message.", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Not able to order via 👆", om: "How to order - https://youtube.com/shorts/F-zdRRSs370?feature=share" },
  { buyer: "I don't want tshirt i want cloth", om: "Cloth we dont sell" },
  { buyer: "Thank you for your reply sir 🙏\n\nI am building a London-based sourcing support service to help Indian manufacturers connect with genuine UK buyers.\nWe will showcase verified samples in London, coordinate buyer communication, and support with order follow-up and documentation  so buyers can place orders with more confidence.\n\nMay I ask:\n\n1) What main challenges do you face while dealing with UK buyers? (pricing pressure, small MOQ, communication, payments, etc.)\n2) If we display your samples in London and coordinate buyer discussions locally, would that help you get more serious export orders?\n\nYour feedback will really help us design the service better. Thank you!", om: "No issue from our side. You keep showing sampels to your buyers, and keep ordering. Will keep dispatching same day" },
  { buyer: "Sir apki bo round neck aur non bio me kya jyada farq h", om: "True Bio Rneck - double biowash\nBio Rneck - single biowash\nNon bio - no biowash" },
  { buyer: "Bhaiya 1 oversize 240 gsm M size chaiye hai black color m", om: "Website se kar do order" },
  { buyer: "Your website is very complicated that's why i approached here", om: "How to order - https://youtube.com/shorts/F-zdRRSs370?feature=share" },
  { buyer: "Did the printer collect the items", om: "Printwr se baat kar lo ek baar. Inform kar diya tha use" },
  { buyer: "Round tshirt size chet", om: "Size chart - https://www.bulkplaintshirt.com/?q=SizeChart" },
  { buyer: "Sceaner send kijiye sir ji", om: "Website se lijiye. Whatsapp se sell nahi hota" },
  { buyer: "Available or not yet", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Extra wala aya he nhi h", om: "Nahi samjha. Ye pcs nahi mila aapko , jo add kiya tha?" },
  { buyer: "Humne abhi phone kiye the aap video bhejiye", om: "How to order - https://youtube.com/shorts/F-zdRRSs370?feature=share" },
  { buyer: "Dtf sticker wale ka link de denge kya sir?", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Sir regular fit zipper and non zipper hoodies mai kafi rava /balls ban gai hai thode use mai hi or fabric to bilkul hi rough ho chuka hai andar bahar se", om: "Hoodies non biowash hoti hai. Jyada rough use hoga to roa aayega" },
  { buyer: "My home is in Tiruppur only that's why I asked", om: "Samples we can courier to you sir. Within 2 days it deliveres" },
  { buyer: "My Order When I Get", om: "Tracking check karna uspe likha hoga delivery date" },
  { buyer: "Do you have the stock in tirupur", om: "Tiruppur only production unit sir.. Visit allowed in delhi warehouse only." },
  { buyer: "Could you print\nAlso", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Like i buy Tshirts from you and give them Tshirts with low moq wala", om: "For these no sir" },
  { buyer: "Jab 10 se zaida buy karenge to overall kitna GST lagega", om: "Same lagega jo website mein lag raha hai" },
  { buyer: "Direct nahi ho raha", om: "How to order - https://youtube.com/shorts/F-zdRRSs370?feature=share" },
  { buyer: "Delivery charges kitna hai?", om: "Shipping calculator - https://www.bulkplaintshirt.com/calc/shipping-calculator.html" },
  { buyer: "Ketu, any embroidery vendor near Khanpur, you know?", om: "Nahi sir. Khanpur mein to idea nahi hai." },
  { buyer: "Uska kia charge hai? T shirt par Print karwana h graphic", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "What cost it'll be if I order as sample in 240GSM", om: "Here written sir. Check and order once" },
  { buyer: "True bio rneck or non bio rnech me kya difference h or bio rneck", om: "True Bio Rneck - double biowash\nBio Rneck - single biowash\nNon bio - no biowash" },
  { buyer: "And bhaiya apki najar Mai dtf printing service he kya", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "But both polo came in same colour. Also one kids round neck was fullhand", om: "We only sell half tshirts sir." },
  { buyer: "5A/52 Block A NIT Faridabad near pizza villa", om: "Website pe sahi dal hai?" },
  { buyer: "Lagbhag 1 week pahle bhi aapne next week hi bola tha", om: "Xs mein thoda time lag raha hai. Is week ka time do, main update karta hun" },
  { buyer: "Pls send the details of embroidery vendor", om: "We sell plain tshirts only. You can talk to him for Embroidary - Wa.me/919266306545" },
  { buyer: "Sir apke diye huwe num main koi oder hi received nahi karraha hai", om: "Bhejo , kya order chahiye aapko. Screenshot bhejo cart ka" },
  { buyer: "Aap ne bola next order", om: "Online mein 2 rs per pc ka discount lag jaayega. Manually possible nahi hota discount" },
  { buyer: "delhivery price was 3000 something but estimate date is 2 march\n\nbluedart price was 4000 something but estimate date is 22 feb", om: "Ok. Next time avoid bluedart sir. For now i will push them for urgent delivery" },
  { buyer: "Bhai kis rate say vapis liye details bhej dena", om: "Not caluclated sir. Just refunded approx amount." },
  { buyer: "Can I have the pricing details\nFor Henley neck", om: "This type we dont make" },
  { buyer: "I am not able to find in this link", om: "Only half sleeve we sell" },
  { buyer: "Washcare label lagane k lie app kuch suggest kr sktei h? Kahin apke as pas sei Krva sake...", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Call v nhi aya", om: "Oho. Main wapas se baat karta hun bluedart wale se." },
  { buyer: "kya aap kuch help kar sakte hain?", om: "Main complaint daal deta hun urgent delivery ke liye" },
  { buyer: "Aap t-shirts print karke bhi dete Hain ya only for plain t-shirt", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Us se baat krlu print k barey me?", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Actually dhaga bhi thoda stitching ka bhi h bt voh koi baat ni isliye confirm Kiya h ki aage or piece m aisa na ho that's it", om: "Ok sir. Dekhta hun" },
  { buyer: "Mal lgatar lgega agle mhine se", om: "Nahi sir. On order nahi banate ham" },
  { buyer: "टी शर्ट और शर्ट और लोवर का कैटलॉग भेजो सर", om: "HD Photos - https://www.bulkplaintshirt.com/?q=HDphoto" },
  { buyer: "Sir roder ks number mil jaega kya", om: "Tracking aayi hogi aapko doosre number pe" },
  { buyer: "And MOQ KYA HAI", om: "10 pcs only sir." },
  { buyer: "Printing shirts ..\nPlease send me your products pitures ans prices", om: "HD Photos - https://www.bulkplaintshirt.com/?q=HDphoto" },
  { buyer: "Size badi lag rahi hai.\nL order kiya tha , shayad,  M thik hai", om: "Return, replace allpwed nahi hota sir." },
  { buyer: "We got only this", om: "Ok. Jo aapne order kiya tha, wo order hamari taraf se galat aaya tha? Ya fir aapko sizing badi lag rahi hai pehnne mein?" },
  { buyer: "bulk me lege ti price kya lagega\nsir 100pv\npc\n?", om: "Approx 120 to 130 ke aas paas aayega per pc. Aane ke baad hi clear bata paaunga" },
  { buyer: "bike pr chla jaegaa? ya auto book kru?", om: "Bik se chala jaayega. 100rs extra lega. Same rate mein auto book ho to auto hi kar dena" },
  { buyer: "Inka no. Bhej dogy ap?", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Which products are available and what are the products\nU have", om: "HD Photos - https://www.bulkplaintshirt.com/?q=HDphoto" },
  { buyer: "Sir, hume RF acid wash ki requirement hai. Kindly help kijiye. Agar aap jaisi quality ka koi RF acid wash supplier ho toh please inform kijiye.", om: "Better searxh on indiamart sir" },
  { buyer: "Can I get to talk to some executive?", om: "Size chart - https://www.bulkplaintshirt.com/?q=SizeChart" },
  { buyer: "240 gsm 140 ki nhi hogi", om: "Nahi sir. Fixed price" },
  { buyer: "It’s very difficult to purchase them without size chart", om: "Womens tshrits launhing in march sir. Sizechart also will be available soon" },
  { buyer: "Sir apni catalogue bhejna", om: "Website check kar lo once" },
  { buyer: "200 me lu tab b stitching double nai kroge kya", om: "Custom possible nahi hota sir." },
  { buyer: "can you confirm the pricing please so we can give quotation to the customer", om: "210+5% gst per pc madam" },
  { buyer: "ok - then what will be the total cost? Will share the quotation with customer and wait for approval...", om: "Will send from tiruppur," },
  { buyer: "Hello sir \nI ordered sample and that's pretty good now I was thinking about printing do you provide printing services?", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Any planning to bring for this summer brother..?", om: "Yes sir . Give me 20 days , will give clarity" },
  { buyer: "I can trll you my order here and then you can uou please forward it to the printing guy", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "And kg per rate hote hain kya parcel ke", om: "Shipping calculator - https://www.bulkplaintshirt.com/calc/shipping-calculator.html" },
  { buyer: "Agar abhi nahi nikla hai to pls hold kar lo", om: "Pahuchne wala hoga. Kaafi der ho gayi nikle" },
  { buyer: "Sir abhi aa jaye ..close to nhi ho gaya ya fr morning me aaye ..morning me kitne baje open ho jaati hai sir", om: "6.30 tak wait kar loonga. Aaj aaoge to" },
  { buyer: "Products show ni ho re to product description show ni ho ra h", om: "Website mein check kar lo - sale91.com" },
  { buyer: "Size chart bta do black polo ki", om: "Size chart - https://www.bulkplaintshirt.com/?q=SizeChart" },
  { buyer: "Crop top is an option?", om: "After 20 days , we are launching ladies wear" },
  { buyer: "What's the ordering process", om: "How to order - https://youtube.com/shorts/F-zdRRSs370?feature=share" },
  { buyer: "Design print ho sakta h ispe?", om: "Yes\nWe only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Black dekha tha bas", om: "Ok. Jo bhi fresh pc hai aap use courier kar do hanare address pe." },
  { buyer: "Or replace it with any other tshirt", om: "Koi pcs to open nahi kiye gaye hai? Sayad 1 pc aapne open kiya hoga check karne ke liye" },
  { buyer: "Planning start my business", om: "Ok. Return we are not allowed sir" },
  { buyer: "Delivery ke time payment karunga hoga", om: "Dispatch ke pehle clear karna hota hai" },
  { buyer: "Sincar favourite Mein maal mil sakta hai kya", om: "Ek baar catalog check kar lo" },
  { buyer: "Did you receive the payment?", om: "No madam. Share screnshot once" },
  { buyer: "I want 300 Plain hoodies \nWhat is the cost bro", om: "Color?\nhttps://wa.me/p/25256530500685914/919336695049\n\nHoodie catalog 👆" },
  { buyer: "Bhai acid wash me colour bhejo n", om: "Yes soon launching more color. 6 colors under production" },
  { buyer: "Don't worry about that", om: "Ok. You total quantity approx idea give me once sir" },
  { buyer: "alag se nahi kiya tha", om: "Order website se kiya tha?" },
  { buyer: "Call me if you can", om: "Where do you need delivery sir? India or outside?" },
  { buyer: "I want printed t shirt", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Ekbar screenshot bhi dehiga toh file karne kaa", om: "Gst number is wrong sir. Please verify again and share gst document" },
  { buyer: "Cost kya rahegi if i opt for 10-12 Tshirts initially", om: "Same fixed price as per website" },
  { buyer: "Also can you print also?", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Polo par dtf nai chslra chippak raha hai\nHow to do?", om: "Hota hai sir. Kaafi log karte hai. Aapki heat kam hofi/ya duration/ya sticker ke glue mein kuch issue hoga" },
  { buyer: "Do you have this colour", om: "HD Photos - https://www.bulkplaintshirt.com/?q=HDphoto\nThese only we sell" },
  { buyer: "Apki koi other shop hai ? Near by noida", om: "No sir. But within 2 hours delivery possible" },
  { buyer: "Do you manufacture also?", om: "On order we dont make" },
  { buyer: "can you cancel? refund?", om: "Your parcel dispatched already sir" },
  { buyer: "What is specs of Oversized T shirts ?", om: "Size chart - https://www.bulkplaintshirt.com/?q=SizeChart" },
  { buyer: "apkai pas milaiga yeh acid wash", om: "Yes\nhttps://wa.me/p/25545071575113769/919336695049\n\nAcidWash Cataloge👆" },
  { buyer: "ap rakh lena bhai mughay or oversige tshirts may segment may jana hai", om: "Saare pcs packed hai proper. ? Kuch open hue hai?" },
  { buyer: "1.5 ya 2 lakh tak ka product kharid chuka hu apsay", om: "Hamare paas bhi rakha rahega next winter tak sir." },
  { buyer: "Sir mai puch rha tha ki apni tshirt mai kitna percentage cotton and polyester hota hai\nIski detail", om: "100% cotton only sir" },
  { buyer: "I need oversized tshirt for women", om: "After 25 days this we launching" },
  { buyer: "can i buy directly from whatsapp", om: "Do from website for urgent dispatch sir\nHow to order - https://youtube.com/shorts/F-zdRRSs370?feature=share" },
  { buyer: "Plz send the bill", om: "How to order - https://youtube.com/shorts/F-zdRRSs370?feature=share" },
  { buyer: "3-4 customers ke complaint aaye hai", om: "Both same size , before wash?" },
  { buyer: "baaki apki oversize bhi mangvai maine bhot achi h", om: "Boxy mein thoda mota fabric bana rahe hai. Jaldi refill hoga" },
  { buyer: "Ban sakte hai kya", om: "Nahi madam, customize order possible nahi jo paate" },
  { buyer: "I want to buy Cash on delivery process", om: "Only prepaid we have" },
  { buyer: "Ok \nOr sir bottom wear mai\nJoggers vagera", om: "Yes fulll pant coming soon sir" },
  { buyer: "Riyadh at takhassusi \nZip code 12311\nSaudi Arabia \n\n100 piece of acid wash oversized t-shirt", om: "Ok wait. Askimg shipping cost for 100 pc , approx 27kg" },
  { buyer: "I’m in Riyadh city", om: "Share full addrss with zipcode sir" },
  { buyer: "M 7\nL 8", om: "Website se kar dijiye" },
  { buyer: "Same here Saudi Arabia?", om: "No sir. Insternational order here only" },
  { buyer: "E block, sector 12 noida,\nNear modern school junior wing.", om: "Website mein correct location daali hai?" },
  { buyer: "Can you tell me about \n\nWhat’s na minimum count for the order \n\nAnd did you deliver it Saudi Arabia?", om: "Anything you can order" },
  { buyer: "Thik hey print mey Kitna cost lagega idhar mereko", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Please do the needful", om: "Yes sir. Doing what is possible from my side. Will push them" },
  { buyer: "do you have a store in Ahmedabad?", om: "No. But next day deivery possible by train" },
  { buyer: "WHOLESALER AND BULK BUYERS CONTACT ON FACTORY NUMBER 9716367078 🙏\nWHOLESALER AND BULK BUYERS CONTACT ON FACTORY NUMBER 9716367078 🙏", om: "Inform him sir once" },
  { buyer: "Order website pe karna he", om: "Yes kar dijiye\nHow to order - https://youtube.com/shorts/F-zdRRSs370?feature=share" },
  { buyer: "Hey I ordered a sample. Quality was superb but the only issue is oversized hone k bd bhii sleeves are shorter compared to normal oversize that we wear.", om: "Boxy Fit hai hamare paas. Ek baar wo bhi check kar. Lo" },
  { buyer: "Kuch discount hoga kiya", om: "Fixed price sir. Website se order kar lijiye" },
  { buyer: "Scanner\nBhejoge ek baar", om: "True bio maroon 42 ..2pc short \nKids baby pink 30 1pc shot" },
  { buyer: "Ya total 23kg weight ka bol rahe ho", om: "Weight 23 kg And Charges @520 Per kg //DPD Duty Free Service" },
  { buyer: "Gat invoicw would ve in our name", om: "On website add yourbilling details. After order, bill will download" },
  { buyer: "Delevery kitna din me hojae ga", om: "Shipping calculator - https://www.bulkplaintshirt.com/calc/shipping-calculator.html" },
  { buyer: "Send me colors avilable", om: "HD Photos - https://www.bulkplaintshirt.com/?q=HDphoto" },
  { buyer: "Can you share me some clothes pictures", om: "HD Photos - https://www.bulkplaintshirt.com/?q=HDphoto" },
  { buyer: "Oder cancl dkara hn mera why", om: "Hamne koi order nahi bheja aapko. By mistake message aa gaya hoga" },
  { buyer: "As per our design requirements?", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Ho sakti hai kya same price me vo", om: "Custom nahi banate sir. Baaki khud ke liye ek baar dekh leta hu. Theek lagega to aise hi continue kar doonga" },
  { buyer: "Need custmoised t shorts for promotion", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Off white  430 gsm me \\M\\ size", om: "Nahi sir. Hoodie mein abhi thoda time lagega" },
  { buyer: "Can you also share me a no kf someone who deal in caps want tshirts and caps for my brand", om: "9953532428 - Mukesh ji\n\nBol dena Ketu ne number diya hai, will give better rates." },
  { buyer: "Printing walle ka\nSir", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "waise kal kitne baje tak received ho jayega ?", om: "Kal 10 baje nikal doomga" },
  { buyer: "Delivery charges kaya ha", om: "Shipping calculator - https://www.bulkplaintshirt.com/calc/shipping-calculator.html" },
  { buyer: "You will mention the size atleast right?", om: "Yes size lable hota hai waha" },
  { buyer: "Sir this Artical\nMinimum Kitna Pes order \nKrna hoga\nTo \nRs.180 /- GSM 240 Loopknit Cotton \nLagega\nSame rate", om: "Kuch bhi lelo. Ready stock hota hai" },
  { buyer: "And also do you attach the size lable?\nOr u print it on the tshirt?", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Printed tshirt ve milega kya", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Kitna charge aaega Mumbai Tak", om: "Shipping calculator - https://www.bulkplaintshirt.com/calc/shipping-calculator.html" },
  { buyer: "Bina print ka hip hop tshirt hain kya", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Bhut mnga print kr ra hn ye to", om: "We sell plain tshirts only. You can talk to him for Embroidary - Wa.me/919266306545" },
  { buyer: "Printer no send kr do", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Client wants to have information around waisit size in tshirts , it is not mentioned in size chart", om: "Size chart - https://www.bulkplaintshirt.com/?q=SizeChart" },
  { buyer: "What is your return policy", om: "No return, no replacement sir. Check sample before bulk purchase" },
  { buyer: "I need only 5 pieces", om: "Size chart - https://www.bulkplaintshirt.com/?q=SizeChart" },
  { buyer: "Do you attach care labels as well?", om: "No sir. Plain solid color only we sell. No custom" },
  { buyer: "Label humara chaya\nLogo", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Pls share pictures \nCloseup photos\nOf fsbric", om: "XL, XXL only we have sir." },
  { buyer: "Uske saat bhi hojayega?", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Pehle bohot order Kiya hai aapse", om: "Website se order kar do" },
  { buyer: "Aaj nahi ho paiga?", om: "Sunday 11 to 4 only open hota hai" },
  { buyer: "Is there any shipping charges", om: "Yes\nShipping calculator - https://www.bulkplaintshirt.com/calc/shipping-calculator.html" },
  { buyer: "and also provide me the dtf print number", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "What is the minimum order quantity that can be made?", om: "Any quantity you can do sir" },
  { buyer: "Sir ap dtf sticker use karte ho", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "bhai apko embroidery wala koi mila?", om: "We sell plain tshirts only. You can talk to him for Embroidary - Wa.me/919266306545" },
  { buyer: "430 gsm hoodie black L size 2", om: "Kar dijiye website se hi" },
  { buyer: "sir aap muje print karwa ke tshirts available karwa skte ho kya", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Premium polo ka mall update", om: "Tuesdaybupdate karta hun clearly air\nSir" },
  { buyer: "4-5 DIN TK CHAHIYE THA", om: "Nahi aayega sir . Thoda sa time lag rhaa hai. But aane ke baad issue nahi aayega fir" },
  { buyer: "Biowashed \nPre shrunk\nColor fade", om: "Koi issue nahi hai. Ek baar 1 pc sample leke check kar lo" },
  { buyer: "Ok, order place website se Krna h direct?", om: "Yes website se\nHow to order - https://youtube.com/shorts/F-zdRRSs370?feature=share" },
  { buyer: "Kitne tak ak\nKa", om: "Fixed price hota hai sir hamara. 500+ ke liye 173rs per pc lag jaayega +5% gst" },
  { buyer: "Isse zyda toh ni lagega na sir?", om: "Ek baar tuesday confirm  kar lena. Clarity dedoonga" },
  { buyer: "Kids may t-shirt Gol Gala aur colar mein send me catalogue with price", om: "Kids keval gol gala milega\nhttps://wa.me/p/25279271618431821/919336695049\n\nKids Catalog 👆" },
  { buyer: "Also in polo customised colours", om: "Not available this type" },
  { buyer: "Aapke paas ye colour available Hai?", om: "HD Photos - https://www.bulkplaintshirt.com/?q=HDphoto" },
  { buyer: "Order kaise karna hain video send kijiye", om: "How to order - https://youtube.com/shorts/F-zdRRSs370?feature=share" },
  { buyer: "yes, looking to start up my t-shirt printing business and exploring now.\nso what's the minimum qty i have to order to check the quality and all", om: "Any quantity you can buy" },
  { buyer: "Bhaiya, paisa wapas nahi aya. Aap check kar lijiye ek bar.", om: "Ek baar screenshot bhejna jo deduct hua hai. Check karta hu apni side" },
  { buyer: "Can you send me size chart of over size  t shirt", om: "Size chart - https://www.bulkplaintshirt.com/?q=SizeChart" },
  { buyer: "Check if you can increase it.", om: "Fixed price sir. We work with tight margin" },
  { buyer: "Paisa kat gaya hai, maine khudh hi upi se payment kiya hai.", om: "Ok. Wait foe somtime" },
  { buyer: "I hav already taken d payment", om: "Next week will update for this" },
  { buyer: "U sure na he wil pick up today", om: "Yes delhivery will pick today" },
  { buyer: "Aur ye bhi bata dijiye ki ham tak deliver kaise hoga ?", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726\nHow do I cordinate with printer - https://youtube.com/shorts/Vwg-lChShx4" },
  { buyer: "Shipping charges bohot jada hai", om: "Shipping calculator - https://www.bulkplaintshirt.com/calc/shipping-calculator.html" },
  { buyer: "Can you print on the tshirt?", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Aur agar koi factory defect, yeh alter koi pcs hai toh exchange ho jayega\n??", om: "Kuch genuine issue hua to replce kar doonga" },
  { buyer: "You are also do dropshipping and pod", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "What is the minimum order quantity", om: "10 pcs only for bulk rates" },
  { buyer: "Aap kab tak refund karenge agar kal cancel kardu", om: "Parcel aa jaayega return, uske baad ho jaayega" },
  { buyer: "Ordered on 8th Feb", om: "Ok. Main complaint daal deta hun urgejt delivery ke liye" },
  { buyer: "*\nmain aaap se next time purchase karuga toh add Karwa luga \nChalega?", om: "Main pay kar deta hun , hisaab clear rahega. Share QR" },
  { buyer: "Also what is your return policy?", om: "Next day possible viantrain option on website" },
  { buyer: "But phir website pe se kaise order hoga?", om: "How to order - https://youtube.com/shorts/F-zdRRSs370?feature=share" },
  { buyer: "Jaha M ka sticker laga hey wo S hey as per measurement", om: "Ek baar chest size ka measurement bhejna" },
  { buyer: "Which courier should i select", om: "Select delhivery. Will be picked todayy." },
  { buyer: "I have already made the payment. Will you put it in the train today?", om: "Whixh order. Share bill number" },
  { buyer: "Grey and black zipper hoodie", om: "Website wala order ho dena hai, correct? Anything else?" },
  { buyer: "I want polo t.shirt dot knit", om: "Only cotton we sell sir" },
  { buyer: "Need pique collar t.shirts 220gsm rib collar and rib short sleeves with pocket and side slit. It should have minimum 3 or 4 button placket. Any pastel colour is ok. But Good quality.", om: "Custom order we dont make sid" },
  { buyer: "Let me know white sir", om: "White will update after 2 days sir" },
  { buyer: "Oversize tshirt \nSize chart bhejna\n\n210 gsm\nBeige \nQty 100", om: "Size chart - https://www.bulkplaintshirt.com/?q=SizeChart" },
  { buyer: "Collor tshirt sublimation printing ka liaya", om: "Only round neck we sell in sublimation tshirt" },
  { buyer: "Apna barcode ya FIR bank detail send kar sakte hain kya", om: "Kya issue hai? Screenshot bhejna ek baar" },
  { buyer: "Sir dtf printing ka charge kya rahega", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Also do you have 240 gsm in XS in black and white?\nOr 220", om: "Black we have , will be ailable soon sir" },
  { buyer: "Kam nai hoga? Ap dairect wtsp pe kr le skte h ordr?", om: "Website se order only sir we are allowd" },
  { buyer: "What is the moq for order?", om: "10 pcs for bulk rates" },
  { buyer: "Without zip hythobhi chalega", om: "Not available this type" },
  { buyer: "Not showing 120 gsm 145 gsm", om: "This on order we make. Moq 10K pcs per color" },
  { buyer: "Bhaiya number bhej dene customize wale ka", om: "Custom order ke liye inse baat kar lo, bol dena Ketu ne number diya hai, acche rates laga denge - https://wa.me/917808284808" },
  { buyer: "Do you do printing as well ?", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Can you please share bill", om: "JAGS CUSTOM GARMENTS, save this link and download all your bills here👇\n\nhttps://www.bulkplaintshirt.com/b.html#Af9iaZs5govds" },
  { buyer: "And hume kya 300pay Krna hai?? Because isme topay likha hai or hum to already pay kr chuke h", om: "Bus/transport mein topay hi hota hai. 350rs local transport hota hai, jo jaata hai booking karane , usko dene hote hai." },
  { buyer: "I need it tomorrow", om: "Already taken today. May be not updated in system but dispatched from my side. Late nitght it will update" },
  { buyer: "And I want order at uae\nIs it possible?", om: "This is our new product, will update soon after 25 days" },
  { buyer: "You have production in unisex?", om: "We currently sell mens tshirts only. It alao works as unisex" },
  { buyer: "Me agar 150 peace black t shirt lu to kitne ka parega?\n?", om: "3 verities hai\nhttps://wa.me/p/25429462326705540/919336695049\n\nNon Bio Catalog👆" },
  { buyer: "Size chart chahiye tha sir", om: "Size chart - https://www.bulkplaintshirt.com/?q=SizeChart" },
  { buyer: "How can I get sample?", om: "How to order - https://youtube.com/shorts/F-zdRRSs370?feature=share" },
  { buyer: "Sham ko portar book karunga ho jyega kya", om: "Ok. Click order now. Book under self pickup" },
  { buyer: "I want 200 buy so price?", om: "Fixed price sir. We work with tight margin" },
  { buyer: "We will purchase new  t shirt from you please", om: "All pcs are fresh packed , jaise aaye the or open kiye hai?" },
  { buyer: "As that huddies are dead stock for me  and I am a small business owner", om: "We are not allowed like this madam" },
  { buyer: "Bill details mai forward kr rha jiske name se banega", om: "Website mein hi billing details daal do\nHow to order - https://youtube.com/shorts/F-zdRRSs370?feature=share" },
  { buyer: "Delivery timing to Chennai and courier charges", om: "Shipping calculator - https://www.bulkplaintshirt.com/calc/shipping-calculator.html" },
  { buyer: "apki service, cost, delivery time response.....sab accha hai... isliye chahta hoon ki sabhi required colors apke paas hi mil jaye", om: "Ji sir. Will surely add. Aap bas yaad se bhej dena , jo bhi best ho, bas 3 article is enough" },
  { buyer: "When you can send sample ?", om: "Order from here\nHow to order - https://youtube.com/shorts/F-zdRRSs370?feature=share" },
  { buyer: "mere pass 1 week mein aa jayega... Tirupur se aayega", om: "Ok. Agar possible ho to mere paas bhej dijiye , 3 /4 article bas , jo aapke best lage, launch karne ke liye. Jo bhi cost hogi main aapko dedoonga" },
  { buyer: "Minimum order quantity !?", om: "Anything you can buy sir." },
  { buyer: "Want to start with sweatshirts and hoodies.. later check on others .", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "appse aakar ekdin milna bhi hai...apka kuch suggetion bhi chahiye mujhe apne brand ko aur establish karne ke liye", om: "Noted. This will also launch soom\nSure sir" },
  { buyer: "Bro I dnt know Hindi \nCan u reply in english", om: "I will put a compalint for urgent delivery" },
  { buyer: "L 5\nXl 5\n3xl 3\n4xl 3\n5xl 3\n\nBlack", om: "Website mein daal ke screenshot bhej do" },
  { buyer: "You didn't share yesterday bhaiya", om: "Forgot sir. Will share today. Will make video and share" },
  { buyer: "Please share size chart", om: "Size chart - https://www.bulkplaintshirt.com/?q=SizeChart" },
  { buyer: "Ok payment ka kese karna padega", om: "How to order - https://youtube.com/shorts/F-zdRRSs370?feature=share" },
  { buyer: "Sir ye fabric mil sakta hai ?", om: "Nahi. Keval cotton ka kaam hota hai hamraa" },
  { buyer: "How many days it takes to reach Mumbai", om: "2 days by bluedart air" },
  { buyer: "bulk main kitne ka 1 pic milega", om: "Rate check karlo. Fixed price hai" },
  { buyer: "Oversize hoodies ka shoulder and sleeve length ji details bhej skte hai kya\nOrder Krna hai", om: "Size chart - https://www.bulkplaintshirt.com/?q=SizeChart" },
  { buyer: "What is the different between true bio reck , bio rneck and non bio rneck ?", om: "True Bio Rneck - double biowash\nBio Rneck - single biowash\nNon bio - no biowash" },
  { buyer: "Bhai photo send kr sakte hoo kya??\nReal image", om: "HD Photos - https://www.bulkplaintshirt.com/?q=HDphoto" },
  { buyer: "Apko send nhi kiye hey\nWo mera loss hey", om: "I understand. Main 19 pcs ka refund karta hun aapko. Share QR" },
  { buyer: "Mere pass kuch nhi aya tracking ka\nCheck kiya", om: "Website se order kiya?" },
  { buyer: "1 piece kitne ka pdega", om: "Catalog check karo. Saare rates hai" },
  { buyer: "What is the minimum order", om: "10 pcs only for bulk rates" },
  { buyer: "Matlab 180/- ka piece h toh kitne ka piece padega?", om: "1 pc. 180+5% gst" },
  { buyer: "Printer ka contact send", om: "We only sell blanks. For print related, talk to Printer - https://wa.me/918810256726" },
  { buyer: "Sample chahiye 240 1 180 1 GMS", om: "How to order - https://youtube.com/shorts/F-zdRRSs370?feature=share\n\n======================================================================\nEND OF EXPORT — 337 permanent pairs" },
]

// ===========================================
// Catalog Tab Component
// ===========================================
export default App
