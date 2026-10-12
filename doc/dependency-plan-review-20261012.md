# REA 安装方案评估（2026-10-12）

状态：设计建议，尚未实施。基于用户提供的《Industrial Harness — Domain Pack 安装行为改造（精简开发 Plan）》及当前 runtime-distribution-v2 实现。当前已实施范围见 [v2 说明](runtime-distribution-v2.md)，实际验收见 [QA](qa-runtime-distribution-v2-20261012.md)。

方案能补齐 v2 的依赖准备体验，适合在现有两仓增量实现。最有价值的增量是自动只读检查、可审阅且不可变的补齐计划、逐能力诊断，以及持久化失败恢复入口。

## 当前实现与增量

| 环节          | 当前 v2                                                     | 建议补齐                                                            |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| 安装 Pack     | 五域源码包独立安装，不自动安装完整软件                      | 安装结束自动运行受信任的只读检查，直接显示下一步                    |
| 检测与选择    | 用户主动检测；关联本机应用或明确准备容器/软件；远程安全配置 | 推荐可用方案及理由，展示兼容版本和能力覆盖                          |
| 安装预览      | 有 Pack 体积估算及显式准备按钮                              | 软件级来源、版本、下载/额外磁盘、权限、许可提示、目标路径与分步计划 |
| 能力就绪      | 按选中 profile 过滤工具；配置不冒充远程握手                 | 按 capability 汇总 ready/degraded/unavailable 及具体阻塞依赖        |
| 失败恢复      | 取消清理、校验缓存、重试、损坏连接明确重置                  | 统一持久任务日志；重试失败步骤、重开恢复及清理状态                  |
| REA / Windows | 本轮未接入                                                  | 固定平台 bundle、真实 MCP/Provider 验证、Windows 专项               |

## 建议修改附件的六处

1. **保留唯一声明来源。** `runtimeAssets` 管产物身份，`executionProfiles` 管执行方案及工具/资产关系。新增 dependency 元数据只补依赖图、版本/ABI约束、检测和许可提示，通过 ID 引用现有声明；不要再维护另一份 capability 就绪映射。Owner 持有领域语义，Host 负责通用验证、计划和执行生命周期。
2. **把基础 Pack 激活与环境绑定分开。** 默认先装基础 Pack，再准备用户选中的依赖，检查成功后关联环境。可选或尚未选用的依赖失败不阻断 Pack。保留旧版本只属于明确选择的联合升级事务，不能恢复为整域强制下载。用户自行安装的软件、Pack 和项目绑定也不能承诺同一事务完全回滚。
3. **安装计划锁定实际变更。** Plan 包含 Pack/目录摘要、profile、recipe 版本、产物摘要、检测快照、目标位置、磁盘预算、权限、选定操作及有效期。审批绑定 plan hash 与操作 ID；apply 前重查前提、空间和租约，变化时重新计划，不能静默换版本、镜像源或执行位置。持久日志应区分准备、应用、验证、绑定和清理；完成的外部系统安装未必可回滚。
4. **检查与修复留在正确层。** 可在共享环境服务提供 `inspect/plan/apply/doctor/repair`，CLI/Desktop 仅展示；领域探测规则由 Owner 提供，Core 不内置 Ghidra/JDK/Hopper 语义。Doctor 是环境/连接健康度，工程结果仍由 canonical Runtime/Verifier 验收。无可靠许可接口时显示“需用户确认”，不能推断拥有许可证。
5. **npm Recipe 使用完整固定产物。** 优先发行已锁定 Node 范围、传递依赖、平台二进制、哈希和许可清单的 bundle；不在用户机器运行浮动 `npx @latest` 或任意生命周期脚本。内置 Node 的版本/ABI、子进程和沙箱能力需实测。复用 REA provider/doctor；不要让 REA setup 修改 Harness 之外的客户端注册。
6. **收紧 Docker-free 与平台承诺。** 按经过验证的 capability/profile 承诺无需 Docker。Go 检测器不替代 EDA/PCB/DXF 的完整工具链。Windows recipe 未经真实普通用户安装、取消、恢复和权限验证保持 unsupported。REA 大工具目录作为独立 MCP 索引/渐进披露改造，不以盲目增加 128 上限代替内存、分页、schema 和授权边界。

## 缺软件时的目标交互

安装领域包完成后，自动检查并显示：

> 领域包已安装。已可使用：项目文件与现有成果查看。PCB 原生检查尚不可用：未找到兼容 KiCad。
>
> 选择已有安装 · 打开官方安装页面 · 查看托管安装计划 · 查看可用远程方案

点击托管安装计划才展示版本、来源、体积、安装位置和将启用的具体能力；用户选择后准备，结束再运行 Doctor。安装失败时保留已可用功能并显示失败步骤、重试和诊断入口。服务配置完成只显示“已配置，等待连接验证”。

“自动检查”仅指受信任、限时的只读检查，不自动下载、请求提权或关联新环境。“继续安装”需要实际恢复点；仅复用完整缓存的实现应表述为“重试并复用已验证缓存”。

## 实施顺序建议

1. 在现有五域增加安装后只读检查、逐能力状态与补齐建议。
2. 建立统一的不可变 Plan、授权范围、分步任务日志和恢复语义。
3. 以 REA 固定 bundle 验证“基础分析可用、可选 Provider 缺失不阻断”；独立解决大工具目录。
4. 扩展并真实验收 Windows Recipe，再逐步补复杂工具链的原生 profile。

## 参考核对

- [REA Setup](https://github.com/morluto/rea/blob/main/src/application/Setup.ts) 实现 discovery、plan、dry-run、交互选择/确认、apply、最终 Doctor 和清理结果；其客户端注册逻辑不应照搬到 Harness。
- [REA 安装文档](https://github.com/morluto/rea/blob/main/docs/installation.md) 区分包安装与外部配置，支持按 Provider 诊断；Ghidra/JDK 仍由用户准备，Hopper 初次许可/试用选择仍可能需要用户操作。
- [REA macOS Hopper](https://github.com/morluto/rea/blob/main/src/application/MacHopper.ts) 有受限来源、签名校验、暂存和清理；当前通过在线发行元数据选安装产物，Harness 应改用自己的已审核不可变发行锁。
- Harness 当前 [external-client](../packages/domain-mcp/src/external-client.cjs) 对超过 128 项工具明确报错，并有分页循环保护；没有静默截断，也尚不支持完整大目录。
