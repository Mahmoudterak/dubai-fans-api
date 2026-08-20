import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.ts'
import { Card, Badge, Table, Pagination, PageHeader, Input, fmtDate, fmtAED } from '../components/ui.tsx'

const STATUSES = ['', 'new', 'under_review', 'waiting_customer', 'ready_to_start', 'in_progress', 'waiting_approval', 'active', 'completed', 'cancelled']

interface Order {
  id: number
  referenceCode: string
  status: string
  source: 'website' | 'mobile_app'
  totalAmount: string
  createdAt: string
  customerName?: string
  customerEmail?: string
  customerMobile?: string
  serviceName?: string
  packageName?: string
  paymentStatus?: string
  paymentMethod?: string
}

interface Meta { page: number; pages: number; total: number }

export default function Orders() {
  const navigate = useNavigate()
  const [orders, setOrders] = useState<Order[]>([])
  const [meta, setMeta] = useState<Meta>({ page: 1, pages: 1, total: 0 })
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [source, setSource] = useState('')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' })
      if (status) params.set('status', status)
      if (source) params.set('source', source)
      if (search) params.set('search', search)
      const res = await api.get<{ orders: Order[]; meta: Meta } | Order[]>(`/orders?${params}`)
      const arr = Array.isArray(res) ? res : (res as any).orders ?? []
      const m = Array.isArray(res) ? meta : (res as any).meta ?? meta
      setOrders(arr)
      setMeta(m)
    } catch { }
    setLoading(false)
  }, [page, status, source, search])

  useEffect(() => { load() }, [load])

  const cols = [
    { key: 'referenceCode', header: 'Ref #', render: (r: any) => <span className="font-mono text-xs">#{r.referenceCode}</span> },
    { key: 'customerName', header: 'Customer', render: (r: any) => (
      <div>
        <p className="font-medium text-slate-800">{r.customerName ?? '—'}</p>
        <p className="text-xs text-slate-500">{r.customerEmail ?? r.customerMobile ?? '—'}</p>
      </div>
    ) },
    { key: 'source', header: 'Source', render: (r: any) => (
      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${r.source === 'mobile_app' ? 'bg-violet-50 text-violet-700' : 'bg-sky-50 text-sky-700'}`}>
        {r.source === 'mobile_app' ? 'Mobile App' : 'Website'}
      </span>
    ) },
    { key: 'serviceName', header: 'Service' },
    { key: 'packageName', header: 'Package' },
    { key: 'status', header: 'Status', render: (r: any) => <Badge status={r.status} /> },
    { key: 'paymentStatus', header: 'Payment', render: (r: any) => r.paymentStatus ? (
      <span className="text-xs text-slate-600">{r.paymentMethod ? `${r.paymentMethod} · ` : ''}{r.paymentStatus}</span>
    ) : <span className="text-xs text-slate-400">Wallet</span> },
    { key: 'totalAmount', header: 'Amount', render: (r: any) => <span className="font-semibold text-primary">{fmtAED(r.totalAmount)}</span> },
    { key: 'createdAt', header: 'Date', render: (r: any) => fmtDate(r.createdAt) },
  ]

  return (
    <div className="p-6">
      <PageHeader title="Orders" subtitle="Manage all customer orders" />
      <Card>
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-slate-100">
          <Input
            placeholder="Search by ref, customer, email or mobile…"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            className="w-56"
          />
          <select
            aria-label="Order source"
            value={source}
            onChange={e => { setSource(e.target.value); setPage(1) }}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-primary"
          >
            <option value="">All sources</option>
            <option value="website">Website</option>
            <option value="mobile_app">Mobile App</option>
          </select>
          <div className="flex flex-wrap gap-1.5">
            {STATUSES.map(s => (
              <button
                key={s}
                onClick={() => { setStatus(s); setPage(1) }}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  status === s ? 'bg-primary text-white border-primary' : 'border-slate-200 text-slate-600 hover:border-slate-300'
                }`}
              >
                {s === '' ? 'All' : s.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        </div>
        <Table
          columns={cols as any}
          data={orders as any}
          loading={loading}
          onRowClick={(row: any) => navigate(`/orders/${row.id}`)}
          emptyMsg="No orders found"
        />
        <Pagination page={meta.page} pages={meta.pages} total={meta.total} onPage={p => setPage(p)} />
      </Card>
    </div>
  )
}
