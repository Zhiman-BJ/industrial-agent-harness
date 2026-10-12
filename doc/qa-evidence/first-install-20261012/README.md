# 新用户安装 QA 留存证据

对应 [总报告](../../qa-first-install-20261012.md)。这里仅留存小型原始结果和
经人工查看的真实 UI 截图，不包含 DMG、应用、归档缓存、签名私钥或用户配置。
完整现场保留在仓库忽略的 `dist/qa-first-install-20261012/`。

- `payload.json`：实际构建并安装的 ARM64 DMG 身份；未签名、公证。
- `desktop-summary.json`：实际首启、安装、首任务、退出及恢复的分项结果。
- `kicad-first-attempt.json`、`freecad-first-attempt.json`：生产默认冷下载失败的
  原始进度、请求来源和清理结果。两个资产并行，期间重叠了桌面 Godot 下载，
  条件和完整时段见下载分项报告。
- `godot-cancellation.json`、`godot-recovery.json`：后续单独真实下载取消、
  空缓存重试、完整哈希和专属临时 store 清理结果；只验证下载。
- `download-qa-assessment.json`：下载总体失败、并发条件和最终清理。其中路径
  相对原始 `dist/.../downloads/`；原 `godot-isolated/` 下两份 JSON 在这里平铺
  留存，内容未改写。
- `prerequisites-summary.json`：8 项前提、恢复和验证结果；QA 签名的 localhost
  目录承载真实 Pack，Docker 层已缓存，不是公众目录或冷镜像验收。
- `cad-prerequisite-order.json`：CAD 先进入原生归档下载、尚未检查 Docker 的
  零字节受控诊断；不是完整下载安装。
- `godot-first-task-import.json`：真实 DMG 首个工程任务失败时的原生导入结果。
- `godot-font-diagnostic.json`：同一真实 Godot 二进制的三组独立字体访问对照，
  只定位导入问题；诊断权限未进入生产代码，也不算完整工程通过。
- `restart-observation.json`：正常退出没有结束进程；仅终止测试进程后，同一
  profile 重启恢复项目、失败历史与领域状态的观察。
- `quit-observation.json`、`desktop-cleanup.json`：首次退出异常与最终仅清理本次
  自建应用、模型服务的检查记录。

## 截图

| 截图                                        | 证明的事实                                                     |
| ------------------------------------------- | -------------------------------------------------------------- |
| [首启五领域](first-launch.png)              | 空配置首次领域选择，含真实前提及混合语言问题                   |
| [下载进度](godot-downloading.png)           | 真实 Harbor 下载期间的字节数、速度、ETA 和取消入口             |
| [安装就绪](godot-ready-card.png)            | 能力中心中已安装 Godot 的就绪状态                              |
| [实际审批](godot-approval.png)              | 正常聊天中的工具输入与审批界面                                 |
| [首次任务失败](godot-first-task-failed.png) | 批准后的工程证据不足及实际日志产物；不能由安装就绪推导工程成功 |
| [重启后历史](restart-history.png)           | 终止测试进程后重新打开，同一审批与失败历史保留                 |
| [重启后领域状态](restart-domain-status.png) | Godot 就绪、CUDA 外部依赖待配置的状态均保留                    |

截图是测试应用与测试工程，没有替换运行状态或编辑画面。文件字节和 SHA-256
保存在 `manifest.json`，便于追踪后续文档变更是否替换了证据。
