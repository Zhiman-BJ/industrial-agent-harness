# macOS Electron 开发启动

## 已确认的启动边界

2026-10-20，本机从 ChatGPT 受限命令进程直接启动 Electron 44.0.0 时，在 AppKit `_RegisterApplication` 阶段收到 SIGABRT，尚未进入 Harness JavaScript。只读 Mach lookup 诊断对 `com.apple.coreservices.launchservicesd`、`com.apple.windowserver.active` 均返回 `1100 / BOOTSTRAP_NOT_PRIVILEGED`。

同一官方 Electron 二进制通过桌面应用启动通道成功打开。2026-10-20 13:15:55（Asia/Shanghai），用户从普通终端打开正式可复用入口后，同步加载干净 main 工作树的原始 `main.cjs`，13:16:09 完成真实 `--ui-selftest` 并正常退出 0。主可执行文件仍名为 `Electron`，原生 `app.isPackaged` 为 false，无属性替换。[验收记录](evidence/macos-gui-20261020.md)保存了运行身份、日志摘要及哈希。此前两次退出 1 的具体原因因旧入口未捕获标准错误而无法追溯，不能据此次通过倒推其原因。

这修复的是本仓库的本地启动入口及失败诊断。宿主进程的服务访问限制，以及 AppKit 在该限制下的原生 abort 行为不由 Harness 更改。相同上游报告：[Electron #52815](https://github.com/electron/electron/issues/52815)、[Codex #30043](https://github.com/openai/codex/issues/30043)。

## 使用

先安装依赖并构建：

```sh
pnpm install --frozen-lockfile
pnpm --filter @industrial-agent-harness/desktop build
```

普通本机终端可继续使用 `pnpm dev`、`pnpm start` 和现有 `test:*` 命令。它们的统一启动器在 macOS 做一次只读服务 lookup；明确拒绝时提前给出诊断，不再启动注定失败的 GUI 子进程。缺少编译器、服务未知或诊断超时按“未知”处理，不能据此声称系统 GUI 不可用；启动器保守停止本次直接启动并提示使用桌面入口，避免瞬时诊断失败再次触发原生 abort。lookup 成功同样不是启动或自测通过的证明。

macOS 命令启动的诊断需要可运行的 Xcode Command Line Tools（`xcrun clang`）。诊断工具缺失时会保留“未知”状态并停止直接启动，也可使用下面的桌面入口；无需更改系统权限。

在命令进程无法访问 GUI 服务的环境中，准备一个独立的本地桌面入口：

```sh
pnpm --filter @industrial-agent-harness/desktop gui:prepare
# 准备隔离 UI 自测入口：
pnpm --filter @industrial-agent-harness/desktop gui:prepare -- --ui-selftest
```

命令打印本次 `.app`、日志和结果文件的绝对路径。通过 Finder 或已授权的桌面应用启动工具打开这个 `.app`。白名单参数与所需测试配置已经固定在入口中，因此不依赖受限调用方转交 `open --args` 或继承整个环境。

`start:gui` 在生成入口后仅尝试一次标准 Launch Services `open`。当前调用环境若连该操作也受限，会保留入口和明确诊断，交由桌面通道打开；不自动重试或申请系统权限。

## 入口与验收

开发入口复制已安装的官方 Electron 到本次私有临时目录，保留其主/Helper 可执行名称和上游文件。仅为新副本添加固定的 `Resources/app` 入口及开发签名；不覆盖用户安装，不改变正式发布的签名流程。

入口在 Electron ready 之前同步调用原始 main，保持其协议注册时序。自测继续使用原 main 的隔离 userData；日志记录进入 main、套件完成、标准错误、退出码和本次运行身份。每次实际启动分配独立 `attemptId`，进入 main 前移除旧结果；验收必须匹配最新启动日志与结果身份，或重新准备一个独立入口。发生在 JavaScript 之前的 abort 无法清除旧结果，不能把残留的通过记录当作本次通过。窗口出现或单独 exit 0 均不能替代自测成功标记。

Mach helper 不链接 AppKit、不创建窗口、不向系统服务发送消息，也不修改权限。每次编译到私有临时目录，执行有时限并清理。默认启动器在明确拒绝时不会解析或执行 Electron。

启动器自身的参数、文件边界、日志、失败路径及跨平台行为由桌面 Node 测试覆盖；桌面启动成功需要另有真实 GUI 日志和退出结果。
