/**
 * 修复方案对账纯逻辑（无副作用，便于升级迁移与页面共用）
 *
 * 对账口径：归档前把方案与该册实做记录一项项对账——
 * 目标 pH / 补纸纸种 / 工序 / 完工工期 四项；
 * 对得上＝match，对不上但已登记偏离＝covered，对不上又没登记＝held（先挂起，不许归档）。
 *
 * 另含 v2→v3 升级用的历史方案回填：按现有配纸与工序回填；补纸或工序缺失则补不出。
 */
import type { Binding } from '@/types/binding'
import type { Leaf } from '@/types/leaf'
import type { Paper, PaperType } from '@/types/paper'
import type { RepairName, RepairOrder } from '@/types/repairOrder'
import type { Deviation, DeviationKind } from '@/types/deviation'
import { DEVIATION_KIND_LABEL } from '@/types/deviation'
import {
  type RepairPlan,
  type RepairPlanDraft,
  type VolumePlanStatus
} from '@/types/repairPlan'
import { PAPER_TYPE_LABEL } from '@/types/paper'
import { REPAIR_NAME_LABEL } from '@/types/repairOrder'

/** 目标 pH 对账容差：实做平均 pH 落在目标 ±0.2 内视为达标 */
export const PH_TOLERANCE = 0.2

/** 对账结论：对得上 / 偏离已登记 / 挂起 */
export type CheckStatus = 'match' | 'covered' | 'held'

export interface ReconcileItem {
  kind: DeviationKind
  label: string
  /** 方案要求 */
  plannedText: string
  /** 实做记录 */
  actualText: string
  status: CheckStatus
  /** 覆盖该出入的偏离登记 id */
  deviationIds: string[]
}

export interface VolumeReconcile {
  volumeId: string
  /** 生效方案（最新定稿方案）；没有则为 null */
  plan: RepairPlan | null
  items: ReconcileItem[]
  matchCount: number
  coveredCount: number
  heldCount: number
  /** 工序尚未全部完成：此时对账先挂着，也不允许归档 */
  inProgress: boolean
}

/** 一册实做记录的汇总 */
export interface ActualSummary {
  leaves: Leaf[]
  papers: Paper[]
  orders: RepairOrder[]
  binding: Binding | undefined
  /** 实做平均 pH（按叶） */
  averagePh: number
  /** 实做用到的纸种集合 */
  paperTypes: PaperType[]
  /** 已完成工序（去重） */
  doneSteps: RepairName[]
  /** 全部已排工序（去重，按首次出现序） */
  allSteps: RepairName[]
  /** 实做完工日期：优先装订完工日，否则取已完成工序的最晚日期 */
  finishDate: string | null
  /** 是否还有工序没做完（或压根没排工序） */
  inProgress: boolean
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 汇总一册的实做记录 */
export function summarizeActual(input: {
  leaves: Leaf[]
  papers: Paper[]
  orders: RepairOrder[]
  binding?: Binding
}): ActualSummary {
  const leaves = [...input.leaves].sort((a, b) => a.leafNo - b.leafNo)
  const leafIds = new Set(leaves.map((leaf) => leaf.id))
  const papers = input.papers.filter((paper) => leafIds.has(paper.leafId))
  const orders = input.orders
    .filter((order) => leafIds.has(order.leafId))
    .sort((a, b) => (a.seq === b.seq ? a.date.localeCompare(b.date) : a.seq - b.seq))

  const averagePh = leaves.length === 0 ? 0 : round1(leaves.reduce((sum, leaf) => sum + leaf.phValue, 0) / leaves.length)
  const paperTypes = Array.from(new Set(papers.map((paper) => paper.paperType)))
  const allSteps = Array.from(new Set(orders.map((order) => order.name)))
  const doneSteps = Array.from(new Set(orders.filter((order) => order.state === 'done').map((order) => order.name)))
  const doneDates = orders.filter((order) => order.state === 'done').map((order) => order.date).filter(Boolean)
  const finishDate = input.binding?.finishDate || (doneDates.length > 0 ? [...doneDates].sort().at(-1) ?? null : null)
  const inProgress = orders.length === 0 || orders.some((order) => order.state !== 'done')

  return { leaves, papers, orders, binding: input.binding, averagePh, paperTypes, doneSteps, allSteps, finishDate, inProgress }
}

function statusOf(match: boolean, deviations: Deviation[]): CheckStatus {
  if (match) return 'match'
  return deviations.length > 0 ? 'covered' : 'held'
}

/** 方案与实做逐项对账 */
export function reconcilePlan(
  volumeId: string,
  plans: RepairPlan[],
  deviations: Deviation[],
  actualInput: { leaves: Leaf[]; papers: Paper[]; orders: RepairOrder[]; binding?: Binding }
): VolumeReconcile {
  const plan = effectivePlan(plans, volumeId)
  const actual = summarizeActual(actualInput)
  if (!plan) {
    return { volumeId, plan: null, items: [], matchCount: 0, coveredCount: 0, heldCount: 0, inProgress: actual.inProgress }
  }
  const ofKind = (kind: DeviationKind): Deviation[] =>
    deviations.filter((item) => item.planId === plan.id && item.kind === kind)

  // ① 目标 pH：实做平均 pH 与目标相差不超过容差
  const phDeviations = ofKind('ph')
  const phMatch = actual.averagePh > 0 && Math.abs(actual.averagePh - plan.targetPh) <= PH_TOLERANCE
  const phItem: ReconcileItem = {
    kind: 'ph',
    label: DEVIATION_KIND_LABEL.ph,
    plannedText: `目标 pH ${plan.targetPh.toFixed(1)}`,
    actualText: actual.averagePh > 0 ? `实做平均 pH ${actual.averagePh.toFixed(1)}` : '实做尚无 pH 记录',
    status: statusOf(phMatch, phDeviations),
    deviationIds: phDeviations.map((item) => item.id)
  }

  // ② 补纸纸种：方案纸种在实做选配纸种集合内
  const paperDeviations = ofKind('paper')
  const paperMatch = actual.paperTypes.includes(plan.paperType)
  const paperItem: ReconcileItem = {
    kind: 'paper',
    label: DEVIATION_KIND_LABEL.paper,
    plannedText: PAPER_TYPE_LABEL[plan.paperType],
    actualText: actual.paperTypes.length > 0 ? actual.paperTypes.map((type) => PAPER_TYPE_LABEL[type]).join(' / ') : '实做尚未选配补纸',
    status: statusOf(paperMatch, paperDeviations),
    deviationIds: paperDeviations.map((item) => item.id)
  }

  // ③ 工序：方案列出的工序与实做已完成工序集合必须一致（少做 / 多做都算出入）
  const stepDeviations = ofKind('step')
  const plannedSet = new Set(plan.steps)
  const doneSet = new Set(actual.doneSteps)
  const missing = plan.steps.filter((name) => !doneSet.has(name))
  const extra = actual.doneSteps.filter((name) => !plannedSet.has(name))
  const stepMatch = missing.length === 0 && extra.length === 0
  const stepActualText =
    actual.doneSteps.length > 0
      ? `已完成：${actual.doneSteps.map((name) => REPAIR_NAME_LABEL[name]).join('、')}`
      : '实做尚无已完成工序'
  const stepDetail = [
    missing.length > 0 ? `少做：${missing.map((name) => REPAIR_NAME_LABEL[name]).join('、')}` : '',
    extra.length > 0 ? `多做：${extra.map((name) => REPAIR_NAME_LABEL[name]).join('、')}` : ''
  ]
    .filter(Boolean)
    .join('；')
  const stepItem: ReconcileItem = {
    kind: 'step',
    label: DEVIATION_KIND_LABEL.step,
    plannedText: plan.steps.map((name) => REPAIR_NAME_LABEL[name]).join('、'),
    actualText: stepDetail ? `${stepActualText}（${stepDetail}）` : stepActualText,
    status: statusOf(stepMatch, stepDeviations),
    deviationIds: stepDeviations.map((item) => item.id)
  }

  // ④ 完工工期：方案预计完工日与实做完工日比对；尚未完工先挂起
  const scheduleDeviations = ofKind('schedule')
  const scheduleMatch = actual.finishDate !== null && actual.finishDate === plan.plannedFinishDate
  const scheduleItem: ReconcileItem = {
    kind: 'schedule',
    label: DEVIATION_KIND_LABEL.schedule,
    plannedText: `预计 ${plan.plannedFinishDate}`,
    actualText: actual.finishDate ? `实际 ${actual.finishDate}` : '实做尚未完工',
    status: statusOf(scheduleMatch, scheduleDeviations),
    deviationIds: scheduleDeviations.map((item) => item.id)
  }

  const items = [phItem, paperItem, stepItem, scheduleItem]
  return {
    volumeId,
    plan,
    items,
    matchCount: items.filter((item) => item.status === 'match').length,
    coveredCount: items.filter((item) => item.status === 'covered').length,
    heldCount: items.filter((item) => item.status === 'held').length,
    inProgress: actual.inProgress
  }
}

/* ------------------------------ 方案生效规则 ------------------------------ */

/** 生效方案：该册最新一版定稿方案（历史方案也算生效，用于旧档对账） */
export function effectivePlan(plans: RepairPlan[], volumeId: string): RepairPlan | null {
  const confirmed = plans
    .filter((plan) => plan.volumeId === volumeId && plan.state === 'confirmed')
    .sort((a, b) => b.revision - a.revision)
  return confirmed[0] ?? null
}

/** 册次的方案立账状态（PlanTag 与筛选共用） */
export function planStatusForVolume(
  volume: { id: string; legacyReadOnly?: boolean },
  plans: RepairPlan[]
): VolumePlanStatus {
  if (volume.legacyReadOnly === true) return 'legacy'
  const own = plans.filter((plan) => plan.volumeId === volume.id)
  if (own.length === 0) return 'none'
  if (effectivePlan(plans, volume.id)) return 'confirmed'
  if (own.some((plan) => plan.state === 'draft')) return 'draft'
  return 'voided'
}

/* ------------------------------ 归档闸门 ------------------------------ */

export type ArchiveBlockReason = 'legacy-readonly' | 'no-plan' | 'plan-draft' | 'plan-voided' | 'in-progress' | 'held'

export const ARCHIVE_BLOCK_LABEL: Record<ArchiveBlockReason, string> = {
  'legacy-readonly': '旧档只读：升级时未能回填历史方案，只可只读留存',
  'no-plan': '尚未立修复方案，不许归档',
  'plan-draft': '方案还是草稿，主管定稿后才算数',
  'plan-voided': '方案已作废，请主管作废重立后再对账',
  'in-progress': '工序尚未全部完成，先挂起来',
  held: '对账有挂起项：请修复师补登记偏离说明，或按方案返工'
}

export interface ArchiveGate {
  allowed: boolean
  reasons: ArchiveBlockReason[]
}

/** 归档闸门：已经归档的旧档放行；否则逐项校验 */
export function archiveGate(
  volume: { state: string; legacyReadOnly?: boolean },
  reconcile: VolumeReconcile
): ArchiveGate {
  if (volume.state === 'archived') return { allowed: true, reasons: [] }
  const reasons: ArchiveBlockReason[] = []
  if (volume.legacyReadOnly === true) reasons.push('legacy-readonly')
  if (!reconcile.plan) {
    reasons.push('no-plan')
  } else if (reconcile.plan.state === 'draft') {
    reasons.push('plan-draft')
  } else if (reconcile.plan.state === 'voided') {
    reasons.push('plan-voided')
  } else {
    if (reconcile.inProgress) reasons.push('in-progress')
    if (reconcile.heldCount > 0) reasons.push('held')
  }
  return { allowed: reasons.length === 0, reasons }
}

/* --------------------------- v2→v3 历史方案回填 --------------------------- */

export interface HistoricalPlanInput {
  volumeId: string
  leaves: Leaf[]
  papers: Paper[]
  orders: RepairOrder[]
  binding?: Binding
  /** 回填主管署名（缺省取验收人 / 系统回填） */
  supervisor?: string
}

/**
 * 按现有配纸与工序回填一份历史方案。
 * 规则：至少登记过 1 条补纸与 1 道工序才补得出；补不上返回 null，调用方把册次标为只读。
 */
export function buildHistoricalPlan(input: HistoricalPlanInput): RepairPlanDraft | null {
  const actual = summarizeActual(input)
  if (actual.papers.length === 0 || actual.orders.length === 0) return null

  // 纸种取众数（并列时取先出现的）
  const paperCount = new Map<PaperType, number>()
  actual.papers.forEach((paper) => paperCount.set(paper.paperType, (paperCount.get(paper.paperType) ?? 0) + 1))
  let paperType = actual.papers[0]!.paperType
  let maxCount = -1
  paperCount.forEach((count, type) => {
    if (count > maxCount) {
      maxCount = count
      paperType = type
    }
  })

  return {
    volumeId: input.volumeId,
    // 旧档目标 pH 只能照实做记录回填（平均到 0.1）
    targetPh: actual.averagePh > 0 ? actual.averagePh : 7.0,
    paperType,
    steps: actual.allSteps,
    plannedFinishDate: actual.finishDate ?? new Date().toISOString().slice(0, 10),
    remark: 'v2 旧数据升级时按现有配纸与工序回填的历史方案，只读留存',
    supervisor: input.supervisor ?? actual.binding?.inspector ?? '系统回填'
  }
}
