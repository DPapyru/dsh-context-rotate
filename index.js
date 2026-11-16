import z from '@deepseek-ai/schemastery'
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-context-rotate'

export const Config = z.object({
  enabled: z
    .boolean()
    .default(false)
    .description('启用自动轮换；/rotate 手动命令不受影响')
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
const BASELINE_RECORD = 'plugin:context-rotate'
const MAX_FILES = 40

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
    state = { c0: undefined, instructions: [], plan: '', todos: '', rotations: 0, hydratedThrough: undefined }
    states.set(session.id, state)
    hydrate(session, state)
  }
  return state
}

/** Replay a session's durable log once, so a restart cannot lose the brief's sources or baseline. */
function hydrate(session, state) {
  try {
    for (const event of session.snapshotEvents()) {
      state.hydratedThrough = event.seq
      const record = pluginRecordOf(event)
      if (record?.type === BASELINE_RECORD && typeof record.data?.baseline === 'string') {
        state.c0 = record.data.baseline
      } else if (event.type === 'user/message' && event.data?.source?.kind === 'context-rotate') {
        state.rotations += 1
      } else {
        capture(state, session, event)
      }
    }
  } catch (error) {
    log(`hydrate error ${error?.message}`)
  }
}

/** Tool name and normalized input for native calls and PTC sub-dispatches. */
function toolOf(event) {
  const data = event.data
  if (event.type !== 'tool/call' && event.type !== 'tool/ptc-dispatch') return undefined
  if (typeof data?.name !== 'string') return undefined
  let args = data.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      args = undefined
    }
  }
  return { name: data.name, args: args && typeof args === 'object' ? args : undefined, raw: data.arguments }
}

/** Record one event's contribution to the brief. */
function capture(state, session, event) {
  const data = event.data
  if (event.type === 'user/message') {
    const text = textOf(data)
    const kind = data?.source?.kind
    const firstOfChild = data?.source !== undefined && state.instructions.length === 0
    if (text && (kind === 'user' || (session.header?.origin === 'subagent' && firstOfChild))) {
      state.instructions.push(text)
    }
    return
  }
  const tool = toolOf(event)
  if (tool?.name === 'exit_plan_mode' && typeof tool.args?.plan === 'string' && tool.args.plan) {
    state.plan = tool.args.plan
  } else if (tool?.name === 'todo_write' && tool.args !== undefined) {
    state.todos = typeof tool.raw === 'string' ? tool.raw : JSON.stringify(tool.args)
  }
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

/** Bound one file list so a large change set cannot bloat the brief. */
function excerpt(lines) {
  return lines.length > MAX_FILES
    ? [...lines.slice(0, MAX_FILES), `…（其余 ${lines.length - MAX_FILES} 个文件省略）`]
    : lines
}

function buildBrief(session, state, cwd) {
  const c1 = snapshot(cwd)
  const tracked = state.c0 && c1
    ? git(cwd, ['diff', '--name-status', state.c0, c1]).split('\n').filter(Boolean)
    : []
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(Boolean)
    .map((path) => `?? ${path}`)
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
  if (tracked.length || untracked.length) {
    parts.push('', '## 本段改动（git）')
    parts.push(
      '',
      '本节列出本段开始（第一次为会话开始）以来发生过改动的文件：已跟踪部分来自 `git diff --name-status`，包含已提交和未提交的改动；未跟踪文件单独列出。截断后你看不到这些改动是怎么发生的，**请先用读取工具逐个查看下列文件的当前内容**，再继续工作，不要凭记忆推断。',
    )
    if (tracked.length) parts.push('', '已跟踪（提交或未提交）：', ...excerpt(tracked).map((line) => `- ${line}`))
    if (untracked.length) parts.push('', '未跟踪：', ...excerpt(untracked).map((line) => `- ${line}`))
    if (tracked.length) {
      parts.push('', `完整 diff 请自行运行：git diff ${state.c0} ${c1}`, '（未跟踪文件不在 diff 中，请直接读取文件。）')
    }
  }
  parts.push('', '## 注意', '用户原始指令永远优先于任何推断；不确定的状态请自行读取文件核实。')
  return { text: parts.join('\n'), baseline: c1 }
}

/** Best-effort durable baseline; a lost record only re-baselines the next segment. */
function persistBaseline(session, baseline) {
  if (!baseline) return
  try {
    appendPluginRecord(session, BASELINE_RECORD, { baseline })
  } catch (error) {
    log(`persist baseline error ${error?.message}`)
  }
}

/** Model-visible surface range to replace: everything after the rendered system prompt. */
function replaceRange(session) {
  const nodes = session.surface?.nodes ?? []
  if (nodes.length < 2) return undefined
  return { startSeq: nodes[1], endSeq: nodes[nodes.length - 1], shadowed: nodes.slice(1) }
}

export function apply(ctx, config) {
  log('apply')

  // Ships its own settings page; the service is not up during apply, so register once injected.
  ctx.inject(['settings'], (scoped) =>
    scoped.settings.configure({ auto: false }, scoped.fiber),
  )
  registerRotateCommand(ctx, config)

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
      // Events the hydration pass already replayed must not be counted twice.
      if (state.hydratedThrough !== undefined && event.seq <= state.hydratedThrough) return
      capture(state, session, event)
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

function rotate(ctx, config, agent, options = {}) {
  const manual = options.manual === true
  const session = agent.session
  const state = stateOf(session)
  const cwd = session.header?.cwd
  if (!cwd) return { kind: 'no-cwd' }

  const dryRun = read(config.dryRun, true)
  // `enabled` gates automatic rotation only; an explicit /rotate is always allowed.
  if (!manual && !read(config.enabled, false)) return { kind: 'disabled' }
  if (manual) log(`MANUAL ${session.id}`)

  if (!state.c0) {
    state.c0 = snapshot(cwd)
    if (!dryRun) persistBaseline(session, state.c0)
  }

  if (!manual) {
    const pressure = ctx.get('sessionProjections')?.snapshot?.(session, ['contextPressure'])
      ?.values?.contextPressure
    const total = pressure?.projectedTokens ?? pressure?.pressureTokens
    const window = pressure?.contextWindow
    if (!total || !window) return { kind: 'no-pressure' }

    const isChild = session.header?.origin === 'subagent' || (session.header?.delegationDepth ?? 0) > 0
    const percent = isChild
      ? read(config.subPercent, 50)
      : read(config.mainPercent, 60)
    const ratio = total / window
    log(`check ${session.id} child=${isChild} ratio=${ratio.toFixed(3)} limit=${percent}%`)
    if (ratio * 100 < percent) return { kind: 'under' }
  }

  const range = replaceRange(session)
  if (!range) return { kind: 'empty' }
  const brief = buildBrief(session, state, cwd)
  const segment = state.rotations + 1
  if (dryRun) {
    log(`DRY ${session.id} manual=${manual} range=${range.startSeq}..${range.endSeq}`)
    log(`DRY brief ${JSON.stringify(brief.text)}`)
    return { kind: 'dry', shadowed: range.shadowed.length, segment }
  }

  session.append(
    'user/message',
    {
      id: `context-rotate-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text: brief.text }],
      source: { kind: 'context-rotate' },
    },
    {
      surfaceOp: { op: 'replace', startSeq: range.startSeq, endSeq: range.endSeq },
      sourceEventSeqs: range.shadowed,
    },
  )
  state.rotations += 1
  state.c0 = brief.baseline
  persistBaseline(session, brief.baseline)
  log(`ROTATED ${session.id} manual=${manual} seg=${state.rotations}`)
  return { kind: 'rotated', shadowed: range.shadowed.length, segment }
}

function registerRotateCommand(ctx, config) {
  ctx.inject(['commands'], (scoped) =>
    scoped.commands.register({
      name: 'rotate',
      description: '立即截断上下文并生成交接书',
      handler: async ({ agent, rawInput, signal }) => {
        if (rawInput.trim()) return { kind: 'error', text: '用法：/rotate（无参数）' }
        let entered = false
        try {
          const result = await agent.runMaintenance(async () => {
            entered = true
            return rotate(ctx, config, agent, { manual: true })
          })
          if (result.kind === 'rotated') {
            return { kind: 'success', text: `已截断 ${result.shadowed} 条历史，进入第 ${result.segment} 段。` }
          }
          if (result.kind === 'dry') {
            return { kind: 'success', text: `dryRun：将截断 ${result.shadowed} 条历史（第 ${result.segment} 段），未写入。` }
          }
          if (result.kind === 'empty') return { kind: 'success', text: '没有可截断的历史。' }
          if (result.kind === 'no-cwd') return { kind: 'error', text: '会话没有工作目录，无法截断。' }
          return { kind: 'error', text: '无法截断：当前状态不满足条件。' }
        } catch (error) {
          if (signal.aborted) return { kind: 'error', text: '已取消。' }
          if (!entered) return { kind: 'error', text: '当前有回合或维护任务在运行，稍后再试。' }
          log(`command error ${error?.message}`)
          return { kind: 'error', text: `截断失败：${error?.message ?? error}` }
        }
      },
    }),
  )
}
