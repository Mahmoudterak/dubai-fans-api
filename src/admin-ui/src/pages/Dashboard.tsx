import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.ts'
import { StatCard, Card, Badge, Table, PageHeader, fmtDate, fmtAED } from '../components/ui.tsx'

interface Stats {
  totalCustomers: number
  newCustomers: number
  activeOrders: number
  pendingTopups: number
  totalWallet: string
  mobileOrdersTotal: number
  mobileOrdersNew: number
  mobileOrdersInProgress: number
  mobileOrdersCompleted: number
  mobileOrdersValue: string
}

interface RecentOrder {
  id: number
  referenceCode: string
  status: string
  totalAmount: string
  createdAt: string
  customerName?: string
  serviceName?: string
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [stats, setStats] = useState<Stats | null>(null)
  const [orders, setOrders] = useState<RecentOrder[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      api.get<Stats>('/stats'),
      api.get<{ orders: RecentOrder[] } | RecentOrder[]>('/orders?limit=8&page=1'),
    ]).then(([s, o]) => {
      setStats(s)
      setOrders(Array.isArray(o) ? o : (o as any).orders ?? [])
    }).catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="p-6">
      <PageHeader title="Dashboard" subtitle="Overview of your portal activity" />

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard icon="👥" label="Total Customers" value={stats?.totalCustomers ?? '—'} sub={`+${stats?.newCustomers ?? 0} this week`} color="blue" />
        <StatCard icon="📋" label="Active Orders" value={stats?.activeOrders ?? '—'} color="green" />
        <StatCard icon="💳" label="Pending Top-ups" value={stats?.pendingTopups ?? '—'} color="yellow" />
        <StatCard icon="💰" label="Total Wallet Balance" value={stats ? fmtAED(stats.totalWallet) : '—'} color="purple" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <StatCard icon="📱" label="Mobile Orders" value={stats?.mobileOrdersTotal ?? '—'} color="blue" />
        <StatCard icon="🆕" label="Mobile New" value={stats?.mobileOrdersNew ?? '—'} color="yellow" />
        <StatCard icon="⚙️" label="Mobile In Progress" value={stats?.mobileOrdersInProgress ?? '—'} color="purple" />
        <StatCard icon="✅" label="Mobile Completed" value={stats?.mobileOrdersCompleted ?? '—'} color="green" />
        <StatCard icon="💵" label="Mobile Order Value" value={stats ? fmtAED(stats.mobileOrdersValue) : '—'} color="blue" />
      </div>

      {/* Recent orders */}
      <Card>
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900">Recent Orders</h2>
          <button onClick={() => navigate('/orders')} className="text-sm text-primary hover:underline">View all</button>
        </div>
        <Table
          loading={loading}
          columns={[
            { key: 'referenceCode', header: 'Ref', render: r => <span className="font-mono text-xs text-slate-600">#{String(r.referenceCode)}</span> },
            { key: 'customerName', header: 'Customer' },
            { key: 'serviceName', header: 'Service' },
            { key: 'status', header: 'Status', render: r => <Badge status={String(r.status)} /> },
            { key: 'totalAmount', header: 'Amount', render: r => <span className="font-semibold text-primary">{fmtAED(String(r.totalAmount))}</span> },
            { key: 'createdAt', header: 'Date', render: r => fmtDate(String(r.createdAt)) },
          ]}
          data={orders as unknown as Record<string, unknown>[]}
          onRowClick={row => navigate(`/orders/${row.id}`)}
        />
      </Card>
    </div>
  )
}
