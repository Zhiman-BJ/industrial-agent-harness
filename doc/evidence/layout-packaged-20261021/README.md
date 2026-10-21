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
