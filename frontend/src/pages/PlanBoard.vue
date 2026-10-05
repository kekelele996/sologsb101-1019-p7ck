<script setup lang="ts">
/**
 * /plans 修复方案与归档对账
 * 主管按册立方案（目标 pH / 补纸纸种 / 工序 / 预计完工日）：
 * 草稿可改，定稿后主管也不能改，要改只能作废重立（revision+1）；历史回填方案只读。
 * 修复师动不了方案，只能在定稿方案上登记偏离说明。
 * 归档前四项逐项对账：对不上又没登记偏离的先挂起，存在挂起项不许归档。
 */
import { computed, reactive, ref, watch, watchEffect } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CircleCheck, DocumentAdd, Edit, RefreshLeft, Remove } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, { useFilterQuery, type FilterModel } from '@/components/common/FilterBar.vue'
import PlanTag from '@/components/common/PlanTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useAuthStore } from '@/stores/authStore'
import { useBookStore } from '@/stores/bookStore'
import { usePlanStore } from '@/stores/planStore'
import { usePlanReconcile } from '@/hooks/usePlanReconcile'
import {
  PLAN_STATE_COLOR,
  PLAN_STATE_LABEL,
  VOLUME_PLAN_STATUS_OPTIONS,
  createEmptyPlanDraft,
  type RepairPlan,
  type RepairPlanDraft,
  type VolumePlanStatus
} from '@/types/repairPlan'
import {
  DEVIATION_KIND_COLOR,
  DEVIATION_KIND_LABEL,
  DEVIATION_KIND_OPTIONS,
  DEVIATION_STATUS_LABEL,
  createEmptyDeviationDraft,
  type Deviation,
  type DeviationDraft,
  type DeviationKind
} from '@/types/deviation'
import { PAPER_TYPE_LABEL, PAPER_TYPE_OPTIONS } from '@/types/paper'
import { REPAIR_NAME_LABEL, REPAIR_NAME_OPTIONS } from '@/types/repairOrder'
import { BINDING_TYPE_LABEL, VOLUME_STATE_LABEL } from '@/types/volume'
import { planStatusForVolume, ARCHIVE_BLOCK_LABEL, type CheckStatus } from '@/utils/planReconcile'

const auth = useAuthStore()
const bookStore = useBookStore()
const planStore = usePlanStore()
const { reconcileOf, gateOf, overview } = usePlanReconcile()

const FILTER_KEYS = ['status'] as const
const url = useFilterQuery(FILTER_KEYS)

const filterModel = computed<FilterModel>(() => ({
  keyword: url.keyword.value,
  status: url.values.value.status ?? []
}))

const filterSelects = [
  { key: 'status', label: '方案状态', options: VOLUME_PLAN_STATUS_OPTIONS.map((item) => ({ label: item.label, value: item.value })) }
]

function handleFilterChange(next: FilterModel): void {
  url.apply({
    kw: typeof next.keyword === 'string' ? next.keyword : '',
    status: (next.status as string[]) ?? []
  })
}

interface VolumeCard {
  volumeId: string
  bookTitle: string
  volumeNo: number
  bindingType: string
  stateText: string
  legacyReadOnly: boolean
  status: VolumePlanStatus
}

const cards = computed<VolumeCard[]>(() => {
  const keyword = url.keyword.value.trim()
  const statuses = url.values.value.status ?? []
  const list: VolumeCard[] = bookStore.books.flatMap((book) =>
    bookStore.volumesOfBook(book.id).map((volume) => {
      const status = planStatusForVolume(volume, planStore.plans)
      return {
        volumeId: volume.id,
        bookTitle: book.title,
        volumeNo: volume.volumeNo,
        bindingType: BINDING_TYPE_LABEL[volume.bindingType],
        stateText: VOLUME_STATE_LABEL[volume.state],
        legacyReadOnly: volume.legacyReadOnly === true,
        status
      }
    })
  )
  return list.filter((card) => {
    if (keyword.length > 0 && !`《${card.bookTitle}》第${card.volumeNo}册`.includes(keyword)) return false
    if (statuses.length > 0 && !statuses.includes(card.status)) return false
    return true
  })
})

const currentVolumeId = ref<string>('')

watch(
  cards,
  (list) => {
    if (list.length === 0) {
      currentVolumeId.value = ''
      return
    }
    if (!list.some((card) => card.volumeId === currentVolumeId.value)) currentVolumeId.value = list[0]!.volumeId
  },
  { immediate: true }
)

const currentCard = computed(() => cards.value.find((card) => card.volumeId === currentVolumeId.value) ?? null)
const historyPlans = computed<RepairPlan[]>(() =>
  currentVolumeId.value ? planStore.plansOfVolume(currentVolumeId.value) : []
)
const activePlan = computed<RepairPlan | null>(() =>
  currentVolumeId.value ? planStore.activePlanOf(currentVolumeId.value) : null
)
const draftPlan = computed<RepairPlan | null>(
  () => historyPlans.value.find((plan) => plan.state === 'draft') ?? null
)
const reconcile = computed(() => (currentVolumeId.value ? reconcileOf(currentVolumeId.value) : null))
const gate = computed(() => (currentVolumeId.value ? gateOf(currentVolumeId.value) : null))
const currentDeviations = computed<Deviation[]>(() =>
  currentVolumeId.value ? planStore.deviationsOfVolume(currentVolumeId.value) : []
)

watchEffect(() => {
  void url.keyword.value
  void url.values.value
})

/* ----------------------------- 方案表单（主管） ----------------------------- */
const planDialog = ref(false)
const planEditing = ref<RepairPlan | null>(null)
const planForm = reactive<RepairPlanDraft>(createEmptyPlanDraft('', auth.displayName))

watch(
  () => auth.displayName,
  (name) => {
    if (planForm.supervisor.length === 0 || planForm.supervisor === '周知白') planForm.supervisor = name
  }
)

function openCreatePlan(): void {
  if (!currentVolumeId.value) {
    ElMessage.warning('请先选择册次')
    return
  }
  if (!auth.isSupervisor) {
    ElMessage.warning('修复方案由修复室主管订立，请切换为主管身份')
    return
  }
  planEditing.value = null
  Object.assign(planForm, createEmptyPlanDraft(currentVolumeId.value, auth.displayName))
  planDialog.value = true
}

function openEditDraft(plan: RepairPlan): void {
  if (!auth.isSupervisor) {
    ElMessage.warning('只有主管能修改方案草稿')
    return
  }
  planEditing.value = plan
  Object.assign(planForm, {
    volumeId: plan.volumeId,
    targetPh: plan.targetPh,
    paperType: plan.paperType,
    steps: [...plan.steps],
    plannedFinishDate: plan.plannedFinishDate,
    remark: plan.remark,
    supervisor: plan.supervisor
  })
  planDialog.value = true
}

async function submitPlan(): Promise<void> {
  try {
    if (planEditing.value) {
      await planStore.updateDraft(planEditing.value.id, { ...planForm })
      ElMessage.success('已更新方案草稿')
    } else {
      await planStore.createPlan({ ...planForm })
      ElMessage.success('方案已立为草稿；定稿之后才算数')
    }
    planDialog.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败')
  }
}

async function submitAndConfirm(): Promise<void> {
  try {
    if (planEditing.value) {
      await planStore.updateDraft(planEditing.value.id, { ...planForm })
      await planStore.confirmPlan(planEditing.value.id)
    } else {
      await planStore.createPlan({ ...planForm }, true)
    }
    ElMessage.success('方案已定稿：主管与修复师都不能再改，要改只能作废重立')
    planDialog.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '定稿失败')
  }
}

async function confirmDraft(plan: RepairPlan): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `目标 pH ${plan.targetPh}、${PAPER_TYPE_LABEL[plan.paperType]}、${plan.steps.length} 道工序、预计 ${plan.plannedFinishDate} 完工。定稿后不可再改。`,
      '定稿修复方案',
      { type: 'warning', confirmButtonText: '确认定稿', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await planStore.confirmPlan(plan.id)
    ElMessage.success('方案已定稿，修复师可按方案实做')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '定稿失败')
  }
}

async function voidAndRecreate(plan: RepairPlan): Promise<void> {
  if (!auth.isSupervisor) {
    ElMessage.warning('只有主管能作废重立方案')
    return
  }
  let reason = ''
  try {
    const result = await ElMessageBox.prompt('定稿方案不能直接修改，请先写明作废原因，再据新版重立。', `作废第 ${plan.revision} 版方案`, {
      type: 'warning',
      confirmButtonText: '作废并重立',
      cancelButtonText: '取消',
      inputType: 'textarea',
      inputPlaceholder: '如：实际酸化比勘验时严重，需增加脱酸工序，目标 pH 调整……'
    })
    reason = result.value
  } catch {
    return
  }
  try {
    await planStore.voidPlan(plan.id, reason)
    planEditing.value = null
    Object.assign(planForm, {
      volumeId: plan.volumeId,
      targetPh: plan.targetPh,
      paperType: plan.paperType,
      steps: [...plan.steps],
      plannedFinishDate: plan.plannedFinishDate,
      remark: '',
      supervisor: auth.displayName
    })
    planDialog.value = true
    ElMessage.info(`第 ${plan.revision} 版已作废，可在对话框中订立第 ${plan.revision + 1} 版`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '作废失败')
  }
}

/* ----------------------------- 偏离登记（修复师） ----------------------------- */
const devDialog = ref(false)
const devForm = reactive<DeviationDraft>(createEmptyDeviationDraft('', '', auth.displayName))

function kindPlannedActual(kind: DeviationKind, plan: RepairPlan | null): { planned: string; actual: string } {
  if (!plan) return { planned: '', actual: '' }
  if (kind === 'ph') return { planned: `目标 pH ${plan.targetPh.toFixed(1)}`, actual: actualText('ph') }
  if (kind === 'paper') return { planned: PAPER_TYPE_LABEL[plan.paperType], actual: actualText('paper') }
  if (kind === 'step') return { planned: plan.steps.map((name) => REPAIR_NAME_LABEL[name]).join('、'), actual: actualText('step') }
  return { planned: `预计 ${plan.plannedFinishDate} 完工`, actual: actualText('schedule') }
}

function actualText(kind: DeviationKind): string {
  if (!reconcile.value) return ''
  const item = reconcile.value.items.find((entry) => entry.kind === kind)
  return item ? item.actualText : ''
}

function openRegisterDeviation(kind?: DeviationKind): void {
  if (!currentVolumeId.value) {
    ElMessage.warning('请先选择册次')
    return
  }
  if (!auth.isRestorer) {
    ElMessage.warning('偏离说明由修复师登记，请切换为修复师身份')
    return
  }
  if (!activePlan.value) {
    ElMessage.warning('该册还没有定稿方案，谈不上偏离')
    return
  }
  const presetKind: DeviationKind = kind ?? reconcile.value?.items.find((item) => item.status === 'held')?.kind ?? 'ph'
  Object.assign(devForm, createEmptyDeviationDraft(currentVolumeId.value, activePlan.value.id, auth.displayName, presetKind))
  applyKindPreset()
  devDialog.value = true
}

function applyKindPreset(): void {
  const preset = kindPlannedActual(devForm.kind, activePlan.value)
  devForm.planned = preset.planned
  if (!devForm.actual) devForm.actual = preset.actual
}

watch(() => devForm.kind, applyKindPreset)

async function submitDeviation(): Promise<void> {
  try {
    await planStore.registerDeviation({ ...devForm })
    ElMessage.success('偏离说明已登记，归档对账将据此放行')
    devDialog.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '登记失败')
  }
}

async function resolveDeviation(deviation: Deviation): Promise<void> {
  if (!auth.isSupervisor) {
    ElMessage.warning('处理结论由主管对账后填写')
    return
  }
  try {
    const result = await ElMessageBox.prompt('请填写主管对账后的处理结论（留空则退回待认定）。', '认定偏离说明', {
      confirmButtonText: '保存结论',
      cancelButtonText: '取消',
      inputValue: deviation.resolution,
      inputType: 'textarea',
      inputPlaceholder: '如：情况属实，属于湿度导致的合理顺延，同意按实做归档。'
    })
    await planStore.resolveDeviation(deviation.id, result.value)
    ElMessage.success('已保存认定结论')
  } catch {
    /* 取消 */
  }
}

async function removeDeviation(deviation: Deviation): Promise<void> {
  try {
    await ElMessageBox.confirm('将删除这条偏离说明；若对应出入仍在，对账会重新挂起。', '删除偏离说明', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  try {
    await planStore.removeDeviation(deviation.id)
    ElMessage.success('已删除')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '删除失败')
  }
}

/* ----------------------------- 展示辅助 ----------------------------- */
const CHECK_STATUS_META: Record<CheckStatus, { label: string; color: string }> = {
  match: { label: '对得上', color: '#1e8449' },
  covered: { label: '有偏离登记', color: '#a8623a' },
  held: { label: '挂起', color: '#b03a2e' }
}

function planStateColor(state: string): string {
  return PLAN_STATE_COLOR[state as keyof typeof PLAN_STATE_COLOR] ?? '#8c8c8c'
}

function planStateLabel(state: string): string {
  return PLAN_STATE_LABEL[state as keyof typeof PLAN_STATE_LABEL] ?? state
}

function kindColor(kind: string): string {
  return DEVIATION_KIND_COLOR[kind as DeviationKind] ?? '#6b6257'
}

function kindLabel(kind: string): string {
  return DEVIATION_KIND_LABEL[kind as DeviationKind] ?? kind
}

function stepLabel(name: string): string {
  return REPAIR_NAME_LABEL[name as keyof typeof REPAIR_NAME_LABEL] ?? name
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>修复方案与归档对账</h2>
        <p>主管按册先立方案，定稿后不可改、只能作废重立；修复师登记偏离说明，归档前逐项对账。</p>
      </div>
      <div class="gb-toolbar">
        <el-radio-group :model-value="auth.role" size="small" @update:model-value="(value: string | number | boolean) => auth.setRole(String(value) as 'supervisor' | 'restorer')">
          <el-radio-button value="supervisor">主管 · {{ auth.displayName }}</el-radio-button>
          <el-radio-button value="restorer">修复师 · {{ auth.displayName }}</el-radio-button>
        </el-radio-group>
      </div>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="在册册次" :value="overview.total" suffix="册" tone="primary" />
      <StatBadge label="已有方案" :value="overview.confirmed" suffix="册" tone="success" />
      <StatBadge label="挂起出入" :value="overview.heldItemCount" suffix="项" tone="danger" />
      <StatBadge label="偏离已覆盖" :value="overview.coveredItemCount" suffix="项" tone="warning" />
      <StatBadge label="暂不许归档" :value="overview.blocked" suffix="册" tone="danger" />
      <StatBadge label="旧档只读" :value="overview.legacyReadonly" suffix="册" tone="info" />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索书名 / 册次…"
      @change="handleFilterChange"
      @reset="url.reset()"
    />

    <el-empty v-if="cards.length === 0 && bookStore.books.length === 0" description="还没有古籍与册次，请先到古籍台账登记" />

    <el-row :gutter="16" style="margin-top: 16px">
      <!-- 左：册次清单 -->
      <el-col :xs="24" :xl="9">
        <el-card shadow="never" body-style="max-height: 70vh; overflow: auto">
          <template #header>
            <span>册次方案立账（{{ cards.length }}）</span>
          </template>
          <div
            v-for="card in cards"
            :key="card.volumeId"
            class="plan-volume"
            :class="{ 'is-active': card.volumeId === currentVolumeId }"
            @click="currentVolumeId = card.volumeId"
          >
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px">
              <strong>《{{ card.bookTitle }}》第 {{ card.volumeNo }} 册</strong>
              <PlanTag :status="card.status" size="small" />
            </div>
            <div class="gb-muted">{{ card.bindingType }} · {{ card.stateText }}</div>
          </div>
        </el-card>
      </el-col>

      <!-- 右：方案 / 对账 / 偏离 -->
      <el-col :xs="24" :xl="15">
        <EmptyPanel
          v-if="!currentCard"
          title="请选择左侧册次"
          description="选中一册后，可以立修复方案、登记偏离说明，并查看归档前逐项对账结果。"
          size="small"
        />

        <template v-else>
          <!-- 旧档只读 -->
          <el-alert
            v-if="currentCard.legacyReadOnly"
            type="info"
            show-icon
            :closable="false"
            style="margin-bottom: 12px"
            title="旧档只读：升级时按现有配纸与工序补不出历史方案"
            description="该册缺少补纸选配或工序记录，无法回填历史方案，按规则只读留着，不能再立方案或改动实做。"
          />

          <!-- 方案操作条 -->
          <el-card shadow="never" style="margin-bottom: 12px">
            <template #header>
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap">
                <span>修复方案（按册次）</span>
                <div class="gb-toolbar">
                  <el-button
                    v-if="!activePlan && !draftPlan && !currentCard.legacyReadOnly && auth.isSupervisor"
                    type="primary"
                    size="small"
                    :icon="DocumentAdd"
                    @click="openCreatePlan"
                  >
                    立方案
                  </el-button>
                  <el-button
                    v-if="draftPlan && auth.isSupervisor"
                    type="success"
                    size="small"
                    :icon="CircleCheck"
                    @click="confirmDraft(draftPlan)"
                  >
                    定稿
                  </el-button>
                </div>
              </div>
            </template>

            <EmptyPanel
              v-if="historyPlans.length === 0"
              :title="currentCard.legacyReadOnly ? '该旧档没有历史方案' : '该册还没立方案'"
              :description="
                currentCard.legacyReadOnly
                  ? '补纸与工序记录缺失，无法回填，整册只读留存。'
                  : auth.isSupervisor
                    ? '由主管写明目标 pH、打算用哪种补纸、走哪几道工序、预计哪天完工；定稿后才算数。'
                    : '当前是修复师身份：方案只能由修复室主管订立。'
              "
              size="small"
            />

            <el-timeline v-else>
              <el-timeline-item
                v-for="plan in historyPlans"
                :key="plan.id"
                :timestamp="plan.state === 'voided' ? `作废于 ${plan.voidedAt ? new Date(plan.voidedAt).toLocaleDateString('zh-CN') : ''}` : plan.state === 'confirmed' ? `定稿于 ${plan.confirmedAt ? new Date(plan.confirmedAt).toLocaleDateString('zh-CN') : ''}` : `起草于 ${new Date(plan.createdAt).toLocaleDateString('zh-CN')}`"
                placement="top"
              >
                <el-card shadow="never" :class="['plan-revision', { 'is-voided': plan.state === 'voided' }]">
                  <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap">
                    <div class="gb-toolbar">
                      <strong>第 {{ plan.revision }} 版方案</strong>
                      <el-tag
                        :style="{ color: planStateColor(plan.state), borderColor: `${planStateColor(plan.state)}66` }"
                        effect="plain"
                        round
                        size="small"
                      >
                        {{ planStateLabel(plan.state) }}
                      </el-tag>
                      <el-tag v-if="plan.historical" type="info" effect="plain" round size="small">历史回填·只读</el-tag>
                    </div>
                    <div v-if="!plan.historical && auth.isSupervisor" class="gb-toolbar">
                      <el-button v-if="plan.state === 'draft'" size="small" text :icon="Edit" @click="openEditDraft(plan)">编辑草稿</el-button>
                      <el-button v-if="plan.state === 'confirmed'" size="small" text type="warning" :icon="RefreshLeft" @click="voidAndRecreate(plan)">
                        作废重立
                      </el-button>
                    </div>
                  </div>

                  <el-descriptions :column="2" size="small" border style="margin-top: 8px">
                    <el-descriptions-item label="目标 pH">{{ plan.targetPh.toFixed(1) }}</el-descriptions-item>
                    <el-descriptions-item label="补纸纸种">{{ PAPER_TYPE_LABEL[plan.paperType] }}</el-descriptions-item>
                    <el-descriptions-item label="工序" :span="2">
                      <el-tag v-for="(name, index) in plan.steps" :key="name" size="small" effect="plain" round style="margin-right: 6px">
                        {{ index + 1 }}.{{ stepLabel(name) }}
                      </el-tag>
                    </el-descriptions-item>
                    <el-descriptions-item label="预计完工">{{ plan.plannedFinishDate }}</el-descriptions-item>
                    <el-descriptions-item label="主管">{{ plan.supervisor }}</el-descriptions-item>
                    <el-descriptions-item v-if="plan.remark" label="备注" :span="2">{{ plan.remark }}</el-descriptions-item>
                    <el-descriptions-item v-if="plan.voidReason" label="作废原因" :span="2">{{ plan.voidReason }}</el-descriptions-item>
                  </el-descriptions>
                </el-card>
              </el-timeline-item>
            </el-timeline>
          </el-card>

          <!-- 归档对账 -->
          <el-card shadow="never" style="margin-bottom: 12px">
            <template #header>
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px">
                <span>归档前逐项对账</span>
                <el-button
                  size="small"
                  type="danger"
                  plain
                  :icon="Edit"
                  :disabled="!auth.isRestorer || !activePlan"
                  @click="openRegisterDeviation()"
                >
                  修复师登记偏离
                </el-button>
              </div>
            </template>

            <el-alert
              v-if="!activePlan"
              type="warning"
              show-icon
              :closable="false"
              title="该册没有定稿方案，方案定了才算数；归档前必须先立方案"
              style="margin-bottom: 10px"
            />

            <el-table v-if="reconcile" :data="reconcile.items" size="small" border>
              <el-table-column prop="label" label="对账项" width="110" />
              <el-table-column label="方案" min-width="170">
                <template #default="{ row }"><span>{{ row.plannedText }}</span></template>
              </el-table-column>
              <el-table-column label="实做" min-width="200">
                <template #default="{ row }"><span>{{ row.actualText }}</span></template>
              </el-table-column>
              <el-table-column label="结论" width="130">
                <template #default="{ row }">
                  <el-tag
                    :style="{ color: CHECK_STATUS_META[row.status as CheckStatus].color, borderColor: `${CHECK_STATUS_META[row.status as CheckStatus].color}66` }"
                    effect="plain"
                    round
                    size="small"
                  >
                    {{ CHECK_STATUS_META[row.status as CheckStatus].label }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="110">
                <template #default="{ row }">
                  <el-button
                    v-if="row.status === 'held' && auth.isRestorer"
                    size="small"
                    text
                    type="danger"
                    @click="openRegisterDeviation(row.kind as DeviationKind)"
                  >
                    补偏离
                  </el-button>
                  <span v-else-if="row.status === 'held'" class="gb-muted">先挂起</span>
                  <span v-else class="gb-muted">—</span>
                </template>
              </el-table-column>
            </el-table>

            <el-alert
              v-if="gate && !gate.allowed"
              type="error"
              show-icon
              :closable="false"
              style="margin-top: 10px"
              title="归档未通过：存在挂起项，没登记偏离不许归档"
            >
              <div v-for="reason in gate.reasons" :key="reason">· {{ ARCHIVE_BLOCK_LABEL[reason] }}</div>
            </el-alert>
            <el-alert
              v-else-if="gate && gate.allowed && currentCard.stateText !== '已归档'"
              type="success"
              show-icon
              :closable="false"
              title="对账通过，可到「装订归档」页登记验收合格并归档"
            />
          </el-card>

          <!-- 偏离说明台账 -->
          <el-card shadow="never">
            <template #header>
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px">
                <span>偏离说明（{{ currentDeviations.length }}）</span>
                <el-button size="small" :disabled="!auth.isRestorer || !activePlan" @click="openRegisterDeviation()">
                  新增偏离
                </el-button>
              </div>
            </template>
            <EmptyPanel
              v-if="currentDeviations.length === 0"
              title="暂无偏离说明"
              description="实做与方案一致时无需登记；有出入时由修复师补一条偏离说明，否则归档对账一直挂起。"
              size="small"
            />
            <div v-else style="display: flex; flex-direction: column; gap: 10px">
              <div v-for="deviation in currentDeviations" :key="deviation.id" class="deviation-row">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap">
                  <div class="gb-toolbar">
                    <el-tag
                      :style="{ color: kindColor(deviation.kind), borderColor: `${kindColor(deviation.kind)}66` }"
                      effect="plain"
                      round
                      size="small"
                    >
                      {{ kindLabel(deviation.kind) }}
                    </el-tag>
                    <el-tag :type="deviation.status === 'resolved' ? 'success' : 'warning'" effect="plain" round size="small">
                      {{ DEVIATION_STATUS_LABEL[deviation.status] }}
                    </el-tag>
                    <span class="gb-muted">{{ deviation.date }} · {{ deviation.recorder }}</span>
                  </div>
                  <div v-if="auth.isSupervisor" class="gb-toolbar">
                    <el-button size="small" text type="primary" @click="resolveDeviation(deviation)">
                      {{ deviation.resolution ? '改认定' : '认定' }}
                    </el-button>
                    <el-button size="small" text type="danger" :icon="Remove" @click="removeDeviation(deviation)">删除</el-button>
                  </div>
                </div>
                <div style="margin-top: 6px">
                  <div><span class="gb-muted">方案：</span>{{ deviation.planned }}</div>
                  <div><span class="gb-muted">实做：</span>{{ deviation.actual }}</div>
                  <div><span class="gb-muted">说明：</span>{{ deviation.reason }}</div>
                  <div v-if="deviation.resolution"><span class="gb-muted">主管认定：</span>{{ deviation.resolution }}</div>
                </div>
              </div>
            </div>
          </el-card>
        </template>
      </el-col>
    </el-row>

    <!-- 方案对话框 -->
    <el-dialog
      v-model="planDialog"
      :title="planEditing ? `编辑第 ${planEditing.revision} 版草稿` : `立修复方案 · ${currentCard ? `《${currentCard.bookTitle}》第 ${currentCard.volumeNo} 册` : ''}`"
      width="620px"
    >
      <el-form label-width="110px">
        <el-form-item label="主管">
          <el-input v-model="planForm.supervisor" placeholder="立方案的修复室主管" />
        </el-form-item>
        <el-form-item label="目标 pH" required>
          <el-input-number v-model="planForm.targetPh" :min="4" :max="10" :step="0.1" :precision="1" />
          <span class="gb-muted" style="margin-left: 8px">脱酸后整册应达到的 pH</span>
        </el-form-item>
        <el-form-item label="补纸纸种" required>
          <el-select v-model="planForm.paperType" style="width: 100%">
            <el-option v-for="item in PAPER_TYPE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="工序" required>
          <el-select v-model="planForm.steps" multiple style="width: 100%" placeholder="选择走哪几道工序（按勾选先后排列）">
            <el-option v-for="item in REPAIR_NAME_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="预计完工日" required>
          <el-input v-model="planForm.plannedFinishDate" type="date" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="planForm.remark" type="textarea" :rows="2" placeholder="技法要点 / 材料批次 / 勘验补充" />
        </el-form-item>
      </el-form>
      <el-alert type="info" show-icon :closable="false" title="保存为草稿后仍可修改；一旦定稿，主管与修复师都不能改，要改只能作废重立。" />
      <template #footer>
        <el-button @click="planDialog = false">取消</el-button>
        <el-button @click="submitPlan">存草稿</el-button>
        <el-button type="primary" @click="submitAndConfirm">直接定稿</el-button>
      </template>
    </el-dialog>

    <!-- 偏离对话框 -->
    <el-dialog v-model="devDialog" title="登记偏离说明（修复师）" width="620px">
      <el-form label-width="100px">
        <el-form-item label="偏离类别" required>
          <el-select v-model="devForm.kind" style="width: 100%">
            <el-option v-for="item in DEVIATION_KIND_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="方案要求">
          <el-input v-model="devForm.planned" />
        </el-form-item>
        <el-form-item label="实做情况" required>
          <el-input v-model="devForm.actual" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="偏离原因" required>
          <el-input v-model="devForm.reason" type="textarea" :rows="3" placeholder="为什么与方案有出入" />
        </el-form-item>
        <el-form-item label="登记人">
          <el-input v-model="devForm.recorder" />
        </el-form-item>
        <el-form-item label="日期">
          <el-input v-model="devForm.date" type="date" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="devDialog = false">取消</el-button>
        <el-button type="primary" @click="submitDeviation">登记偏离</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.plan-volume {
  padding: 10px 12px;
  border: 1px solid rgba(58, 74, 107, 0.16);
  border-radius: 8px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.plan-volume:hover {
  border-color: rgba(58, 74, 107, 0.5);
}

.plan-volume.is-active {
  border-color: #3a4a6b;
  box-shadow: 0 0 0 2px rgba(58, 74, 107, 0.16);
  background: rgba(58, 74, 107, 0.04);
}

.plan-revision.is-voided {
  opacity: 0.72;
  background: repeating-linear-gradient(45deg, transparent 0 8px, rgba(140, 132, 121, 0.05) 8px 16px);
}

.deviation-row {
  padding: 10px 12px;
  border: 1px solid rgba(168, 98, 58, 0.28);
  border-left: 4px solid #a8623a;
  border-radius: 8px;
  background: var(--gb-paper-light);
  font-size: 13px;
}
</style>
