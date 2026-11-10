import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { fingerprintRestoreValue } from '../src/services/restoreFingerprint.ts';
import {
  isDurableRestoreOperation,
  isRestoreEnginePlanSummary,
  isRestoreJournalAction,
  isRestoreJournalSnapshot,
  type DurableRestoreOperation,
  type RestoreEnginePlanSummaryV1,
} from '../src/services/restoreSafety.ts';

const OPERATION_ID = '9d44a3b0-4ed6-4f79-8561-df8825c8f18a';
const WORKSPACE_ID = 'temporary:7a34d3f1-1d2e-4a5b-8c6d-1234567890ab';
const DOCUMENT_ID = 'synthetic-phase-c';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const ACTION_ID = `${OPERATION_ID}:action:000001`;
const SNAPSHOT_ID = `${ACTION_ID}:snapshot`;

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(path);
    return /\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

function plan(): RestoreEnginePlanSummaryV1 {
  return {
    version: 1,
    backupFormatVersion: 5,
    manifestFingerprint: HASH_A,
    planFingerprint: HASH_B,
    beforeFingerprint: HASH_A,
    targetFingerprint: HASH_C,
    actionCount: 1,
    documentDecisions: [
      {
        documentId: DOCUMENT_ID,
        resolution: 'replace',
        annotationActionId: ACTION_ID,
      },
    ],
    collectionActionIds: [],
    actions: [
      {
        actionId: ACTION_ID,
        snapshotId: SNAPSHOT_ID,
        database: 'annotation',
        kind: 'annotation-document',
        targetKey: DOCUMENT_ID,
        beforeFingerprint: HASH_A,
        targetFingerprint: HASH_C,
      },
    ],
  };
}

function operation(
  phase: DurableRestoreOperation['phase'] = 'preparing',
): DurableRestoreOperation {
  return {
    operationId: OPERATION_ID,
    workspaceId: WORKSPACE_ID,
    phase,
    generation: 1,
    createdAt: 1,
    recoveryRequired: phase === 'recovery-required',
    publicationHold: phase === 'publication-hold',
    remoteRevalidationRequired: phase === 'publication-hold',
    enginePlan: plan(),
    ...(phase === 'committed' ||
    phase === 'recovery-required' ||
    phase === 'publication-hold'
      ? {
          commitEvidence: {
            version: 1 as const,
            operationId: OPERATION_ID,
            planFingerprint: HASH_B,
            targetFingerprint: HASH_C,
            verifiedAt: 2,
          },
        }
      : {}),
  };
}

test('Phase C frozen plans reject skip actions and mismatched database ownership', () => {
  assert.equal(isRestoreEnginePlanSummary(plan()), true);
  const skipWithWrite = plan();
  skipWithWrite.documentDecisions[0] = {
    documentId: DOCUMENT_ID,
    resolution: 'skip',
    annotationActionId: ACTION_ID,
  };
  assert.equal(isRestoreEnginePlanSummary(skipWithWrite), false);

  const wrongDatabase = plan();
  wrongDatabase.actions[0] = {
    ...wrongDatabase.actions[0],
    database: 'productivity',
  };
  assert.equal(isRestoreEnginePlanSummary(wrongDatabase), false);
});

test('commit evidence is mandatory for Phase C committed and publication-hold states', () => {
  assert.equal(isDurableRestoreOperation(operation('preparing')), true);
  assert.equal(isDurableRestoreOperation(operation('committed')), true);
  assert.equal(isDurableRestoreOperation(operation('publication-hold')), true);
  const missing = operation('committed');
  delete missing.commitEvidence;
  assert.equal(isDurableRestoreOperation(missing), false);
  const mismatched = operation('committed');
  mismatched.commitEvidence = {
    ...mismatched.commitEvidence!,
    targetFingerprint: HASH_A,
  };
  assert.equal(isDurableRestoreOperation(mismatched), false);
});

test('strict Phase C snapshots and action markers bind operation, workspace, target and hashes', () => {
  const snapshot = {
    version: 1,
    id: SNAPSHOT_ID,
    operationId: OPERATION_ID,
    workspaceId: WORKSPACE_ID,
    database: 'annotation',
    kind: 'annotation-document',
    targetKey: DOCUMENT_ID,
    recordPresence: 'mixed',
    beforeFingerprint: HASH_A,
    capturedAt: 1,
    payload: { state: { present: true, value: {} }, source: { present: false } },
  };
  const action = {
    version: 1,
    id: ACTION_ID,
    operationId: OPERATION_ID,
    workspaceId: WORKSPACE_ID,
    actionId: ACTION_ID,
    snapshotId: SNAPSHOT_ID,
    database: 'annotation',
    kind: 'annotation-document',
    targetKey: DOCUMENT_ID,
    beforeFingerprint: HASH_A,
    targetFingerprint: HASH_C,
    status: 'planned',
    createdAt: 1,
  };
  assert.equal(isRestoreJournalSnapshot(snapshot), true);
  assert.equal(isRestoreJournalAction(action), true);
  assert.equal(
    isRestoreJournalAction({ ...action, status: 'applied' }),
    false,
    'applied marker requires appliedAt',
  );
  assert.equal(
    isRestoreJournalSnapshot({ ...snapshot, database: 'productivity' }),
    false,
    'action kind cannot move between physical databases',
  );
});

test('restore fingerprints include exact Blob bytes and absence markers', async () => {
  const first = await fingerprintRestoreValue({
    source: { present: true, value: new Blob(['first'], { type: 'text/plain' }) },
  });
  const second = await fingerprintRestoreValue({
    source: { present: true, value: new Blob(['second'], { type: 'text/plain' }) },
  });
  const absent = await fingerprintRestoreValue({ source: { present: false } });
  assert.notEqual(first, second);
  assert.notEqual(first, absent);
});

test('Phase D exposes exactly one production Restore entrypoint through the crash-safe engine', () => {
  const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
  const enginePath = join(sourceRoot, 'services', 'crashSafeRestoreEngine.ts');
  const productionCallers = collectTypeScriptFiles(sourceRoot)
    .filter((path) => path !== enginePath)
    .flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return Array.from(source.matchAll(/\brunCrashSafeRestore\s*\(/gu), () => path);
    });
  assert.deepEqual(productionCallers, [
    join(sourceRoot, 'components', 'LibraryPanel.tsx'),
  ]);

  for (const path of collectTypeScriptFiles(sourceRoot)) {
    assert.doesNotMatch(
      readFileSync(path, 'utf8'),
      /\brestoreBackup\s*\(/u,
      `legacy restore call remains in ${path}`,
    );
  }
  const librarySource = readFileSync(
    new URL('../src/components/LibraryPanel.tsx', import.meta.url),
    'utf8',
  );
  assert.match(librarySource, /runCrashSafeRestore\(/u);
  const backupSource = readFileSync(
    new URL('../src/services/libraryBackup.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(backupSource, /export async function restoreBackup\(/u);
});

test('Phase D startup recovery gates React and sync initialization', () => {
  const mainSource = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  const startupSource = readFileSync(
    new URL('../src/services/restoreSafetyStartup.ts', import.meta.url),
    'utf8',
  );
  const securityGateSource = readFileSync(
    new URL('../src/sync/temporaryOAuthStartup.ts', import.meta.url),
    'utf8',
  );
  assert.match(mainSource, /verifyRestoreSafety: verifyRestoreSafetyBeforeAppMount/u);
  assert.ok(
    securityGateSource.indexOf('await dependencies.verifyRestoreSafety?.()') <
      securityGateSource.indexOf('dependencies.mountApplication()'),
  );
  assert.match(startupSource, /recoverRestore: recoverCrashSafeRestore/u);
  assert.match(startupSource, /if \(recovery\.outcome === 'rolled-back'\)/u);
  assert.match(startupSource, /recovery\.outcome === 'publication-hold'/u);
  assert.match(startupSource, /throw new RestoreStartupRecoveryError\(\)/u);
  assert.match(mainSource, /Retry safe startup/u);
});

test('Phase D Restore UI exposes bounded cancellation and a fail-closed recovery-only state', () => {
  const librarySource = readFileSync(
    new URL('../src/components/LibraryPanel.tsx', import.meta.url),
    'utf8',
  );
  assert.match(
    librarySource,
    /collisionPolicy:[\s\S]*?'replace-existing'[\s\S]*?'keep-existing'/u,
  );
  assert.match(librarySource, /signal: controller\.signal/u);
  assert.match(
    librarySource,
    /onProgress: \(progress\) => setRestoreExecution\(progress\)/u,
  );
  assert.match(
    librarySource,
    /restoreExecution\?\.phase === 'validation'[\s\S]*?restoreExecution\?\.phase === 'preparation'[\s\S]*?restoreExecution\?\.phase === 'restoration'/u,
  );
  assert.doesNotMatch(
    librarySource,
    /restoreExecution\?\.phase === 'verification'[\s\S]{0,300}restoreAbortRef\.current\?\.abort/u,
  );
  assert.match(librarySource, /phase: 'recovery-required'/u);
  assert.match(librarySource, /Retry safe recovery/u);
  assert.match(librarySource, /aria-modal="true"/u);
  assert.match(
    librarySource,
    /const isLibraryModalOpen = Boolean\(restorePreview \|\| destructiveDialogKey\)/u,
  );
  assert.match(librarySource, /inert=\{isLibraryModalOpen \? true : undefined\}/u);
  assert.ok(
    librarySource.indexOf('loadDurableRestoreOperation()') <
      librarySource.indexOf('inspectBackup(file)'),
    'durable restore state must be checked before backup inspection',
  );
  assert.match(
    librarySource,
    /existingOperation\.phase === 'publication-hold'[\s\S]*?waiting for Google Drive review/u,
  );
  assert.match(
    librarySource,
    /disabled=\{Boolean\(syncState\.restorePublicationHold\)\}/u,
  );
  assert.match(
    librarySource,
    /Another Library restore is unavailable until you review the restored work/u,
  );
});

test('Phase D publication hold blocks ordinary Drive work until exact explicit review', () => {
  const coordinatorSource = readFileSync(
    new URL('../src/sync/paperCoordinator.ts', import.meta.url),
    'utf8',
  );
  const controlSource = readFileSync(
    new URL('../src/sync/PaperSyncControl.tsx', import.meta.url),
    'utf8',
  );
  assert.match(
    coordinatorSource,
    /assertWorkspaceCloudOperationAllowed\(workspaceLease\)/u,
  );
  assert.match(coordinatorSource, /authorization: 'resume-restored-library'/u);
  assert.match(
    coordinatorSource,
    /assertWorkspaceCloudOperationAllowed\(workspaceLease, \{[\s\S]*?operationId: held\.operationId,[\s\S]*?expectedGeneration: held\.generation/u,
  );
  assert.match(
    coordinatorSource,
    /publicationResumeAuthorized: true,[\s\S]*?remoteReconciled: true,[\s\S]*?verifiedAccountId: accountId/u,
  );
  assert.match(
    coordinatorSource,
    /if \(this\.restorePublicationOperation\) \{[\s\S]*?connection: 'connected',[\s\S]*?return;/u,
  );
  assert.match(
    coordinatorSource,
    /profile\?\.deviceMode === 'personal'[\s\S]*?!this\.restorePublicationOperation/u,
  );
  assert.match(
    controlSource,
    /resumeAfterRestorePublication\('resume-restored-library'\)/u,
  );
  assert.match(controlSource, /This review does not upload the\s+restored\s+Library/u);
});

test('Phase C preserves established version constants and contains no remote client dependency', () => {
  const annotationSource = readFileSync(
    new URL('../src/services/annotationPersistence.ts', import.meta.url),
    'utf8',
  );
  const backupSource = readFileSync(
    new URL('../src/services/libraryBackup.ts', import.meta.url),
    'utf8',
  );
  const paperSource = readFileSync(
    new URL('../src/sync/paperTypes.ts', import.meta.url),
    'utf8',
  );
  const engineSource = readFileSync(
    new URL('../src/services/crashSafeRestoreEngine.ts', import.meta.url),
    'utf8',
  );
  assert.match(annotationSource, /PERSISTENCE_SCHEMA_VERSION\s*=\s*\n?\s*9/u);
  assert.match(backupSource, /BACKUP_FORMAT_VERSION = 5/u);
  assert.match(paperSource, /PAPER_SYNC_PROTOCOL_VERSION = 3/u);
  assert.doesNotMatch(engineSource, /driveClient|paperDriveRepository|fetch\(/u);
});
