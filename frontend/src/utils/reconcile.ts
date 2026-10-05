/**
 * 归档前对账（reconcile）
 * 归档前把已确认修复方案与该册实做记录一项项核对：目标 pH、补纸纸种、
 * 工序、预计完工日。对得上的放行；有出入但已登记偏离说明的挂账可放行；
 * 对不上又没登记偏离的先「挂起」，没登记的偏离不许归档。
 *
 * 纯函数：只读方案与实做数据，不触碰 IndexedDB，便于被页面与导出工具共用。
 */
import type { RepairPlan } from '@/types/repairPlan'
import type { Deviation, DeviationKind } from '@/types/deviation'
import type { Leaf } from '@/types/leaf'
import type { Paper } from '@/types/paper'
import type { RepairOrder, RepairName } from '@/types/repairOrder'
import type { Binding } from '@/types/binding'
import { PAPER_TYPE_LABEL } from '@/types/paper'
import { REPAIR_NAME_LABEL } from '@/types/repairOrder'

/** 实做平均 pH 与目标 pH 的允许误差，超出即视为偏离 */
export const PH_TOLERANCE = 0.3

/** 单个对账项的结论：对得上 / 有出入已说明 / 挂起（待说明） */
export type ReconcileStatus = 'match' | 'documented' | 'pending'

export interface ReconcileItem {
  kind: DeviationKind
  /** 工序类偏离时定位到具体工序 */
  relatedStep?: RepairName
  /** 对账项名称 */
  label: string
  /** 方案原定 */
  planned: string
  /** 实际做成 */
  actual: string
  status: ReconcileStatus
  /** 命中的已说明偏离记录 id */
  deviationId?: string
}

export interface ReconcileResult {
  volumeId: string
  /** 作为对账基准的方案 id；无已确认方案时为空 */
  planId: string | null
  hasConfirmedPlan: boolean
  items: ReconcileItem[]
  /** 对得上的项数 */
  matchCount: number
  /** 有出入但已登记偏离说明的项数 */
  documentedCount: number
  /** 挂起待说明的项数 */
  pendingCount: number
  /** 是否允许归档：存在已确认方案且没有挂起项 */
  canArchive: boolean
  /** 不予放行的原因 */
  blockers: string[]
}

export interface ReconcileInput {
  volumeId: string
  plans: RepairPlan[]
  deviations: Deviation[]
  leaves: Leaf[]
  papers: Paper[]
  orders: RepairOrder[]
  binding?: Binding
}

function averagePh(leaves: Leaf[]): number | null {
  if (leaves.length === 0) return null
  return leaves.reduce((sum, leaf) => sum + leaf.phValue, 0) / leaves.length
}

/** 找到覆盖某个不符项的「已说明」偏离（工序项还需工序名一致） */
function findExplainedDeviation(
  deviations: Deviation[],
  planId: string,
  kind: DeviationKind,
  relatedStep?: RepairName
): Deviation | undefined {
  return deviations.find(
    (item) =>
      item.planId === planId &&
      item.kind === kind &&
      item.status === 'explained' &&
      item.reason.trim().length > 0 &&
      (kind !== 'process' || item.relatedStep === relatedStep)
  )
}

function resolve(
  deviations: Deviation[],
  planId: string,
  base: Omit<ReconcileItem, 'status' | 'deviationId'> & { mismatch: boolean }
): ReconcileItem {
  if (!base.mismatch) return { ...base, status: 'match' }
  const hit = findExplainedDeviation(deviations, planId, base.kind, base.relatedStep)
  return hit
    ? { ...base, status: 'documented', deviationId: hit.id }
    : { ...base, status: 'pending' }
}

/** 取一册当前的对账基准：已确认（已定）方案；没有则返回 undefined */
export function activePlanOf(plans: RepairPlan[], volumeId: string): RepairPlan | undefined {
  return plans
    .filter((plan) => plan.volumeId === volumeId && plan.status === 'confirmed')
    .sort(
      (a, b) =>
        (b.confirmedAt ?? b.updatedAt) - (a.confirmedAt ?? a.updatedAt)
    )[0]
}

/**
 * 逐项对账。无已确认方案时直接判为不可归档（旧数据须先有历史方案或补立方案）。
 */
export function reconcileVolume(input: ReconcileInput): ReconcileResult {
  const plan = activePlanOf(input.plans, input.volumeId)
  const baseResult: ReconcileResult = {
    volumeId: input.volumeId,
    planId: plan?.id ?? null,
    hasConfirmedPlan: Boolean(plan),
    items: [],
    matchCount: 0,
    documentedCount: 0,
    pendingCount: 0,
    canArchive: false,
    blockers: []
  }
  if (!plan) {
    baseResult.blockers.push('该册没有已确认的修复方案（草稿 / 已作废不能作为对账基准），须先立方案')
    return baseResult
  }

  const items: ReconcileItem[] = []

  /* 1. 目标 pH：实做各叶平均 pH 与目标 pH 之差超容差即偏离 */
  const avgPh = averagePh(input.leaves)
  items.push(
    resolve(input.deviations, plan.id, {
      kind: 'ph',
      label: '目标 pH',
      planned: `目标 pH ${plan.targetPh}（容差 ±${PH_TOLERANCE}）`,
      actual: avgPh === null ? '实做未登记书叶 pH' : `实做平均 pH ${Math.round(avgPh * 100) / 100}`,
      mismatch: avgPh === null || Math.abs(avgPh - plan.targetPh) > PH_TOLERANCE
    })
  )

  /* 2. 补纸纸种：实做选配纸中出现方案外纸种即偏离；未配纸挂起 */
  const actualPaperKinds = Array.from(new Set(input.papers.map((paper) => paper.paperType)))
  const paperText = actualPaperKinds.map((kind) => PAPER_TYPE_LABEL[kind]).join('、')
  items.push(
    resolve(input.deviations, plan.id, {
      kind: 'paper',
      label: '补纸纸种',
      planned: `计划用 ${PAPER_TYPE_LABEL[plan.paperType]}`,
      actual: actualPaperKinds.length === 0 ? '实做未选配补纸' : `实做选配 ${paperText}`,
      mismatch: actualPaperKinds.length === 0 || actualPaperKinds.some((kind) => kind !== plan.paperType)
    })
  )

  /* 3. 工序：方案工序集合与实做登记工序集合比对（缺失 / 多出逐项挂起） */
  const actualStepKinds = new Set(input.orders.map((order) => order.name))
  plan.processSteps.forEach((step) => {
    if (!actualStepKinds.has(step)) {
      items.push(
        resolve(input.deviations, plan.id, {
          kind: 'process',
          relatedStep: step,
          label: `工序·${REPAIR_NAME_LABEL[step]}`,
          planned: `方案要求 ${REPAIR_NAME_LABEL[step]}`,
          actual: '实做未实施 / 未登记',
          mismatch: true
        })
      )
    }
  })
  actualStepKinds.forEach((step) => {
    if (!plan.processSteps.includes(step)) {
      items.push(
        resolve(input.deviations, plan.id, {
          kind: 'process',
          relatedStep: step,
          label: `工序·${REPAIR_NAME_LABEL[step]}`,
          planned: '方案未列此工序',
          actual: `实做增加 ${REPAIR_NAME_LABEL[step]}`,
          mismatch: true
        })
      )
    }
  })

  /* 4. 预计完工日：晚于预计即偏离；未装订完工先挂起 */
  const binding = input.binding
  items.push(
    resolve(input.deviations, plan.id, {
      kind: 'finishDate',
      label: '完工日期',
      planned: `预计 ${plan.expectedFinishDate}`,
      actual: binding ? `实际完工 ${binding.finishDate}` : '尚未装订完工',
      mismatch: !binding || binding.finishDate > plan.expectedFinishDate
    })
  )

  const pending = items.filter((item) => item.status === 'pending')
  const blockers = pending.map((item) => `${item.label}：${item.planned}；${item.actual}`)
  return {
    ...baseResult,
    items,
    matchCount: items.filter((item) => item.status === 'match').length,
    documentedCount: items.filter((item) => item.status === 'documented').length,
    pendingCount: pending.length,
    canArchive: pending.length === 0,
    blockers
  }
}

/** 对账项状态徽标文案 / 颜色，供页面与导出共用 */
export const RECONCILE_STATUS_LABEL: Record<ReconcileStatus, string> = {
  match: '对得上',
  documented: '已挂账',
  pending: '挂起待说明'
}

export const RECONCILE_STATUS_COLOR: Record<ReconcileStatus, string> = {
  match: '#1e8449',
  documented: '#3a6ea5',
  pending: '#b03a2e'
}
