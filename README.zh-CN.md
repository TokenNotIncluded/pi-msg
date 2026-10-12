# pi-msg

把 [MSG](https://github.com/TokenNotIncluded/msg) 深度接入 Pi：后台订阅、合并唤醒、可靠交接和私有频道浏览。它是通信适配器，不是新的 agent 平台。

[English / 完整参数和边界](README.md)

## 使用

需要 Node.js ≥22.19、Pi 1.1.x，以及支持 `agent inbox --cursor`、`listen --cursor-file` 的 MSG CLI。

```sh
pi install git:github.com/TokenNotIncluded/pi-msg
```

在 `~/.config/pi-msg/config.json` 配置**已有**账号、服务、邮箱标签和独立订阅 ID：

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
  "maxPending": 2000
}
```

目录权限为 `0700`、配置文件权限为 `0600`。配置不放凭据。扩展不会注册账号、读取或导出私钥，也不会启动子 agent 或扩大授权。

明确选择本地离线模式时，设置 `remote: false`、独立的 `configDir` 和 `username`，不设置生产身份。远程失败不会自动转成本地通信。

## 事件驱动

后台 MSG CLI 事件作为通知提示，扩展重新核对持久邮箱，将原文和游标一起落盘。空闲 Pi 自动开始处理；忙碌 Pi 通过原生 follow-up 队列在安全边界接收通知。

阻断和结果快速合并交付；普通 progress 默认只更新状态，不产生模型调用。100 条并行消息也不会逐条唤醒。模型不需要反复执行 `listen` 等待。

这里“事件驱动”指 **Pi 和模型的运行方式**。当前 MSG CLI 的网络监听仍通过间隔读取实现，不假装已经拥有服务端推送。

## 用户界面

- `/msg`：浏览有权访问的频道，包括主 agent 和子 agent 邮箱。
- Enter：摘要 → 单条正文；不会把全频道正文塞进模型上下文。
- Tab：查看异步流向、任务／源码版本、等待／领取／完成和重试次数。
- `n`：下一页历史；`r`：刷新历史；Esc：返回或关闭。
- `/msg status`：连接、待处理量、最早等待时间、最近交付和唤醒次数。
- `/msg disconnect`：明确停止订阅，保留待办；`/msg connect`：恢复。

投递板和连接状态随事件重绘。历史浏览有单独游标，不推进交接游标。界面只在本机终端显示，不启动网页服务器、不公开私有记录，也不把邮箱数量当作实际 worker 数。

## 可靠性与低上下文

`msg_inbox` 给预算受限的摘要；`msg_read` 按 ID 读取；`msg_send` 只返回简短 receipt，本地模式也不回显正文。重试沿用同一消息 ID，正文冲突会被拒绝。

`msg_delivery` 显式区分 claim、complete 和 fail，使用租约和 token。过期 token 不能完成任务；崩溃后的领取会恢复为待处理。采用**至少一次投递＋幂等处理**：业务副作用必须自行去重，不承诺恰好一次。

**领取是本地适配器状态，不是 MSG 服务端分布式租约。** 不会自动给发送方签发完成回执，也不能防止另一个独立消费者处理同一任务。需要服务端能力时继续完善 MSG 协议，不虚构保证。

扩展在连接时追加精简协作提示：授权后才协作、同账号独立 mailbox 标签、固定帖子引用、一个任务一棵私有讨论树、精简通知、不重复读正文、先领取再处理、不得把读取当完成。标签和 task metadata 不是经过验证的独立测试身份。

未处理消息不会静默删除。已完成的本地索引在后续入库时保留最近 1000 条；完整历史仍在 MSG。超出待办上限时保留未落盘页的游标并暂停。自动 outbox 清理、附件容量管理和服务端分布式领取留待后续版本。

本地验证：`npm run typecheck`、`npm test`；设置 `MSG_PI_TEST_CLI` 可验证真实 CLI 的离线事件、重试去重和崩溃恢复。具体输出／token 对照见 [测量说明](docs/MEASUREMENTS.md)。

MIT 开源。
