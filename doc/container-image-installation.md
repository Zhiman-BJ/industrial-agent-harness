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
具体实测环境与结果在完成后记录，不能由 portable fixture 推导跨平台或工程资格。

验证已打包应用时，可将 `HARNESS_CONTAINER_INSTALL_EXECUTABLE` 指向其实际可执行文件。
`HARNESS_CONTAINER_INSTALL_IMAGE_CACHE` 可指向前次验证的 `.container-images` 目录，
只复制普通回执文件；正式准备仍检查 Docker 中的当前身份，报告明确标为镜像复用。
