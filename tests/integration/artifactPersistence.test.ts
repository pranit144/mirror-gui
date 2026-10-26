/**
 * Regression: operation A's archive must remain unchanged and downloadable
 * after operation B generates another mirror_000001.tar in the same destination.
 *
 * Exercises the real start → oc-mirror close → persist → list/download path
 * with a fake oc-mirror that writes archives into the file:// destination.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getTestApp } from './helpers/testApp.js';
import { ensureTestDirs } from './helpers/setup.js';

async function waitForStatus(
  _request: Awaited<ReturnType<typeof getTestApp>>,
  operationId: string,
  timeoutMs = 5000,
): Promise<{ status: string; artifactFiles?: string[] }> {
  const storageDir = process.env.STORAGE_DIR!;
  const recordPath = path.join(storageDir, 'operations', `${operationId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(await fs.promises.readFile(recordPath, 'utf8')) as {
        status: string;
        artifactFiles?: string[];
      };
      if (record.status && record.status !== 'running') {
        return record;
      }
    } catch {
      // record may not exist yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Operation ${operationId} did not leave running state within ${timeoutMs}ms`);
}

describe('Artifact persistence across overwrites', () => {
  let request: Awaited<ReturnType<typeof getTestApp>>;
  let fakeOcMirrorDir: string;
  let origPath: string;
  let contentFile: string;

  beforeAll(async () => {
    await ensureTestDirs();
    request = await getTestApp();

    contentFile = path.join(os.tmpdir(), `oc-mirror-content-${Date.now()}.txt`);
    await fs.promises.writeFile(contentFile, 'unset');

    fakeOcMirrorDir = path.join(os.tmpdir(), `oc-mirror-fake-persist-${Date.now()}`);
    await fs.promises.mkdir(fakeOcMirrorDir, { recursive: true });
    const fakeScript = path.join(fakeOcMirrorDir, 'oc-mirror');

    // Fake oc-mirror: write mirror_000001.tar into the file:// destination using
    // the bytes from OC_MIRROR_FAKE_CONTENT_FILE (so each test run can change content).
    await fs.promises.writeFile(
      fakeScript,
      [
        '#!/bin/sh',
        'dest=""',
        'for arg in "$@"; do',
        '  case "$arg" in',
        '    file://*) dest="${arg#file://}" ;;',
        '  esac',
        'done',
        'if [ -z "$dest" ]; then',
        '  echo "fake oc-mirror: missing file:// destination" >&2',
        '  exit 1',
        'fi',
        'mkdir -p "$dest/working-dir"',
        'content_file="${OC_MIRROR_FAKE_CONTENT_FILE}"',
        'if [ -z "$content_file" ] || [ ! -f "$content_file" ]; then',
        '  echo "fake oc-mirror: OC_MIRROR_FAKE_CONTENT_FILE not set" >&2',
        '  exit 1',
        'fi',
        'cp "$content_file" "$dest/mirror_000001.tar"',
        'exit 0',
        '',
      ].join('\n'),
    );
    await fs.promises.chmod(fakeScript, 0o755);
    origPath = process.env.PATH || '';
    process.env.PATH = `${fakeOcMirrorDir}:${origPath}`;
    process.env.OC_MIRROR_FAKE_CONTENT_FILE = contentFile;
  });

  afterAll(async () => {
    process.env.PATH = origPath;
    delete process.env.OC_MIRROR_FAKE_CONTENT_FILE;
    await fs.promises.rm(fakeOcMirrorDir, { recursive: true, force: true });
    await fs.promises.rm(contentFile, { force: true });
  });

  it('preserves operation A archive bytes after operation B overwrites mirror_000001.tar', async () => {
    const storageDir = process.env.STORAGE_DIR!;
    const sharedSubdir = 'persist-regression';

    const configRes = await request.post('/api/config/save').send({
      config:
        'kind: ImageSetConfiguration\napiVersion: mirror.openshift.io/v2alpha1\nmirror:\n  platform: {}\n  operators: []\n  additionalImages: []',
      name: 'persist-regression-config.yaml',
    });
    expect(configRes.status).toBe(200);

    // --- Operation A ---
    await fs.promises.writeFile(contentFile, 'operation-A-archive-payload');
    const startA = await request.post('/api/operations/start').send({
      configFile: 'persist-regression-config.yaml',
      mirrorDestinationSubdir: sharedSubdir,
    });
    expect(startA.status).toBe(200);
    const opAId = startA.body.operationId as string;

    const recordA = await waitForStatus(request, opAId);
    expect(recordA.status).toBe('success');
    const shortA = opAId.replace(/-/g, '').slice(0, 8);
    const archivedNameA = `mirror_${shortA}.tar`;
    expect(recordA.artifactFiles).toEqual([archivedNameA]);

    const persistedA = path.join(storageDir, 'artifacts', opAId, archivedNameA);
    expect(fs.existsSync(persistedA)).toBe(true);
    expect(await fs.promises.readFile(persistedA, 'utf8')).toBe('operation-A-archive-payload');

    const listA1 = await request.get(`/api/operations/${opAId}/artifacts`);
    expect(listA1.status).toBe(200);
    expect(listA1.body.artifacts).toHaveLength(1);
    expect(listA1.body.artifacts[0].filename).toBe(archivedNameA);

    const dlA1 = await request.get(
      `/api/operations/${opAId}/artifacts/${archivedNameA}/download`,
    );
    expect(dlA1.status).toBe(200);
    expect(dlA1.text).toBe('operation-A-archive-payload');

    // Working-dir tree from the shared destination must still function.
    const wdA = await request.get(`/api/operations/${opAId}/working-dir`);
    expect(wdA.status).toBe(200);

    // --- Operation B overwrites the same destination filename ---
    await fs.promises.writeFile(contentFile, 'operation-B-archive-payload');
    const startB = await request.post('/api/operations/start').send({
      configFile: 'persist-regression-config.yaml',
      mirrorDestinationSubdir: sharedSubdir,
    });
    expect(startB.status).toBe(200);
    const opBId = startB.body.operationId as string;

    const recordB = await waitForStatus(request, opBId);
    expect(recordB.status).toBe('success');
    const shortB = opBId.replace(/-/g, '').slice(0, 8);
    const archivedNameB = `mirror_${shortB}.tar`;
    expect(recordB.artifactFiles).toEqual([archivedNameB]);

    const sharedArchive = path.join(storageDir, 'mirrors', sharedSubdir, 'mirror_000001.tar');
    expect(await fs.promises.readFile(sharedArchive, 'utf8')).toBe('operation-B-archive-payload');

    // Operation A's persisted copy must be unchanged.
    expect(await fs.promises.readFile(persistedA, 'utf8')).toBe('operation-A-archive-payload');

    const [listA2, listB, dlA2, dlB] = await Promise.all([
      request.get(`/api/operations/${opAId}/artifacts`),
      request.get(`/api/operations/${opBId}/artifacts`),
      request.get(`/api/operations/${opAId}/artifacts/${archivedNameA}/download`),
      request.get(`/api/operations/${opBId}/artifacts/${archivedNameB}/download`),
    ]);

    expect(listA2.status).toBe(200);
    expect(listA2.body.artifacts).toHaveLength(1);
    expect(listA2.body.artifacts[0].filename).toBe(archivedNameA);
    expect(listA2.body.artifacts[0].sizeBytes).toBe(
      Buffer.byteLength('operation-A-archive-payload'),
    );

    expect(listB.status).toBe(200);
    expect(listB.body.artifacts).toHaveLength(1);
    expect(listB.body.artifacts[0].filename).toBe(archivedNameB);
    expect(listB.body.artifacts[0].sizeBytes).toBe(
      Buffer.byteLength('operation-B-archive-payload'),
    );

    expect(dlA2.status).toBe(200);
    expect(dlA2.text).toBe('operation-A-archive-payload');
    expect(dlB.status).toBe(200);
    expect(dlB.text).toBe('operation-B-archive-payload');

    // Shared working-dir remains browsable for both successful ops.
    const wdB = await request.get(`/api/operations/${opBId}/working-dir`);
    expect(wdB.status).toBe(200);
  });

  it('does not persist archives for a failed operation', async () => {
    // Swap in a failing fake for this test only.
    const failScript = path.join(fakeOcMirrorDir, 'oc-mirror');
    await fs.promises.writeFile(
      failScript,
      ['#!/bin/sh', 'echo "[error] simulated failure" >&2', 'exit 1', ''].join('\n'),
    );
    await fs.promises.chmod(failScript, 0o755);

    try {
      const configRes = await request.post('/api/config/save').send({
        config:
          'kind: ImageSetConfiguration\napiVersion: mirror.openshift.io/v2alpha1\nmirror:\n  platform: {}\n  operators: []\n  additionalImages: []',
        name: 'persist-fail-config.yaml',
      });
      expect(configRes.status).toBe(200);

      const start = await request.post('/api/operations/start').send({
        configFile: 'persist-fail-config.yaml',
        mirrorDestinationSubdir: 'persist-fail',
      });
      expect(start.status).toBe(200);
      const opId = start.body.operationId as string;

      const record = await waitForStatus(request, opId);
      expect(record.status).toBe('failed');
      expect(record.artifactFiles).toBeUndefined();
      expect(fs.existsSync(path.join(process.env.STORAGE_DIR!, 'artifacts', opId))).toBe(false);

      const list = await request.get(`/api/operations/${opId}/artifacts`);
      expect(list.status).toBe(409);
    } finally {
      // Restore successful fake for any subsequent tests in this file.
      await fs.promises.writeFile(
        failScript,
        [
          '#!/bin/sh',
          'dest=""',
          'for arg in "$@"; do',
          '  case "$arg" in',
          '    file://*) dest="${arg#file://}" ;;',
          '  esac',
          'done',
          'mkdir -p "$dest/working-dir"',
          'cp "${OC_MIRROR_FAKE_CONTENT_FILE}" "$dest/mirror_000001.tar"',
          'exit 0',
          '',
        ].join('\n'),
      );
      await fs.promises.chmod(failScript, 0o755);
    }
  });
});
