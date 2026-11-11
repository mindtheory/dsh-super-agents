# 005 面板与运维（Panel & Operations）

面板是系统的"注意力出口"：它存在的唯一理由，是让人在最少的扫描后知道**现在是否需要我、
系统是否健康、一件事的来龙去脉**。承接 [000 理念](000-philosophy.md)、[001 领域](001-domain.md)。

## 面板回答的三个问题（按序）

1. **现在有什么需要我？** —— 顶部只列：`error` 级健康条目、需要人的 Run
   （failed / timeout / interrupted / done_no_artifact）、被暂停的调度。健康状态不占空间。
2. **系统健康且在干对的事吗？** —— 调度器心跳、runner 队列深度/活跃数、最近 24h 的
   Run 成败计数。数字只在会改变监督者动作时出现。
3. **一件工作的历史** —— Run 详情：任务文本、会话 id、日志尾部、产物全文、蒸馏去向。

## 设计原则（继承原型 005，逐条落地）

| 原则 | 本项目落地 |
| --- | --- |
| 每个元素必须回答三问之一 | 面板四视图：概览（问 1+2）/ 角色卡 / 调度 / 运行（问 3）；没有"统计图表"这类装饰 |
| 类别可检查、互斥、全覆盖 | Run 状态判定表（001）首行命中即止；面板标签说"等人做什么"（失败/超时/无产物），不显示内部码 |
| 一个概念一个地方 | 健康只在概览；Run 只在运行视图；调度只在调度视图；概览只摘要+跳转 |
| 诚实状态 | 计数 = 它链接的列表长度；`interrupted` 如实显示，不伪装成 running |
| 默认安静 | 健康时概览顶部为空；一次性失败不弹提示，进列表等人来看 |
| 状态可解释 | 每个 Run 有追加式日志文件；`done_no_artifact` 附日志尾部，能回答"为什么没产物" |

## 健康条目（单一写者）

| 条目 | 写者 | ok 条件 | error 何时 |
| --- | --- | --- | --- |
| `scheduler` | 调度器 | 最近一次 tick 无异常 | tick 连续抛错 |
| `runner` | runner | 无连续执行失败 | 连续 3 次 Run failed |
| `sessionController` | runner 启动检查 | 宿主端口可用 | 端口缺失（Run 会全部失败） |
| `pause` | 暂停开关 | 未暂停 | 暂停中显示为 warn（提醒调度不会触发） |

`GET /api/dsh-super-agents/health` 返回全部条目 + 暂停态 + 队列水位；面板与外部监控共用。

## 运维契约

- **暂停**：`sa_health pause` 全局停调度触发（不杀运行中的 Run）；`resume` 恢复且不补发
  错过的 occurrence。暂停持久化，重启后仍生效。对应理念"agent 吵了就暂停它"。
- **监控接入**：外部 cron/看门狗只需 `curl /health`，`error` 条目非空即告警——对应原型
  status 四退出码的极简版（我们只有一个 HTTP 探针，够用）。
- **数据目录**：`$DSH_HOME/dsh-super-agents/`（agents.json / schedules.json / runs.json /
  logs/ / results/ / playbooks/ / pause.json）。全部原子写（tmp+rename），可 grep、可手改、
  可整目录备份。恢复 = 拷回目录 + 重启宿主（启动清扫自动把 in-flight Run 标 interrupted）。
- **升级**：`dsh plugin remove && dsh plugin add link:<path>`。台账格式带 `version` 字段，
  未来迁移按版本号单向升级（对齐原型"迁移不可逆，升级前备份"的纪律——备份就是拷目录）。
- **排障表**（症状 → 原因 → 动作）：
  - Run 全部 `failed: session_controller_unavailable` → 装在了无会话服务的 profile → 装到 web profile
  - `done_no_artifact` 且日志有 write 被拒 → 产物路径在 cwd 外 → 检查 agent cwd 是否可写
  - 调度不触发 → 概览有 pause warn？cron 时区与预期不符（看 tz 字段）？agent enabled=false？
  - 面板没出现 → 硬刷新（boot 清单缓存）→ 查插件管理启用态 → `curl /health` 确认服务端活着
