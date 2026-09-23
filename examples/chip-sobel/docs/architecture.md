# Sobel 滤镜芯片 — 架构设计

## 1. 顶层结构

单模块 `sobel_top`（rtl/sobel_top.sv），单时钟 `clk`，同步低有效复位 `rst_n`。
内部四个部分：输入侧 FSM + 行缓存/窗口形成、Sobel 组合计算、数据 FIFO、
配置 FIFO、输出侧 FSM。

```
cfg_* ──► 锁存(帧首) ──► cfg FIFO ──► 输出 FSM 帧参数
in_* ──► 输入 FSM ──► lb0/lb1 行缓存 + 窗口移位链 ──► Sobel 组合逻辑 ──► data FIFO ──► 输出 FSM ──► out_*
```

## 2. 流式窗口形成（1 像素/周期稳态）

- 行缓存 `lb0`（存第 r-2 行）、`lb1`（存第 r-1 行），各 128×8 bit 寄存器阵列，
  按列地址读写；不缓存整幅图像（F6）。
- 消费输入像素 (r,c) 的同一拍：
  - 组合读出 `lb0[c]`、`lb1[c]`（写前旧值）；
  - 三条 2 级移位链更新：t 链←lb0 读出、m 链←lb1 读出、b 链←当前像素；
  - 行缓存滚动写入：`lb0[c]<=lb1[c]`，`lb1[c]<=in_pixel`。
- 消费 (r,c) 时恰好凑齐输出像素 (r-1,c-1) 的 3×3 窗口：
  顶行 = {t1, t2, lb0[c]}，中行 = {m1, m2, lb1[c]}，底行 = {b1, b2, in_pixel}。
- 仅当 `in_r>=2 && in_c>=2`（对应输出内部像素 (r-1,c-1)，范围 1..H-2 / 1..W-2）
  才把二值化结果推入 data FIFO。推入顺序 = 内部像素的行扫描顺序。

## 3. Sobel 计算（组合逻辑，单周期）

- Gx = (p02 + 2·p12 + p22) − (p00 + 2·p10 + p20)，12 bit 有符号，范围 ±1020
- Gy = (p20 + 2·p21 + p22) − (p00 + 2·p01 + p02)
- mag = |Gx| + |Gy| ≤ 2040（12 bit 无符号）
- out = (mag >= threshold) ? 255 : 0（阈值取本帧锁存值 thr_q）

## 4. 输出定序（顺序/不丢不重保证）

- 输出 FSM 按行扫描顺序遍历 (or,oc)：边界位置（首/末行、首/末列）直接发 0，
  内部位置从 data FIFO 弹出一个结果。推入与弹出同为行扫描序，一一对应 ⇒
  不丢失、不重复、不乱序（I4）。
- data FIFO 深度 8。稳态推导：输出 FSM 仅在本行内部像素结果尚未算出时停等，
  推入与弹出均 ≤1/拍，占用峰值 ≤2；`in_ready` 以 `count <= DEPTH-2` 回压兜底，
  即使推导有偏差也不会溢出。
- `out_frame_start` = 输出 (0,0)，`out_frame_end` = 输出 (H-1,W-1)，由位置计数器产生。

## 5. 逐帧配置

- 输入 FSM 在一帧第一个被接收像素处锁存 `cfg_*`（I5），并把 {width,height}
  推入深度 4 的 cfg FIFO；输出 FSM 在开始新帧时弹出。
- 至多两帧在途（输出排空滞后输入约 W+1 拍，远小于最短帧 9 拍的输入时长），
  cfg FIFO 深度 4 有充分裕量；`cfg_full` 同样并入 `in_ready` 回压。
- 行/列计数器：行 16 bit（H ≤ 65535），列 8 bit（W ≤ 128）。

## 6. 时钟/复位/物理约束

- 单时钟 100 MHz（constraints/sobel.sdc：周期 10 ns，输入/输出延迟各 2 ns，
  setup 不确定度 0.15 ns，hold 0.05 ns）。
- 同步低有效复位；`in_ready`/`out_valid` 在复位期间均无效。
- 物理：Nangate45（typical corner），die 250×250 μm，core 230×230 μm，
  引脚 metal2/metal3，信号布线 metal2–metal10，M1/M4/M7 电源网格，
  TAPCELL_X1（间距 120 μm 规则），FILLCELL_X1..X32 填充。

## 7. 风险与对策

| 风险 | 对策 |
|------|------|
| FreePDK45/Nangate45 为教学"假"工艺，GDS 可能不含器件级扩散层，LVS 可能不可行 | 先完成 DRC；LVS 用 Magic 提取 + Netgen 尝试，失败则如实记录为工艺数据限制 |
| FreePDK45 DRC 含天线规则，无二极管可能违规 | 先跑 DRC 看违规类别；必要时插入 repair_antennas（ANTENNA_X1）或记录豁免 |
| 100 MHz 下 128:1 行缓存读 mux + Sobel 组合路径 | 45nm 下量级约 1–2 ns，远低于 10 ns 周期；STA 验证 |
