# Domain Pack 扩展契约

Domain Pack 是用户安装或卸载某个工业领域能力的单位。一个 Pack 汇集领域识别、状态、Capability 声明、skills、工具映射、验证器及查看器，而不要求修改 Harness Core。V0.1 以 Chip 和 PCB 检查这套扩展机制是否足够通用。

## 建议组成

```text
domain-packs/<domain>/
├── domain.yaml          领域标识、阶段与资源声明
├── capabilities/        能力声明
├── skills/              工作方法与参考资料
├── tools/               canonical ID 到提供者的映射
├── state/               状态提供者
├── verifiers/           结果检查
├── viewers/             产物呈现接入
└── bridges/             专业软件连接
```

这是逻辑结构提案，不要求所有目录在首版同时出现。Domain Pack 可以选择性引用共享 Viewer、Bridge 或 Tool 实现。Pack 自身版本和所需资源应可独立检查与升级。

## 最小契约

- **识别与状态**：稳定 Domain ID；项目探测规则；阶段、当前产物、问题和指标。路径必须绑定用户选定项目，不能让 Pack 任意访问其他工作区。
- **能力**：每个 Capability 有稳定 ID、适用状态、依赖、冲突与优先级；Skill 与 Tool 通过 canonical ID 引用。
- **动作与验证**：声明动作的输入、输出、风险和验证要求。验证器必须区分执行成功、证据不足和目标未满足。
- **产物**：记录来源、类型、内容身份和所属运行或状态。查看器只消费可追溯产物，不生成替代的工程事实。
- **隔离**：Pack 加载或单项能力失败只影响相应领域能力，不使 Broker 或其他 Pack 整体失效。

## 参考领域

| 领域 | 初始能力示例 | 产物与验证示例 |
| --- | --- | --- |
| Chip | RTL 验证、placement 优化、routing 修复 | RTL、VCD、网表、ODB、DEF、GDS；仿真、时序、DRC、LVS |
| PCB | 原理图检查、布局优化、DRC 修复 | 原理图、PCB、Gerber、报告；电气规则与设计规则检查 |

这些是首批验证候选，具体工具、规模和可用平台需在实现与验收时确认。CAD、CAE 等未来领域应复用相同核心契约，再由自己的 Pack 提供阶段、能力和验证规则。

## 安装与发现

桌面安装包最终应携带 Broker、Kimi 运行时及默认 Pack；额外 Pack 可独立安装。Broker 先读取 Pack 元数据和能力索引，再按项目状态加载所需详细内容。错误的声明需给出可定位诊断，不能静默跳过，也不能破坏已安装领域。安装格式、签名、资源下载和升级策略仍待设计。
