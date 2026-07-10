# TeleBox (mtcute) 架构审查笔记

> 由健康检查 agent 维护。记录过于复杂或冗余的架构设计问题、影响范围与改进方向。

## 1. Leech 模块：每次命令新建 SQLite 连接（中优先级）

- **问题描述**：`src/plugin/leech.ts` 在每次命令执行时 `new LeechDB()`（better-sqlite3 连接），并在 `finally` 中 `db.close()`。`LeechService` 与 `StructuredLeechLogger` 共享同一实例，但 `getHistory` 分页循环中的每次 `db.upsertMessage` 都是独立事务（WAL 模式下无显式事务批处理）。
- **影响范围**：`src/plugin/leech.ts`、`src/utils/leech/leechService.ts`、`src/utils/leech/leechDB.ts`。单次 leech 任务在大量消息时会产生数千次单条 `INSERT ... ON CONFLICT` 写入，每次都走 WAL 提交。
- **建议改进方向**：
  - 在 `runChatLeech` 中按 batch 用 `db.transaction()` 批量 upsert，减少 fsync 次数。
  - 或将 `LeechDB` 改为进程级单例（按 `dbPath` 缓存连接），避免每次命令 `open/close` 文件系统句柄；不过需注意插件热重载（pluginManager reload）时连接需被排除出缓存清理或重新打开。

## 2. Leech 模块：mtcute `getHistory` 分页的边界语义（低优先级，已适配）

- **问题描述**：teleproto 版使用 `client.getMessages(entity, { offsetId, offsetDate })`，而 mtcute 无此 offset 分页签名，需改用 `client.getHistory(entity, { offset: { id, date } })`。`offset.date` 在 mtcute 中以**秒**为单位（原始 TL），与 teleproto 一致；`Message.date` 在 mtcute 是 JS `Date`，写入 offset 前需 `Math.floor(date.getTime()/1000)`。
- **影响范围**：`src/utils/leech/leechService.ts`。
- **当前状态**：已按上述规则适配，tsc 通过且运行时可加载。保留此笔记以防后续维护者误用 `getMessages` 的 id-only 签名。

## 3. 通用：插件命令消息的 HTML 渲染方式

- **问题描述**：mtcute 的 `msg.edit({ text })` 不接受 `parseMode: "html"`，必须用 `@mtcute/node` 的 `html()` 标签函数包裹文本（底层走 `TextWithEntities`）。teleproto 迁移遗留代码若仍带 `parseMode: "html"` 会触发 TS 类型错误。
- **影响范围**：所有从 teleproto 迁移的命令插件。
- **建议改进方向**：全局统一使用 `html()` helper；可在 `htmlEscape.ts` 旁提供一个 `safeHtml()` 封装，统一处理转义 + 解析，避免散落的 `htmlEscape` + `html()` 混用。
