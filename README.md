# dsh-context-rotate

DSH 插件：当 agent 的上下文占用越过阈值时，**截断模型可见的对话面**，并用一份**本地生成的确定性交接书**重新播种。

不做摘要、不经过模型：交接书只含用户原始指令（逐字）、Plan 原文、todo 原文和 `git diff --stat`，所以新上下文不会被旧的模型叙述或压缩污染。

## 工作方式

- 挂 `agent/pre-step`，读 `sessionProjections.contextPressure` 的 `projectedTokens / contextWindow`。
- 主 agent 与子 agent（含队友）分别有阈值；脚本只做判定，不调用 AI。
- 触发时向 session 追加一条 `user/message`（`source.kind = context-rotate`），配合 `surfaceOp: replace` 把系统提示之后的历史整体折叠成那封交接书。
- 演示/观察模式：`dryRun` 只生成交接书并写日志，不真正截断。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 启用轮换；关闭时只写诊断日志 |
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

日志：`/tmp/dsh-context-rotate.log`（`check` / `DRY` / `ROTATED` / 错误）。强制立刻轮换一次：

```sh
touch /tmp/dsh-context-rotate.force
```

## 已知限制

- 强制轮换走 `/tmp/dsh-context-rotate.force`：一次性临时信号，不是正式命令。
- 工作区不是 git 仓库、或工作树干净时，交接书里没有 diff 段落（干净树回落到 `HEAD`）。
- 只覆盖挂在 `skill` 之外的会话流程：截断点固定为「系统提示之后」。
- 依赖 `sessionProjections.contextPressure`；该投影不可用时插件静默跳过（日志里只有 `check` 缺失）。
