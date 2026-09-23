# 产品决策记录

这里记录已经由产品讨论确认、会影响用户操作方式的决定。每条记录保留编号、日期、状态和具体行为；若以后改变决定，新增记录说明替代关系，不直接抹去原决定。技术边界和待验证接口另见[架构决策记录](decisions.md)。

## PD-001：Project、目录与 Domain 的关系

- 日期：2026-09-23
- 状态：已确定
- 来源：Project Domain 与新 Session 交互讨论

### 背景

早期 MVP 虽将 Domain 保存到每个 Project，却把编辑入口放在全局 Settings，容易让用户误认为 Domain 是整个应用的配置。新 Session 的领域选择也与 Project 的领域归属关系不清。

### 决定

1. 一个本地文件目录对应一个 Project；同一目录不能重复创建 Project。
2. 一个 Project 只归属一个 Domain。创建 Project 时必须选择 Domain；此后可在该 Project 的详情页修改。
3. 点击左侧项目进入项目详情页，显示项目名称、本地目录和 Domain。全局 Settings 不提供 Project Domain 编辑入口。
4. 新 Session 在输入框中用只读小按钮显示所属 Project 的 Domain，不能在 Session 内改选。
5. 修改 Project Domain 后，清空当前会话的 Broker Scope。Broker 在主进程拒绝与 Project Domain 不符的解析请求。

### 旧数据

已有的 Sobel 示例归属 Chip。旧版本创建但没有 Domain 的 Project 保留目录绑定，进入详情页补选并保存 Domain 后才能开始新 Session。

### 实施范围

桌面端的项目创建流程、项目详情页和只读 Domain 按钮遵循本决定。Domain 选项来自已注册的领域能力，不在通用 UI 中写死 Chip、PCB 列表。

## PD-002：项目创建入口与 Domain 标识

- 日期：2026-09-23
- 状态：已确定
- 来源：Projects 侧栏与 Codex 风格对齐的反馈

### 背景

把“Add local project…”作为项目列表的一整行，会让创建动作看起来像一个已有项目；先弹系统目录选择器，也使用户在看到项目名称和 Domain 前就进入文件选择。Domain 在项目列表中缺少可见标识。

### 决定

1. Projects 标题旁提供「＋」创建入口。点击后先打开新项目界面，在其中填写名称、选择本地目录及 Domain，最后明确创建。
2. Domain 使用带专属 emoji 的小圆角按钮：创建项目时并排展示所有可用 Domain，直接点击选择，不设二级菜单；项目列表与聊天输入框中只读。列表与按钮的名称、emoji 均来自领域注册信息。
3. 项目名称不再重复写入 Domain；已有 Sobel 示例显示为“Sobel example”，旁边单独显示 Chip 标识。

这条决定补充 PD-001 的创建流程和视觉呈现，不改变一个目录对应一个 Project、一个 Project 对应一个 Domain 的关系。

## PD-003：项目文件触发 Viewer

- 日期：2026-09-23
- 状态：已确定
- 来源：对工作区文件树中「VIEWER EXAMPLES」入口的反馈

### 决定

文件树只展示当前 Project 目录中的文件，不提供「VIEWER EXAMPLES」或独立的演示产物列表。用户点击项目文件时，普通文件显示源码；受支持的版图、网表和波形格式自动进入对应 Viewer。Viewer 的小型 fixture 只供开发和测试，不作为产品交互入口。Sobel 示例项目包含从同一设计记录中提取的三种产物，用于验证这一流程。

## PD-004：Agent 过程信息保持紧凑

- 日期：2026-09-23
- 状态：已确定
- 来源：对实时 Thinking 与 Tool Use 展示密度的反馈

### 决定

一次 Prompt 后，思考进行时只显示最近两三行；思考结束后默认收起为一行标题，可按需展开全文。每次 Tool Use 默认折叠，调用参数和返回结果合并在同一条记录中，展开后查看。审批请求仍直接显示操作按钮，以便用户处理。

## PD-005：Broker 在消息流中按工具调用呈现

- 日期：2026-09-23
- 状态：已确定
- 来源：Capability Broker 卡片与 Tool Use 视觉不一致的反馈

### 决定

一次任务的 Broker 解析在消息流中使用与 Tool Use 相同的默认折叠条目。摘要显示领域、阶段和能力数量；展开后查看上下文选项、选中的能力、Skill/Tool 数量和按需披露详情。Debug 模式的 L0–L3 Trace 留在该条目的展开内容中，不在消息流额外铺开一整块日志。

## PD-006：默认 Skill 与 MCP 按 Project 管理

- 日期：2026-09-23
- 状态：已确定
- 来源：默认 MCP/Skill 由仓库接入，并能在每个 Project 中手动禁用
- 原因：不同项目对同一默认资源的适用性不同，禁用状态不能污染其他项目或仓库默认配置。

### 决定

仓库声明默认 Skill 和 Domain MCP；每个 Project 独立保存禁用项，而不是修改仓库默认声明或全局 Settings。项目详情页显示该 Domain 的资源及开关。变更资源后清空当前会话 Scope，下一次任务重新解析。CLI 以显式禁用参数表达同一策略，便于 Bench 固定实验条件。
