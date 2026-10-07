// 端到端逻辑验证（由 esbuild 打包后在 Node 运行，localStorage/window 用内存桩）
const mem = new Map<string, string>()
const localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  removeItem: (k: string) => { mem.delete(k) },
}
;(globalThis as any).localStorage = localStorage
const timers: Record<string, any> = {}
;(globalThis as any).window = {
  setTimeout: (fn: any) => { const id = String(Math.random()); timers[id] = fn; return id as any },
  clearTimeout: () => {},
}
;(globalThis as any).setTimeout = (fn: any) => { const id = String(Math.random()); timers[id] = fn; return id as any }
function flushTimers() { Object.values(timers).forEach((fn) => fn()); for (const k of Object.keys(timers)) delete timers[k] }

import { createPinia, setActivePinia } from 'pinia'
import { useReleaseStore } from '../src/stores/release'
import { useDesignerStore } from '../src/stores/designer'
import { useSessionsStore } from '../src/stores/sessions'
import { initWorkspace, RELEASE_KEY, SESSIONS_KEY, DRAFT_KEY, LEGACY_DRAFT_KEY } from '../src/stores/workspace'
import { findNode, planMigration, resolveMigrationConflict, evaluateCondition, normalizeSchema, buildDefaultValues } from '../src/utils/schema'
import type { FormSchema } from '../src/types/form'

let passed = 0
function check(name: string, cond: boolean, extra = '') {
  if (!cond) { console.error(`✗ ${name} ${extra}`); process.exitCode = 1 }
  else { passed++; console.log(`✓ ${name}`) }
}

setActivePinia(createPinia())
const release = useReleaseStore()
const designer = useDesignerStore()
const sessions = useSessionsStore()

// --- 1. 首次播种：v1 + 演示会话 ---
check('首次进入已播种 v1', release.latestRevision?.rev === 1)
check('首次进入有 1 个锚定 v1 的进行中会话', sessions.sessions.length === 1 && sessions.sessions[0].revId === 1)
const v1 = release.latestRevision!.schema
check('会话答案按 v1 字段路径存储', sessions.sessions[0].answers['applicantName'] === '李雷')
check('嵌套字段路径含容器段', sessions.sessions[0].answers['reasonSection.detail'] !== undefined)
flushTimers()
check('三份文档均已持久化', !!localStorage.getItem(RELEASE_KEY) && !!localStorage.getItem(SESSIONS_KEY) && !!localStorage.getItem(DRAFT_KEY))

// --- 2. 改草稿：改名 + 删字段 + 加字段，发布 v2 ---
// applicantName 改名为 fullName
const nameNode = designer.nodes.find((n) => n.name === 'applicantName')!
check('非法标识被拒绝（保留旧值）', designer.renameField(nameNode.id, '1bad-name') !== null)
check('合法改名生效', designer.renameField(nameNode.id, 'fullName') === null)
check('改名后草稿出现未发布修改', designer.draftDirty)
// 联动条件 amount 指向 requestType，不受影响；删除 expectedDate（字段缺失场景）
const dateNode = designer.nodes.find((n) => n.name === 'expectedDate')!
designer.removeNodeById(dateNode.id)
// 新增一个同类型字段，作为迁移候选
designer.addField('input')
const newField = designer.nodes[designer.nodes.length - 1]
designer.renameField(newField.id, 'contactPhone')
newField.label = '联系电话'
// 让联动条件指向被删字段路径，验证失效
const amount = designer.nodes.find((n) => n.name === 'amount')!
designer.selectedId = amount.id
designer.updateCondition({ fieldPath: 'expectedDate' })
const paths = designer.fieldPaths
const amountAfter = designer.nodes.find((n) => n.name === 'amount')!
check('指向已删字段的联动立即失效（隐藏+broken）', evaluateCondition(amountAfter.condition, {}, paths).broken === true)
// 恢复合法条件
designer.updateCondition({ fieldPath: 'requestType', operator: 'equals', value: '差旅报销' })
const amountFixed = designer.nodes.find((n) => n.name === 'amount')!
check('重选字段路径后联动恢复', evaluateCondition(amountFixed.condition, { requestType: '差旅报销' }, paths).visible === true)

const rev2 = designer.publish()
check('发布产生 v2 冻结版本', rev2.rev === 2 && release.revisions.length === 2)
check('发布后草稿与 v2 一致（不脏）', !designer.draftDirty)
// v1 冻结内容不受草稿影响
check('v1 结构冻结：仍含 applicantName/expectedDate', !!findNode(v1.nodes, nameNode.id) === false || v1.nodes.some((n) => n.name === 'applicantName'))
check('v1 结构冻结：仍含 expectedDate', v1.nodes.some((n) => n.name === 'expectedDate'))
check('v2 草稿结构：applicantName 已改名', !v1.nodes.some((n) => n.name === 'fullName'))

// --- 3. 老会话仍按 v1 恢复，且可继续填写 ---
const session = sessions.sessions[0]
check('老会话仍锚定 v1', session.revId === 1)
check('会话恢复出的结构是 v1（含 expectedDate）', sessions.schemaOf(session)!.nodes.some((n) => n.name === 'expectedDate'))
const okWrite = sessions.updateAnswer(session.id, 'applicantName', '韩梅梅')
check('按 v1 路径继续填写并持久化', okWrite && sessions.sessions[0].answers['applicantName'] === '韩梅梅')
// 被删字段 expectedDate 也已有旧答案，迁移时应与改名的 applicantName 一起列入待处理
sessions.updateAnswer(session.id, 'expectedDate', '2026-10-20')

// --- 4. 迁移到 v2 ---
const begin = sessions.beginMigration(session.id)
check('迁移启动成功', begin.ok)
const migrating = sessions.sessions[0]
check('迁移期间答案版本初始化为 v2 默认值结构', Object.prototype.hasOwnProperty.call(migrating.answers, 'fullName'))
check('保留原始答案快照供重试', migrating.migration!.originalAnswers['applicantName'] === '韩梅梅')
// 期望：requestType / detail / expenses 直接匹配；applicantName(改名) 与 expectedDate(删除) 成冲突
const conflicts = migrating.migration!.conflicts
const conflictPaths = conflicts.map((c) => c.oldPath).sort()
check('匹配字段直接补入（requestType）', migrating.answers['requestType'] === '差旅报销')
check('嵌套路径匹配补入', migrating.answers['reasonSection.detail'] === '客户现场交付支持，需出差三天')
check('表格按路径补入（列一致）', Array.isArray(migrating.answers['expenses']) && migrating.answers['expenses'][0].name === '高铁票')
check('对不上的旧值列待处理：applicantName / expectedDate', JSON.stringify(conflictPaths) === JSON.stringify(['applicantName', 'expectedDate']))
const nameConflict = conflicts.find((c) => c.oldPath === 'applicantName')!
check('改名冲突提供同类型候选字段（含 fullName/contactPhone）', nameConflict.candidates.includes('fullName') && nameConflict.candidates.includes('contactPhone'))
check('迁移未完成不能提交', !sessions.submit(session.id).ok)
check('迁移中 revId 仍是旧版（处理完才切换）', sessions.sessions[0].revId === 1)

// --- 5. 补入一条；保留一条（两边都不丢） ---
const r1 = sessions.resolveConflict(session.id, nameConflict.id, 'map', 'fullName')
check('旧值补入新路径成功', r1.ok && sessions.sessions[0].answers['fullName'] === '韩梅梅')
const expConflict = sessions.sessions[0].migration!.conflicts.find((c) => c.oldPath === 'expectedDate')!
const r2 = sessions.resolveConflict(session.id, expConflict.id, 'retain')
check('无候选时保留两边值成功', r2.ok)
const done = sessions.sessions[0]
check('冲突清空后会话切到 v2', done.revId === 2 && done.migration === null)
check('补入值在新路径，旧默认值未被丢', done.answers['fullName'] === '韩梅梅')
check('保留的旧值挂在会话上长期留存', done.retainedAnswers.some((r) => r.oldPath === 'expectedDate'))
const persistedSessions = JSON.parse(localStorage.getItem(SESSIONS_KEY)!).payload
check('保留项已持久化（写入中断也不丢）', persistedSessions.sessions[0].retainedAnswers.some((r: any) => r.oldPath === 'expectedDate'))

// --- 6. 纯函数层面：类型变化冲突（两边保留）、默认值防覆盖 ---
const oldSchema: FormSchema = {
  version: 1, title: 't', description: '', updatedAt: '',
  nodes: [
    { id: 'a', type: 'input', name: 'amount', label: '金额', validation: { required: false } },
    { id: 'b', type: 'input', name: 'gone', label: '消失', validation: { required: false } },
  ],
}
const newSchema: FormSchema = {
  version: 1, title: 't', description: '', updatedAt: '',
  nodes: [
    { id: 'a2', type: 'date', name: 'amount', label: '金额(日期)', validation: { required: false } },
    { id: 'c', type: 'input', name: 'remark', label: '备注', validation: { required: false } },
  ],
}
const plan = planMigration(oldSchema, newSchema, { amount: '100', gone: 'x' })
check('同路径类型变化产生 type_changed 冲突', plan.conflicts.some((c) => c.oldPath === 'amount' && c.reason === 'type_changed'))
check('类型变化时新字段保留默认值（不覆盖）', plan.answers['amount'] === '')
const amountConflict = plan.conflicts.find((c) => c.oldPath === 'amount')!
const defaults = buildDefaultValues(newSchema.nodes)
let res = resolveMigrationConflict({ answers: plan.answers, conflicts: plan.conflicts, retained: [] }, amountConflict.id, 'map', 'remark', defaults)
check('类型兼容字段可补入', res.result.answers['remark'] === '100')
// 目标已有手工值 → 拒绝覆盖
res.result.answers['remark'] = 'user-typed'
const again = resolveMigrationConflict(res.result, amountConflict.id, 'map', 'remark', defaults)
check('目标已被手工填写时拒绝覆盖', !!again.error && again.result.answers['remark'] === 'user-typed')

// --- 7. 迁移：无冲突直切、写入失败保留可重试、冲突中重试回退 ---
// 在 v2 上再开一个会话（此时最新仍是 v2）
const s2 = sessions.startSession()
sessions.updateAnswer(s2.id, 'fullName', '临时填写')
// 发布 v3：仅新增字段，旧答案全部能对上
designer.addField('date')
const third = designer.nodes[designer.nodes.length - 1]
designer.renameField(third.id, 'v3date')
designer.publish()
const realSetItem = localStorage.setItem.bind(localStorage)
localStorage.setItem = () => { throw new Error('disk full') }
const failBegin = sessions.beginMigration(s2.id)
check('写入失败时迁移不会开始（原会话保留）', failBegin.ok === false && sessions.sessions.find((x) => x.id === s2.id)!.migration === null)
check('写入失败时已录答案不丢', sessions.sessions.find((x) => x.id === s2.id)!.answers['fullName'] === '临时填写')
localStorage.setItem = realSetItem
const retryBegin = sessions.beginMigration(s2.id)
check('恢复后重试成功', retryBegin.ok)
const direct = sessions.sessions.find((x) => x.id === s2.id)!
check('无冲突迁移直接切到新版本', direct.revId === 3 && direct.migration === null)
check('直接补入后旧答案仍在，新字段取默认值', direct.answers['fullName'] === '临时填写' && Array.isArray(Object.keys(direct.answers).filter(k => k === 'v3date')))
// 发布 v4：改名 fullName → candidateName，产生冲突
const fullNode = designer.nodes.find((n) => n.name === 'fullName')!
designer.renameField(fullNode.id, 'candidateName')
designer.publish()
const c4 = sessions.beginMigration(s2.id)
check('有冲突时进入待处理迁移', c4.ok && sessions.sessions.find((x) => x.id === s2.id)!.migration !== null)
// 迁移中放弃重试：恢复 v3 旧答案，再重新规划到 v4（仍是待处理）
const retry = sessions.retryMigration(s2.id)
check('冲突迁移可重试', retry.ok)
const afterRetry = sessions.sessions.find((x) => x.id === s2.id)!
check('重试后仍锚定旧版本，原始答案完整保留', afterRetry.revId === 3 && afterRetry.migration!.originalAnswers['fullName'] === '临时填写')
check('重新规划后冲突仍在', afterRetry.migration!.conflicts.some((c) => c.oldPath === 'fullName'))
// 完成迁移：补入改名后的路径
const cf = afterRetry.migration!.conflicts.find((c) => c.oldPath === 'fullName')!
const mapped = sessions.resolveConflict(s2.id, cf.id, 'map', 'candidateName')
check('重试后仍可补入并完成迁移', mapped.ok && sessions.sessions.find((x) => x.id === s2.id)!.revId === 4)

// --- 8. 旧版 fieldId 联动归一化 ---
const legacy = {
  version: 1, title: '旧', description: '', updatedAt: '',
  nodes: [{ id: 'f1', type: 'input', name: 'a', label: 'A', validation: { required: false }, condition: { fieldId: 'f2', operator: 'equals', value: 'x' } },
    { id: 'f2', type: 'select', name: 'b', label: 'B', options: ['x'] }],
}
const norm = normalizeSchema(legacy)!
check('旧 fieldId 条件归一化为字段路径', norm.nodes[0].condition?.fieldPath === 'b')
check('归一化后按新模型判定显隐', evaluateCondition(norm.nodes[0].condition, { b: 'x' }).visible === true)


// --- 9. 显隐参与提交校验：条件隐藏的必填字段不拦提交 ---
{
  // 导入一份最小草稿：类型=其他时，必填的金额字段隐藏
  designer.replaceSchema({
    version: 1, title: '条件必填', description: '', updatedAt: '',
    nodes: [
      { id: 'r1', type: 'select', name: 'requestType', label: '申请类型', options: ['差旅报销', '其他'], validation: { required: false } },
      { id: 'r2', type: 'input', name: 'amount', label: '金额', validation: { required: true }, condition: { fieldPath: 'requestType', operator: 'notEquals', value: '其他' } },
    ],
  })
  designer.publish('条件必填场景')
  const hs = sessions.startSession()
  // 不填金额，类型选「其他」→ 金额隐藏
  sessions.updateAnswer(hs.id, 'requestType', '其他')
  const hiddenResult = sessions.submit(hs.id)
  check('条件隐藏的必填字段不拦截提交', hiddenResult.ok === true)
  // 改回差旅报销 → 金额可见且为空，必须拦截
  sessions.updateAnswer(hs.id, 'requestType', '差旅报销')
  // 已提交会话不可重复校验，新开一个
  const hs2 = sessions.startSession()
  sessions.updateAnswer(hs2.id, 'requestType', '差旅报销')
  const visibleResult = sessions.submit(hs2.id)
  check('字段重新可见时必填校验生效', !visibleResult.ok && String(visibleResult.error).includes('金额'))
}

// 旧草稿引导的纯存储层验证：主文档写入失败时，旧主文档仍可被读回
import { writeAtomic, readDoc } from '../src/utils/storage'
mem.clear()
writeAtomic('k-doc', { v: 1 })
let mainCall = 0
const originalSet = localStorage.setItem.bind(localStorage)
localStorage.setItem = (k: string, v: string) => {
  // tmp 成功，主文档写入抛错
  if (k === 'k-doc') { mainCall += 1; throw new Error('main write interrupted') }
  originalSet(k, v)
}
let interrupted = false
try { writeAtomic('k-doc', { v: 2 }) } catch { interrupted = true }
check('写入中断抛错且旧主文档未被破坏', interrupted && readDoc('k-doc', (d): d is { v: number } => !!d && typeof (d as any).v === 'number')?.v === 1)
localStorage.setItem = originalSet
writeAtomic('k-doc', { v: 3 })
check('中断后下一次写入成功并清理临时文档', readDoc('k-doc', (d): d is { v: number } => !!d)?.v === 3 && localStorage.getItem('k-doc.tmp') === null)

// 旧草稿引导（清空模块缓存后重新初始化工作区）
mem.clear()
mem.set(LEGACY_DRAFT_KEY, JSON.stringify(legacy))

console.log(`\n${passed} 项检查通过`)
