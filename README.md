# dsh-context-rotate

DSH 插件：当 agent 的上下文占用越过阈值时，**截断模型可见的对话面**，并用一份**本地生成的确定性交接书**重新播种。

不做摘要、不经过模型：交接书只含用户原始指令（逐字）、Plan 原文、todo 原文和 git 改动文件清单，所以新上下文不会被旧的模型叙述或压缩污染。

## 工作方式

- 挂 `agent/pre-step`，读 `sessionProjections.contextPressure` 的 `projectedTokens / contextWindow`。
- 主 agent 与子 agent（含队友）分别有阈值；脚本只做判定，不调用 AI。
- 触发时向 session 追加一条 `user/message`（`source.kind = context-rotate`），配合 `surfaceOp: replace` 把系统提示之后的历史整体折叠成那封交接书。
- 手动触发：`/rotate` 在任何空闲会话里立即截断一次；不看阈值，也不受 `enabled` 限制，只受 `dryRun` 限制。
- 演示/观察模式：`dryRun` 只生成交接书并写日志，不真正截断，也不推进基线。

### 交接书内容

- 用户原始指令（逐字，跨段累计）。
- `exit_plan_mode` 的 plan 原文：native `tool/call` 与 PTC `tool/ptc-dispatch` 两条执行路径都会捕获。
- `todo_write` 原文：同样覆盖 native 与 PTC。
- 本段改动文件：`git diff --name-status <c0> <c1>` 覆盖已提交与未提交的跟踪改动，未跟踪文件单独列出；交接书要求模型先读取这些文件。完整 diff 不内嵌，只给出 `git diff <c0> <c1>` 让模型自行运行。

### git 基线

- `c0` 是会话开始时的 `git stash create` 快照（工作树干净时回落到 `HEAD`）。
- 每段轮换成功后 `c0` 推进到本段快照，并作为 `plugin:context-rotate` 记录（`{ baseline }`）写入会话日志；重启/恢复后由该记录恢复。
- 工作区不是 git 仓库时 git 段整体省略，轮换照常。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 启用**自动**轮换；`/rotate` 手动命令不受影响 |
| `dryRun` | `true` | 只生成交接书 + 日志，不截断 |
| `mainPercent` | `60` | 主 agent 阈值（窗口百分比，10–99） |
| `subPercent` | `50` | 子 agent / 队友阈值（窗口百分比，10–99） |

设置面板由插件自带（`client.js`），数字输入在聚焦期间不回写 Host，避免逐键往返。

## 安装

```jsonc
// ~/.dsh/profiles/web/package.json
"dependencies": { "@local/dsh-context-rotate": "github:DPapyru/dsh-context-rotate" },
"dsh": { "profile": { "bundles": ["@local/dsh-context-rotate"] } }
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: context-rotate
  name: "@local/dsh-context-rotate"
  config: { enabled: true, dryRun: false, mainPercent: 50, subPercent: 50 }
```

本地改代码时把依赖换成 `link:/path/to/dsh-context-rotate` 即可。

## 诊断

日志：`/tmp/dsh-context-rotate.log`（`check` / `MANUAL` / `DRY` / `ROTATED` / 错误）。手动立即轮换一次：

```
/rotate
```

## 已知限制

- 自动轮换在任意 pre-step 都可能触发；如果发生在工具调用之后，本轮刚产生的 tool result 会被折叠掉（交接书里没有它）。
- 替换事件没有写 `compaction/prune` 影子价格，`contextPressure` 不会立即下降；超阈值时手动 `/rotate` 后，下一次 pre-step 可能再自动截断一次。
- 未跟踪文件列表是“当前状态”，不按段增量去重；单次列表中超过 40 个文件会省略其余。
- 工作区不是 git 仓库、或没有首个 commit 时，交接书里没有 git 段。
- 基线记录是 best-effort：记录丢失或 `<c0>` 被 git gc 回收时，下一段会从当前工作树重新基线。
- 从旧版本升级的会话没有基线记录，第一段以升级后第一次 pre-step 的工作树为基线。
- 只覆盖挂在 `skill` 之外的会话流程：截断点固定为「系统提示之后」。
- 自动轮换依赖 `sessionProjections.contextPressure`；该投影不可用时自动轮换静默跳过（`/rotate` 不受影响）。
