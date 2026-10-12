# 新用户安装前置条件、取消与恢复 QA（2026-10-12）

本次在 macOS arm64、Node v26.10.0 上验证实际 CLI → 已签名 Pack → 生产安装器 → 实际 Docker → installed runtime factory。主回归 8 项通过；另外确认了 CAD 在大归档下载前没有预检 Docker 的体验问题。主回归通过不表示该问题已经修复。

- Harness 锚定提交：`56c13604ca9956a57aa3585c4f920bb7e3409b21`。本次脚本和其他并行 QA 文档属于工作区新增文件，实际快照见证据中的 `git-status.txt`。
- Owner：`e7347c14bddc956ed0336570dea0af652ccec296`，版本 `0.6.0`，content SHA-256 `4388bc7239eb2f322e45700230b4b8ebc28af6ddc99e6c17ff83c34651dfc2f6`。
- 最终主回归：`dist/qa-first-install-20261012/prerequisites/qualified-final/summary.json`，UTC 05:16:02–05:16:25。
- 补充顺序诊断：`dist/qa-first-install-20261012/prerequisites/asset-order-observation/`。

## 可重复执行

已安装锁定的仓库依赖、实际 Docker 可用且可访问 Harbor 后，在仓库根目录运行：

```bash
node scripts/qa-fresh-install-prerequisites.cjs dist/qa-first-install-20261012/prerequisites/NEW_RUN
```

必须提供不存在的新目录。脚本在写入证据前限定 macOS arm64，拒绝覆盖旧证据，固定本次完整提交 SHA，保存子进程输出和安装状态，并在断言失败时非零退出。缺 Docker 测试通过子进程 `PATH=/usr/bin:/bin:/usr/sbin:/sbin` 实际触发 `ENOENT`，不使用假 Docker 可执行文件；不把其他平台的系统 PATH 假定为无 Docker。服务不可达测试只给子进程设置一个短且不存在的 Unix socket `DOCKER_HOST`，不会关闭真实服务。

脚本使用隔离的 store、配置和 HOME；Docker 客户端只读取已有 Docker 配置并保留已有镜像层。它不删除用户缓存、镜像、容器或全局配置，不安装 KiCad、FreeCAD 或 Godot 原生应用。所有容器都由生产 backend 管理。本次 native Action 对应容器已确认移除，自建 TLS 服务已关闭，临时签名私钥已删除；证据中的 CA 和签名公钥不是用户凭据。

## 实测结果

| 用例                 | 实际结果                                                                                                                                                   | 持久状态与重试                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 缺少 Docker          | 安装失败，提示安装并启动 Docker、重试准备；原始错误 `spawn docker ENOENT`                                                                                  | 未显示 `ready`/`activating`，没有激活 Pack；journal `failed`、`active=false`，无锁、partial 或 staging 残留                                                                     |
| 恢复正常 PATH        | 新子进程对同一 store 重试安装 Chip 成功                                                                                                                    | 重新打开 CLI 后 `runtimeState=ready`，journal `completed`                                                                                                                       |
| Docker daemon 不可达 | 实际 Docker 客户端报告 `failed to connect to the docker API ... dial unix ... connect: no such file or directory`，安装器保留安装/启动 Docker 并重试的提示 | 无误报就绪、无激活、无锁或 partial 残留；重新打开显示失败已结束                                                                                                                 |
| 恢复正常 Docker 连接 | 同一 store 重试 Chip 安装成功                                                                                                                              | 新进程重新读取 `runtimeState=ready`                                                                                                                                             |
| 下载中取消后重试     | 实际收到 Chip `.hpack` body 字节后向 CLI 发 SIGINT；提示 `Domain preparation cancelled.`                                                                   | journal `cancelled`、无激活和临时残留；同一 store 重试成功并重新打开为 `ready`                                                                                                  |
| 恢复后实际工程运行   | 安装出的 Chip 使用 Owner `examples/managed-rtl`，真实 factory 执行 `chip.rtl.verify`                                                                       | 原生 Verilator 工程验证 `passed`，不是退出码或 fixture PASS；本次容器清理确认                                                                                                   |
| CUDA 未配置服务      | 安装后明确显示 `external-dependencies`，列出两个已认证 Compiler/Evaluator 服务前置条件                                                                     | Owner `examples/square` 真项目；已声明的 `cuda.candidate.compile` 被拒绝；installed plugin `available=false`、`tools=[]`，Action `failed`、Verification `insufficient_evidence` |
| 既有下载生命周期回归 | `packages/pack-manager/src/download-lifecycle.test.cjs` 2 项通过                                                                                           | 覆盖签名 HTTPS 降级拒绝、stall、取消、保留旧版本、重试成功；属于真实传输 + 合成归档测试                                                                                         |

每次失败和重试都有 `*.stdout.log`、`*.stderr.log`、`*.result.json`；重新打开时的完整结果保存在 `*-reopen.result.json`。恢复后的工程结果见 `chip-after-recovery-native.result.json`，容器清理见 `own-container-cleanup.log`。

缺 Docker 时的用户提示原文：

```text
Docker runtime is unavailable. Install and start Docker (Docker Desktop on macOS), then retry preparation. spawn docker ENOENT
```

CUDA 未配置时，安装列表准确说明服务必需；直接调用工具的错误仅为 `Tool is unavailable in this runtime.`，具体接入方向需要查看列表中的 prerequisites。这是提示细节不足，不是错误就绪或工程误判。

## 补充发现：大下载前未预检 Docker

对真实 CAD assets `[freecad: macos-app-dmg, cad-dxf: docker-image]`，使用全新 store 和无 Docker 的子进程 PATH，运行生产 `RuntimeAssetManager.ensure`。command 观察器仅记录并委托生产 `run`，没有模拟执行结果。

实际首先进入 FreeCAD `downloading`，`received=0`、`total=649760538`，此时 command 列表为空，尚未尝试 `docker info`。首次下载进度回调主动触发 `QA_STOP_BEFORE_BODY`，在发起 body 传输前停止；两个 asset 均 `ready=false`，无 prepare/install 锁和 partial 残留。

这确认了前置检查顺序问题：没有 Docker 的用户可能先完成约 650 MB FreeCAD 下载和应用准备，才被后面的 DXF 容器前置条件阻止。生产代码按 assets 顺序逐一准备；PCB 的 native-app → Docker 顺序同样存在这个代码路径，但本次低成本诊断只实测 CAD。建议在任何大归档传输之前统一预检待准备资产要求的 Docker。**本次没有修改生产代码，也没有把受控零字节取消当作真实冷下载或原生安装验收。**

证据：`asset-order-observation/observation.stdout.json`、`observation.stderr.log`、`cleanup.json`。

## 独立诊断：Godot 导入与 macOS 字体沙箱边界

桌面首任务的 Godot `--headless --text-driver Dummy --import --quit` 虽然退出 0，但原始日志两次报告无法读取 `/Users/roger/Library/Fonts/NotoSansCJKsc-Regular.otf`，Owner 严格验证拒绝通过。日志另有系统 CA 初始化错误；现有 Owner 已精确识别这条离线诊断，因此它本身不是本次失败的判定原因。

本诊断复制该次运行的输入到独立 `dist` 工程，使用同一个 Harbor 安装出的 Godot 二进制，SHA-256 为 `c7cccbf8fb143e34e02fd6521e09be2c2b974f0d5db080b19071c9c570718ccf`。没有修改桌面验收工程、生产代码或 Verifier。三组均只执行导入，退出码均为 0：

| 对照                                                | 字体读取错误 | 系统 CA 诊断 | 现有 Owner 对导入的判定 |
| --------------------------------------------------- | ------------ | ------------ | ----------------------- |
| 隔离 HOME，直接运行，无沙箱                         | 无           | 无           | 通过                    |
| 正常父 HOME `/Users/roger`，生产 `executeTask` 沙箱 | 有           | 有           | 拒绝通过                |
| 同一生产 backend，仅诊断性增加用户字体目录只读声明  | 无           | 有           | 通过                    |

生产 backend 本身会把任务 HOME 设置为 `work/home`；恢复正常父 HOME 后仍可重现，排除了“仅本次桌面 QA 隔离 HOME 导致”的解释。macOS CoreText 仍会选择当前用户已注册的字体，而生产沙箱未授予该字体目录的只读访问。第三组只增加精确字体目录的只读边界，就消除了阻断错误，且保留了系统 CA 原始诊断。

这是生产 macOS 原生执行的字体访问边界缺口。修复归属应是 Host 通用 macOS backend 的安全字体只读边界，或 Owner Godot 明确声明可信字体依赖的接线；应保留沙箱、严格错误检查及日志，不能开放整个 HOME、网络权限或放宽 Verifier。此次没有实施生产修复。**诊断中的“通过”仅指该次 import 满足现有导入检查，不表示完整工程任务、编辑、验证或桌面恢复已经通过。**

精确摘要路径（相对 Host 仓库）：`dist/qa-first-install-20261012/prerequisites/godot-sandbox-diagnostic/summary.json`。三组各自保留 `result.json`、`tool.log`；两组沙箱对照还保留实际 `task.sb`。

## 证据边界与早期运行

主回归的 catalog 是 QA 临时公钥签名的 loopback TLS feed，`.hpack` 使用最终 Owner 的完整真实 bytes；下载、校验、取消、安装和 Docker 都是生产实现，没有 fetch/installer mock。**loopback `.hpack` 取消不等于 Harbor 原生归档冷下载取消**。Docker 安装会实际检查并拉取固定 Harbor digest，但保留和复用已有镜像层；不声称全新 Docker daemon 的冷层下载已验收。Harbor 大归档下载及取消证据由本轮独立下载 QA 提供。

没有配置或运行 CUDA 原生服务、GPU，没有使用真实模型 API 密钥，没有重复三套原生应用安装，也没有验证 Windows/Linux 用户环境。架构门通过，主回归是本次窄范围补充，不替代 QA runbook 的完整分层门。

最初 `prerequisites/summary.json` 的 daemon 地址过深，触发 Unix socket 长度限制；该用例已明确改为 `blocked` 并保留原始输出，不作为 daemon 连通性证据。`qualified-r2` 使用短 socket 纠正该测试环境。`qualified-final` 又补强了 CUDA 实际声明工具、完整示例、availability/tools withheld 断言和资源清理，本文结论以最后一轮为准。曾失败的脚本启动目录 `recheck-short-socket` 只含启动快照，未产生安装或验收结果。
