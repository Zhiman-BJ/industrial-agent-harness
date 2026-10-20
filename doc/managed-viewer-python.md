# 托管的版图 Viewer Python

GDS/GDSII、OAS/OASIS Viewer 的 Python 环境由共享 Pack Manager 管理。Chip Pack owner 声明固定的 CPython 3.12.15（Astral PBS build `20261013`）与 KLayout 0.30.12 wheel；Harness 不维护另一份领域版本表。

在领域包设置里选择 **Install viewer support / 安装查看器支持**，或对已安装包选择 **Prepare / repair viewers / 准备 / 修复查看器**、**Check / repair viewers / 检查 / 修复查看器**。这些操作复用现有进度、取消、失败记录和重试入口。仅准备 Viewer 不要求 Docker，也不准备无关原生应用。完整领域安装仍保留原来的工程依赖检查；Viewer 就绪与工程工具链就绪分别显示。

CLI 使用相同安装器：

```sh
industrial-harness domains install chip --viewer-only --catalog HTTPS_URL --keys-file KEYS.json
industrial-harness domains repair chip --viewer-only
```

源码维护者也可运行 `pnpm --filter @industrial-agent-harness/desktop setup:layout`。该入口现在调用同一托管安装器，使用私有完整 Python，不再创建工作树 venv，也不要求宿主 Python 或 pip。

## 安装与修复边界

- 固定 HTTPS URL、精确大小及 SHA-256 覆盖解释器归档和每个 wheel。下载先进入私有临时文件，通过校验后才成为可复用缓存；只读状态查询和打开 GDS 不会下载。
- 环境位于 Pack store 的 `.python-environments/`，与工程目录、全局 Python 和 Pack 文件分开。解释器、pip 及上游许可保留在固定归档的完整私有树内。
- 安全归档清单检查拒绝越界路径、外部链接、特殊文件、重复条目和超额展开。pip 使用已校验本地 wheel、`--no-index --no-deps --require-hashes --only-binary=:all: --no-compile`，不在线解析或编译依赖。
- 安装前后均执行精确版本、模块导入与 owner 提供的 64×64 PNG 渲染探针。最终路径再检查，避免重定位后才发现环境失效。检查失败的旧环境保留文件，但不会继续标为就绪。
- 中断等待正在运行的安装进程结束后清理 staging。已校验下载可复用；修复会检查完整安装内容并重跑真实探针，删除或损坏的模块可通过显式修复恢复。
- 新打开文件时重新解析依赖；同一解释器上的连续缩放/平移复用 worker，仅做轻量身份检查。修复、安装或项目切换关闭旧 worker。Python worker 禁用用户 site/startup overrides 与字节码写入，同时保留可信脚本目录中的 `layout_themes` 导入。

路径优先级为显式 `KLAYOUT_PYTHON` → 当前领域已安装 Pack 声明的就绪环境 → 仅源码开发模式的旧 `.venv-klayout` 兼容路径。显式 override 无效会报错，不自动改用另一套环境。已打包程序不搜索源码工作树；用户通过领域包设置准备或修复依赖。

四个平台有固定资源声明：macOS arm64、Linux x64/arm64、Windows x64。资源与校验和齐全不代表所有平台的原生安装、动态库和 GUI 路径已验收；只声明实际执行结果，见[本次验证记录](evidence/klayout-managed-20261020/README.md)。

KLayout 是 GPL-3.0-or-later 的独立 Python 渲染进程；解释器与包的原有许可、第三方 notices 保留。查看或成功渲染不更新工程状态，也不代表 DRC/LVS 或制造验收通过。
