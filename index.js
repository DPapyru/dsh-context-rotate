import z from '@deepseek-ai/schemastery'
import { appendFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-context-rotate'

export const Config = z.object({
  enabled: z
    .boolean()
    .default(false)
    .description('启用上下文轮换；关闭时插件只写诊断日志')
    .volatile(),
  dryRun: z
    .boolean()
    .default(true)
    .description('只生成交接书写日志，不真正截断模型可见面')
    .volatile(),
  mainPercent: z
    .number()
    .default(60)
    .min(10)
    .max(99)
    .description('主 agent 触发轮换的上下文占用阈值（窗口百分比）')
    .volatile(),
  subPercent: z
    .number()
    .default(50)
    .min(10)
    .max(99)
    .description('子 agent / 队友触发轮换的上下文占用阈值（窗口百分比）')
    .volatile(),
})

const LOG = join(tmpdir(), 'dsh-context-rotate.log')

function log(message) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // diagnostics must never break a step
  }
}

const read = (ref, fallback) => (typeof ref?.get === 'function' ? ref.get() : ref ?? fallback)

/** One session's rotation state: git baseline, instruction log, plan/todo snapshots. */
const states = new Map()

function stateOf(session) {
  let state = states.get(session.id)
  if (!state) {
    state = { c0: undefined, instructions: [], plan: '', todos: '', rotations: 0 }
    states.set(session.id, state)
  }
  return state
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 }).trim()
  } catch {
    return ''
  }
}

/** Snapshot the working tree without touching it; falls back to HEAD on a clean tree. */
function snapshot(cwd) {
  return git(cwd, ['stash', 'create']) || git(cwd, ['rev-parse', 'HEAD'])
}

function textOf(message) {
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .map((block) => (block?.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

function buildBrief(session, state, cwd) {
  const c1 = snapshot(cwd)
  const diff = state.c0 && c1 ? git(cwd, ['diff', '--stat', state.c0, c1]) : ''
  const parts = [
    `# 交接书 · ${new Date().toISOString()} · 第 ${state.rotations + 1} 段`,
    '',
    '你的前序上下文已被截断、不再可见。以下是你接手工作所需的全部信息。',
    '',
    `## 用户原始指令（逐字，${state.instructions.length} 条）`,
    ...state.instructions.map((text, index) => `${index + 1}. ${text}`),
  ]
  if (state.plan) parts.push('', '## 计划（exit_plan_mode 原文，逐字）', state.plan)
  if (state.todos) parts.push('', '## 待办（todo_write 原文）', state.todos)
  if (diff) {
    parts.push('', `## 本段改动（git diff ${state.c0} ${c1} --stat）`, diff)
    parts.push('', `完整 diff 自行获取：git diff ${state.c0} ${c1}`)
  }
  parts.push('', '## 注意', '用户原始指令永远优先于任何推断；不确定的状态请自行读取文件核实。')
  return parts.join('\n')
}

/** Model-visible surface range to replace: everything after the rendered system prompt. */
function replaceRange(session) {
  const nodes = session.surface?.nodes ?? []
  if (nodes.length < 2) return undefined
  return { startSeq: nodes[1], endSeq: nodes[nodes.length - 1], shadowed: nodes.slice(1) }
}

export function apply(ctx, config) {
  log('apply')

  // This plugin ships its own settings page, so suppress any auto-generated form.
  const settings = ctx.get('settings')
  settings?.configure?.({ auto: false }, ctx.fiber)
  setTimeout(() => {
    try {
      const served = (settings?.describe?.({}) ?? []).some((row) => row.ns === 'context-rotate')
      if (!served) log('WARN settings namespace missing; the settings page will stay empty')
    } catch (error) {
      log(`settings describe error ${error?.message}`)
    }
  }, 2000)

  ctx.on('session/created', (session) => {
    const state = stateOf(session)
    if (state.c0) return
    const cwd = session.header?.cwd
    if (cwd) state.c0 = snapshot(cwd)
    log(`baseline ${session.id} c0=${state.c0 ?? '-'}`)
  })

  ctx.on('session/event', (session, event) => {
    try {
      const state = stateOf(session)
      if (event.type === 'user/message') {
        const text = textOf(event)
        const kind = event.source?.kind
        const firstOfChild = event.source !== undefined && state.instructions.length === 0
        if (text && (kind === 'user' || (session.header?.origin === 'subagent' && firstOfChild))) {
          state.instructions.push(text)
        }
      } else if (event.type === 'tool/call') {
        if (event.name === 'exit_plan_mode') {
          const args = JSON.parse(event.arguments || '{}')
          if (typeof args.plan === 'string' && args.plan) state.plan = args.plan
        } else if (event.name === 'todo_write') {
          state.todos = event.arguments || ''
        }
      }
    } catch (error) {
      log(`session/event error ${error?.message}`)
    }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      rotate(ctx, config, payload.agent)
    } catch (error) {
      log(`rotation error ${error?.message}`)
    }
    return next()
  })
}

function rotate(ctx, config, agent) {
  const session = agent.session
  const state = stateOf(session)
  const cwd = session.header?.cwd
  if (!cwd) return
  if (!state.c0) state.c0 = snapshot(cwd)

  const pressure = ctx.get('sessionProjections')?.snapshot?.(session, ['contextPressure'])
    ?.values?.contextPressure
  const total = pressure?.projectedTokens ?? pressure?.pressureTokens
  const window = pressure?.contextWindow
  if (!total || !window) return

  const isChild = session.header?.origin === 'subagent' || (session.header?.delegationDepth ?? 0) > 0
  const percent = isChild
    ? read(config.subPercent, 50)
    : read(config.mainPercent, 60)
  const ratio = total / window
  log(`check ${session.id} child=${isChild} ratio=${ratio.toFixed(3)} limit=${percent}%`)
  const forcePath = join(tmpdir(), 'dsh-context-rotate.force')
  const forced = existsSync(forcePath)
  if (!read(config.enabled, false)) return
  if (ratio * 100 < percent && !forced) return
  if (forced) rmSync(forcePath, { force: true })
  // shortcut: one-shot manual trigger via a tmp file, replace with a real command when this ships
  if (forced) log(`FORCE ${session.id} ratio=${ratio.toFixed(3)}`)

  const range = replaceRange(session)
  if (!range) return
  const brief = buildBrief(session, state, cwd)
  const dryRun = read(config.dryRun, true)

  if (dryRun) {
    log(`DRY ${session.id} ratio=${ratio.toFixed(3)} range=${range.startSeq}..${range.endSeq}`)
    log(`DRY brief ${JSON.stringify(brief.slice(0, 600))}`)
    return
  }

  session.append(
    'user/message',
    {
      id: `context-rotate-${randomUUID()}`,
      content: [{ type: 'text', text: brief }],
      source: { kind: 'context-rotate' },
    },
    {
      surfaceOp: { op: 'replace', startSeq: range.startSeq, endSeq: range.endSeq },
      sourceEventSeqs: range.shadowed,
    },
  )
  state.rotations += 1
  log(`ROTATED ${session.id} seg=${state.rotations} ratio=${ratio.toFixed(3)}`)
}
