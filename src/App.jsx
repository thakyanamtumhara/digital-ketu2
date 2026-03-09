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
        {['live', 'analytics', 'defer', 'settings', 'sync'].map(t => (
          <button
            key={t}
            style={{ ...styles.tab, ...(tab === t ? styles.activeTab : {}) }}
            onClick={() => {
              setTab(t)
              if (t === 'defer') fetchDeferList()
              if (t === 'sync') fetchSyncLogs()
              if (t === 'analytics') fetchAnalytics()
            }}
          >
            {t === 'live' ? 'Live Monitor' : t === 'analytics' ? 'Analytics' : t === 'defer' ? 'Defer to Ketu' : t === 'settings' ? 'Settings' : 'Sync'}
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
        {tab === 'settings' && <SettingsPanel settings={settings} updateSetting={updateSetting} onDownload={downloadKnowledge} />}
        {tab === 'sync' && <SyncPanel logs={syncLogs} settings={settings} onSync={triggerSync} syncing={syncing} />}
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
              {log.costUsd != null && <span> / ${log.costUsd.toFixed(5)}</span>}
              {log.processingMs && <span> / {log.processingMs}ms</span>}
              <span style={styles.logTime}>{new Date(log.createdAt).toLocaleTimeString('en-IN')}</span>
            </div>
          </div>
          <div style={styles.logBody}>
            <div style={styles.logMessage}><strong>Buyer:</strong> {log.buyerMessage}</div>
            {log.aiReply && <div style={styles.logReply}><strong>AI Reply:</strong> {log.aiReply}</div>}
          </div>
          {expandedLog === log.id && (
            <div style={styles.logExpanded}>
              {log.knowledgeChunks && (
                <div><strong>Knowledge chunks used:</strong><pre style={styles.pre}>{JSON.stringify(log.knowledgeChunks, null, 2)}</pre></div>
              )}
              {log.catalogMatch && (
                <div><strong>Catalog match:</strong><pre style={styles.pre}>{JSON.stringify(log.catalogMatch, null, 2)}</pre></div>
              )}
              {log.similarityScore != null && (
                <div><strong>Best similarity:</strong> {(log.similarityScore * 100).toFixed(1)}%</div>
              )}
              {log.promptTokens && (
                <div><strong>Tokens:</strong> {log.promptTokens} input + {log.completionTokens} output = {log.totalTokens} total</div>
              )}
              {log.promptSent && (
                <div><strong>Full prompt:</strong><pre style={styles.pre}>{typeof log.promptSent === 'string' ? log.promptSent : JSON.stringify(log.promptSent, null, 2)}</pre></div>
              )}
            </div>
          )}
        </div>
      ))}
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
        <StatCard label="Total Cost" value={`$${analytics.tokens.totalCostUsd.toFixed(4)}`} />
        <StatCard label="Avg Tokens/Reply" value={analytics.tokens.avgTokensPerReply} />
        <StatCard label="Avg Cost/Reply" value={`$${(analytics.tokens.avgCostPerReply || 0).toFixed(5)}`} />
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

function SettingsPanel({ settings, updateSetting, onDownload }) {
  return (
    <div>
      <h2 style={styles.sectionTitle}>Settings</h2>

      <div style={styles.settingsGrid}>
        <SettingRow label="AI Active" type="toggle" value={settings.isActive} onChange={v => updateSetting('isActive', v)} />
        <SettingRow label="Daily Budget (INR)" type="number" value={settings.dailyBudgetInr} onChange={v => updateSetting('dailyBudgetInr', Number(v))} />
        <SettingRow label="Confidence Threshold" type="number" value={settings.confidenceThreshold} onChange={v => updateSetting('confidenceThreshold', Number(v))} step="0.05" />
        <SettingRow label="Defer Threshold" type="number" value={settings.deferThreshold} onChange={v => updateSetting('deferThreshold', Number(v))} step="0.05" />
        <SettingRow label="Message Merge Window (ms)" type="number" value={settings.mergeWindowMs} onChange={v => updateSetting('mergeWindowMs', Number(v))} />
        <SettingRow label="Cooldown Minutes" type="number" value={settings.cooldownMinutes} onChange={v => updateSetting('cooldownMinutes', Number(v))} />
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

function SettingTextarea({ label, value, onChange }) {
  return (
    <div style={styles.settingRow}>
      <label style={styles.settingLabel}>{label}</label>
      <textarea style={styles.textarea} value={value} onChange={e => onChange(e.target.value)} rows={3} />
    </div>
  )
}

function SyncPanel({ logs, settings, onSync, syncing }) {
  return (
    <div>
      <h2 style={styles.sectionTitle}>Knowledge Base Sync</h2>

      <div style={styles.syncInfo}>
        <p><strong>Last sync:</strong> {settings.lastSyncAt ? new Date(settings.lastSyncAt).toLocaleString('en-IN') : 'Never'}</p>
        <p><strong>Next sync:</strong> {settings.nextSyncAt ? new Date(settings.nextSyncAt).toLocaleString('en-IN') : 'Not scheduled'}</p>
        <button style={styles.btnPrimary} onClick={onSync} disabled={syncing}>
          {syncing ? 'Syncing...' : 'Sync Now'}
        </button>
      </div>

      <h3 style={{ ...styles.sectionTitle, fontSize: '16px', marginTop: '24px' }}>Sync History</h3>
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
  tabs: { display: 'flex', gap: '4px', marginTop: '16px', borderBottom: '1px solid #1e293b', paddingBottom: '0' },
  tab: { padding: '10px 16px', border: 'none', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: '14px', borderBottom: '2px solid transparent' },
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

  // Buttons
  btnPrimary: { padding: '8px 20px', border: 'none', borderRadius: '6px', background: '#3b82f6', color: '#fff', fontWeight: '600', cursor: 'pointer', fontSize: '14px' },
  btnSecondary: { padding: '6px 16px', border: '1px solid #334155', borderRadius: '6px', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: '13px', marginLeft: '8px' },
  btnDanger: { padding: '4px 12px', border: '1px solid #ef4444', borderRadius: '4px', background: 'transparent', color: '#ef4444', cursor: 'pointer', fontSize: '12px' },
}

export default App
