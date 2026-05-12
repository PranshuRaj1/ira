import { useEffect, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis,
  Tooltip, Legend, ResponsiveContainer, CartesianGrid
} from 'recharts'

const WORKER_URL = 'https://worker.ira-worker.workers.dev'

type MetricPoint = {
  time: string
  peekP50: number
  meshP50: number
  silkP50: number
  peekP90: number
  meshP90: number
  silkP90: number
}

type Memory = {
  user_id: string
  content: string
  importance: number
  access_count: number
  last_accessed: string
  decayed_importance: number
}

export default function App() {
  const [history, setHistory] = useState<MetricPoint[]>([])
  const [total, setTotal] = useState(0)
  const [memories, setMemories] = useState<Memory[]>([])
  const [activeTab, setActiveTab] = useState<'latency' | 'memories'>('latency')

  // Poll metrics every 5 seconds
  useEffect(() => {
    const pollMetrics = async () => {
      try {
        const res = await fetch(`${WORKER_URL}/metrics`)
        const data = await res.json() as any
        setTotal(data.totalRequests)
        setHistory(prev => [...prev.slice(-30), {
          time: new Date().toLocaleTimeString(),
          peekP50: data.peek.p50,
          meshP50: data.mesh.p50,
          silkP50: data.silk.p50,
          peekP90: data.peek.p90,
          meshP90: data.mesh.p90,
          silkP90: data.silk.p90,
        }])
      } catch (e) {
        console.error('Metrics fetch failed', e)
      }
    }

    pollMetrics()
    const id = setInterval(pollMetrics, 5000)
    return () => clearInterval(id)
  }, [])

  // Poll memories every 10 seconds
  useEffect(() => {
    const pollMemories = async () => {
      try {
        const res = await fetch(`${WORKER_URL}/memories`)
        const data = await res.json() as any
        setMemories(data.memories)
      } catch (e) {
        console.error('Memories fetch failed', e)
      }
    }

    pollMemories()
    const id = setInterval(pollMemories, 10000)
    return () => clearInterval(id)
  }, [])

  return (
    <div style={{
      padding: 32,
      fontFamily: 'monospace',
      background: '#0a0a0a',
      minHeight: '100vh',
      color: '#fff'
    }}>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ margin: 0, color: '#60a5fa', fontSize: 28 }}>IRA Dashboard</h1>
        <p style={{ margin: '8px 0 0', color: '#888' }}>
          Total requests tracked: <span style={{ color: '#fff' }}>{total}</span>
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
        {(['latency', 'memories'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: '8px 20px',
              background: activeTab === tab ? '#60a5fa' : '#1a1a1a',
              color: activeTab === tab ? '#000' : '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontFamily: 'monospace',
              fontSize: 14
            }}
          >
            {tab === 'latency' ? 'Latency' : 'Memories'}
          </button>
        ))}
      </div>

      {activeTab === 'latency' && (
        <div>
          {/* p50 Chart */}
          <div style={{ background: '#111', borderRadius: 12, padding: 24, marginBottom: 24 }}>
            <h2 style={{ margin: '0 0 16px', color: '#aaa', fontSize: 16 }}>
              p50 Latency by Layer (ms)
            </h2>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={history}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis dataKey="time" stroke="#555" tick={{ fontSize: 11 }} />
                <YAxis stroke="#555" tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: '#1a1a1a', border: '1px solid #333' }}
                />
                <Legend />
                <Line type="monotone" dataKey="peekP50" stroke="#60a5fa" name="Peek" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="meshP50" stroke="#34d399" name="Mesh" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="silkP50" stroke="#f472b6" name="Silk" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* p90 Chart */}
          <div style={{ background: '#111', borderRadius: 12, padding: 24, marginBottom: 24 }}>
            <h2 style={{ margin: '0 0 16px', color: '#aaa', fontSize: 16 }}>
              p90 Latency by Layer (ms)
            </h2>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={history}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis dataKey="time" stroke="#555" tick={{ fontSize: 11 }} />
                <YAxis stroke="#555" tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: '#1a1a1a', border: '1px solid #333' }}
                />
                <Legend />
                <Line type="monotone" dataKey="peekP90" stroke="#60a5fa" name="Peek p90" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="meshP90" stroke="#34d399" name="Mesh p90" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="silkP90" stroke="#f472b6" name="Silk p90" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Stats summary */}
          <div style={{ display: 'flex', gap: 16 }}>
            {[
              { label: 'Peek p50', value: history.at(-1)?.peekP50 ?? 0, color: '#60a5fa' },
              { label: 'Mesh p50', value: history.at(-1)?.meshP50 ?? 0, color: '#34d399' },
              { label: 'Silk p50', value: history.at(-1)?.silkP50 ?? 0, color: '#f472b6' },
            ].map(stat => (
              <div key={stat.label} style={{
                flex: 1, background: '#111', borderRadius: 12,
                padding: 20, textAlign: 'center'
              }}>
                <div style={{ color: stat.color, fontSize: 32, fontWeight: 'bold' }}>
                  {stat.value}ms
                </div>
                <div style={{ color: '#888', fontSize: 13, marginTop: 4 }}>
                  {stat.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'memories' && (
        <div style={{ background: '#111', borderRadius: 12, padding: 24 }}>
          <h2 style={{ margin: '0 0 16px', color: '#aaa', fontSize: 16 }}>
            Stored Memories ({memories.length})
          </h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: '#888', textAlign: 'left' }}>
                <th style={{ padding: '8px 12px', borderBottom: '1px solid #222' }}>Content</th>
                <th style={{ padding: '8px 12px', borderBottom: '1px solid #222' }}>User</th>
                <th style={{ padding: '8px 12px', borderBottom: '1px solid #222' }}>Importance</th>
                <th style={{ padding: '8px 12px', borderBottom: '1px solid #222' }}>Decayed</th>
                <th style={{ padding: '8px 12px', borderBottom: '1px solid #222' }}>Accesses</th>
                <th style={{ padding: '8px 12px', borderBottom: '1px solid #222' }}>Last Accessed</th>
              </tr>
            </thead>
            <tbody>
              {memories.map((m, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #1a1a1a' }}>
                  <td style={{ padding: '10px 12px', color: '#fff', maxWidth: 300 }}>{m.content}</td>
                  <td style={{ padding: '10px 12px', color: '#888' }}>{m.user_id}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{
                      background: `rgba(96,165,250,${m.importance})`,
                      padding: '2px 8px', borderRadius: 4,
                      color: '#fff', display: 'inline-block'
                    }}>
                      {m.importance.toFixed(2)}
                    </div>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{
                      background: `rgba(52,211,153,${Number(m.decayed_importance)})`,
                      padding: '2px 8px', borderRadius: 4,
                      color: '#fff', display: 'inline-block'
                    }}>
                      {Number(m.decayed_importance).toFixed(3)}
                    </div>
                  </td>
                  <td style={{ padding: '10px 12px', color: '#888' }}>{m.access_count}</td>
                  <td style={{ padding: '10px 12px', color: '#888' }}>
                    {new Date(m.last_accessed).toLocaleString()}
                  </td>
                </tr>
              ))}
              {memories.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: 32, textAlign: 'center', color: '#555' }}>
                    No memories yet. Send your bot a message first.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
