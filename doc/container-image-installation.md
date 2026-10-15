# Release tarball 容器镜像安装

镜像配方、依赖锁和 release 由 `industrial-domain-packs` 维护。Harness #172 负责消费，
匿名 HTTPS release tarball 是主通道，不要求登录镜像仓库。构建器原样封装固定 owner 的
`provenance/runtime-distribution.json`，只选择当前 Domain 已发布的镜像。

Desktop 的安装／更新／修复和 CLI 的 `domains install|update|repair` 都进入共享 Pack Manager。
签名目录、包摘要和文件库存校验通过后，先准备原生软件与容器镜像，再原子激活 Pack。
修复从完整性检查通过的安装目录读取锁；环境变量不能将正式安装重定向到其他锁。

## 身份、进度与失败

下载逐块写入临时文件并增量计算 SHA-256，强制匹配锁中的字节数。总超时默认两小时，
停滞超时沿用共享传输层；进度给出已下载字节、速率和可计算的剩余时间。
OCI 检查只随机读取有界的 metadata，跳过层内容，不解包到文件系统。

三种摘要有不同含义：锁中的 `imageDigest` 可以是 registry index；tar 中的 manifest
摘要对应归档单平台镜像；`configDigest` 对应镜像配置。归档 SHA-256 绑定整个文件，
配置摘要与平台必须匹配锁，manifest 和 config 的内容摘要也逐一校验。
Docker containerd 存储使用 manifest ID，classic 存储使用 config ID；安装器兼容两者。
`docker load` 即使只输出 `Loaded image ID:` 也能完成安装，因为最终 tag 来自锁，
不是从人类可读输出中猜测。显式指定的 registry、namespace、tag、digest 不匹配时拒绝。

准备成功后记录镜像回执，并再次检查 Docker 中的实际 tag 身份。列表和修复都会检查当前
Docker；本地镜像缺失或被替换时显示需要准备。临时 tar 在成功、失败和取消后清理。
卸载 Pack 保留 Docker 镜像和小型回执，重装可以复用。下载目录检查磁盘空间；Docker
可能使用独立磁盘，其剩余空间由引擎负责，不能把 UI 的保守展开估算当成实际容量检测。
Docker Desktop 中已安装镜像显示在 **Images → Local**。安装不创建常驻容器；验证用的
临时容器完成后自动清理，因此 **Containers** 页不一定出现新条目。

## 使用与边界

先启动运行 Linux 容器的 Docker engine，再在桌面安装对应 Domain，或使用已有签名 feed：

```sh
node apps/cli/src/main.cjs domains install <domain> --catalog <https-catalog> --keys-file <keys.json>
node apps/cli/src/main.cjs domains repair <domain>
```

开发者单独取镜像时可使用：

```sh
node scripts/acquire-container-image.cjs <owner-directory> <locked-image-id-or-reference>
```

`--keep-archive` 仅保留成功的独立下载。此开发者入口允许向上查找锁和
`INDUSTRIAL_HARNESS_RUNTIME_DISTRIBUTION` 覆盖；正式安装不使用这些发现规则。
尚未发布的镜像保持外部依赖状态，现有原生运行环境声明继续生效。
镜像就绪不代表项目已绑定该镜像；项目的执行配置、主机依赖和领域工程验收仍由 Pack 负责。

Docker 是外部前提，安装器不会自动安装或启动它。没有 `docker` 命令时，Desktop／CLI
提示安装 Docker Desktop（macOS／Windows）或 Docker Engine（Linux）并确保命令可用；
命令存在但引擎无法连接时，提示启动 Docker 或检查当前连接；非 Linux 引擎提示切换 Linux
容器。三种情况都在原生应用和镜像下载前失败，不激活新 Pack，更新时保留旧版本；已有镜像回执也
必须重新检查实际 Docker 身份。不依赖容器的 Pack 仍走其原有安装流程。

## 验证

回归测试覆盖未打 tag 的归档、classic/containerd 身份差异、256 MiB 有界内存下载、
显式引用约束、真实 HTTPS、失败与取消清理、签名包安装、修复锁来源及更新回滚。
真实 release 验证入口：

```sh
pnpm --filter @industrial-agent-harness/desktop build
node scripts/verify-release-image-installation.cjs dist/release-image-installation
```

该入口使用固定 owner 的真实 release URL，建立隔离的签名包 feed 与安装库。CLI 冷安装
会实际下载镜像，随后检查容器能启动、修复并卸载 Pack。Desktop 再通过真实 renderer →
preload → IPC 安装及修复，复用之前验证过的 Docker 镜像。输出包含日志、镜像身份、
Docker 版本、桌面状态及截图；桌面这一步是镜像复用，不宣称第二次冷下载。
2026-10-14 实测在 macOS arm64、Docker Desktop Linux engine 29.5.2（containerd）通过：

- CLI 冷安装实际下载两个 `chip-v0.1.0` release tarball，共 1,976,178,688 字节，完成
  校验、加载、tag、Pack 激活、修复及卸载；成功后无临时 tar。两个 linux/amd64 镜像均实际启动成功。
- 源码 Desktop 和未签名 macOS arm64 打包应用均通过真实安装及 Check/repair 按钮验证，
  签名 feed 连接正常，状态为 ready；这两轮复用已验证镜像，未重复冷下载。
- 实际 release 下载中断后，记录 cancelled，未激活 Pack，未残留临时 tar。
  打包应用另用隔离的非 Linux engine fixture 验证失败提示和不激活行为；该模拟不代表本机 Docker 状态。
- 20 项镜像回归、portable suite（577 通过，1 项既有允许跳过）、架构与发行门禁、
  Electron UI／安装／退出和打包首次启动检查通过。

镜像身份、环境、内存采样及验证范围见[实测记录](evidence/release-image-installation-20261014.json)，
界面见[打包应用截图](evidence/release-image-installation-20261014.png)。首次全流程中的 CLI
阶段通过后，桌面自测监听器的跨进程序列化出错；修复自测后，源码与打包 UI 流程分别完整通过。
classic 存储仅有 fixture 覆盖；本记录不推导 Linux／Windows 的真实镜像安装或领域工程资格。

验证已打包应用时，可将 `HARNESS_CONTAINER_INSTALL_EXECUTABLE` 指向其实际可执行文件。
`HARNESS_CONTAINER_INSTALL_IMAGE_CACHE` 可指向前次验证的 `.container-images` 目录，
只复制普通回执文件；正式准备仍检查 Docker 中的当前身份，报告明确标为镜像复用。
`HARNESS_CONTAINER_INSTALL_NATIVE_CACHE` 可指向已有原生安装包缓存，仅复制按 SHA-256
命名的普通 DMG/ZIP 文件；正式安装仍完整校验大小与哈希，并实际安装、探测应用。
这不会复用镜像回执，报告分别说明原生安装包缓存和镜像冷下载。

命令缺失与引擎不可达也已在 CLI 和打包 Desktop 分别验证通过。在 macOS／Linux 可复现：

```sh
node scripts/verify-docker-prerequisites.cjs <新输出目录> <已有真实-release-验证目录> <打包应用可执行文件>
```

前者仅清空子进程 PATH，后者仅指定不存在的本地 socket；不会卸载、停止或修改本机 Docker。
