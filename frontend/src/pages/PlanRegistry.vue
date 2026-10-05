<script setup lang="ts">
/**
 * /plans 修复方案与偏离对账
 * 主管按册次立方案：目标 pH、补纸纸种、工序、预计完工日；草稿可改，定下即锁死，
 * 想改只能作废重立（旧案留痕）。修复师只读方案，实做有出入时在此登记偏离说明。
 * 归档前对账结果同时被装订归档页消费（canArchive 闸门）。
 * 消费 RepairPlan、Deviation、Volume、Leaf、Paper、RepairOrder、Binding。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  CircleCheck,
  DocumentCopy,
  Edit,
  List,
  Plus,
  RefreshLeft,
  Select,
  Warning
} from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import { useRepairStore } from '@/stores/repairStore'
import { usePlanStore, PlanRuleError } from '@/stores/planStore'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  PLAN_ORIGIN_LABEL,
  PLAN_STATUS_COLOR,
  PLAN_STATUS_LABEL,
  TARGET_PH_MAX,
  TARGET_PH_MIN,
  createEmptyPlanDraft,
  type RepairPlan,
  type RepairPlanDraft
} from '@/types/repairPlan'
import {
  DEVIATION_KIND_LABEL,
  type Deviation,
  type DeviationDraft
} from '@/types/deviation'
import { ROLE_LABEL, ROLE_OPTIONS, type Role } from '@/types/role'
import { BINDING_TYPE_LABEL, VOLUME_STATE_COLOR, VOLUME_STATE_LABEL } from '@/types/volume'
import { PAPER_TYPE_LABEL, PAPER_TYPE_OPTIONS, type Paper } from '@/types/paper'
import { REPAIR_NAME_LABEL, REPAIR_NAME_OPTIONS, type RepairName } from '@/types/repairOrder'
import type { Binding } from '@/types/binding'
import {
  RECONCILE_STATUS_COLOR,
  RECONCILE_STATUS_LABEL,
  reconcileVolume,
  type ReconcileItem,
  type ReconcileResult
} from '@/utils/reconcile'

const bookStore = useBookStore()
const leafStore = useLeafStore()
const repairStore = useRepairStore()
const planStore = usePlanStore()
const paperTable = useIdbTable<Paper>((database) => database.papers, { sortByUpdatedAt: false })
const bindingTable = useIdbTable<Binding>((database) => database.bindings, { sortByUpdatedAt: false })

/* ------------------------------ 角色切换 ------------------------------ */
function changeRole(role: Role): void {
  planStore.setRole(role)
  ElMessage.success(`已切换为${ROLE_LABEL[role]}视角`)
}

/* ------------------------------ 册次选择 ------------------------------ */
interface VolumeOption {
  id: string
  bookTitle: string
  volumeNo: number
  bindingType: string
  stateLabel: string
  stateColor: string
}

const volumeOptions = computed<VolumeOption[]>(() =>
  bookStore.books.flatMap((book) =>
    bookStore.volumesOfBook(book.id).map((volume) => ({
      id: volume.id,
      bookTitle: book.title,
      volumeNo: volume.volumeNo,
      bindingType: BINDING_TYPE_LABEL[volume.bindingType],
      stateLabel: VOLUME_STATE_LABEL[volume.state],
      stateColor: VOLUME_STATE_COLOR[volume.state]
    }))
  )
)

const selectedVolumeId = ref<string | null>(bookStore.currentVolumeId ?? volumeOptions.value[0]?.id ?? null)

function selectVolume(id: string): void {
  selectedVolumeId.value = id
  bookStore.setCurrentVolume(id)
}

const currentVolumeId = computed<string | null>(
  () => selectedVolumeId.value ?? volumeOptions.value[0]?.id ?? null
)

function volumeCaption(volumeId: string): string {
  const volume = bookStore.volumeById(volumeId)
  if (!volume) return '册次已删除'
  const book = bookStore.bookById(volume.bookId)
  return `${book ? `《${book.title}》` : ''}第 ${volume.volumeNo} 册 · ${BINDING_TYPE_LABEL[volume.bindingType]}`
}

/* ------------------------------ 对账派生 ------------------------------ */
const reconcileMap = computed<Record<string, ReconcileResult>>(() => {
  const result: Record<string, ReconcileResult> = {}
  volumeOptions.value.forEach((option) => {
    const leaves = leafStore.leavesOfVolume(option.id)
    const leafIds = new Set(leaves.map((leaf) => leaf.id))
    result[option.id] = reconcileVolume({
      volumeId: option.id,
      plans: planStore.plans,
      deviations: planStore.deviations,
      leaves,
      papers: paperTable.rows.value.filter((paper) => leafIds.has(paper.leafId)),
      orders: repairStore.orders.filter((order) => leafIds.has(order.leafId)),
      binding: bindingTable.rows.value.find((item) => item.volumeId === option.id)
    })
  })
  return result
})

const currentReconcile = computed<ReconcileResult | null>(
  () => (currentVolumeId.value ? reconcileMap.value[currentVolumeId.value] ?? null : null)
)

const currentPlans = computed<RepairPlan[]>(() =>
  currentVolumeId.value ? planStore.plansOfVolume(currentVolumeId.value) : []
)

const currentActivePlan = computed<RepairPlan | undefined>(() =>
  currentVolumeId.value ? planStore.activePlanOfVolume(currentVolumeId.value) : undefined
)

const currentDeviations = computed<Deviation[]>(() =>
  currentVolumeId.value ? planStore.deviationsOfVolume(currentVolumeId.value) : []
)

const stat = computed(() => {
  const total = volumeOptions.value.length
  const confirmed = volumeOptions.value.filter((option) => planStore.activePlanOfVolume(option.id)).length
  let blocked = 0
  let pendingItems = 0
  volumeOptions.value.forEach((option) => {
    const rec = reconcileMap.value[option.id]
    if (rec && !rec.canArchive) blocked += 1
    pendingItems += rec?.pendingCount ?? 0
  })
  return {
    total,
    confirmed,
    blocked,
    pendingItems,
    deviations: planStore.deviations.length
  }
})

/* ------------------------------ 方案表单 ------------------------------ */
type DialogMode = 'create' | 'edit' | 'reissue'

const planDialog = ref(false)
const dialogMode = ref<DialogMode>('create')
const reissueOldPlan = ref<RepairPlan | null>(null)
const planForm = reactive<RepairPlanDraft>(createEmptyPlanDraft(''))
const voidReason = ref('')
const stepOptions = REPAIR_NAME_OPTIONS.map((item) => ({ value: item.value, label: item.label }))

function resetForm(volumeId: string, plan?: RepairPlan): void {
  const draft = createEmptyPlanDraft(volumeId)
  Object.assign(planForm, draft)
  if (plan) {
    planForm.targetPh = plan.targetPh
    planForm.paperType = plan.paperType
    planForm.processSteps = [...plan.processSteps]
    planForm.expectedFinishDate = plan.expectedFinishDate
    planForm.supervisor = plan.supervisor
    planForm.remark = plan.remark
  }
  voidReason.value = ''
}

function openCreate(): void {
  if (!currentVolumeId.value) {
    ElMessage.warning('请先在古籍台账中建立册次')
    return
  }
  if (planStore.activePlanOfVolume(currentVolumeId.value)) {
    ElMessage.warning('该册已有生效方案，主管如需调整请用「作废重立」')
    return
  }
  dialogMode.value = 'create'
  reissueOldPlan.value = null
  resetForm(currentVolumeId.value)
  planDialog.value = true
}

function openEdit(plan: RepairPlan): void {
  dialogMode.value = 'edit'
  reissueOldPlan.value = plan
  resetForm(plan.volumeId, plan)
  planDialog.value = true
}

function openReissue(plan: RepairPlan): void {
  dialogMode.value = 'reissue'
  reissueOldPlan.value = plan
  resetForm(plan.volumeId, plan)
  planDialog.value = true
}

const dialogTitle = computed(() => {
  if (dialogMode.value === 'create') return '主管订立修复方案（草稿）'
  if (dialogMode.value === 'edit') return '编辑方案草稿'
  return '作废现方案并重立'
})

async function submitPlan(): Promise<void> {
  if (!currentVolumeId.value && !reissueOldPlan.value) return
  const draft: RepairPlanDraft = {
    ...planForm,
    volumeId: reissueOldPlan.value ? reissueOldPlan.value.volumeId : (currentVolumeId.value as string),
    processSteps: [...planForm.processSteps]
  }
  try {
    if (dialogMode.value === 'create') {
      await planStore.createDraft(draft)
      ElMessage.success('已立为草稿；草稿可改，确认后即定下锁死')
    } else if (dialogMode.value === 'edit' && reissueOldPlan.value) {
      await planStore.updateDraft(reissueOldPlan.value.id, draft)
      ElMessage.success('草稿已更新')
    } else if (dialogMode.value === 'reissue' && reissueOldPlan.value) {
      await planStore.voidAndReissue({
        oldPlanId: reissueOldPlan.value.id,
        reason: voidReason.value,
        nextDraft: draft,
        confirm: false
      })
      ElMessage.success('旧方案已作废留痕，新方案已立为草稿')
    }
    planDialog.value = false
  } catch (err) {
    ElMessage.error(err instanceof PlanRuleError ? err.message : '保存失败')
  }
}

async function confirmPlan(plan: RepairPlan): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '方案定下后主管与修复师都不能直接修改；如需调整只能作废重立。确认定下？',
      '确认定下方案',
      { type: 'warning', confirmButtonText: '定下', cancelButtonText: '再想想' }
    )
  } catch {
    return
  }
  try {
    await planStore.confirmPlan(plan.id)
    ElMessage.success('方案已定，作为实做与归档对账基准')
  } catch (err) {
    ElMessage.error(err instanceof PlanRuleError ? err.message : '确认失败')
  }
}

async function removeDraft(plan: RepairPlan): Promise<void> {
  try {
    await ElMessageBox.confirm('草稿删除后不可恢复（已定 / 已作废方案不可删，会留痕）。', '删除草稿', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  try {
    await planStore.removeDraft(plan.id)
    ElMessage.success('草稿已删除')
  } catch (err) {
    ElMessage.error(err instanceof PlanRuleError ? err.message : '删除失败')
  }
}

/* ------------------------------ 偏离登记 ------------------------------ */
const deviationDialog = ref(false)
const deviationEditing = ref<Deviation | null>(null)
const deviationItem = ref<ReconcileItem | null>(null)
const deviationForm = reactive<{ reason: string; operator: string }>({ reason: '', operator: '' })

function openRegisterDeviation(item: ReconcileItem): void {
  if (!currentActivePlan.value || !currentVolumeId.value) return
  deviationEditing.value = null
  deviationItem.value = item
  deviationForm.reason = ''
  deviationForm.operator = ''
  deviationDialog.value = true
}

function openEditDeviation(deviation: Deviation): void {
  deviationEditing.value = deviation
  deviationItem.value = null
  deviationForm.reason = deviation.reason
  deviationForm.operator = deviation.operator
  deviationDialog.value = true
}

async function submitDeviation(): Promise<void> {
  try {
    if (deviationEditing.value) {
      await planStore.updateDeviation(deviationEditing.value.id, {
        reason: deviationForm.reason,
        operator: deviationForm.operator
      })
      ElMessage.success('偏离说明已更新')
    } else if (deviationItem.value && currentActivePlan.value && currentVolumeId.value) {
      const draft: DeviationDraft = {
        volumeId: currentVolumeId.value,
        planId: currentActivePlan.value.id,
        kind: deviationItem.value.kind,
        relatedStep: deviationItem.value.relatedStep,
        plannedValue: deviationItem.value.planned,
        actualValue: deviationItem.value.actual,
        reason: deviationForm.reason,
        operator: deviationForm.operator
      }
      await planStore.registerDeviation(draft)
      ElMessage.success('偏离说明已登记并挂账，该项可参与归档对账')
    }
    deviationDialog.value = false
  } catch (err) {
    ElMessage.error(err instanceof PlanRuleError ? err.message : '登记失败')
  }
}

async function removeDeviation(deviation: Deviation): Promise<void> {
  try {
    await ElMessageBox.confirm('删除后该不符项将重新挂起，可能导致无法归档。', '删除偏离说明', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  try {
    await planStore.removeDeviation(deviation.id)
    ElMessage.success('已删除')
  } catch (err) {
    ElMessage.error(err instanceof PlanRuleError ? err.message : '删除失败')
  }
}

function findDeviationOfItem(item: ReconcileItem): Deviation | undefined {
  if (!currentActivePlan.value) return undefined
  return planStore.deviations.find(
    (deviation) =>
      deviation.planId === currentActivePlan.value?.id &&
      deviation.kind === item.kind &&
      (item.kind !== 'process' || deviation.relatedStep === item.relatedStep)
  )
}

/* ------------------------------ 展示辅助 ------------------------------ */
function statusColor(status: ReconcileItem['status']): string {
  return RECONCILE_STATUS_COLOR[status]
}

function statusLabel(status: ReconcileItem['status']): string {
  return RECONCILE_STATUS_LABEL[status]
}

function planStatusColor(plan: RepairPlan): string {
  return PLAN_STATUS_COLOR[plan.status]
}

function planStatusLabel(plan: RepairPlan): string {
  return PLAN_STATUS_LABEL[plan.status]
}

function stepText(steps: RepairName[]): string {
  return steps.map((step) => REPAIR_NAME_LABEL[step]).join(' → ')
}

function deviationKindLabel(kind: Deviation['kind']): string {
  return DEVIATION_KIND_LABEL[kind]
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>修复方案与偏离对账</h2>
        <p>修一册前主管先立方案：目标 pH · 补纸 · 工序 · 预计完工日；定下即锁，改动须作废重立。</p>
      </div>
      <el-radio-group :model-value="planStore.role" @update:model-value="changeRole">
        <el-radio-button v-for="option in ROLE_OPTIONS" :key="option.value" :value="option.value">
          {{ ROLE_LABEL[option.value] }}
        </el-radio-button>
      </el-radio-group>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="在册册次" :value="stat.total" suffix="册" tone="primary" :icon="'Files'" />
      <StatBadge label="已有生效方案" :value="stat.confirmed" suffix="册" tone="success" :icon="'TrendCharts'" />
      <StatBadge label="对账受阻册次" :value="stat.blocked" suffix="册" tone="danger" :icon="'WarningFilled'" />
      <StatBadge label="挂起待说明项" :value="stat.pendingItems" suffix="项" tone="warning" :icon="'Histogram'" />
      <StatBadge label="已登记偏离" :value="stat.deviations" suffix="条" tone="info" :icon="'PieChart'" />
    </div>

    <EmptyPanel
      v-if="volumeOptions.length === 0"
      title="还没有册次"
      description="请先在古籍台账中建立古籍与册次，再由主管按册订立修复方案。"
    />

    <el-row v-else :gutter="16">
      <!-- 左：册次清单 -->
      <el-col :xs="24" :md="9" :xl="7">
        <el-card shadow="never" class="plan-volume-card">
          <template #header>
            <span>册次方案一览</span>
          </template>
          <ul class="plan-volume-list">
            <li
              v-for="option in volumeOptions"
              :key="option.id"
              class="plan-volume-item"
              :class="{ 'is-active': option.id === currentVolumeId }"
              @click="selectVolume(option.id)"
            >
              <div class="plan-volume-item__main">
                <p class="plan-volume-item__title">
                  《{{ option.bookTitle }}》第 {{ option.volumeNo }} 册
                </p>
                <p class="plan-volume-item__sub">
                  {{ option.bindingType }}
                  <span :style="{ color: option.stateColor }">· {{ option.stateLabel }}</span>
                </p>
              </div>
              <el-tag
                v-if="planStore.activePlanOfVolume(option.id)"
                size="small"
                :type="reconcileMap[option.id]?.canArchive ? 'success' : 'danger'"
                effect="plain"
                round
              >
                {{ reconcileMap[option.id]?.canArchive ? '对账通过' : `${reconcileMap[option.id]?.pendingCount} 项挂起` }}
              </el-tag>
              <el-tag v-else size="small" type="info" effect="plain" round>无生效方案</el-tag>
            </li>
          </ul>
        </el-card>
      </el-col>

      <!-- 右：当前册详情 -->
      <el-col :xs="24" :md="15" :xl="17" v-if="currentVolumeId">
        <el-card shadow="never">
          <template #header>
            <div class="plan-detail-head">
              <div>
                <span class="plan-detail-head__title">{{ volumeCaption(currentVolumeId) }}</span>
                <span class="gb-muted" style="margin-left: 10px">
                  {{ currentActivePlan ? `当前生效 · 第 ${currentActivePlan.version} 版` : '尚无生效方案' }}
                </span>
              </div>
              <el-button
                v-if="planStore.canManage"
                type="primary"
                size="small"
                :icon="Plus"
                @click="openCreate"
              >
                立方案
              </el-button>
            </div>
          </template>

          <!-- 当前生效 / 最新草稿方案 -->
          <template v-if="currentActivePlan">
            <div class="plan-active">
              <div class="plan-active__head">
                <el-tag :style="{ color: planStatusColor(currentActivePlan), borderColor: `${planStatusColor(currentActivePlan)}66` }" effect="plain" round>
                  {{ planStatusLabel(currentActivePlan) }} · v{{ currentActivePlan.version }}
                </el-tag>
                <el-tag v-if="currentActivePlan.origin === 'historical'" size="small" type="warning" effect="plain" round>
                  {{ PLAN_ORIGIN_LABEL.historical }} · 只读
                </el-tag>
                <span class="gb-muted">订立人 {{ currentActivePlan.supervisor || '旧数据未留名' }}</span>
                <span v-if="planStore.canManage" class="plan-active__actions">
                  <el-button text size="small" type="danger" :icon="RefreshLeft" @click="openReissue(currentActivePlan)">
                    作废重立
                  </el-button>
                </span>
              </div>
              <el-descriptions :column="2" size="small" border style="margin-top: 10px">
                <el-descriptions-item label="目标 pH">{{ currentActivePlan.targetPh }}</el-descriptions-item>
                <el-descriptions-item label="补纸纸种">{{ PAPER_TYPE_LABEL[currentActivePlan.paperType] }}</el-descriptions-item>
                <el-descriptions-item label="工序" :span="2">{{ stepText(currentActivePlan.processSteps) || '（历史数据缺失）' }}</el-descriptions-item>
                <el-descriptions-item label="预计完工日">{{ currentActivePlan.expectedFinishDate || '（历史数据缺失）' }}</el-descriptions-item>
                <el-descriptions-item label="备注">{{ currentActivePlan.remark || '—' }}</el-descriptions-item>
              </el-descriptions>
              <el-alert
                v-if="currentActivePlan.origin === 'historical'"
                style="margin-top: 10px"
                type="warning"
                show-icon
                :closable="false"
                title="这是升级时按现有配纸与工序回填的历史方案，只读留痕；缺失项须人工核对，相关不符要登记偏离才能归档。"
              />
            </div>
          </template>
          <EmptyPanel
            v-else
            title="该册还没有生效方案"
            description="方案定下才算数；修复师须照已定方案施工。"
            :action-text="planStore.canManage ? '立方案' : ''"
            size="small"
            @action="openCreate"
          />

          <!-- 版本沿革 -->
          <div v-if="currentPlans.length > 0" class="plan-history">
            <p class="plan-section-title"><el-icon><DocumentCopy /></el-icon> 方案版本沿革（旧案留痕，不可改）</p>
            <el-timeline>
              <el-timeline-item
                v-for="plan in currentPlans"
                :key="plan.id"
                :timestamp="plan.status === 'voided' ? '已作废' : plan.status === 'confirmed' ? '已定' : '草稿'"
                :type="plan.status === 'confirmed' ? 'success' : plan.status === 'voided' ? 'danger' : 'info'"
                placement="top"
              >
                <div class="plan-history-item">
                  <strong>v{{ plan.version }} · {{ planStatusLabel(plan) }}</strong>
                  <el-tag v-if="plan.origin === 'historical'" size="small" type="warning" effect="plain" style="margin-left: 6px">
                    历史回填
                  </el-tag>
                  <p class="gb-muted" style="margin: 4px 0">
                    pH {{ plan.targetPh }} · {{ PAPER_TYPE_LABEL[plan.paperType] }} ·
                    {{ stepText(plan.processSteps) || '工序缺失' }} · 完工 {{ plan.expectedFinishDate || '缺失' }}
                  </p>
                  <p v-if="plan.voidReason" class="plan-history-item__reason">废案原因：{{ plan.voidReason }}</p>
                  <p v-if="plan.status === 'draft' && planStore.canManage" class="plan-history-item__actions">
                    <el-button text size="small" type="primary" :icon="Edit" @click="openEdit(plan)">编辑草稿</el-button>
                    <el-button text size="small" type="success" :icon="Select" @click="confirmPlan(plan)">定下</el-button>
                    <el-button text size="small" type="danger" @click="removeDraft(plan)">删除草稿</el-button>
                  </p>
                </div>
              </el-timeline-item>
            </el-timeline>
          </div>
        </el-card>

        <!-- 归档前对账 -->
        <el-card v-if="currentReconcile" shadow="never" style="margin-top: 16px">
          <template #header>
            <div class="plan-detail-head">
              <span><el-icon><List /></el-icon> 归档前逐项对账（方案 ↔ 实做）</span>
              <el-tag :type="currentReconcile.canArchive ? 'success' : 'danger'" effect="dark" round>
                {{ currentReconcile.canArchive ? '对账通过，可归档' : `${currentReconcile.pendingCount} 项挂起，不许归档` }}
              </el-tag>
            </div>
          </template>

          <el-table :data="currentReconcile.items" size="small" border>
            <el-table-column prop="label" label="对账项" min-width="130" />
            <el-table-column prop="planned" label="方案原定" min-width="180" />
            <el-table-column prop="actual" label="实做记录" min-width="180" />
            <el-table-column label="结论" width="120">
              <template #default="{ row }">
                <el-tag :style="{ color: statusColor(row.status), borderColor: `${statusColor(row.status)}66` }" effect="plain" round size="small">
                  {{ statusLabel(row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="偏离 / 操作" min-width="180">
              <template #default="{ row }">
                <div v-if="row.status === 'documented'" class="plan-deviation-link">
                  <el-icon style="color: #1e8449"><CircleCheck /></el-icon>
                  <span>已挂账：{{ findDeviationOfItem(row)?.reason }}</span>
                </div>
                <el-button
                  v-else-if="row.status === 'pending' && planStore.canRegister"
                  size="small"
                  type="warning"
                  plain
                  :icon="Warning"
                  @click="openRegisterDeviation(row)"
                >
                  补偏离说明
                </el-button>
                <span v-else-if="row.status === 'pending'" class="gb-muted">待修复师补偏离说明</span>
                <span v-else class="gb-muted">—</span>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <!-- 偏离说明登记台账 -->
        <el-card shadow="never" style="margin-top: 16px">
          <template #header>
            <span>本册偏离说明（修复师登记，主管照单核对）</span>
          </template>
          <EmptyPanel
            v-if="currentDeviations.length === 0"
            title="暂无偏离说明"
            description="实做与方案一致即无需登记；一旦有出入，必须补一条偏离说明才能归档。"
            size="small"
          />
          <el-table v-else :data="currentDeviations" size="small" border>
            <el-table-column label="维度" width="100">
              <template #default="{ row }">{{ deviationKindLabel(row.kind) }}</template>
            </el-table-column>
            <el-table-column prop="plannedValue" label="原定" min-width="150" />
            <el-table-column prop="actualValue" label="实做" min-width="150" />
            <el-table-column prop="reason" label="偏离原因" min-width="220" />
            <el-table-column prop="operator" label="登记人" width="90" />
            <el-table-column label="操作" width="140">
              <template #default="{ row }">
                <el-button
                  v-if="planStore.canRegister"
                  text
                  size="small"
                  :icon="Edit"
                  @click="openEditDeviation(row)"
                >
                  改说明
                </el-button>
                <el-button
                  v-if="planStore.canRegister"
                  text
                  size="small"
                  type="danger"
                  @click="removeDeviation(row)"
                >
                  删除
                </el-button>
                <el-tag v-else size="small" type="success" effect="plain">已挂账</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <!-- 方案表单对话框 -->
    <el-dialog v-model="planDialog" :title="dialogTitle" width="620px">
      <el-form label-width="110px">
        <el-form-item label="册次">
          <el-input :model-value="volumeCaption(reissueOldPlan?.volumeId ?? currentVolumeId ?? '')" disabled />
        </el-form-item>
        <el-form-item label="目标 pH" required>
          <el-input-number v-model="planForm.targetPh" :min="0" :max="14" :step="0.1" :precision="2" />
          <span class="gb-muted" style="margin-left: 10px">
            建议区间 {{ TARGET_PH_MIN }}–{{ TARGET_PH_MAX }}
          </span>
        </el-form-item>
        <el-form-item label="补纸纸种" required>
          <el-select v-model="planForm.paperType" style="width: 220px">
            <el-option v-for="option in PAPER_TYPE_OPTIONS" :key="option.value" :value="option.value" :label="option.label" />
          </el-select>
        </el-form-item>
        <el-form-item label="工序" required>
          <el-select v-model="planForm.processSteps" multiple :style="{ width: '100%' }" placeholder="选择计划走的工序">
            <el-option v-for="option in stepOptions" :key="option.value" :value="option.value" :label="option.label" />
          </el-select>
        </el-form-item>
        <el-form-item label="预计完工日" required>
          <el-input v-model="planForm.expectedFinishDate" type="date" />
        </el-form-item>
        <el-form-item label="订立人" required>
          <el-input v-model="planForm.supervisor" placeholder="修复室主管姓名，如：韩墨" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="planForm.remark" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item v-if="dialogMode === 'reissue'" label="废案原因" required>
          <el-input v-model="voidReason" type="textarea" :rows="2" placeholder="主管想改已定方案，必须写明为什么作废重立" />
        </el-form-item>
      </el-form>
      <el-alert
        v-if="dialogMode === 'reissue'"
        type="warning"
        show-icon
        :closable="false"
        title="现方案将置为「已作废」并永久留痕，新版本立为草稿，确认定下后才生效。"
      />
      <template #footer>
        <el-button @click="planDialog = false">取消</el-button>
        <el-button type="primary" @click="submitPlan">
          {{ dialogMode === 'reissue' ? '作废并立草稿' : '存为草稿' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 偏离说明对话框 -->
    <el-dialog
      v-model="deviationDialog"
      :title="deviationEditing ? '补改偏离说明' : '登记偏离说明'"
      width="560px"
    >
      <el-descriptions v-if="deviationItem" :column="1" size="small" border style="margin-bottom: 12px">
        <el-descriptions-item label="对账项">{{ deviationItem.label }}</el-descriptions-item>
        <el-descriptions-item label="方案原定">{{ deviationItem.planned }}</el-descriptions-item>
        <el-descriptions-item label="实做记录">{{ deviationItem.actual }}</el-descriptions-item>
      </el-descriptions>
      <el-form label-width="90px">
        <el-form-item label="偏离原因" required>
          <el-input v-model="deviationForm.reason" type="textarea" :rows="3" placeholder="说明实做为什么与方案有出入" />
        </el-form-item>
        <el-form-item label="登记人" required>
          <el-input v-model="deviationForm.operator" placeholder="修复师姓名，如：沈玉" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="deviationDialog = false">取消</el-button>
        <el-button type="primary" @click="submitDeviation">登记并挂账</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.plan-volume-card {
  position: sticky;
  top: 12px;
}

.plan-volume-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.plan-volume-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid #ece5d8;
  border-radius: 8px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.plan-volume-item:hover {
  border-color: #b9a988;
}

.plan-volume-item.is-active {
  border-color: #3a4a6b;
  background: #f4f1ea;
  box-shadow: inset 3px 0 0 #3a4a6b;
}

.plan-volume-item__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #2f2a24;
}

.plan-volume-item__sub {
  margin: 2px 0 0;
  font-size: 12px;
  color: #8c8479;
}

.plan-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.plan-detail-head__title {
  font-weight: 600;
}

.plan-active__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.plan-active__actions {
  margin-left: auto;
}

.plan-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 18px 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: #3a4a6b;
}

.plan-history-item__reason {
  margin: 4px 0;
  font-size: 12px;
  color: #b03a2e;
}

.plan-history-item__actions {
  margin: 2px 0 0;
}

.plan-deviation-link {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  font-size: 12px;
  color: #4a443b;
}
</style>
