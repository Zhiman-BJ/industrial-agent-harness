# 远程 RTL 验证已完成

## 1. `chip.rtl.verify` 工具发现

| 字段 | 值 |
|---|---|
| toolId | `chip.rtl.verify` |
| version | 0.6.1-core.2 |
| risk / effect | mutating / execution |
| verification | remote.reported |
| 描述 | 在受控远程沙箱中执行已批准的 Chip RTL 断言与波形验证 |
| inputs schema | `{ "type": "object" }`（无可选/必填字段名约束；直接以空对象 `{}` 调用被 Broker 接受并完成真实分派） |

Capability `remote.software` 也列出同一条目并注明 "Run this tool in the bound remote sandbox; describe inputs first."。它的允许验证集合是 `remote.reported`，不依赖本地 Shell。

## 2. 实际调用与执行标识

通过 `industrial_action_call` 调用（未走 Shell、未修改输入）：

```
toolId      : chip.rtl.verify
expectedStateId: 88ec6ff9-8a17-4271-bb89-e222bf680354
inputsJson            : {}
```

返回的请求级标识：

| 标识 | 值 |
|---|---|
| runId | `6145c20e-a07f-4f7d-b583-e3239b3fcc75` |
| actionId | `f6ac009f-35a1-41cb-9753-b3beee8552c8` |
| 远程 request | `4b988ce1-eb86-4bf0-86ed-c8194f37ad38` |
| 源 verifier | `f91b4e56-c217-4643-897e-f5e992f037ee` |
| actionStatus | `completed` |
| 新 stateId | `eb6d4958-1129-4c38-a13b-3914ef7851d4` |
| stateStatus | `verified` |

输入文件哈希（与上传一致，未被改动）：
- `eda.yaml` = `3f443071a1acea375d5c86328fb1b5719d5ce1c34bf05a2a820ef5dea3fd1a00`
- `smoke_tb.sv` = `4d87257501bdf363b8c9a30538e724bb8cdc0dc0f6cb94cf9fb556552a6595ff`

## 3. Verifier 结果

```
verification.id          : aa2023c7-3bae-4334-900e-8cc2e723645c
verification.status      : passed
verification.verifierId  : remote.reported
verification.reason      : Remote verifier chip.rtl.assertions:
                          Assertions enabled; testbench reached $finish
                          and produced a real VCD. Functional coverage
                          remains testbench-defined.
metrics.completed        : true
metrics.waveformPresent  : true
metrics.assertionFailure : false
durationMs               : 10900
profileId                : rtl-cpu
toolVersion              : Verilator 5.026 2024-06-15 rev v5.026
nativeVerification.status: PASS
nativeVerification.action: rtl.simulate
compileExitCode          : 0
simulationExitCode       : 0
completionMarker         : EDA_SIMULATION_FINISHED
```

`log.tool`末尾的远程日志印证了真实运行：`HARNESS_REMOTE_SMOKE_PASS` → `$finish` → `EDA_SIMULATION_FINISHED`，由 Verilator 5.026 编译并执行。

## 4. 本次运行产生的产物路径

均落在 `remote-results/4b988ce1-eb86-4bf0-86ed-c8194f37ad38/` 下：

| kind | artifactId | sha256 | 相对路径 |
|---|---|---|---|
| log.tool | `13731205-291c-4d5f-8cc2-dfbb33b53489` | `0c389442…01f8` | `remote-results/4b988ce1-eb86-4bf0-86ed-c8194f37ad38/0-log.tool.log` |
| report.simulation | `14bf7fbb-0e23-4868-be3c-ba6aa86d3978` | `8ac9714f…f6151` | `remote-results/4b988ce1-eb86-4bf0-86ed-c8194f37ad38/1-report.simulation.json` |
| waveform.vcd | `8ff1d66d-b2d3-465d-acf4-b36134d8c954` | `a373b895…d343` | `remote-results/4b988ce1-eb86-4bf0-86ed-c8194f37ad38/2-waveform.vcd.vcd` |

工程目录中的输入文件 `eda.yaml`、`smoke_tb.sv` 未被本次调用改动。

## 5. 结论

本次是对当前已上传的 `eda.yaml` + `smoke_tb.sv` **真实执行**的一次 RTL 验证（由 Broker `remote.reported` 报告型 verifier 评出），`remote.simulate` 在 Verilator 5.026 下编译/仿真退出码均为 0，断言未失败，波形 VCD 真实生成，验证状态 **passed**，DomainState 已推进到 `eb6d4958…/verified`。报告基于本次 `runId=6145c20e…` / `actionId=f6ac009f…` / `request=4b988ce1…` 的新鲜产物，并非旧产物。
