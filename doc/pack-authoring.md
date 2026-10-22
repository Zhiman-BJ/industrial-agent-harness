# 独立开发与验证 Domain Pack

本教程从一个仓库自有的 Skill-only 示例开始，完整经过校验、构建、安装、动态发现、Broker
Scope 和会话资源交付。示例目录是
[`packages/pack-manager/examples/review-pack`](../packages/pack-manager/examples/review-pack)，
没有原生 Tool 或工程 Verifier，也不改变 Core 源码。

以下命令在仓库根执行，要求 Node.js 24 及已安装的 workspace 依赖。使用隔离临时安装库；
最后删除该临时目录即可清理，不操作用户默认安装库。

## 1. 声明资源与能力

`bundle.json` 必须包含 `schemaVersion: 1`、`coreApi: 1`、Domain、三段版本、标签、
`capabilities / skills / providerPacks` 数组。Capability 声明阶段、关键词、优先级及 Skill/Tool
引用；被引用 Skill 必须在同包注册，每个 ID 唯一，Skill 的入口位于 `skills/` 下且名为 `SKILL.md`。
详情直接参见可执行示例，避免复制一套与 schema 漂移的简化 manifest。

每份 Skill 保留完整目录；Markdown 中的 `references/criteria.md` 和
`assets/report-template.md` 在源码、归档、安装和会话中使用相同相对路径。
新增资源直接置于该目录，并提供真实许可材料。包不得含软链、绝对路径、`..`、特殊文件或超限资源。

校验命令只输出目录身份、兼容版本、文件数量、压缩大小与摘要：

```sh
node scripts/build-external-domain-pack.cjs packages/pack-manager/examples/review-pack
```

## 2. 构建归档

```sh
TASK_PACK_TMP="$(mktemp -d)"
export TASK_PACK_TMP
node scripts/build-external-domain-pack.cjs \
  packages/pack-manager/examples/review-pack "$TASK_PACK_TMP/review.hpack"
export INDUSTRIAL_HARNESS_PACK_STORE="$TASK_PACK_TMP/store"
```

脚本要求 `LICENSE`、`THIRD_PARTY_NOTICES.md`，校验后写入 `.hpack`；已有输出拒绝覆盖。
Pack Manager 解码归档时再检查必需 Skill、Provider 和 Runtime 入口。

## 3. 本地开发安装

桌面生产安装只接受信任公钥验证过的 HTTPS 目录。以下本地 Node 片段显式使用
`allowUnsigned: true` 与内存归档，供独立开发者测试自己刚构建的包：

```sh
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { PackManager, decodeArchive, digest } = require('./packages/pack-manager/src/index.cjs');
const bytes = fs.readFileSync(path.join(process.env.TASK_PACK_TMP, 'review.hpack'));
const { bundle } = decodeArchive(bytes);
new PackManager().install({
  domain: bundle.domain, version: bundle.version,
  sha256: digest(bytes), size: bytes.length,
  platforms: [`${process.platform}-${process.arch}`],
}, { bytes, allowUnsigned: true }).then(pack => console.log(pack.domain, pack.version));
NODE
node -e "console.log(new (require('./packages/pack-manager/src/index.cjs').PackManager)().list())"
```

安装库动态发现 `review-fixture`，不要求编辑静态 Domain 注册表或 Core。

## 4. 验证真实披露与附属资源

以下片段直接检查生产 Registry/Broker 与资源材料化；不启动模型，也不作为单独的 CLI 产品。输出 Scope 必须包含 `review-fixture.inspect`，并读取完整相对参考与模板：

```sh
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { loadRegistry, materializeSkills } = require('./packages/domain-skills/src/index.cjs');
const { resolve } = require('./packages/capability-broker/src/index.cjs');
const registry = loadRegistry();
const { scope } = resolve({ domain: 'review-fixture', stage: 'review', task: 'inspect report' }, registry.capabilities);
const directory = materializeSkills(scope, path.join(process.env.TASK_PACK_TMP, 'session'));
for (const resource of ['references/criteria.md', 'assets/report-template.md'])
  console.log(fs.readFileSync(path.join(directory, 'review-fixture.inspect', resource), 'utf8'));
NODE
```

需要模型生成报告时，在桌面 Model API 设置中配置模型，新建绑定 `review-fixture` 领域的专用项目并发送任务。该示例没有工具和独立验证器，模型生成的报告不能建立工业验收。

## 5. 发布、更新与失败行为

生产发布者使用 `signCatalog(payload, keyId, privateKey)` 生成 Ed25519 签名目录，并把目录与
归档放到 HTTPS。`payload` 包含容器版本、`stable / beta` 渠道和 Pack 列表；每条记录提供
Domain、版本、归档摘要、大小、URL 和真实支持的平台列表。私钥保留在发布环境；消费方明确
信任对应公钥。生产安装示例：

应用发行方配置受信目录与公钥后，在桌面能力中心选择该领域并安装。

上面地址和公钥文件由实际发布者提供；应用默认消费 `stable` 渠道。公钥文件形状为
`{"publisher-key-id":"-----BEGIN PUBLIC KEY-----..."}`。仓库自有发布可使用
`HARNESS_PACK_CHANNEL=stable`、`HARNESS_PACK_SIGNING_KEY_FILE`、`HARNESS_PACK_SIGNING_KEY_ID`
与 `scripts/build-pack-distribution.cjs`；该命令构建内置领域，不替代外部源目录构建命令。

升级修改 Pack 版本并重新构建、签名。`coreApi` 未支持、文件摘要损坏、必需资源缺失时，旧活动版本
保留；使用租约期间升级或删除被拒绝。Skill Scope 更换以完整树替换；材料化失败保留先前有效 Scope。
当前容器支持 Core API 1，不自动忽略未来 API 或把旧工程记录提升为新版本事实。

```sh
node scripts/check-pack-release.cjs
```

这个 gate 经过真实作者构建命令、归档、安装、Broker 与会话，核对 refs/assets 内容，并覆盖
失败保留旧版本、版本不兼容、软链、越界、资源上限、安装后损坏和旧 v1 安装。另检查全部内置
公开归档的许可和自有脚本，确认 PCB 私有 Skill 正文仍在外部。

## 6. 从 Skill-only 到工业 Runtime

现有受信任 Pack 可在 Provider Pack 声明 `runtime: {"entry":"runtime/index.cjs"}`。
入口位于 `domain-packs/<packDirectory>/`，完整代码随归档携带并通过资源库存校验。
Runtime 模块向共享工业运行时注入 StateProvider、Tool 与 Verifier；具体导出与示例见
[`domain-packs/chip/runtime/index.cjs`](../domain-packs/chip/runtime/index.cjs) 和
[Domain Runtime 文档](../packages/domain-runtime/README.md)。这些扩展执行受信任代码；不要把签名
目录或文件校验当作通用第三方代码沙箱。

原生 Provider backend 和专业工具环境仍有仓库注册及平台边界。新工业集成必须经真实运行时，
声明修改风险及独立验证，使用[版本化工业契约](contracts-versioning.md)，并添加状态迁移、失效、
失败和恢复测试。Viewer 不能更新工程状态。仅修改 Skill、完成构建或获得一次模型输出都不满足工业 DoD。
