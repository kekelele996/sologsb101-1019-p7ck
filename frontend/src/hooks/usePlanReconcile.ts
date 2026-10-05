/**
 * usePlanReconcile()：方案与实做的逐项对账（响应式）
 * 被方案页（/plans）、装订归档页（/export）消费。
 * 汇总：方案 / 偏离（planStore）＋书叶（leafStore）＋工序（repairStore）
 *      ＋补纸 / 装订（useIdbTable liveQuery 订阅）。
 */
import { computed, type ComputedRef } from 'vue'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import { useRepairStore } from '@/stores/repairStore'
import { usePlanStore } from '@/stores/planStore'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  archiveGate,
  reconcilePlan,
  summarizeActual,
  type ArchiveGate,
  type ActualSummary,
  type VolumeReconcile
} from '@/utils/planReconcile'
import type { Binding } from '@/types/binding'
import type { Paper } from '@/types/paper'

export interface PlanReconcileResult {
  reconcileMap: ComputedRef<Record<string, VolumeReconcile>>
  reconcileOf: (volumeId: string) => VolumeReconcile
  actualOf: (volumeId: string) => ActualSummary
  gateOf: (volumeId: string) => ArchiveGate
  /** 全局对账概览 */
  overview: ComputedRef<{
    total: number
    confirmed: number
    blocked: number
    heldItemCount: number
    coveredItemCount: number
    legacyReadonly: number
  }>
}

const EMPTY_RECONCILE = (volumeId: string): VolumeReconcile => ({
  volumeId,
  plan: null,
  items: [],
  matchCount: 0,
  coveredCount: 0,
  heldCount: 0,
  inProgress: true
})

export function usePlanReconcile(): PlanReconcileResult {
  const bookStore = useBookStore()
  const leafStore = useLeafStore()
  const repairStore = useRepairStore()
  const planStore = usePlanStore()
  const paperTable = useIdbTable<Paper>((database) => database.papers, { sortByUpdatedAt: false })
  const bindingTable = useIdbTable<Binding>((database) => database.bindings, { sortByUpdatedAt: false })

  const bindingByVolume = computed<Record<string, Binding>>(() => {
    const map: Record<string, Binding> = {}
    bindingTable.rows.value.forEach((binding) => {
      map[binding.volumeId] = binding
    })
    return map
  })

  const actualOf = (volumeId: string): ActualSummary => {
    const leaves = leafStore.leaves.filter((leaf) => leaf.volumeId === volumeId)
    const leafIds = new Set(leaves.map((leaf) => leaf.id))
    return summarizeActual({
      leaves,
      papers: paperTable.rows.value.filter((paper) => leafIds.has(paper.leafId)),
      orders: repairStore.orders.filter((order) => leafIds.has(order.leafId)),
      binding: bindingByVolume.value[volumeId]
    })
  }

  const reconcileMap = computed<Record<string, VolumeReconcile>>(() => {
    const result: Record<string, VolumeReconcile> = {}
    bookStore.volumes.forEach((volume) => {
      const leaves = leafStore.leaves.filter((leaf) => leaf.volumeId === volume.id)
      const leafIds = new Set(leaves.map((leaf) => leaf.id))
      result[volume.id] = reconcilePlan(volume.id, planStore.plans, planStore.deviations, {
        leaves,
        papers: paperTable.rows.value.filter((paper) => leafIds.has(paper.leafId)),
        orders: repairStore.orders.filter((order) => leafIds.has(order.leafId)),
        binding: bindingByVolume.value[volume.id]
      })
    })
    return result
  })

  const reconcileOf = (volumeId: string): VolumeReconcile => reconcileMap.value[volumeId] ?? EMPTY_RECONCILE(volumeId)

  const gateOf = (volumeId: string): ArchiveGate => {
    const volume = bookStore.volumeById(volumeId)
    if (!volume) return { allowed: false, reasons: ['no-plan'] }
    return archiveGate(volume, reconcileOf(volumeId))
  }

  const overview = computed(() => {
    let confirmed = 0
    let blocked = 0
    let heldItemCount = 0
    let coveredItemCount = 0
    let legacyReadonly = 0
    bookStore.volumes.forEach((volume) => {
      if (volume.legacyReadOnly === true) legacyReadonly += 1
      const reconcile = reconcileMap.value[volume.id] ?? EMPTY_RECONCILE(volume.id)
      if (reconcile.plan) confirmed += 1
      heldItemCount += reconcile.heldCount
      coveredItemCount += reconcile.coveredCount
      const gate = archiveGate(volume, reconcile)
      if (volume.state !== 'archived' && !gate.allowed) blocked += 1
    })
    return { total: bookStore.volumes.length, confirmed, blocked, heldItemCount, coveredItemCount, legacyReadonly }
  })

  return { reconcileMap, reconcileOf, actualOf, gateOf, overview }
}
