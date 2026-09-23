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
