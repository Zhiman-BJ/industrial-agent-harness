# 版图 Viewer P0 验收记录

2026-10-19。**P0 尚未完整通过**：真实文件后端与 HTTP 路径已有证据，最终生产构建及 48 项架构检查通过；新版浏览器 GPU/原生 Electron 界面未验收。本轮不宣布 UI、首帧、FPS、超大工业版图或 OAS 支持通过。

| 检查 | 状态 | 证据与边界 |
| --- | --- | --- |
| 真实 GDS 几何 | 通过 | [后端原始报告](real-layouts-report.json)、[摘要](backend-summary.json)：189 次顶面 XY 对照和 63 次接缝检查，缺失/多出区域及假墙均为零；[Sobel](sobel-real-oracle.json)、[FIFO](sync-fifo-real-oracle.json)分别保存结果 |
| 缓存与恢复 | 通过 | 每文件 12 轮缓存字节稳定，最多一个存活 worker；真实 `SIGKILL` 后在途请求明确失败，未缓存请求恢复且几何一致，源 SHA-256 不变。重启累计两个 worker 不代表并行两个 |
| 内存观测 | 已记录 | Sobel/FIFO 的 worker 自报峰值分别为 98.67/82.30 MiB；仅限这两个输入与请求集合，属于软监控，不是 Electron/GPU 内存测量或 OS 硬隔离 |
| HTTP 生产服务链路 | 通过 | [http-smoke.json](http-smoke.json)：真实 metadata→overview→detail，Sobel/FIFO 指定层分别返回 226/1214 个三角形；不包含浏览器渲染或 Electron IPC 验收 |
| 预览重新打开 | 通过 | [preview-reload.json](preview-reload.json)：重新打开生成新 token，旧 generation 100 与新会话 generation 1 隔离，精确几何一致；保留生产 generation 防陈旧响应检查 |
| 前端组件回归 | 通过，无 GUI | 本轮修复快速二维对比使用旧 ROI、隐藏二维视图比例变化后未重新 Fit、隐藏选层提示及重复点击 2.5D 重置范围；新增 4 条组件行为回归通过，包含实际 Shift-drag 事件在 120ms 调度前同步发布 ROI。相关回归合计 29/29、TypeScript 检查及最终生产构建通过 |
| 浏览器 GPU / 原生 Electron | 待完成 | CUA 本轮 `getState` 成功后，`getTab`/reset 返回 Transport closed，未取得本轮界面证据。原生尚未运行；旧启动崩溃位于 macOS RegisterApplication→NSApplication、早于 JavaScript，之前提权启动被自动审批拒绝，未绕过限制 |
| 输入覆盖 | 不完整 | 本轮工作区盘点 113 个 GDS 路径、11 个不同 SHA-256、0 个原生 OAS/OASIS；缺少真实大型工业 GDS 和原生 OAS 样本，不能外推完整规模或格式资格 |

## 本轮真实输入

输入字节、完整 SHA-256、dbu、ROI 和层统计见 [real-layouts.json](real-layouts.json)。逻辑出现次数计入层级实例展开后的引用，不等于唯一源图形或 GPU 常驻三角形。

| 输入 | 图层 | Cell | 唯一源图形 | 逻辑出现次数 | 适用范围 |
| --- | ---: | ---: | ---: | ---: | --- |
| Sobel | 22 | 63 | 71718 | 1025550 | 已归档教学工艺产物；未重新执行或验收 EDA 生成流程 |
| sync FIFO | 41 | 77 | 95126 | 536769 | 现有小型 OpenLane 设计；不代表大型工业芯片覆盖 |

后端复测实现见 [test-real-layouts.cjs](test-real-layouts.cjs)，输入统计脚本见 [inspect-real-layouts.py](inspect-real-layouts.py)。与此前合成压力 fixture 的结果分开记录。

## 待执行的人工入口

本机预览：[FIFO 中文预览](http://127.0.0.1:43125/?fixture=sync-fifo-real&lang=zh)。该地址依赖本机预览服务运行，地址存在不构成渲染通过证据。

[run-layout-p0.sh](../../../packages/viewer-builtin/tests/tools/run-layout-p0.sh) 已通过 `sh -n`，本轮未执行。后续需在允许启动的原生桌面环境验证文件树→Registry→Viewer、概览与精确切换、选层/二维对应、缩放/旋转/平移、全屏/退出、隐藏/恢复与失败恢复；结果完成前保留上述待验收状态。


## 公开路径与复现

公开发布时只归一化路径元数据：Sobel 使用仓库相对路径，FIFO 使用 `external-fixtures/sync_fifo.gds` 标识，相关外部来源材料使用 `external-fixtures/sync-fifo-provenance/` 标识。这些外部文件不包含在本仓库中。`provenance.json` 中无关的工作区文件/目录清单已删除，只保留原有扫描计数和范围说明。测量数值、选中来源的 SHA-256、结论及历史实现摘要均未重写；历史实现摘要描述当时运行的脚本，未冒充本次路径整理后的脚本摘要。

三个真实文件验收脚本共用 [输入解析器](load-layout-inputs.cjs)。从仓库根目录运行，提供 Node.js 及 KLayout 0.30.12 Python，并自行提供与清单 SHA-256 相符的 FIFO。相对路径（包括环境变量中的相对路径）都以仓库根目录为基准；可选 `LAYOUT_ACCEPTANCE_MANIFEST` 指定相同结构的输入清单。更换 `LAYOUT_FIFO_FILE` 不会跳过字节数/SHA-256 校验，也不会在缺少 FIFO 时静默缩小验收范围。

```sh
export KLAYOUT_PYTHON=/path/to/klayout/python
export LAYOUT_FIFO_FILE=/path/to/sync_fifo.gds
# 可选：export LAYOUT_ACCEPTANCE_MANIFEST=/path/to/real-layouts.json
node doc/evidence/layout-p0-20261019/load-layout-inputs.cjs
"$KLAYOUT_PYTHON" doc/evidence/layout-p0-20261019/inspect-real-layouts.py --check-inputs
```

以上命令只解析输入和核对摘要，不运行几何验收或压力测试。重新生成输入统计清单时，显式指定新的输出文件；默认输出到 stdout，不覆盖历史证据，也不隐式合并其他临时 fixture：

```sh
"$KLAYOUT_PYTHON" doc/evidence/layout-p0-20261019/inspect-real-layouts.py --output /tmp/real-layouts-reproduced.json
```

统计脚本通过 Node 输入解析器执行相同校验；若 `node` 不在 PATH 中，可设置 `NODE_BINARY`。需要重新执行工作负载时分别运行 `test-real-layouts.cjs`、`../layout-performance-20261019/soak-real-layouts.cjs` 和 `../layout-performance-20261019/probe-generation-latency.cjs`。这三个命令会重新生成各自目录的报告，运行前应另行保存历史证据。本次发布整理未执行这些工作负载。
