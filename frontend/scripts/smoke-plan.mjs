/**
 * 节点侧冒烟测试：v2 旧库 → v3 升级回填、方案状态机、对账挂起 / 偏离放行、归档闸门。
 * 运行：node --experimental-strip-types scripts/smoke-plan.mts（经 esbuild 打包后执行，见 package 无依赖改法）
 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'

// ---- 1. 造一个 v2 结构的旧库（含两种册：可回填 / 补不上）----
const oldDb = new Dexie('gbbookrestore')
oldDb.version(2).stores({
  books: 'id, title, era, level, collectionNo, updatedAt',
  volumes: 'id, bookId, volumeNo, bindingType, state, updatedAt',
  leaves: 'id, volumeId, leafNo, damageType, phValue, state, updatedAt',
  papers: 'id, leafId, paperType, laidPattern, deltaE, updatedAt',
  repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
  bindings: 'id, volumeId, method, verdict, finishDate, updatedAt'
})
await oldDb.open()
const now = Date.now()
await oldDb.table('books').put({
  id: 'b1', title: '旧书', edition: '旧刻', era: '明', volumeCount: 2, collectionNo: 'X', level: 'normal',
  createdAt: now, updatedAt: now
})
// volA：有补纸 + 工序（可回填）
await oldDb.table('volumes').put({ id: 'volA', bookId: 'b1', volumeNo: 1, leafCount: 2, bindingType: 'thread', state: 'archived', createdAt: now, updatedAt: now })
// volB：有书叶但无补纸无工序（补不上 → 只读）
await oldDb.table('volumes').put({ id: 'volB', bookId: 'b1', volumeNo: 2, leafCount: 1, bindingType: 'thread', state: 'pending', createdAt: now, updatedAt: now })
await oldDb.table('leaves').bulkPut([
  { id: 'lA1', volumeId: 'volA', leafNo: 1, damageType: 'acid', damageAreaCm2: 5, phValue: 6.6, state: 'repaired', createdAt: now, updatedAt: now },
  { id: 'lB1', volumeId: 'volB', leafNo: 1, damageType: 'worm', damageAreaCm2: 3, phValue: 6.8, state: 'pending', createdAt: now, updatedAt: now }
])
await oldDb.table('papers').put({
  id: 'pA1', leafId: 'lA1', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.07, deltaE: 1.2,
  dyeRecipe: 'r', createdAt: now, updatedAt: now
})
await oldDb.table('repairOrders').bulkPut([
  { id: 'oA1', leafId: 'lA1', seq: 1, name: 'mend', material: 'm', operator: '沈玉', date: '2026-02-01', state: 'done', createdAt: now, updatedAt: now },
  { id: 'oA2', leafId: 'lA1', seq: 2, name: 'press', material: 'p', operator: '沈玉', date: '2026-02-02', state: 'done', createdAt: now, updatedAt: now }
])
await oldDb.table('bindings').put({
  id: 'bdA', volumeId: 'volA', method: '六眼线装', finishDate: '2026-02-02', verdict: 'pass', inspector: '程砚', createdAt: now, updatedAt: now
})
oldDb.close()

// ---- 2. 用当前版本的 db 模块重新打开，触发 v2→v3 升级 ----
const { db } = await import('../src/utils/db.ts')
await db.open()
const plansV3 = await db.repairPlans.toArray()
const volumesV3 = await db.table('volumes').toArray()

function assert(cond, msg) {
  if (!cond) {
    console.error('✗', msg)
    process.exitCode = 1
  } else {
    console.log('✓', msg)
  }
}

const planA = plansV3.find((p) => p.volumeId === 'volA')
assert(planA, 'volA 回填了历史方案')
assert(planA?.historical === true && planA?.state === 'confirmed', '历史方案标记 historical + confirmed')
assert(planA?.paperType === 'bark', '历史方案纸种按现有配纸回填为皮纸')
assert(JSON.stringify(planA?.steps) === JSON.stringify(['mend', 'press']), '历史方案工序按现有工序回填 [mend,press]')
assert(planA?.targetPh === 6.6, '历史方案目标 pH 按实做平均回填 6.6')
assert(planA?.plannedFinishDate === '2026-02-02', '历史方案预计完工日取装订完工日')

const volB = volumesV3.find((v) => v.id === 'volB')
assert(volB?.legacyReadOnly === true, 'volB 补不上历史方案 → legacyReadOnly 只读')
assert(!plansV3.some((p) => p.volumeId === 'volB'), 'volB 没有回填任何方案')

// ---- 3. 对账纯逻辑：新册方案与实做不一致 → held；登记偏离 → covered；归档闸门 ----
const { reconcilePlan, archiveGate } = await import('../src/utils/planReconcile.ts')

const planX = {
  id: 'planX', volumeId: 'volX', revision: 1, targetPh: 7.0, paperType: 'xuan',
  steps: ['mend', 'mount', 'press'], plannedFinishDate: '2026-03-01', remark: '',
  state: 'confirmed', supervisor: '主管', historical: false, confirmedAt: now, voidedAt: null, voidReason: '',
  createdAt: now, updatedAt: now
}
const actual = {
  leaves: [{ id: 'lx', volumeId: 'volX', leafNo: 1, damageType: 'worm', damageAreaCm2: 2, phValue: 5.2, state: 'repaired' }],
  papers: [{ id: 'px', leafId: 'lx', paperType: 'bamboo', laidPattern: 'x', thicknessMm: 0.06, deltaE: 1, dyeRecipe: 'r' }],
  orders: [
    { id: 'ox1', leafId: 'lx', seq: 1, name: 'mend', material: '', operator: '', date: '2026-03-01', state: 'done' },
    { id: 'ox2', leafId: 'lx', seq: 2, name: 'mount', material: '', operator: '', date: '2026-03-02', state: 'done' }
  ],
  binding: undefined
}

const before = reconcilePlan('volX', [planX], [], actual)
assert(before.heldCount === 4, `四项全对不上且无偏离 → 4 项挂起（实得 ${before.heldCount}）`)
const gateBefore = archiveGate({ state: 'repairing' }, before)
assert(!gateBefore.allowed && gateBefore.reasons.includes('held'), '有挂起项不许归档')

const deviations = ['ph', 'paper', 'step', 'schedule'].map((kind) => ({
  id: `d-${kind}`, volumeId: 'volX', planId: 'planX', kind, planned: 'p', actual: 'a', reason: 'r',
  recorder: '修复师', resolution: '', status: 'open', date: '2026-03-02', createdAt: now, updatedAt: now
}))
const after = reconcilePlan('volX', [planX], deviations, actual)
assert(after.heldCount === 0 && after.coveredCount === 4, `四类偏离都登记后 → 0 挂起 4 覆盖（实得 held=${after.heldCount} covered=${after.coveredCount}）`)
assert(after.inProgress === false, '已排工序全部完成 → 不在修（少做的 press 走工序挂起，不算在修）')

// 还有工序没做完 → in-progress 拦截
const actualDoing = {
  ...actual,
  orders: [
    ...actual.orders,
    { id: 'ox3', leafId: 'lx', seq: 3, name: 'press', material: '', operator: '', date: '2026-03-01', state: 'doing' }
  ]
}
assert(reconcilePlan('volX', [planX], deviations, actualDoing).inProgress === true, 'press 进行中 → 判定为在修')

// 工序补齐后闸门放行
const actualDone = {
  ...actual,
  orders: [
    ...actual.orders,
    { id: 'ox3', leafId: 'lx', seq: 3, name: 'press', material: '', operator: '', date: '2026-03-01', state: 'done' }
  ]
}
const finalCheck = reconcilePlan('volX', [planX], deviations, actualDone)
const gateFinal = archiveGate({ state: 'repairing' }, finalCheck)
assert(gateFinal.allowed, '工序齐 + 挂起项都有偏离登记 → 允许归档')

// 无方案 / 草稿 / 已作废 一律拦截
assert(!archiveGate({ state: 'repairing' }, reconcilePlan('volY', [], [], actual)).allowed, '无方案不许归档')
assert(
  !archiveGate({ state: 'repairing' }, reconcilePlan('volY', [{ ...planX, volumeId: 'volY', state: 'draft' }], [], actual)).allowed,
  '草稿不许归档'
)
assert(
  !archiveGate({ state: 'repairing' }, reconcilePlan('volY', [{ ...planX, volumeId: 'volY', state: 'voided' }], [], actual)).allowed,
  '已作废方案不许归档'
)
assert(
  archiveGate({ state: 'pending', legacyReadOnly: true }, reconcilePlan('volB', [], [], { leaves: [], papers: [], orders: [] })).reasons.includes('legacy-readonly'),
  '旧档只读册归档被拦'
)

console.log(process.exitCode ? '\n有断言失败' : '\n全部断言通过')
