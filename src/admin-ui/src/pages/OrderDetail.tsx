import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '../api.ts'
import { Card, Badge, Btn, Select, Textarea, Modal, useToast, fmtDate, fmtAED, PageHeader } from '../components/ui.tsx'

const ORDER_STATUSES = [
  'new','under_review','waiting_customer','ready_to_start',
  'in_progress','waiting_approval','active','completed','cancelled',
].map(s => ({ value: s, label: s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) }))

interface Order {
  id: number; referenceCode: string; status: string; totalAmount: string; vatAmount?: string
  notes?: string; internalNotes?: string; source?: 'website' | 'mobile_app'; createdAt: string; updatedAt: string
  customerName?: string; customerEmail?: string; customerMobile?: string
  serviceName?: string; packageName?: string
  timeline?: { id: number; status: string; notes?: string; createdAt: string; adminName?: string }[]
  files?: { id: number; fileName: string; fileSize: number; mimeType: string; createdAt: string; url?: string }[]
  payments?: { id: number; provider: string; status: string; amount: string; currency: string; createdAt: string }[]
  campaign?: Record<string, unknown>
}

export default function OrderDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { show, ToastEl } = useToast()
  const [order, setOrder] = useState<Order | null>(null)
  const [loading, setLoading] = useState(true)
  const [newStatus, setNewStatus] = useState('')
  const [statusNote, setStatusNote] = useState('')
  const [changingStatus, setChangingStatus] = useState(false)
  const [note, setNote] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [notifModal, setNotifModal] = useState(false)
  const [notifMsg, setNotifMsg] = useState('')
  const [sendingNotif, setSendingNotif] = useState(false)

  useEffect(() => {
    api.get<Order>(`/orders/${id}`)
      .then(data => { setOrder(data); setNewStatus(data.status); setNote(data.internalNotes ?? '') })
      .catch(() => navigate('/orders'))
      .finally(() => setLoading(false))
  }, [id, navigate])

  async function changeStatus() {
    if (!newStatus || !order) return
    setChangingStatus(true)
    try {
      await api.patch(`/orders/${id}/status`, { status: newStatus, note: statusNote })
      const updated = await api.get<Order>(`/orders/${id}`)
      setOrder(updated)
      setStatusNote('')
      show('Status updated successfully')
    } catch (err: any) { show(err.message ?? 'Failed', 'error') }
    setChangingStatus(false)
  }

  async function saveNote() {
    setSavingNote(true)
    try {
      await api.patch(`/orders/${id}/note`, { internalNotes: note })
      setOrder(current => current ? { ...current, internalNotes: note } : current)
      show('Note saved')
    } catch (err: any) { show(err.message ?? 'Failed', 'error') }
    setSavingNote(false)
  }

  async function sendNotif() {
    if (!order || !notifMsg.trim()) return
    setSendingNotif(true)
    try {
      const customerId = (order as any).customerId ?? (order as any).userId
      await api.post('/notifications/send', {
        recipient: 'user',
        userId: customerId,
        title: `Update on order #${order.referenceCode}`,
        body: notifMsg,
        type: 'order',
        data: { orderId: order.id },
      })
      show('Notification sent')
      setNotifModal(false)
      setNotifMsg('')
    } catch (err: any) { show(err.message ?? 'Failed', 'error') }
    setSendingNotif(false)
  }

  if (loading) return <div className="flex items-center justify-center h-64"><div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" /></div>
  if (!order) return null

  return (
    <div className="p-6 max-w-5xl">
      {ToastEl}
      <PageHeader
        title={`Order #${order.referenceCode}`}
        subtitle={fmtDate(order.createdAt)}
        action={
          <div className="flex gap-2">
            <Btn variant="secondary" size="sm" onClick={() => navigate('/orders')}>← Back</Btn>
            <Btn variant="secondary" size="sm" onClick={() => setNotifModal(true)}>🔔 Notify</Btn>
          </div>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Main info */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          {/* Status card */}
          <Card className="p-5">
            <div className="flex items-start justify-between mb-4">
              <div>
                <p className="text-sm text-slate-500 mb-1">Current Status</p>
                <Badge status={order.status} />
              </div>
              <div className="text-right">
                <p className="text-sm text-slate-500">Total Amount</p>
                <p className="text-xl font-bold text-primary">{fmtAED(order.totalAmount)}</p>
              </div>
            </div>
            <div className="flex gap-2 pt-3 border-t border-slate-100">
              <Select
                options={ORDER_STATUSES}
                value={newStatus}
                onChange={e => setNewStatus(e.target.value)}
                className="flex-1 text-sm"
              />
              <Btn size="sm" onClick={changeStatus} loading={changingStatus}>Update</Btn>
            </div>
            <Textarea
              placeholder="Status change note (visible in timeline)…"
              value={statusNote}
              onChange={e => setStatusNote(e.target.value)}
              rows={2}
              className="mt-2 text-sm"
            />
          </Card>

          {/* Campaign data */}
          {order.campaign && (
            <Card className="p-5">
              <h3 className="font-semibold text-slate-900 mb-4">Campaign Details</h3>
              <div className="grid grid-cols-2 gap-3">
                {Object.entries(order.campaign).filter(([k]) => !k.endsWith('At') && !['id','orderId'].includes(k)).map(([k, v]) => (
                  <div key={k}>
                    <p className="text-xs text-slate-500 capitalize">{k.replace(/([A-Z])/g, ' $1').trim()}</p>
                    <p className="text-sm text-slate-800 font-medium">{Array.isArray(v) ? v.join(', ') : String(v ?? '—')}</p>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Admin notes */}
          <Card className="p-5">
            <h3 className="font-semibold text-slate-900 mb-3">Internal Notes</h3>
            <Textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={4}
              placeholder="Internal notes (not visible to customer)…"
            />
            <div className="mt-3 flex justify-end">
              <Btn size="sm" onClick={saveNote} loading={savingNote}>Save Note</Btn>
            </div>
          </Card>

          {/* Files */}
          {(order.files ?? []).length > 0 && (
            <Card className="p-5">
              <h3 className="font-semibold text-slate-900 mb-4">Files</h3>
              <div className="flex flex-col gap-2">
                {order.files!.map(f => (
                  <div key={f.id} className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg">
                    <span className="text-xl">{f.mimeType?.startsWith('image') ? '🖼️' : '📄'}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">{f.fileName}</p>
                      <p className="text-xs text-slate-400">{(f.fileSize / 1024).toFixed(0)} KB · {fmtDate(f.createdAt)}</p>
                    </div>
                    {f.url && (
                      <a href={f.url} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">Download</a>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="flex flex-col gap-4">
          {/* Customer */}
          <Card className="p-5">
            <h3 className="font-semibold text-slate-900 mb-3">Customer</h3>
            <p className="font-medium text-slate-800">{order.customerName ?? '—'}</p>
            <p className="text-sm text-slate-500">{order.customerEmail}</p>
            {order.customerMobile && <p className="text-sm text-slate-500">{order.customerMobile}</p>}
          </Card>

          {/* Service */}
          <Card className="p-5">
            <h3 className="font-semibold text-slate-900 mb-3">Service</h3>
            <p className="text-sm font-medium text-slate-800">{order.serviceName ?? '—'}</p>
            <p className="text-xs text-slate-500 mt-1">{order.packageName}</p>
          </Card>

           <Card className="p-5">
             <h3 className="font-semibold text-slate-900 mb-2">Order Source</h3>
             <span className={`inline-flex rounded-full px-2.5 py-1 text-sm font-medium ${order.source === 'mobile_app' ? 'bg-violet-50 text-violet-700' : 'bg-sky-50 text-sky-700'}`}>
               {order.source === 'mobile_app' ? 'Mobile App' : 'Website'}
             </span>
           </Card>

           <Card className="p-5">
             <h3 className="font-semibold text-slate-900 mb-3">Payment</h3>
             {(order.payments ?? []).length > 0 ? (
               <div className="flex flex-col gap-3">
                 {order.payments!.map(payment => (
                   <div key={payment.id} className="flex items-start justify-between gap-3 text-sm">
                     <div>
                       <p className="font-medium text-slate-800">{payment.provider.replace(/_/g, ' ')}</p>
                       <p className="text-xs text-slate-500">{fmtDate(payment.createdAt)}</p>
                     </div>
                     <div className="text-right">
                       <p className="font-medium text-primary">{fmtAED(payment.amount)}</p>
                       <p className="text-xs capitalize text-slate-500">{payment.status}</p>
                     </div>
                   </div>
                 ))}
               </div>
             ) : <p className="text-sm text-slate-500">Paid from wallet</p>}
           </Card>

          {/* Timeline */}
          <Card className="p-5">
            <h3 className="font-semibold text-slate-900 mb-4">Timeline</h3>
            <div className="flex flex-col gap-3">
              {(order.timeline ?? []).map(entry => (
                <div key={entry.id} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <div className="w-2.5 h-2.5 rounded-full bg-primary mt-1" />
                    <div className="w-px flex-1 bg-slate-200 mt-1" />
                  </div>
                  <div className="flex-1 pb-3">
                    <Badge status={entry.status} />
                    {entry.notes && <p className="text-xs text-slate-600 mt-1">{entry.notes}</p>}
                    <p className="text-xs text-slate-400 mt-1">{fmtDate(entry.createdAt)} {entry.adminName && `· ${entry.adminName}`}</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {/* Notify modal */}
      <Modal open={notifModal} title="Send Notification to Customer" onClose={() => setNotifModal(false)}>
        <Textarea
          label="Message"
          value={notifMsg}
          onChange={e => setNotifMsg(e.target.value)}
          rows={4}
          placeholder="Type your notification message…"
        />
        <div className="mt-4 flex justify-end gap-2">
          <Btn variant="secondary" onClick={() => setNotifModal(false)}>Cancel</Btn>
          <Btn onClick={sendNotif} loading={sendingNotif}>Send</Btn>
        </div>
      </Modal>
    </div>
  )
}
