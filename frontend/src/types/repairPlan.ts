/**
 * 修复方案（RepairPlan）数据模型
 * 修一册之前，由修复室主管按册次先立一份方案：目标 pH、打算用的补纸、
 * 走哪几道工序、预计哪天完工。方案「定了才算数」：草稿不约束实做，
 * 一旦确认即不可修改；主管想改只能把旧方案作废、重新立一份（旧案留痕），
 * 修复师对方案只读。
 *
 * 旧数据没有方案，v2→v3 升级时按现有配纸与工序回填一份历史方案
 *（origin='historical'，与普通方案一样只读留痕）。
 */
import type { PaperType } from './paper';
import type { RepairName } from './repairOrder';

/** 方案状态：草稿 / 已定（生效、不可改）/ 已作废（重立前的旧案留痕） */
export type PlanStatus = 'draft' | 'confirmed' | 'voided';

/** 方案来源：正常订立 / 升级时按实做回填的历史方案 */
export type PlanOrigin = 'normal' | 'historical';

export interface RepairPlan {
  id: string;
  /** 所属册次 id（方案按册次订立，一册可留多版作废旧案） */
  volumeId: string;
  /** 版本号，从 1 开始；作废重立依次递增 */
  version: number;
  /** 重立时指向被作废的上一版方案 id */
  supersedesPlanId?: string;
  /** 目标 pH */
  targetPh: number;
  /** 打算用的补纸纸种 */
  paperType: PaperType;
  /** 计划走的工序（有序、不重复） */
  processSteps: RepairName[];
  /** 预计完工日期 yyyy-MM-dd */
  expectedFinishDate: string;
  /** 订立人（修复室主管） */
  supervisor: string;
  /** 备注 */
  remark: string;
  /** 当前状态 */
  status: PlanStatus;
  /** 来源 */
  origin: PlanOrigin;
  /** 作废原因（作废重立时填写） */
  voidReason?: string;
  /** 确认时间 */
  confirmedAt?: number;
  /** 作废时间 */
  voidedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type RepairPlanDraft = Omit<
  RepairPlan,
  'id' | 'version' | 'status' | 'origin' | 'supersedesPlanId' | 'voidReason' | 'confirmedAt' | 'voidedAt' | 'createdAt' | 'updatedAt'
>;

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  draft: '草稿',
  confirmed: '已定',
  voided: '已作废'
};

export const PLAN_STATUS_COLOR: Record<PlanStatus, string> = {
  draft: '#8c8c8c',
  confirmed: '#1e8449',
  voided: '#b03a2e'
};

export const PLAN_ORIGIN_LABEL: Record<PlanOrigin, string> = {
  normal: '现立',
  historical: '历史回填'
};

/** 已定方案不可改：只有草稿可编辑，已定 / 已作废一律只读 */
export function isPlanConfirmed(plan: RepairPlan): boolean {
  return plan.status === 'confirmed';
}

export function isPlanVoided(plan: RepairPlan): boolean {
  return plan.status === 'voided';
}

/** 方案一旦定下就锁死，主管与修复师都不能直接改 */
export function isPlanLocked(plan: RepairPlan): boolean {
  return plan.status !== 'draft';
}

/** 历史回填方案一律只读留痕 */
export function isHistoricalPlan(plan: RepairPlan): boolean {
  return plan.origin === 'historical';
}

/** 默认工序序列：补破 → 托裱 → 溜口 → 裁齐 → 压平 */
export const DEFAULT_PLAN_STEPS: readonly RepairName[] = ['mend', 'mount', 'corner', 'trim', 'press'];

/** 目标 pH 合理区间，表单校验用 */
export const TARGET_PH_MIN = 6.5;
export const TARGET_PH_MAX = 8.5;

export function createEmptyPlanDraft(
  volumeId: string,
  preset?: { paperType?: PaperType; processSteps?: RepairName[]; expectedFinishDate?: string }
): RepairPlanDraft {
  return {
    volumeId,
    targetPh: 7.2,
    paperType: preset?.paperType ?? 'bamboo',
    processSteps: preset?.processSteps ? [...preset.processSteps] : [...DEFAULT_PLAN_STEPS],
    expectedFinishDate: preset?.expectedFinishDate ?? new Date().toISOString().slice(0, 10),
    supervisor: '',
    remark: ''
  };
}
