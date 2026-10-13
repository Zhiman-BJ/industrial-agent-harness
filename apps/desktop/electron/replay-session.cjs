'use strict';

// 轨迹重放演示 Session（--replay-demo）。实现 TaskService 所需的 agent
// 表面（run / approve / answerQuestion / interrupt），把录制 bundle 里的
// AgentEvent 按录制节奏（长等待按 harness-replay 同款阈值压缩）经 emit
// 灌回产品的事件咽喉。这个 emit 正是 recorder 当时旁听的同一个函数——
// 重放与 live 走完全相同的渲染、持久化与侧栏路径。
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BUNDLE = '/tmp/zm-replay-demo/bundles/agent-task';
const GAP_THRESHOLD_MS = 5000; // 与 packages/harness-replay timeline.cjs 默认压缩对齐
const GAP_CAP_MS = 1500;

function loadTurns(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'recording.json'), 'utf8'));
  const lines = fs
    .readFileSync(path.join(directory, manifest.events.file), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  const records = [];
  lines.forEach((line, index) => {
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      // 与 harness-recording loader 一致：只容忍尾部撕裂行。
      if (index !== lines.length - 1) throw error;
    }
  });
  const order = [];
  const byTurn = new Map();
  for (const record of records) {
    const id = record.origin?.turnId || 'turn-1';
    if (!byTurn.has(id)) {
      byTurn.set(id, []);
      order.push(id);
    }
    byTurn.get(id).push(record);
  }
  return order.map(id => byTurn.get(id));
}

class ReplaySession {
  // TaskService 的构造签名：emit 是第 5 个参数；随后还会被
  // entry.agent.emit = emit 重设（同一个函数引用）。
  constructor(_projectPath, _getScope, _readArtifact, _detail, emit, _getConfig, _createSession) {
    this.emitRef = emit;
    this.interrupted = false;
    this.turnIndex = 0;
    this.turns = loadTurns(process.env.REPLAY_BUNDLE || DEFAULT_BUNDLE);
    // chat:list reads entry.agent.pendingApprovals/pendingQuestions .size.
    this.pendingApprovals = new Set();
    this.pendingQuestions = new Set();
  }

  async run() {
    // 每次 run = 一个用户轮次：第 N 次提交重放录制里的第 N 轮。
    const turn = this.turns[this.turnIndex] || [];
    this.turnIndex += 1;
    let previousMs = 0;
    for (const record of turn) {
      const gap = record.relMs - previousMs;
      previousMs = record.relMs;
      await new Promise(resolve =>
        setTimeout(resolve, Math.max(0, gap > GAP_THRESHOLD_MS ? GAP_CAP_MS : gap)),
      );
      if (this.interrupted) return;
      this.emitRef(record.event);
    }
  }

  // 录制里的 approval-resolved / question-resolved 事件已带结论，无需交互。
  async approve() {}
  async answerQuestion() {}
  interrupt() {
    this.interrupted = true;
  }
}

module.exports = { ReplaySession, loadTurns };
