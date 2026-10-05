/**
 * 偏离说明（Deviation）数据模型
 * 方案与修复师手上的实做互相牵制：实做与已确认方案一旦有出入，
 * 必须补一条偏离说明「挂」到该项不符上，否则归档前对账不予放行。
 * 偏离说明由修复师登记，主管只负责照单核对。
 */
import type { RepairName } from './repairOrder';

/** 偏离维度：目标 pH / 补纸纸种 / 工序 / 预计完工日 */
export type DeviationKind = 'ph' | 'paper' | 'process' | 'finishDate';

/** 偏离状态：待说明（先挂起）/ 已说明（已登记偏离，可据此对账） */
export type DeviationStatus = 'pending' | 'explained';

export interface Deviation {
  id: string;
  /** 所属册次 id */
  volumeId: string;
  /** 针对的修复方案 id（对账基准） */
  planId: string;
  /** 偏离维度 */
  kind: DeviationKind;
  /**
   * 关联的具体工序（仅工序类偏离使用）：
   * 多出 / 缺失 / 调换到某道工序时记录其工序名。
   */
  relatedStep?: RepairName;
  /** 方案原定内容（留痕） */
  plannedValue: string;
  /** 实际做成的内容（留痕） */
  actualValue: string;
  /** 偏离原因说明（修复师填写，非空才视为已说明） */
  reason: string;
  /** 登记人 */
  operator: string;
  /** 状态：先挂起待说明，补登后转为已说明 */
  status: DeviationStatus;
  createdAt: number;
  updatedAt: number;
}

export type DeviationDraft = Omit<Deviation, 'id' | 'status' | 'createdAt' | 'updatedAt'>;

export const DEVIATION_KIND_LABEL: Record<DeviationKind, string> = {
  ph: '目标 pH',
  paper: '补纸纸种',
  process: '工序',
  finishDate: '完工日期'
};

export const DEVIATION_STATUS_LABEL: Record<DeviationStatus, string> = {
  pending: '待说明',
  explained: '已说明'
};

export const DEVIATION_STATUS_COLOR: Record<DeviationStatus, string> = {
  pending: '#b03a2e',
  explained: '#1e8449'
};

export function isPendingDeviation(deviation: Deviation): boolean {
  return deviation.status === 'pending' || deviation.reason.trim().length === 0;
}

export function createEmptyDeviationDraft(params: {
  volumeId: string;
  planId: string;
  kind: DeviationKind;
  plannedValue: string;
  actualValue: string;
  relatedStep?: RepairName;
}): DeviationDraft {
  return {
    volumeId: params.volumeId,
    planId: params.planId,
    kind: params.kind,
    relatedStep: params.relatedStep,
    plannedValue: params.plannedValue,
    actualValue: params.actualValue,
    reason: '',
    operator: ''
  };
}
