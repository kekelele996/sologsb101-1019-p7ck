/**
 * 修复方案与偏离说明 store（Pinia setup store）
 * 规则集中落地在这里：
 * - 方案由修复室主管按册次订立；草稿可改，一确认即「定下」，谁都不能直接改。
 * - 主管想改已定方案只能作废旧案、重立一份新版本（旧案留痕）；修复师只读。
 * - 实做与方案有出入时，由修复师登记偏离说明（status=explained），供归档前对账挂账。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db, readUiPrefs, writeUiPrefs } from '@/utils/db'
import { canManagePlan, canRegisterDeviation, type Role } from '@/types/role'
import type { RepairPlan, RepairPlanDraft } from '@/types/repairPlan'
import type { Deviation, DeviationDraft } from '@/types/deviation'

export class PlanRuleError extends Error {}

export const usePlanStore = defineStore('plan', () => {
  const plans = ref<RepairPlan[]>([])
  const deviations = ref<Deviation[]>([])
  const role = ref<Role>(readUiPrefs().role)
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  async function loadAll(): Promise<void> {
    loading.value = true
    try {
      const [planRows, deviationRows] = await Promise.all([db.repairPlans.toArray(), db.deviations.toArray()])
      planRows.sort(
        (a, b) =>
          (a.volumeId === b.volumeId
            ? b.version - a.version
            : a.volumeId.localeCompare(b.volumeId)) || b.updatedAt - a.updatedAt
      )
      deviationRows.sort((a, b) => b.updatedAt - a.updatedAt)
      plans.value = planRows
      deviations.value = deviationRows
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '修复方案读取失败'
    } finally {
      loading.value = false
    }
  }

  function setRole(next: Role): void {
    role.value = next
    writeUiPrefs({ ...readUiPrefs(), role: next })
  }

  /** 该册全部方案，版本号倒序（最新在前） */
  function plansOfVolume(volumeId: string): RepairPlan[] {
    return plans.value
      .filter((plan) => plan.volumeId === volumeId)
      .sort((a, b) => b.version - a.version || b.updatedAt - a.updatedAt)
  }

  /** 当前生效（已定）方案 */
  function activePlanOfVolume(volumeId: string): RepairPlan | undefined {
    return plansOfVolume(volumeId).find((plan) => plan.status === 'confirmed')
  }

  function deviationsOfVolume(volumeId: string): Deviation[] {
    return deviations.value
      .filter((item) => item.volumeId === volumeId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  function planById(id: string): RepairPlan | undefined {
    return plans.value.find((plan) => plan.id === id)
  }

  const canManage = computed(() => canManagePlan(role.value))
  const canRegister = computed(() => canRegisterDeviation(role.value))

  function assertSupervisor(): void {
    if (!canManagePlan(role.value)) {
      throw new PlanRuleError('修复师不能订立或改动修复方案，方案对修复师只读')
    }
  }

  function assertRestorer(): void {
    if (!canRegisterDeviation(role.value)) {
      throw new PlanRuleError('偏离说明由修复师登记，主管只负责照单对账')
    }
  }

  function nextVersion(volumeId: string): number {
    const versions = plans.value.filter((plan) => plan.volumeId === volumeId).map((plan) => plan.version)
    return versions.length === 0 ? 1 : Math.max(...versions) + 1
  }

  function validateDraft(draft: RepairPlanDraft): string {
    if (!draft.volumeId) return '请选择册次'
    if (!(draft.targetPh >= 0 && draft.targetPh <= 14)) return '请填写合法的目标 pH（0–14）'
    if (!draft.supervisor.trim()) return '请填写订立人（修复室主管）'
    if (!draft.expectedFinishDate) return '请选择预计完工日期'
    if (draft.processSteps.length === 0) return '至少要列一道工序'
    return ''
  }

  /** 主管立一份草稿 */
  async function createDraft(draft: RepairPlanDraft): Promise<RepairPlan> {
    assertSupervisor()
    const invalid = validateDraft(draft)
    if (invalid) throw new PlanRuleError(invalid)
    const now = Date.now()
    const row: RepairPlan = {
      ...draft,
      id: createId('plan'),
      version: nextVersion(draft.volumeId),
      status: 'draft',
      origin: 'normal',
      createdAt: now,
      updatedAt: now
    }
    await db.repairPlans.put(row)
    await loadAll()
    return row
  }

  /** 草稿阶段可改；定下后此方法拒绝 */
  async function updateDraft(id: string, patch: Partial<RepairPlanDraft>): Promise<void> {
    assertSupervisor()
    const plan = planById(id)
    if (!plan) throw new PlanRuleError('方案不存在')
    if (plan.status !== 'draft') {
      throw new PlanRuleError('方案已定 / 已作废，不能直接修改；如需调整请作废后重新订立')
    }
    await db.repairPlans.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadAll()
  }

  /** 草稿确认定下：定下后即锁死 */
  async function confirmPlan(id: string): Promise<void> {
    assertSupervisor()
    const plan = planById(id)
    if (!plan) throw new PlanRuleError('方案不存在')
    if (plan.status !== 'draft') throw new PlanRuleError('只有草稿可以确认定下')
    if (activePlanOfVolume(plan.volumeId)) {
      throw new PlanRuleError('该册已有生效方案；如要调整请先把现方案作废再重立')
    }
    await db.repairPlans.update(id, {
      status: 'confirmed',
      confirmedAt: Date.now(),
      updatedAt: Date.now()
    } as never)
    await loadAll()
  }

  /** 删除草稿（已定 / 已作废 / 历史方案一律留痕，不可删） */
  async function removeDraft(id: string): Promise<void> {
    assertSupervisor()
    const plan = planById(id)
    if (!plan) return
    if (plan.status !== 'draft') throw new PlanRuleError('已定 / 已作废方案须留痕，不能删除')
    await db.repairPlans.delete(id)
    await loadAll()
  }

  /**
   * 作废并重立：把当前生效方案置为 voided（填废案原因），
   * 再据新草稿立一份版本号 +1 的新方案，可直接定下。
   */
  async function voidAndReissue(params: {
    oldPlanId: string
    reason: string
    nextDraft: RepairPlanDraft
    confirm: boolean
  }): Promise<RepairPlan> {
    assertSupervisor()
    const old = planById(params.oldPlanId)
    if (!old) throw new PlanRuleError('原方案不存在')
    if (old.status !== 'confirmed') throw new PlanRuleError('只能作废当前生效方案')
    if (!params.reason.trim()) throw new PlanRuleError('作废重立须填写废案原因')
    const invalid = validateDraft(params.nextDraft)
    if (invalid) throw new PlanRuleError(invalid)
    const now = Date.now()
    await db.transaction('rw', [db.repairPlans], async () => {
      await db.repairPlans.update(old.id, {
        status: 'voided',
        voidReason: params.reason.trim(),
        voidedAt: now,
        updatedAt: now
      } as never)
      const reissued: RepairPlan = {
        ...params.nextDraft,
        volumeId: old.volumeId,
        id: createId('plan'),
        version: nextVersion(old.volumeId),
        supersedesPlanId: old.id,
        status: params.confirm ? 'confirmed' : 'draft',
        origin: 'normal',
        confirmedAt: params.confirm ? now : undefined,
        createdAt: now,
        updatedAt: now
      }
      await db.repairPlans.put(reissued)
    })
    await loadAll()
    return plansOfVolume(old.volumeId)[0] as RepairPlan
  }

  /** 修复师登记一条偏离说明（挂到某个不符项上），状态直接为已说明 */
  async function registerDeviation(draft: DeviationDraft): Promise<Deviation> {
    assertRestorer()
    if (!draft.reason.trim()) throw new PlanRuleError('请填写偏离原因说明')
    if (!draft.operator.trim()) throw new PlanRuleError('请填写登记人')
    const now = Date.now()
    const row: Deviation = {
      ...draft,
      id: createId('dev'),
      status: 'explained',
      createdAt: now,
      updatedAt: now
    }
    await db.deviations.put(row)
    await loadAll()
    return row
  }

  /** 已登记的偏离可补改说明内容；不允许改挂到别的方案 / 维度 */
  async function updateDeviation(id: string, patch: Pick<DeviationDraft, 'reason' | 'operator'>): Promise<void> {
    assertRestorer()
    if (!patch.reason.trim()) throw new PlanRuleError('偏离原因不能为空')
    await db.deviations.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadAll()
  }

  async function removeDeviation(id: string): Promise<void> {
    assertRestorer()
    await db.deviations.delete(id)
    await loadAll()
  }

  /** 册次维度统计，供徽标展示 */
  function pendingDeviationCountOf(volumeId: string): number {
    return deviations.value.filter((item) => item.volumeId === volumeId && item.status === 'pending').length
  }

  return {
    plans,
    deviations,
    role,
    loading,
    ready,
    error,
    canManage,
    canRegister,
    loadAll,
    setRole,
    plansOfVolume,
    activePlanOfVolume,
    deviationsOfVolume,
    planById,
    createDraft,
    updateDraft,
    confirmPlan,
    removeDraft,
    voidAndReissue,
    registerDeviation,
    updateDeviation,
    removeDeviation,
    pendingDeviationCountOf
  }
})
