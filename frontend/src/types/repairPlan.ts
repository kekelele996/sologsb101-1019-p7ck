/**
 * 修复方案（RepairPlan）数据模型
 * 修一册之前，由修复室主管按册次先立一份方案：目标 pH、补纸纸种、工序与预计完工日。
 * 方案「定稿」后主管自己也改不了，要改只能作废重立（revision 递增）；修复师动不了方案。
 * v2→v3 升级时为旧数据回填的历史方案 historical=true，只读留存。
 */
import type { PaperType } from '@/types/paper'
import type { RepairName } from '@/types/repairOrder'

/** 方案状态：草稿 / 已定稿 / 已作废 */
export type PlanState = 'draft' | 'confirmed' | 'voided'

export interface RepairPlan {
  id: string
  /** 所属册次 id */
  volumeId: string
  /** 版次：同一册作废重立一次 +1，从 1 开始 */
  revision: number
  /** 目标 pH（脱酸后整册应达到的 pH） */
  targetPh: number
  /** 打算用哪种补纸 */
  paperType: PaperType
  /** 走哪几道工序（按先后排列） */
  steps: RepairName[]
  /** 预计完工日期 yyyy-MM-dd */
  plannedFinishDate: string
  /** 方案备注（技法要点 / 材料批次等） */
  remark: string
  /** 当前状态 */
  state: PlanState
  /** 立方案的主管姓名 */
  supervisor: string
  /** 旧数据升级回填的历史方案：只读，不可作废重立 */
  historical: boolean
  /** 定稿时间 */
  confirmedAt: number | null
  /** 作废时间 */
  voidedAt: number | null
  /** 作废原因（作废重立时必填） */
  voidReason: string
  createdAt: number
  updatedAt: number
}

export type RepairPlanDraft = Omit<
  RepairPlan,
  'id' | 'revision' | 'state' | 'historical' | 'confirmedAt' | 'voidedAt' | 'voidReason' | 'createdAt' | 'updatedAt'
>

export const PLAN_STATE_LABEL: Record<PlanState, string> = {
  draft: '草稿（未定稿）',
  confirmed: '已定稿',
  voided: '已作废'
}

export const PLAN_STATE_COLOR: Record<PlanState, string> = {
  draft: '#d68910',
  confirmed: '#1e8449',
  voided: '#8c8c8c'
}

/** 册次维度的方案立账状态（PlanTag 与筛选共用） */
export type VolumePlanStatus = 'none' | 'draft' | 'confirmed' | 'voided' | 'legacy'

export const VOLUME_PLAN_STATUS_LABEL: Record<VolumePlanStatus, string> = {
  none: '未立方案',
  draft: '方案草稿',
  confirmed: '方案已定稿',
  voided: '方案已作废',
  legacy: '旧档只读'
}

export const VOLUME_PLAN_STATUS_OPTIONS: ReadonlyArray<{ value: VolumePlanStatus; label: string }> = [
  { value: 'none', label: '未立方案' },
  { value: 'draft', label: '方案草稿' },
  { value: 'confirmed', label: '方案已定稿' },
  { value: 'voided', label: '方案已作废' },
  { value: 'legacy', label: '旧档只读' }
]

export function createEmptyPlanDraft(volumeId: string, supervisor: string): RepairPlanDraft {
  return {
    volumeId,
    targetPh: 7.0,
    paperType: 'bamboo',
    steps: ['mend', 'mount', 'press'],
    plannedFinishDate: new Date().toISOString().slice(0, 10),
    remark: '',
    supervisor
  }
}
