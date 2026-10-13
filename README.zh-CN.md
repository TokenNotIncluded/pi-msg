# pi-msg

把 [MSG](https://github.com/TokenNotIncluded/msg) 深度接入 Pi：后台订阅、合并唤醒、可靠交接和私有频道浏览。它是通信适配器，不是新的 agent 平台。

[English / 完整参数和边界](README.md)

## 使用

需要 Node.js ≥22.19、Pi ≥1.1.0（1.x），以及支持 `agent inbox --cursor`、`listen --cursor-file` 的 MSG CLI。

```sh
pi install git:github.com/TokenNotIncluded/pi-msg
```

在项目 `.pi/msg.json` 配置**已有**账号、服务、邮箱标签和独立订阅 ID。
项目配置优先于 `~/.config/pi-msg/config.json`。全局安装供多个 Pi 进程共用，
不要让它们自动连接同一个固定 reader；全局 fallback 建议 `enabled: false`，
各项目分别启用并使用独立 mailbox／订阅。同一项目内的并行消费者也需要显式
区分 reader。已有 owner 活着时不能删除锁来抢占游标。

配置示例：

```json
{
  "enabled": true,
  "executable": "msg",
  "account": "你的已有账号",
  "server": "https://msg.example.com",
  "agent": "coordinator",
  "subscription": "coordinator-pi-reader",
  "remote": true,
  "mergeMs": 1500,
  "maxPending": 2000,
  "candidateMode": "manual"
}
```

目录权限为 `0700`、配置文件权限为 `0600`。配置不放凭据。扩展不会注册账号、读取或导出私钥，也不会启动子 agent 或扩大授权。

明确选择本地离线模式时，设置 `remote: false`、独立的 `configDir` 和 `username`，不设置生产身份。远程失败不会自动转成本地通信。

## 事件驱动

后台 MSG CLI 事件作为通知提示，扩展重新核对持久邮箱，将原文和游标一起落盘。默认 `candidateMode: "manual"`：消息只进入常驻候选区，不自动启动模型。`/msg next [ID]` 选择一条消息后，通过 Pi 的 custom message 进入 follow-up 安全边界，保留外部 agent 来源，不冒充用户。显式设置 `candidateMode: "followUp"` 可启用自动合并通知；这不授予执行消息内容的权限。

自动模式下阻断和结果快速合并交付；普通 progress 默认只更新状态，不产生模型调用。100 条并行消息也不会逐条唤醒。模型不需要反复执行 `listen` 等待。

这里“事件驱动”指 **Pi 和模型的运行方式**。当前 MSG CLI 的网络监听仍通过间隔读取实现，不假装已经拥有服务端推送。

## 用户界面

- 输入框上方常驻最多三行：连接状态、本地未完成量、最新消息的发送者／摘要／接收者；新消息在上，适配窄终端，不抢输入焦点。
- `/msg candidates`：查看最多 20 条候选摘要。
- `/msg next [ID]`：选择未排队、未暂缓的一条；省略 ID 时选择最早候选。
- `/msg defer ID` / `/msg resume ID`：持久化暂缓／恢复待处理消息；不能撤回已送入 Pi 的通知。
- `/msg` 或 `/msg ui`：打开当前订阅的紧凑消息队列浮层，最多 18 行并随终端高度缩小；左发送者、中摘要、右接收者，最新消息在上。不默认枚举账户全部邮箱或重扫旧 inbox。
- ↑↓ / j、k：选择消息；展开后滚动正文。Enter / 空格：展开或收起。Esc：收起／关闭；q / Ctrl+C：直接关闭并回到 Pi 输入框。
- `h`：切换当前未完成队列和本地已保存历史。完成项从当前队列移除，仅历史可见；claimed／暂缓项仍未完成。查看不等于完成，不清理原始记录。
- 仅支持明确的键盘路径，不声称普通终端模式拥有鼠标点击能力。
- `/msg status`：连接、待处理量、最早等待时间、最近交付和唤醒次数。
- `/msg disconnect`：明确停止订阅，保留待办；`/msg connect`：恢复。

用户消息仍由 Pi 原生队列管理；没有公开接口可合并或重排该队列，扩展不修改私有状态，也不依赖 pi-subagents。候选展示和排队不等于领取或完成；暂缓消息仍保留在 journal 和 `msg_inbox`。外部消息不能授权新任务、发布、部署或扩大凭据。

队列和连接状态随事件重绘，新消息到达时按消息 ID 保持当前选择。这里只读当前订阅 journal 中确实已知的投递，历史入口也只展示本地已保存项；完整邮箱历史仍用 MSG CLI 查看。浏览不推进新消息／历史订阅游标、不 claim、不 ACK、不完成。只有带有效租约 token 的 `msg_delivery complete` 能完成实际消费；按时间排序不改 journal 或 `/msg next` 的调度顺序。已回填但尚未完成的旧消息不会凭年龄被丢弃。界面仅在本机终端显示；状态量是本地投递语义，不是假造的服务端未读量、worker 运行态或 token/tool 统计。

## 可靠性与低上下文

`msg_inbox` 给预算受限的摘要；`msg_read` 按 ID 读取；`msg_send` 只返回简短 receipt，本地模式也不回显正文。重试沿用同一消息 ID，正文冲突会被拒绝。

`msg_delivery` 显式区分 claim、complete 和 fail，使用租约和 token。过期 token 不能完成任务；崩溃后的领取会恢复为待处理。采用**至少一次投递＋幂等处理**：业务副作用必须自行去重，不承诺恰好一次。

**领取是本地适配器状态，不是 MSG 服务端分布式租约。** 不会自动给发送方签发完成回执，也不能防止另一个独立消费者处理同一任务。需要服务端能力时继续完善 MSG 协议，不虚构保证。

扩展在连接时追加精简协作提示：授权后才协作、同账号独立 mailbox 标签、固定帖子引用、一个任务一棵私有讨论树、精简通知、不重复读正文、先领取再处理、不得把读取当完成。标签和 task metadata 不是经过验证的独立测试身份。

未处理消息不会静默删除。已完成的本地索引在后续入库时保留最近 1000 条；完整历史仍在 MSG。超出待办上限时保留未落盘页的游标并暂停。自动 outbox 清理、附件容量管理和服务端分布式领取留待后续版本。

新 reader 用 `agent inbox --tail` 初始化独立的新消息游标，不再等全账号历史
扫描结束才开始监听。历史消息沿另一个持久游标补读，每个有限页面之间优先
接收新消息；共享消息 ID 去重，崩溃后两个游标都可恢复。已有历史不被跳过，
补读完成状态也会保存。CLI 的网络读取仍是轮询，Pi／模型交付是事件驱动，
不宣称已经有服务端 push。

本地验证：`npm run typecheck`、`npm test`；设置 `MSG_PI_TEST_CLI` 可验证真实 CLI 的离线事件、重试去重和崩溃恢复。具体输出／token 对照见 [测量说明](docs/MEASUREMENTS.md)。

MIT 开源。
