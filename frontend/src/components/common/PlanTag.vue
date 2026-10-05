<script setup lang="ts">
/**
 * <PlanTag> 修复方案立账状态徽标
 * 未立 / 草稿 / 已定稿 / 已作废 / 旧档只读 五态；
 * 被方案页、古籍台账、书叶页、工序页、归档页消费。
 */
import { computed } from 'vue'
import { PLAN_STATE_COLOR, VOLUME_PLAN_STATUS_LABEL } from '@/types/repairPlan'
import type { VolumePlanStatus } from '@/types/repairPlan'

const props = withDefaults(
  defineProps<{
    /** 册次维度的立账状态 */
    status: VolumePlanStatus
    size?: 'default' | 'small'
  }>(),
  { size: 'default' }
)

const colorMap: Record<VolumePlanStatus, string> = {
  none: '#8c8c8c',
  draft: PLAN_STATE_COLOR.draft,
  confirmed: PLAN_STATE_COLOR.confirmed,
  voided: PLAN_STATE_COLOR.voided,
  legacy: '#6b6257'
}

const color = computed(() => colorMap[props.status])
const label = computed(() => VOLUME_PLAN_STATUS_LABEL[props.status])
</script>

<template>
  <el-tag
    :size="size === 'small' ? 'small' : 'default'"
    :style="{ color, borderColor: `${color}66`, background: `${color}14` }"
    effect="plain"
    round
  >
    {{ label }}
  </el-tag>
</template>
