/**
 * Integration tests for artifact listing, archive download, and working-dir
 * tree browsing endpoints.
 *
 *  GET /api/operations/:id/artifacts
 *  GET /api/operations/:id/artifacts/:filename/download
 *  GET /api/operations/:id/working-dir
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import { getTestApp } from './helpers/testApp.js';
import { ensureTestDirs } from './helpers/setup.js';

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

/** Write a minimal JSON operation record to disk and return the id. */
async function seedOperation(
  storageDir: string,
  overrides: Partial<{
    id: string;
    status: 'success' | 'failed' | 'stopped' | 'running';
    mirrorDestination: string;
    artifactFiles: string[];
  }> = {},
): Promise<string> {
  const id = overrides.id ?? `test-${Math.random().toString(36).slice(2)}`;
  const record: Record<string, unknown> = {
    id,
    name: `Mirror Operation ${id.slice(0, 8)}`,
    configFile: 'test.yaml',
    mirrorDestination: overrides.mirrorDestination ?? path.join(storageDir, 'mirrors', 'default'),
    status: overrides.status ?? 'success',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    completedAt: new Date().toISOString(),
    duration: 60,
    errorMessage: null,
    logs: [],
  };
  if (overrides.artifactFiles !== undefined) {
    record.artifactFiles = overrides.artifactFiles;
  }
  await fs.promises.writeFile(
    path.join(storageDir, 'operations', `${id}.json`),
    JSON.stringify(record, null, 2),
  );
  return id;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Artifact API', () => {
  let request: Awaited<ReturnType<typeof getTestApp>>;
  let storageDir: string;
  let mirrorDir: string;

  // Operation ids — each test group uses its own id to avoid cross-test
  // state pollution (e.g. the stop test in operationsLifecycle changes status).
  let successOpId: string;
  let failedOpId: string;
  let stoppedOpId: string;
  let noDestOpId: string;

  beforeAll(async () => {
    await ensureTestDirs();
    request = await getTestApp();

    storageDir = process.env.STORAGE_DIR!;
    mirrorDir = path.join(storageDir, 'mirrors', 'default');

    // Create one tar archive in the mirror directory.
    await fs.promises.writeFile(
      path.join(mirrorDir, 'mirror_seq1_000000.tar'),
      'fake-tar-content',
    );

    // Create a working-dir structure that resembles what oc-mirror produces.
    const workingDir = path.join(mirrorDir, 'working-dir');
    await fs.promises.mkdir(path.join(workingDir, 'cluster-resources'), { recursive: true });
    await fs.promises.mkdir(path.join(workingDir, 'signatures'), { recursive: true });
    await fs.promises.writeFile(
      path.join(workingDir, 'cluster-resources', 'imageContentSourcePolicy.yaml'),
      'apiVersion: operator.openshift.io/v1alpha1\nkind: ImageContentSourcePolicy',
    );
    await fs.promises.writeFile(
      path.join(workingDir, 'cluster-resources', 'catalogSource.yaml'),
      'apiVersion: operators.coreos.com/v1alpha1\nkind: CatalogSource',
    );

    // Seed operations.  The success operation records artifactFiles so that
    // scanOperationArtifacts uses the definitive list rather than the live scan.
    successOpId = await seedOperation(storageDir, {
      status: 'success',
      artifactFiles: ['mirror_seq1_000000.tar'],
    });
    failedOpId  = await seedOperation(storageDir, { status: 'failed' });
    stoppedOpId = await seedOperation(storageDir, { status: 'stopped' });

    // Operation with no mirrorDestination recorded.
    const noDestId = `nodest-${Math.random().toString(36).slice(2)}`;
    await fs.promises.writeFile(
      path.join(storageDir, 'operations', `${noDestId}.json`),
      JSON.stringify({
        id: noDestId, name: 'No Dest Op', configFile: 'x.yaml',
        status: 'success', startedAt: new Date().toISOString(), logs: [],
      }),
    );
    noDestOpId = noDestId;
  });

  afterAll(async () => {
    // Cleanup handled by the global cleanupTestDirs in setup.ts.
  });

  // -------------------------------------------------------------------------
  // GET /api/operations/:id/artifacts — listing
  // -------------------------------------------------------------------------

  describe('GET /api/operations/:id/artifacts', () => {
    it('returns artifact list for a successful operation', async () => {
      const res = await request.get(`/api/operations/${successOpId}/artifacts`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('artifacts');
      expect(Array.isArray(res.body.artifacts)).toBe(true);
      expect(res.body.artifacts).toHaveLength(1);

      const artifact = res.body.artifacts[0];
      expect(artifact.filename).toBe('mirror_seq1_000000.tar');
      expect(typeof artifact.sizeBytes).toBe('number');
      expect(artifact.sizeBytes).toBeGreaterThan(0);
      expect(artifact.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(artifact.downloadUrl).toContain('/artifacts/');
      expect(artifact.downloadUrl).toContain('/download');
    });

    it('returns both container and host paths', async () => {
      const res = await request.get(`/api/operations/${successOpId}/artifacts`);
      expect(res.status).toBe(200);
      expect(typeof res.body.mirrorDestination).toBe('string');
      expect(typeof res.body.hostMirrorDestination).toBe('string');
    });

    it('returns empty artifacts array when no tars exist', async () => {
      // Seed an operation pointing at a fresh empty directory.
      const emptyDir = path.join(storageDir, 'mirrors', 'empty-test');
      await fs.promises.mkdir(emptyDir, { recursive: true });
      const emptyOpId = await seedOperation(storageDir, {
        status: 'success',
        mirrorDestination: emptyDir,
      });

      const res = await request.get(`/api/operations/${emptyOpId}/artifacts`);
      expect(res.status).toBe(200);
      expect(res.body.artifacts).toHaveLength(0);
    });

    it('returns 409 for a failed operation', async () => {
      const res = await request.get(`/api/operations/${failedOpId}/artifacts`);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/successful/i);
    });

    it('returns 409 for a stopped operation', async () => {
      const res = await request.get(`/api/operations/${stoppedOpId}/artifacts`);
      expect(res.status).toBe(409);
    });

    it('returns 404 for a non-existent operation', async () => {
      const res = await request.get('/api/operations/00000000-does-not-exist/artifacts');
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    it('returns 404 when operation has no mirrorDestination', async () => {
      const res = await request.get(`/api/operations/${noDestOpId}/artifacts`);
      expect(res.status).toBe(404);
    });

    it('returns artifacts sorted alphabetically', async () => {
      const multiDir = path.join(storageDir, 'mirrors', 'multi-test');
      await fs.promises.mkdir(multiDir, { recursive: true });
      await fs.promises.writeFile(path.join(multiDir, 'mirror_seq2_000000.tar'), 'b');
      await fs.promises.writeFile(path.join(multiDir, 'mirror_seq1_000000.tar'), 'a');

      const multiOpId = await seedOperation(storageDir, {
        status: 'success',
        mirrorDestination: multiDir,
        artifactFiles: ['mirror_seq1_000000.tar', 'mirror_seq2_000000.tar'],
      });

      const res = await request.get(`/api/operations/${multiOpId}/artifacts`);
      expect(res.status).toBe(200);
      expect(res.body.artifacts[0].filename).toBe('mirror_seq1_000000.tar');
      expect(res.body.artifacts[1].filename).toBe('mirror_seq2_000000.tar');
    });

    it('scopes listing to artifactFiles when recorded — later overwrites are hidden', async () => {
      // Simulate the oc-mirror pattern: two operations share the same destination.
      // Op 1 recorded mirror_000001.tar. Op 2 runs later, overwrites that file,
      // and records its own mirror_000001.tar. Op 1's listing must remain empty
      // (the file it produced no longer exists on disk).
      const sharedDir = path.join(storageDir, 'mirrors', 'shared-dest');
      await fs.promises.mkdir(sharedDir, { recursive: true });

      // Op 1: created mirror_000001.tar, but now it no longer exists (overwritten).
      const op1Id = await seedOperation(storageDir, {
        status: 'success',
        mirrorDestination: sharedDir,
        artifactFiles: ['mirror_000001.tar'],
      });

      // Op 2: owns the current mirror_000001.tar.
      await fs.promises.writeFile(path.join(sharedDir, 'mirror_000001.tar'), 'op2-content');
      const op2Id = await seedOperation(storageDir, {
        status: 'success',
        mirrorDestination: sharedDir,
        artifactFiles: ['mirror_000001.tar'],
      });

      const [res1, res2] = await Promise.all([
        request.get(`/api/operations/${op1Id}/artifacts`),
        request.get(`/api/operations/${op2Id}/artifacts`),
      ]);

      // Op 1's recorded file is gone — empty listing, not Op 2's file.
      expect(res1.status).toBe(200);
      expect(res1.body.artifacts).toHaveLength(0);

      // Op 2's file exists — listed correctly.
      expect(res2.status).toBe(200);
      expect(res2.body.artifacts).toHaveLength(1);
      expect(res2.body.artifacts[0].filename).toBe('mirror_000001.tar');
    });

    it('falls back to live directory scan for operations without artifactFiles', async () => {
      const legacyDir = path.join(storageDir, 'mirrors', 'legacy-dest');
      await fs.promises.mkdir(legacyDir, { recursive: true });
      await fs.promises.writeFile(path.join(legacyDir, 'mirror_000001.tar'), 'legacy');

      // No artifactFiles field — legacy record.
      const legacyOpId = await seedOperation(storageDir, {
        status: 'success',
        mirrorDestination: legacyDir,
      });

      const res = await request.get(`/api/operations/${legacyOpId}/artifacts`);
      expect(res.status).toBe(200);
      expect(res.body.artifacts).toHaveLength(1);
      expect(res.body.artifacts[0].filename).toBe('mirror_000001.tar');
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/operations/:id/artifacts/:filename/download
  // -------------------------------------------------------------------------

  describe('GET /api/operations/:id/artifacts/:filename/download', () => {
    it('streams the archive with correct headers', async () => {
      const res = await request.get(
        `/api/operations/${successOpId}/artifacts/mirror_seq1_000000.tar/download`,
      );
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['content-disposition']).toContain('mirror_seq1_000000.tar');
      expect(res.headers['content-type']).toContain('application/x-tar');
      expect(res.headers['content-length']).toBeDefined();
      expect(res.headers['cache-control']).toContain('no-transform');
    });

    it('returns 404 for a filename not in the directory', async () => {
      const res = await request.get(
        `/api/operations/${successOpId}/artifacts/nonexistent.tar/download`,
      );
      expect(res.status).toBe(404);
    });

    it('returns 400 for path traversal attempt', async () => {
      const res = await request.get(
        `/api/operations/${successOpId}/artifacts/..%2F..%2Fetc%2Fpasswd/download`,
      );
      expect(res.status).toBe(400);
    });

    it('returns 400 for a non-archive extension', async () => {
      const res = await request.get(
        `/api/operations/${successOpId}/artifacts/notes.txt/download`,
      );
      expect(res.status).toBe(400);
    });

    it('returns 400 for a filename with invalid characters', async () => {
      const res = await request.get(
        `/api/operations/${successOpId}/artifacts/bad%20name.tar/download`,
      );
      expect(res.status).toBe(400);
    });

    it('returns 404 for a symlink named .tar', async () => {
      // Create a symlink inside mirrorDir pointing outside it.
      const symlinkPath = path.join(mirrorDir, 'evil.tar');
      try {
        await fs.promises.symlink('/etc/hostname', symlinkPath);
        const res = await request.get(
          `/api/operations/${successOpId}/artifacts/evil.tar/download`,
        );
        // lstat sees a symlink, not a regular file → 404.
        expect(res.status).toBe(404);
      } finally {
        await fs.promises.rm(symlinkPath, { force: true });
      }
    });

    it('returns 409 for a non-successful operation', async () => {
      const res = await request.get(
        `/api/operations/${failedOpId}/artifacts/mirror_seq1_000000.tar/download`,
      );
      expect(res.status).toBe(409);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/operations/:id/working-dir
  // -------------------------------------------------------------------------

  describe('GET /api/operations/:id/working-dir', () => {
    it('returns root-level items with correct shape', async () => {
      const res = await request.get(`/api/operations/${successOpId}/working-dir`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(typeof res.body.workingDirPath).toBe('string');
      expect(typeof res.body.hostWorkingDirPath).toBe('string');
      expect(res.body.currentPath).toBe('');

      const names = res.body.items.map((i: { name: string }) => i.name);
      expect(names).toContain('cluster-resources');
      expect(names).toContain('signatures');
    });

    it('lists directories before files and both alphabetically', async () => {
      const res = await request.get(`/api/operations/${successOpId}/working-dir`);
      expect(res.status).toBe(200);
      const items: { name: string; type: string }[] = res.body.items;
      const dirs  = items.filter(i => i.type === 'directory');
      const files = items.filter(i => i.type === 'file');

      // All dirs come first.
      const lastDirIdx  = items.findLastIndex(i => i.type === 'directory');
      const firstFileIdx = items.findIndex(i => i.type === 'file');
      if (dirs.length > 0 && files.length > 0) {
        expect(lastDirIdx).toBeLessThan(firstFileIdx);
      }

      // Alphabetical within dirs.
      const dirNames = dirs.map(d => d.name);
      expect(dirNames).toEqual([...dirNames].sort((a, b) => a.localeCompare(b)));
    });

    it('returns hasChildren=true for non-empty subdirectory', async () => {
      const res = await request.get(`/api/operations/${successOpId}/working-dir`);
      expect(res.status).toBe(200);
      const clusterResources = res.body.items.find(
        (i: { name: string }) => i.name === 'cluster-resources',
      );
      expect(clusterResources).toBeDefined();
      expect(clusterResources.hasChildren).toBe(true);
    });

    it('returns hasChildren=false for empty subdirectory', async () => {
      const res = await request.get(`/api/operations/${successOpId}/working-dir`);
      expect(res.status).toBe(200);
      const signatures = res.body.items.find(
        (i: { name: string }) => i.name === 'signatures',
      );
      expect(signatures).toBeDefined();
      expect(signatures.hasChildren).toBe(false);
    });

    it('returns children when ?path= is provided', async () => {
      const res = await request.get(
        `/api/operations/${successOpId}/working-dir?path=cluster-resources`,
      );
      expect(res.status).toBe(200);
      expect(res.body.currentPath).toBe('cluster-resources');
      const names = res.body.items.map((i: { name: string }) => i.name);
      expect(names).toContain('imageContentSourcePolicy.yaml');
      expect(names).toContain('catalogSource.yaml');
    });

    it('returns 400 for path traversal in ?path=', async () => {
      const res = await request.get(
        `/api/operations/${successOpId}/working-dir?path=..%2F..%2Fetc`,
      );
      expect(res.status).toBe(400);
    });

    it('returns 400 when ?path= points to a file, not a directory', async () => {
      const res = await request.get(
        `/api/operations/${successOpId}/working-dir?path=cluster-resources%2FimageContentSourcePolicy.yaml`,
      );
      expect(res.status).toBe(400);
    });

    it('returns 404 when ?path= does not exist', async () => {
      const res = await request.get(
        `/api/operations/${successOpId}/working-dir?path=does-not-exist`,
      );
      expect(res.status).toBe(404);
    });

    it('returns 404 when working-dir is missing from the mirror destination', async () => {
      const noWdDir = path.join(storageDir, 'mirrors', 'no-working-dir');
      await fs.promises.mkdir(noWdDir, { recursive: true });
      // No working-dir/ created inside.
      const noWdOpId = await seedOperation(storageDir, {
        status: 'success',
        mirrorDestination: noWdDir,
      });

      const res = await request.get(`/api/operations/${noWdOpId}/working-dir`);
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/working-dir not found/i);
    });

    it('returns 409 for a non-successful operation', async () => {
      const res = await request.get(`/api/operations/${failedOpId}/working-dir`);
      expect(res.status).toBe(409);
    });

    it('returns 404 for a non-existent operation', async () => {
      const res = await request.get('/api/operations/00000000-does-not-exist/working-dir');
      expect(res.status).toBe(404);
    });

    it('excludes symlinks from the listing', async () => {
      const wdPath = path.join(mirrorDir, 'working-dir');
      const symlinkPath = path.join(wdPath, 'evil-link');
      try {
        await fs.promises.symlink('/etc', symlinkPath);
        const res = await request.get(`/api/operations/${successOpId}/working-dir`);
        expect(res.status).toBe(200);
        const names = res.body.items.map((i: { name: string }) => i.name);
        expect(names).not.toContain('evil-link');
      } finally {
        await fs.promises.rm(symlinkPath, { force: true });
      }
    });

    it('returns file sizeBytes for files in a subdirectory', async () => {
      const res = await request.get(
        `/api/operations/${successOpId}/working-dir?path=cluster-resources`,
      );
      expect(res.status).toBe(200);
      const yamlFile = res.body.items.find(
        (i: { name: string }) => i.name === 'imageContentSourcePolicy.yaml',
      );
      expect(yamlFile).toBeDefined();
      expect(typeof yamlFile.sizeBytes).toBe('number');
      expect(yamlFile.sizeBytes).toBeGreaterThan(0);
    });
  });
});
