/**
 * 修复方案与偏离说明 store（Pinia setup store）
 *
 * 牵制规则：
 * - 方案只能主管立；草稿只有主管能改；定稿后主管也改不了，想改只能作废重立（revision+1）；
 * - 修复师动不了方案，只能在定稿方案上登记偏离说明；
 * - 旧档回填的历史方案（historical）只读，谁都不能改 / 作废；
 * - legacyReadOnly 的册次补不出历史方案，整册只读。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db } from '@/utils/db'
import { useAuthStore } from '@/stores/authStore'
import { useBookStore } from '@/stores/bookStore'
import { effectivePlan } from '@/utils/planReconcile'
import type { Deviation, DeviationDraft } from '@/types/deviation'
import type { RepairPlan, RepairPlanDraft } from '@/types/repairPlan'

export const usePlanStore = defineStore('plan', () => {
  const auth = useAuthStore()
  const plans = ref<RepairPlan[]>([])
  const deviations = ref<Deviation[]>([])
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  async function loadPlans(): Promise<void> {
    loading.value = true
    try {
      const rows = await db.repairPlans.toArray()
      rows.sort((a, b) => (a.volumeId === b.volumeId ? a.revision - b.revision : a.volumeId.localeCompare(b.volumeId)))
      plans.value = rows
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '修复方案读取失败'
    } finally {
      loading.value = false
    }
  }

  async function loadDeviations(): Promise<void> {
    const rows = await db.deviations.toArray()
    rows.sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : b.date.localeCompare(a.date)))
    deviations.value = rows
  }

  function plansOfVolume(volumeId: string): RepairPlan[] {
    return plans.value
      .filter((plan) => plan.volumeId === volumeId)
      .sort((a, b) => b.revision - a.revision)
  }

  function deviationsOfVolume(volumeId: string): Deviation[] {
    return deviations.value
      .filter((item) => item.volumeId === volumeId)
      .sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : b.date.localeCompare(a.date)))
  }

  function deviationsOfPlan(planId: string): Deviation[] {
    return deviations.value.filter((item) => item.planId === planId)
  }

  /** 该册当前生效方案（最新定稿方案；历史方案也算） */
  function activePlanOf(volumeId: string): RepairPlan | null {
    return effectivePlan(plans.value, volumeId)
  }

  const effectivePlanList = computed<RepairPlan[]>(() => {
    const byVolume = new Map<string, RepairPlan>()
    plans.value.forEach((plan) => {
      if (plan.state !== 'confirmed') return
      const current = byVolume.get(plan.volumeId)
      if (!current || plan.revision > current.revision) byVolume.set(plan.volumeId, plan)
    })
    return [...byVolume.values()]
  })

  function requireSupervisor(): void {
    if (!auth.isSupervisor) throw new Error('只有修复室主管能操作修复方案，请在页头切换为主管身份')
  }

  function requireRestorer(): void {
    if (!auth.isRestorer) throw new Error('偏离说明由修复师登记，请在页头切换为修复师身份')
  }

  /** 取册次；旧档只读册一律拦 */
  function requireWritableVolume(volumeId: string): void {
    const bookStore = useBookStore()
    const volume = bookStore.volumeById(volumeId)
    if (!volume) throw new Error('册次不存在或已删除')
    if (volume.legacyReadOnly === true) throw new Error('该册为升级时补不出历史方案的旧档，只读留着，不能再立方案')
  }

  function nextRevision(volumeId: string): number {
    const own = plans.value.filter((plan) => plan.volumeId === volumeId)
    return own.length === 0 ? 1 : Math.max(...own.map((plan) => plan.revision)) + 1
  }

  function validateDraft(draft: RepairPlanDraft): string {
    if (!draft.volumeId) return '请选择册次'
    if (!(draft.targetPh >= 4 && draft.targetPh <= 10)) return '目标 pH 应在 4～10 之间'
    if (draft.steps.length === 0) return '方案至少要写明一道工序'
    if (!draft.plannedFinishDate) return '请填写预计完工日期'
    return ''
  }

  /** 主管立方案（新册立首版） */
  async function createPlan(draft: RepairPlanDraft, andConfirm = false): Promise<RepairPlan> {
    requireSupervisor()
    requireWritableVolume(draft.volumeId)
    const invalid = validateDraft(draft)
    if (invalid) throw new Error(invalid)
    const own = plans.value.filter((plan) => plan.volumeId === draft.volumeId)
    if (own.some((plan) => plan.state === 'confirmed')) {
      throw new Error('该册已有定稿方案；定稿方案不能改，如需调整请先作废再重立')
    }
    if (own.some((plan) => plan.state === 'draft')) {
      throw new Error('该册已有草稿方案，请在草稿上修改并定稿')
    }
    const now = Date.now()
    const row: RepairPlan = {
      ...draft,
      id: createId('plan'),
      revision: nextRevision(draft.volumeId),
      state: andConfirm ? 'confirmed' : 'draft',
      historical: false,
      confirmedAt: andConfirm ? now : null,
      voidedAt: null,
      voidReason: '',
      createdAt: now,
      updatedAt: now
    }
    await db.repairPlans.put(row)
    await loadPlans()
    return row
  }

  /** 改草稿（定稿 / 作废 / 历史方案一律不允许改） */
  async function updateDraft(id: string, patch: Partial<RepairPlanDraft>): Promise<void> {
    requireSupervisor()
    const plan = plans.value.find((item) => item.id === id)
    if (!plan) throw new Error('方案不存在')
    if (plan.historical) throw new Error('这是升级回填的历史方案，只读留存，不能修改')
    if (plan.state !== 'draft') throw new Error('方案已定稿，主管也不能直接改；要改请作废重立')
    const merged: RepairPlanDraft = {
      volumeId: plan.volumeId,
      targetPh: patch.targetPh ?? plan.targetPh,
      paperType: patch.paperType ?? plan.paperType,
      steps: patch.steps ?? plan.steps,
      plannedFinishDate: patch.plannedFinishDate ?? plan.plannedFinishDate,
      remark: patch.remark ?? plan.remark,
      supervisor: patch.supervisor ?? plan.supervisor
    }
    const invalid = validateDraft(merged)
    if (invalid) throw new Error(invalid)
    await db.repairPlans.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadPlans()
  }

  /** 主管定稿：方案定了才算数 */
  async function confirmPlan(id: string): Promise<void> {
    requireSupervisor()
    const plan = plans.value.find((item) => item.id === id)
    if (!plan) throw new Error('方案不存在')
    if (plan.historical) throw new Error('历史方案无需定稿')
    if (plan.state !== 'draft') throw new Error('只有草稿方案可以定稿')
    const invalid = validateDraft({
      volumeId: plan.volumeId,
      targetPh: plan.targetPh,
      paperType: plan.paperType,
      steps: plan.steps,
      plannedFinishDate: plan.plannedFinishDate,
      remark: plan.remark,
      supervisor: plan.supervisor
    })
    if (invalid) throw new Error(invalid)
    await db.repairPlans.update(id, { state: 'confirmed', confirmedAt: Date.now(), updatedAt: Date.now() } as never)
    await loadPlans()
  }

  /** 主管作废（必须填原因）；历史方案不许作废 */
  async function voidPlan(id: string, reason: string): Promise<void> {
    requireSupervisor()
    const plan = plans.value.find((item) => item.id === id)
    if (!plan) throw new Error('方案不存在')
    if (plan.historical) throw new Error('历史方案只读留存，不能作废')
    if (plan.state !== 'confirmed') throw new Error('只有定稿方案可以作废')
    if (!reason.trim()) throw new Error('作废重立必须写明原因')
    await db.repairPlans.update(id, {
      state: 'voided',
      voidedAt: Date.now(),
      voidReason: reason.trim(),
      updatedAt: Date.now()
    } as never)
    await loadPlans()
  }

  /** 修复师登记偏离说明（只能挂在该册定稿方案上） */
  async function registerDeviation(draft: DeviationDraft): Promise<Deviation> {
    requireRestorer()
    const plan = plans.value.find((item) => item.id === draft.planId)
    if (!plan) throw new Error('偏离说明必须挂在已存在的方案上')
    if (plan.state !== 'confirmed') throw new Error('方案还没定稿，谈不上偏离')
    if (!draft.reason.trim()) throw new Error('请写明偏离原因')
    if (!draft.actual.trim()) throw new Error('请写明实做情况')
    const now = Date.now()
    const row: Deviation = { ...draft, id: createId('dev'), createdAt: now, updatedAt: now }
    await db.deviations.put(row)
    await loadDeviations()
    return row
  }

  /** 主管对账后补认定结论（修复师不能改处理结论） */
  async function resolveDeviation(id: string, resolution: string): Promise<void> {
    requireSupervisor()
    const deviation = deviations.value.find((item) => item.id === id)
    if (!deviation) throw new Error('偏离说明不存在')
    await db.deviations.update(id, {
      resolution: resolution.trim(),
      status: resolution.trim() ? 'resolved' : 'open',
      updatedAt: Date.now()
    } as never)
    await loadDeviations()
  }

  /** 主管删除登记有误的偏离说明（历史旧档的登记也允许删除） */
  async function removeDeviation(id: string): Promise<void> {
    requireSupervisor()
    await db.deviations.delete(id)
    await loadDeviations()
  }

  return {
    plans,
    deviations,
    loading,
    ready,
    error,
    effectivePlanList,
    loadPlans,
    loadDeviations,
    plansOfVolume,
    deviationsOfVolume,
    deviationsOfPlan,
    activePlanOf,
    nextRevision,
    createPlan,
    updateDraft,
    confirmPlan,
    voidPlan,
    registerDeviation,
    resolveDeviation,
    removeDeviation
  }
})
