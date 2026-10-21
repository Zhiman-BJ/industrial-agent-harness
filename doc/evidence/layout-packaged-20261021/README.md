# 打包版 GDS worker 修复验证

日期：2026-10-21；平台：macOS arm64。基线 main `8df13ead060c1ec4760f437fd0fd03860a35d753`；叠加 PR #241 的托管 Python 依赖（原 head `83d6ab0`）。本记录不将 beta.7 已发布安装包标记为已修复。

## 修复与发布回归

`electron-builder.config.cjs` 解包 Viewer 的 Python 脚本。RasterService 将完整 `app.asar` 路径段转换为 `app.asar.unpacked`，检查 `layout.py`、`layout_themes.py` 后使用原有 `-B -E -s -u` 参数启动。进程关闭后报告退出码/信号及最多 4096 字节 stderr 尾部，保留第一次失败原因。

现有 `smoke-packaged-desktop.cjs` 现在强制执行包内模块和解包脚本检查：用发布 Electron 从实际 ASAR 加载生产 RasterService，再由普通 Node 读取真实脚本。设置有效 `KLAYOUT_PYTHON` 后还执行 GDS 到 PNG；`--require-render` 明确要求实际渲染。无解释器时仅报告 `rendered: false`，不能冒充完整渲染验收。

```sh
KLAYOUT_PYTHON=/absolute/verified/python node scripts/smoke-packaged-layout.cjs \
  --executable '/absolute/Industrial Agent Harness.app/Contents/MacOS/Industrial Agent Harness' \
  --require-render
```

macOS `/tmp` 与 `/private/tmp` 别名在真实打包测试中触发过 smoke 的严格路径断言；测试现已先解析物理路径，并增加别名/junction 回归。未放松 archive/unpacked 目录归属校验。

## 实际执行

- Desktop TypeScript/Vite build 通过。
- Viewer、Desktop 依赖解析与托管 Python 相关回归：183/183，零跳过（包括真实 KLayout）。新增进程/打包路径回归另为 8/8；两组不作为互斥全仓总计。
- release-desktop 流程测试：15/15；架构静态 checker 与 contract-policy 11/11 通过。
- 真实 electron-builder 26.15.3 / Electron 44.0.0 生成 macOS arm64 `.app`。包内 RasterService 加载 synthetic `PACKAGED_TOP` 单层 GDS，成功生成 128×128 PNG；外部普通 Node 可读取两份解包脚本。
- 同一 `.app` 包内 RasterService 再加载只读真实 Sobel GDS：`sobel_top`、22 图层、KLayout 0.30.12、1200×800 PNG，源哈希前后一致。Python 实际 spawn 参数为 `.asar.unpacked/.../layout.py`；没有脚本 shim、源码脚本回退或覆盖已安装应用。
- [report.json](report.json) 记录脚本、源文件与输出 PNG 哈希；Sobel PNG 与既有托管依赖记录相同，未重复提交相同图像。

## 限制与未通过项

正常 `stage-desktop.cjs` 的 pnpm deploy 被当前环境 registry DNS 失败阻塞。用于本次 worker 验证的包复用既有生产依赖 stage，并覆盖当前候选生产文件及精确 owner 内容，随后运行实际 electron-builder 和当前解包配置；Electron 分发使用已有本地缓存。它不是干净 frozen install 或正式可分发 release 的替代证明。应用未进行本次完整文件树/缩放/全屏 GUI 点击验收；Windows/Linux 真实打包渲染未执行。

完整 portable 尝试出现 4 个 OIDC fixture 的 `listen EPERM` 和 1 个默认用户目录数据库 `chmod EPERM`，均已定向复现；之后 headless pnpm deploy 无进展，已终止，不能报告全量通过。完整架构套件在 Node 26 与 Electron 的 Node 24 均由既有 candidate-fetch 小缓冲负例返回 `spawnSync git ENOBUFS`，未得到断言要求的 size-limit 错误；静态 checker 与 contract-policy 单独通过。未修改这些失败路径、allowlist、workflow 或 architecture policy。新提交仍需托管 CI 验证。

## PCB 模型下载配套修复

同一候选加入通用 `gitlab-repository-files` 下载类型，API 地址按固定 project、完整编码文件路径及 40 位提交 SHA 构造；仅构造器生成的 `ref` query 可用，重定向和最终响应 URL 不能改变项目、文件或版本。旧目录式 schema 1 保留，API 目录使用 schema 2，使旧客户端在安装校验时明确拒绝。失败或未读取的响应体会取消，不激活错误 HTML、403/429 或校验失败的缓存。

下载器与 registry 41/41 通过，连同新增 layout 进程回归为 49/49，零跳过，静态架构 checker 通过。独立审查发现的最终 URL 拒绝时未取消响应体问题已修复并补断言。

网络恢复后，使用与发布候选逐字节相同的生产下载器（SHA-256 `8d1b0595f76fc8911afa60b655cecd7b2b7b43e91fab82ef53e228128ad9bdf5`）及当时的 owner `6d11b38` 完成一份 R_0603 的[真实 API 下载](pcb-api-live-report.json)：官方源仅一次 GET、HTTP 200，实收 40,618 字节且哈希与目录匹配。规划阶段零网络且不创建缓存；离线重开复用缓存，零新增请求。该记录验证真实生产下载链路，仍不替代最终 GUI 点击或全库可达性验收。

配套 owner 最终提交为 `636281205074b3682d3ca4591f47c9eba258d9ee`（原 API 修复为 `24146ec`）：package 0.5.8、PCB distribution 0.3.4；host manifest 和工程 provider 保持 0.3.3，保留托管 KLayout 声明。7,252 份 STEP 的路径、大小、SHA-256、来源和许可证均与原目录一致。实际跨仓离线校验通过，R_0603 条目为 40,618 字节、SHA-256 `1875571c326d0d9e96f36b4efeb8094068ef7619f0a449c781caf0b49c2e5861`；计划阶段零网络、未创建缓存。

**消费身份已补齐，发行验收待完成：** 此前 GitHub 连接器写入返回 `403 Resource not accessible by integration`，Git 推送和 registry DNS 也失败；后续本机 Git/gh 与归档下载恢复，已创建 [Harness 发布草稿 #248](https://github.com/Zhiman-BJ/industrial-agent-harness/pull/248) 和 [owner #53](https://github.com/Zhiman-BJ/industrial-domain-packs/pull/53)。真实消费 pin 安装揭示最初 owner 候选把 distribution 0.3.4 误填为 host manifest.version，导致已有加载器和包构建拒绝。最终提交 `6362812` 在 owner 修正该字段并补充独立身份契约，保留 Harness 原校验及工程 Runtime；完整 owner 测试 125 通过、0 失败、1 个既有容器环境跳过，真实 KLayout probe 通过。

从真实 codeload 下载的归档为 2,412,708 字节；652 个跟踪文件的内容与模式、583 项 content-lock 及 package inventory 均匹配该 owner 提交。pnpm 生成的 SHA-512 integrity 与独立计算值一致：`sha512-MOfdRQrnC9ba+alCuE+P8Z64JPDNRhc/eSLdJuraGdS5LUxSjJC/h1oBkW7vqrN6r840Gi05OQ2InXbhEDg7JA==`。Harness 的 root、CLI、Desktop 和 peer/lock 已切换到精确身份。上文实际 `.app` 渲染证据仍对应原 `1117d840` 依赖阶段；最终 pin 的干净打包、托管 CI 与完整 GUI 验收仍待完成，beta.8 尚未发布。

最终消费 pin 的 `pnpm install --frozen-lockfile --ignore-scripts` 通过，随后静态架构 checker、layout/API/registry/contract/release-flow/真实包构建组合回归 77/77、`check-pack-release.cjs` 17/17 均通过、零跳过。此前暴露的 `Invalid repository Domain Pack declaration` 已通过实际加载、分发构建和消费路径复验修复。`--ignore-scripts` 的依赖安装不代表已完成最终应用打包。
