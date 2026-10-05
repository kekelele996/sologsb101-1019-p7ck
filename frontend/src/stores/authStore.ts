/**
 * 角色 store（Pinia setup store）
 * 纯前端应用没有登录服务，用 localStorage 模拟当前身份：
 * - 修复室主管：立 / 改草稿 / 定稿 / 作废重立方案，对账认定偏离；
 * - 修复师：动不了方案，只能登记实做偏离说明。
 * 两边互相牵制，谁都越不过对方那一栏。
 */
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

export type UserRole = 'supervisor' | 'restorer'

/** 角色对应的演示署名（表单带出） */
export const ROLE_NAME: Record<UserRole, string> = {
  supervisor: '周知白',
  restorer: '沈玉'
}

export const ROLE_LABEL: Record<UserRole, string> = {
  supervisor: '修复室主管',
  restorer: '修复师'
}

const ROLE_KEY = 'gbbookrestore:role'

function readRole(): UserRole {
  try {
    return localStorage.getItem(ROLE_KEY) === 'restorer' ? 'restorer' : 'supervisor'
  } catch {
    return 'supervisor'
  }
}

export const useAuthStore = defineStore('auth', () => {
  const role = ref<UserRole>(readRole())
  const displayName = computed(() => ROLE_NAME[role.value])

  watch(role, (value) => {
    try {
      localStorage.setItem(ROLE_KEY, value)
    } catch {
      /* 隐私模式下忽略 */
    }
  })

  function setRole(next: UserRole): void {
    role.value = next
  }

  const isSupervisor = computed(() => role.value === 'supervisor')
  const isRestorer = computed(() => role.value === 'restorer')

  return { role, displayName, isSupervisor, isRestorer, setRole }
})
