/**
 * 角色（Role）数据模型
 * 修复室中与修复方案相关的两类身份：
 * - supervisor 修复室主管：按册次订立 / 作废 / 重立修复方案，本人不能改动已定方案
 * - restorer 修复师：只能查看方案并登记实做与偏离说明，动不了方案本身
 * 纯前端本地工具：角色只作操作权限区分，不做账号登录。
 */

/** 角色：修复室主管 / 修复师 */
export type Role = 'supervisor' | 'restorer';

export const ROLE_LABEL: Record<Role, string> = {
  supervisor: '修复室主管',
  restorer: '修复师',
};

export const ROLE_OPTIONS: ReadonlyArray<{ value: Role; label: string }> = [
  { value: 'supervisor', label: '修复室主管（订立 / 作废方案）' },
  { value: 'restorer', label: '修复师（实做 / 偏离登记）' },
];

/** 主管可订立、作废、重立方案；修复师只读方案 */
export function canManagePlan(role: Role): boolean {
  return role === 'supervisor';
}

/** 偏离说明由实做一方（修复师）登记；主管只负责对账，不代填偏离 */
export function canRegisterDeviation(role: Role): boolean {
  return role === 'restorer';
}
