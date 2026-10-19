const crypto = require('node:crypto');
const path = require('node:path');
const { writePrivateJson } = require('./remote-client.cjs');
const {
  ToolDescriptorSchema,
  IndustrialVerificationResultSchema,
} = require('@industrial-agent-harness/contracts');
const { safeDownload } = require('./remote-gateway-client.cjs');
const { boundedIdentity } = require('./remote-gateway-sessions.cjs');

// Adapter for the shipped synchronous MCP contract. Local Run/Action/State and
// Checkpoint identities belong to IndustrialRuntime; remote receipts remain
// separately attributed, immutable evidence. A null remote state stays null.
function createCurrentRemoteRuntime(options, Base) {
  class CurrentRemoteRuntime extends Base {
    constructor() {
      super(options);
      this.workspace.stateProvider = async () => ({
        stage: null,
        inputHashes: Object.fromEntries(
          this.settings
            .snapshot(this.projectDir, this.binding.files)
            .manifest.files.map(file => [file.path, file.sha256]),
        ),
      });
      this.workspace.verifiers['remote.reported'] = ({ result }) => result.assessment;
    }
    async inspect(context, { execution = false } = {}) {
      const signal = context?.controller?.signal;
      signal?.throwIfAborted();
      this.assertCurrent();
      await this.settings.ensureSynced(this.projectDir, this.domain);
      signal?.throwIfAborted();
      if (context) {
        let pending = this.status(context);
        if (pending && ['submitting', 'running', 'unknown'].includes(pending.status))
          throw Error(
            'The previous remote outcome is unknown. Its saved request must not be replayed.',
          );
        if (pending?.needsImport)
          throw Error(
            'The previous remote result still needs import. Recover it before executing again.',
          );
        // Unresolved project effects cannot be bypassed by opening another chat.
        this.settings.assertTaskIdle(this.projectDir, this.domain);
        if (['pending', 'releasing'].includes(pending?.sessionRelease?.status)) {
          await this.releaseSession(context);
          pending = this.status(context);
          if (pending?.sessionRelease?.status !== 'released')
            throw Error(
              'The previous remote result is saved, but sandbox release is not confirmed. Retry after checking the remote session.',
            );
        }
        // A post-turn refresh must not reacquire the quota just released.
        // Revalidate the catalog over HTTP; execution still checks the live MCP.
        if (!execution && this.inventory && pending?.sessionRelease?.status === 'released') {
          const info = await this.control.info({ signal });
          signal?.throwIfAborted();
          if (info.capabilitySnapshotHash !== this.inventory.capabilitySnapshotHash)
            throw Error('Remote capability inventory changed. Reopen this runtime.');
          this.state = await this.workspace.inspect();
          return this.state;
        }
        const inventory = await context.client.listTools({}, { signal });
        signal?.throwIfAborted();
        if (
          inventory.domain !== this.domain ||
          inventory.protected !== true ||
          !/^[a-f0-9]{64}$/.test(inventory.capabilitySnapshotHash || '')
        )
          throw Error('Remote domain does not expose a protected executable tool inventory.');
        if (
          this.inventory &&
          this.inventory.capabilitySnapshotHash !== inventory.capabilitySnapshotHash
        )
          throw Error(
            'Remote capability inventory changed. Reopen this runtime and resolve a new scope.',
          );
        // The shipped gateway returns the active Pack/profile identity here,
        // while descriptors live in service-info. A catalog entry alone is not
        // execution permission: bind its hash, Pack and active profile, then
        // require the live protected runtime to describe each candidate.
        let candidates = inventory.tools;
        if (candidates === undefined) {
          const info = await this.control.info({ signal });
          signal?.throwIfAborted();
          if (info.capabilitySnapshotHash !== inventory.capabilitySnapshotHash)
            throw Error('Remote catalog and active runtime do not share a capability snapshot.');
          const catalogs = info.domainCatalog?.filter(item => item.domain === this.domain);
          const packs =
            catalogs?.length === 1
              ? catalogs[0].packs?.filter(
                  pack => pack.id === inventory.packId && pack.domain === this.domain,
                )
              : [];
          const profiles =
            packs?.length === 1
              ? packs[0].profiles?.filter(
                  profile =>
                    profile.id === inventory.profileId ||
                    `${this.domain}-${profile.id}` === inventory.profileId,
                )
              : [];
          if (
            profiles?.length !== 1 ||
            !Array.isArray(profiles[0].worker?.toolIds) ||
            !profiles[0].worker.toolIds.length ||
            profiles[0].worker.toolIds.length > 128 ||
            new Set(profiles[0].worker.toolIds).size !== profiles[0].worker.toolIds.length
          )
            throw Error('No tool descriptor is bound to the active remote Pack/profile.');
          candidates = [];
          for (const rawId of profiles[0].worker.toolIds) {
            const id = boundedIdentity(rawId, 'tool');
            const detail = await context.client.describeTool(id, { signal });
            signal?.throwIfAborted();
            if (detail.tool?.id !== id)
              throw Error('Remote tool description does not match the active profile.');
            candidates.push({
              ...(profiles[0].descriptor?.id === id ? profiles[0].descriptor : {}),
              ...detail.tool,
            });
          }
        }
        if (!Array.isArray(candidates) || !candidates.length || candidates.length > 128)
          throw Error('Remote domain does not expose a bounded executable tool inventory.');
        const tools = candidates.map(raw => {
          const item = raw.descriptor || raw;
          return ToolDescriptorSchema.parse({
            schemaVersion: '1',
            id: boundedIdentity(item.id, 'tool'),
            version: item.version || inventory.runtimeDigest || inventory.capabilitySnapshotHash,
            risk: 'mutating',
            effect: 'execution',
            verification: ['remote.reported'],
          });
        });
        if (
          new Set(tools.map(tool => tool.id)).size !== tools.length ||
          tools.some(
            tool =>
              this.workspace.tools.has(tool.id) &&
              !this.remoteTools.some(old => old.id === tool.id),
          )
        )
          throw Error('Invalid or colliding remote tool inventory.');
        for (const old of this.remoteTools) this.workspace.tools.delete(old.id);
        this.remoteTools = tools;
        this.inventory = inventory;
        for (const descriptor of tools)
          this.workspace.tools.set(descriptor.id, {
            descriptor,
            execute: args => this.executeRemote(descriptor, args, this.context(args.ownerId)),
          });
        this.capabilities = [
          ...this.workspaceCapabilities,
          {
            id: 'remote.software',
            domain: this.domain,
            title: 'Remote domain tools',
            description: 'Execute the bound project snapshot using the remote domain tools.',
            stages: [],
            priority: 0,
            keywords: [],
            skills: [],
            tools: tools.map(tool => ({
              id: tool.id,
              summary: 'Run this tool in the bound remote sandbox; describe inputs first.',
            })),
            verification: ['remote.reported'],
          },
        ];
      }
      this.state = await this.workspace.inspect();
      return this.state;
    }
    descriptors(scope) {
      return this.workspace.descriptors(scope);
    }
    async executeOne(request, policy, context) {
      await this.inspect(context, {
        execution: this.remoteTools.some(tool => tool.id === request.toolId),
      });
      // The workspace has its own action controller, created only when execute
      // starts. A cancellation during asynchronous discovery must survive that handoff.
      context.controller.signal.throwIfAborted();
      // Another chat may have left an unresolved result while discovery was waiting.
      this.settings.assertTaskIdle(this.projectDir, this.domain);
      const result = await this.workspace.execute(request, { ...policy, ownerId: context.chatId });
      this.state = result.state;
      this.checkpoint = result.checkpoint;
      const pending = this.status(context);
      // A returned result alone is insufficient: the core also returns failure
      // records after collection errors. Only a matching, committed remote.reported
      // assessment confirms import, including a valid remote engineering failure.
      if (
        pending?.needsImport &&
        pending.actionId === result.action.id &&
        pending.runId === result.run.id &&
        result.verification.verifierId === 'remote.reported'
      ) {
        this.publish(context, { ...pending, needsImport: false });
        await this.releaseSession(context);
      }
      return result;
    }
    async releaseSession(context) {
      const released = await this.settings.releaseCompletedSession(
        this.projectDir,
        this.domain,
        context.chatId,
      );
      if (released?.status === 'released') {
        // Teardown is already confirmed. A transport close error must not turn
        // a committed engineering result into a failed action.
        await context.client.close().catch(() => {});
        context.client = this.settings.sessionClient(this.projectDir, this.domain, context.chatId);
      }
      this.onStatus(this.status(context));
    }
    async executeRemote(descriptor, { inputs, action, signal }, context) {
      this.assertCurrent();
      await this.settings.ensureSynced(this.projectDir, this.domain);
      const requestId = crypto.randomUUID();
      const remoteHead = this.workspace.metadata('remote_state_id') || null;
      const previousArtifacts = this.status(context)?.producedArtifacts || [];
      const pending = {
        invocationId: requestId,
        requestId,
        snapshotId: this.binding.snapshotId,
        toolId: descriptor.id,
        actionId: action.id,
        runId: action.runId,
        expectedStateId: remoteHead,
        inputHashes: action.inputHashes,
        status: 'submitting',
        outcome: 'unknown',
        producedArtifacts: previousArtifacts,
      };
      this.publish(context, pending);
      let dispatched = false,
        receipt;
      try {
        if (signal.aborted)
          throw Object.assign(Error('Remote call stopped before dispatch.'), {
            outcome: 'not_submitted',
          });
        this.publish(context, { ...pending, status: 'running' });
        dispatched = true;
        receipt = await context.client.callProtectedTool(descriptor.id, inputs, {
          requestId,
          snapshotId: this.binding.snapshotId,
          expectedStateId: remoteHead,
          signal,
        });
        if (
          receipt.evidence?.requestId !== requestId ||
          receipt.persisted !== true ||
          !['completed', 'failed'].includes(receipt.status) ||
          !Array.isArray(receipt.artifacts) ||
          receipt.artifacts.length > 64
        )
          throw Error(
            'Remote response does not identify the submitted request and persisted result.',
          );
        // Commit the actual response before downloads. Recovery never requires
        // reissuing the engineering mutation, even if local import fails.
        writePrivateJson(
          path.join(this.settings.directory, 'remote-receipts', requestId + '.json'),
          {
            service: this.settings.configuration().url,
            projectId: this.binding.remoteProjectId,
            snapshotId: this.binding.snapshotId,
            requestId,
            toolId: descriptor.id,
            inputs,
            actionId: action.id,
            runId: action.runId,
            receipt,
          },
        );
        if (receipt.state !== null && receipt.state !== undefined) {
          const head = typeof receipt.state === 'string' ? receipt.state : receipt.state.id;
          this.workspace.setMetadata('remote_state_id', boundedIdentity(head, 'state'));
        }
        const ids = new Set();
        let totalBytes = 0;
        const refs = receipt.artifacts.map((item, index) => {
          const id = item.artifactId || item.id;
          if (
            !/^[a-f0-9-]{36}$/i.test(id || '') ||
            ids.has(id) ||
            typeof item.kind !== 'string' ||
            !/^[a-zA-Z0-9._-]{1,128}$/.test(item.kind) ||
            !Number.isSafeInteger(item.sizeBytes) ||
            item.sizeBytes < 0 ||
            !/^[a-f0-9]{64}$/.test(item.sha256 || '')
          )
            throw Error('Invalid produced artifact metadata.');
          ids.add(id);
          totalBytes += item.sizeBytes;
          if (totalBytes > 128 * 1048576) throw Error('Remote result exceeds the artifact budget.');
          const extension = item.kind.startsWith('log.')
            ? 'log'
            : item.kind.startsWith('report.')
              ? 'json'
              : item.kind.split('.').at(-1);
          return {
            id,
            kind: item.kind,
            sha256: item.sha256,
            sizeBytes: item.sizeBytes,
            relativePath: `remote-results/${requestId}/${index}-${item.kind}.${extension}`,
          };
        });
        this.publish(context, {
          ...pending,
          status: receipt.status,
          outcome: 'completed',
          needsImport: true,
          producedArtifacts: [...previousArtifacts, ...refs],
        });
        const artifacts = [];
        for (const ref of refs) {
          const { content } = await context.client.downloadProducedArtifact(ref, { signal });
          const file = safeDownload(this.projectDir, ref.relativePath, content, ref);
          artifacts.push({ file, kind: ref.kind, sha256: ref.sha256 });
        }
        // Transport receipts need not preserve producer filenames. Keep an
        // adjacent, bounded index so read-only viewers can resolve companions
        // by their recorded content hashes without rewriting producer bytes.
        const index = Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            artifacts: refs.map(ref => ({
              name: path.posix.basename(ref.relativePath),
              kind: ref.kind,
              sha256: ref.sha256,
              sizeBytes: ref.sizeBytes,
            })),
          }),
        );
        safeDownload(this.projectDir, `remote-results/${requestId}/artifact-bundle.json`, index, {
          sha256: crypto.createHash('sha256').update(index).digest('hex'),
          sizeBytes: index.length,
        });
        let assessment = {
          status: 'insufficient_evidence',
          reason: 'The remote service returned no engineering verification.',
          metrics: {},
        };
        if (receipt.verification) {
          const value = { ...receipt.verification };
          delete value.checks;
          const verified = IndustrialVerificationResultSchema.parse(value);
          if (
            verified.evidence.artifactIds.some(id => !ids.has(id)) ||
            (verified.status === 'passed' && (receipt.status !== 'completed' || !refs.length))
          )
            throw Error(
              'Remote verification refers to missing evidence or an unsuccessful execution.',
            );
          assessment = {
            status: verified.status,
            reason: `Remote verifier ${verified.verifierId || 'none'}: ${verified.reason}`,
            metrics: verified.metrics,
          };
        }
        // Keep needsImport durable until workspace.execute has committed all
        // canonical records. A crash or local store failure must leave this gate closed.
        return {
          executionSucceeded: receipt.status === 'completed',
          artifacts,
          assessment,
          toolVersion: descriptor.version,
          diagnostics: [
            `Remote request ${requestId}; source verifier ${receipt.verification?.id || 'not returned'}.`,
          ],
        };
      } catch (error) {
        const safe = !dispatched || error.outcome === 'not_submitted';
        this.publish(context, {
          ...(this.status(context) || pending),
          status: safe ? 'failed' : 'unknown',
          outcome: safe ? 'not_submitted' : 'unknown',
          needsImport: Boolean(receipt),
          code: error.code || 'REMOTE_EXECUTION_ERROR',
        });
        throw error;
      }
    }
    cancel(context) {
      context?.controller?.abort();
      this.workspace.cancel(context?.chatId);
    }
  }
  return new CurrentRemoteRuntime();
}
module.exports = { createCurrentRemoteRuntime };
