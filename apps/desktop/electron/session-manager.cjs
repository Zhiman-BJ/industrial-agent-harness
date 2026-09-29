// Own independent Kimi instances and captured project/scope state. Selecting a
// chat only changes UI navigation; it must never rebind a running agent callback.
class SessionManager {
  constructor() {this.entries = new Map();}
  get(project, chatId) {
    if (!project?.id || !project.path || !project.domain || typeof chatId !== 'string' || !chatId) throw Error('Choose a project and chat.');
    let entry = this.entries.get(chatId);
    if (entry && (entry.project.id !== project.id || entry.project.path !== project.path || entry.project.domain !== project.domain)) throw Error('Session belongs to another project or domain.');
    if (!entry) {
      entry = {id: chatId, project: Object.freeze({...project}), scope: undefined, trace: [], preparedTurn: undefined, release: undefined, agent: undefined, context: undefined};
      this.entries.set(chatId, entry);
    }
    return entry;
  }
  busy(entry) {return Boolean(entry.removing || entry.release || entry.agent?.running || entry.agent?.turn);}
  matching(projectId) {return [...this.entries.values()].filter(entry => projectId === undefined || entry.project.id === projectId);}
  running(projectId) {return this.matching(projectId).filter(entry => this.busy(entry));}
  assertIdle(projectId) {if (this.running(projectId).length) throw Error('Stop running chats affected by this setting first.');}
  async reset(projectId) {
    this.assertIdle(projectId);
    const entries = this.matching(projectId);
    await Promise.all(entries.map(async entry => {await entry.agent?.close(); entry.context?.close(); this.entries.delete(entry.id);}));
  }
  async remove(project, chatId) {
    const entry = this.get(project, chatId);
    if (this.busy(entry)) throw Error('Stop this chat before deleting it.');
    entry.removing = true;
    try {await entry.agent?.close(); entry.context?.close(); this.entries.delete(chatId);}
    finally {entry.removing = false;}
  }
  snapshots() {return this.matching().map(entry => ({chatId: entry.id, projectId: entry.project.id, running: this.busy(entry), awaitingApproval: Boolean(entry.agent?.pendingApprovals?.size)}));}
  async close() {try {await Promise.all(this.matching().map(async entry => {try {await entry.agent?.close();} finally {entry.release?.(); entry.context?.close();}}));} finally {this.entries.clear();}}
}
module.exports = {SessionManager};
