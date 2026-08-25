import { useEffect, useMemo, useState } from 'react'
import ReactFlow, {
  Background,
  BackgroundVariant,
  ReactFlowProvider,
  useViewport,
  useReactFlow,
  type Edge,
  type Node
} from 'reactflow'
import dagre from 'dagre'
import { ChevronDown, Minus, Plus, RotateCcw, Sparkles } from 'lucide-react'
import { useAgentsStore } from '../state/agentsStore'
import { AgentNode, type AgentNodeData } from './AgentNode'
import { AgentConfigModal } from './AgentConfigModal'
import type { AgentConfig } from '@shared/types'

const NODE_TYPES = { agentNode: AgentNode }
const NODE_W = 190
const NODE_H = 90
const ROOT_W = 120
const ROOT_H = 44

function buildGraph(
  agents: AgentConfig[],
  onOpen: (id: string) => void,
  onAddChild: (id: string) => void
): { nodes: Node<AgentNodeData>[]; edges: Edge[] } {
  const live = agents.filter((a) => !a.archived)
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 70 })

  g.setNode('__root__', { width: ROOT_W, height: ROOT_H })
  for (const a of live) {
    g.setNode(a.id, { width: NODE_W, height: NODE_H })
  }
  for (const a of live) {
    g.setEdge(a.parentId ?? '__root__', a.id)
  }

  dagre.layout(g)

  const childCount = (id: string): number => live.filter((a) => a.parentId === id).length

  const nodes: Node<AgentNodeData>[] = [
    {
      id: '__root__',
      type: 'agentNode',
      position: {
        x: g.node('__root__').x - ROOT_W / 2,
        y: g.node('__root__').y - ROOT_H / 2
      },
      data: {
        isRoot: true,
        agent: {} as AgentConfig,
        childCount: 0,
        onOpen: () => {},
        onAddChild: () => {}
      },
      draggable: false,
      selectable: false
    },
    ...live.map((a) => ({
      id: a.id,
      type: 'agentNode',
      position: { x: g.node(a.id).x - NODE_W / 2, y: g.node(a.id).y - NODE_H / 2 },
      data: { agent: a, childCount: childCount(a.id), onOpen, onAddChild }
    }))
  ]

  const edges: Edge[] = live.map((a) => ({
    id: `e_${a.parentId ?? 'root'}_${a.id}`,
    source: a.parentId ?? '__root__',
    target: a.id,
    type: 'smoothstep',
    style: { stroke: a.color, strokeWidth: 1.4, strokeDasharray: '4 4', opacity: 0.6 }
  }))

  return { nodes, edges }
}

function CanvasControls(): React.JSX.Element {
  const { zoom } = useViewport()
  const { zoomIn, zoomOut, fitView } = useReactFlow()
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 20,
        left: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 10px',
        borderRadius: 999,
        border: '1px solid var(--c-panel-border)',
        background: 'var(--c-panel)',
        backdropFilter: 'blur(10px)',
        zIndex: 10
      }}
    >
      <button onClick={() => zoomOut()} style={{ color: 'var(--c-text-2)' }}>
        <Minus size={14} />
      </button>
      <span className="tracked-label" style={{ fontSize: 10, minWidth: 38, textAlign: 'center' }}>
        {Math.round(zoom * 100)}%
      </span>
      <button onClick={() => zoomIn()} style={{ color: 'var(--c-text-2)' }}>
        <Plus size={14} />
      </button>
      <button onClick={() => fitView({ padding: 0.3 })} style={{ color: 'var(--c-text-3)' }} title="Fit view">
        <RotateCcw size={12} />
      </button>
    </div>
  )
}

function ArchivedDropdown(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const agents = useAgentsStore((s) => s.agents)
  const restore = useAgentsStore((s) => s.restore)
  const remove = useAgentsStore((s) => s.remove)
  const archived = agents.filter((a) => a.archived)

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="tracked-label"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 10,
          padding: '8px 14px',
          borderRadius: 999,
          border: '1px solid var(--c-panel-border-strong)',
          color: 'var(--c-text-2)'
        }}
      >
        Archived ({archived.length})
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '110%',
            right: 0,
            width: 240,
            maxHeight: 280,
            overflowY: 'auto',
            borderRadius: 10,
            border: '1px solid var(--c-panel-border-strong)',
            background: '#0c0a08',
            boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
            zIndex: 30
          }}
        >
          {archived.length === 0 && (
            <div style={{ padding: 14, fontSize: 12, color: 'var(--c-text-3)' }}>
              No archived agents.
            </div>
          )}
          {archived.map((a) => (
            <div
              key={a.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 14px',
                borderBottom: '1px solid var(--c-panel-border)'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: 3, background: a.color }} />
                <span style={{ fontSize: 12.5, color: 'var(--c-text-1)' }}>{a.name}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  onClick={() => restore(a.id)}
                  style={{ fontSize: 11, color: 'var(--c-gold-bright)' }}
                >
                  Restore
                </button>
                <button
                  onClick={() => {
                    if (window.confirm(`Permanently delete ${a.name}? This cannot be undone and removes it everywhere it's synced.`)) {
                      remove(a.id)
                    }
                  }}
                  style={{ fontSize: 11, color: 'var(--c-text-3)' }}
                >
                  Delete forever
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CanvasInner(): React.JSX.Element {
  const agents = useAgentsStore((s) => s.agents)
  const refresh = useAgentsStore((s) => s.refresh)
  const selectAgent = useAgentsStore((s) => s.selectAgent)
  const createFromPrompt = useAgentsStore((s) => s.createFromPrompt)
  const archive = useAgentsStore((s) => s.archive)

  const [query, setQuery] = useState('')
  const [pendingParentId, setPendingParentId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const { fitView } = useReactFlow()

  useEffect(() => {
    refresh()
  }, [refresh])

  const pendingParent = agents.find((a) => a.id === pendingParentId)

  const { nodes, edges } = useMemo(
    () => buildGraph(agents, selectAgent, setPendingParentId),
    [agents, selectAgent]
  )

  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.3, duration: 300 }), 50)
    return () => clearTimeout(t)
  }, [agents.length]) // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(): Promise<void> {
    const text = query.trim()
    if (!text || submitting) return
    setSubmitting(true)
    try {
      await createFromPrompt(text, pendingParentId)
      setQuery('')
      setPendingParentId(null)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{ position: 'relative', flex: 1 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
        maxZoom={2}
        onNodeContextMenu={(e, node) => {
          e.preventDefault()
          if (node.id === '__root__') return
          const agent = agents.find((a) => a.id === node.id)
          const label = agent?.name ?? 'this agent'
          if (window.confirm(`Archive ${label}? It'll disappear from the switcher, but you can restore it from the Archived list below.`)) {
            archive(node.id)
          }
        }}
        fitView
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="rgba(212,175,55,0.12)" />
      </ReactFlow>

      <div
        style={{
          position: 'absolute',
          top: 20,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: 480,
          maxWidth: '70%',
          zIndex: 10
        }}
      >
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 16px',
            borderRadius: 999,
            border: '1px solid var(--c-panel-border-strong)',
            background: 'var(--c-panel)',
            backdropFilter: 'blur(10px)'
          }}
        >
          <Sparkles size={14} color="var(--c-gold)" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder={
              pendingParent
                ? `Spawn a bot under ${pendingParent.name}...`
                : 'Have DALVE create a new agent or bot...'
            }
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--c-text-1)',
              fontSize: 13
            }}
          />
          {pendingParent && (
            <button
              onClick={() => setPendingParentId(null)}
              style={{ fontSize: 11, color: 'var(--c-text-3)' }}
            >
              cancel
            </button>
          )}
        </div>
      </div>

      <div style={{ position: 'absolute', top: 20, right: 20, zIndex: 10 }}>
        <ArchivedDropdown />
      </div>

      <CanvasControls />
      <AgentConfigModal />
    </div>
  )
}

export function AgentsCanvas(): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  )
}
