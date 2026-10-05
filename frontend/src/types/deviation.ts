/**
 * 偏离说明（Deviation）数据模型
 * 方案与修复师手上的实做互相牵制：实做与方案有出入，就得补一条偏离说明。
 * 归档前逐项对账，挂起项必须有对应的偏离登记才放行。
 */

/** 偏离类别：目标 pH / 补纸 / 工序 / 工期 */
export type DeviationKind = 'ph' | 'paper' | 'step' | 'schedule'

/** 偏离处理状态：待主管认定 / 已有处理结论 */
export type DeviationStatus = 'open' | 'resolved'

export interface Deviation {
  id: string
  /** 所属册次 id */
  volumeId: string
  /** 针对的修复方案 id（按定稿方案挂账） */
  planId: string
  /** 偏离类别 */
  kind: DeviationKind
  /** 方案要求（对账时自动带出，可修订） */
  planned: string
  /** 实做情况 */
  actual: string
  /** 偏离说明：为什么与方案不一致 */
  reason: string
  /** 登记人（修复师） */
  recorder: string
  /** 处理结论（主管对账后可补） */
  resolution: string
  /** 登记 / 处理状态 */
  status: DeviationStatus
  /** 登记日期 yyyy-MM-dd */
  date: string
  createdAt: number
  updatedAt: number
}

export type DeviationDraft = Omit<Deviation, 'id' | 'createdAt' | 'updatedAt'>

export const DEVIATION_KIND_LABEL: Record<DeviationKind, string> = {
  ph: '目标 pH',
  paper: '补纸纸种',
  step: '工序',
  schedule: '完工工期'
}

export const DEVIATION_KIND_COLOR: Record<DeviationKind, string> = {
  ph: '#b03a2e',
  paper: '#a8623a',
  step: '#3a6ea5',
  schedule: '#7d6ba8'
}

export const DEVIATION_KIND_OPTIONS: ReadonlyArray<{ value: DeviationKind; label: string }> = [
  { value: 'ph', label: '目标 pH' },
  { value: 'paper', label: '补纸纸种' },
  { value: 'step', label: '工序' },
  { value: 'schedule', label: '完工工期' }
]

export const DEVIATION_STATUS_LABEL: Record<DeviationStatus, string> = {
  open: '待认定',
  resolved: '已认定'
}

export function createEmptyDeviationDraft(
  volumeId: string,
  planId: string,
  recorder: string,
  kind: DeviationKind = 'ph'
): DeviationDraft {
  return {
    volumeId,
    planId,
    kind,
    planned: '',
    actual: '',
    reason: '',
    recorder,
    resolution: '',
    status: 'open',
    date: new Date().toISOString().slice(0, 10)
  }
}
