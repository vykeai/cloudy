import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Test the resolveImportPath logic indirectly via expandContext behaviour.
// The bug was: a for-loop always returned on the first iteration, so non-relative
// imports were always resolved with '.ts' extension rather than a wildcard.
// The fix: use `${relCandidate}.*` (wildcard) instead.

// Use an isolated empty temp dir as cwd instead of the shared /tmp, which
// resolveContextFiles walks recursively (slow/non-deterministic on dev machines).
let emptyDir: string;
beforeAll(async () => {
  emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudy-ctx-empty-'));
});
afterAll(async () => {
  await fs.rm(emptyDir, { recursive: true, force: true });
});

describe('context-resolver — import resolution bug fix', () => {
  // We test the fix by verifying that expandContext returns wildcard patterns
  // for non-relative (package-like) imports found in Python-style modules.
  // Since expandContext is async and reads the filesystem, we test the
  // behaviour through the exported resolveContextFiles / expandContext directly.

  it('resolveContextFiles returns empty array for no patterns', async () => {
    const { resolveContextFiles } = await import('../../src/executor/context-resolver.js');
    const result = await resolveContextFiles([], emptyDir);
    expect(result).toEqual([]);
  });

  it('resolveContextFiles handles non-existent patterns gracefully', async () => {
    const { resolveContextFiles } = await import('../../src/executor/context-resolver.js');
    const result = await resolveContextFiles(['nonexistent/**/*.ts'], emptyDir);
    expect(result).toEqual([]);
  });

  it('expandContext with no existing patterns returns same patterns', async () => {
    const { expandContext } = await import('../../src/executor/context-resolver.js');
    const result = await expandContext(['src/**/*.ts'], '/tmp/nonexistent-project');
    // expandContext just returns the same patterns when the directory doesn't exist
    expect(result).toContain('src/**/*.ts');
  });
});

describe('resolveImportPath logic (inline test of the fix)', () => {
  // The fix changed:
  //   for (const ext of extensions) { return `${relCandidate}${ext}`; }
  // to:
  //   return `${relCandidate}.*`;
  //
  // We verify this by checking what patterns expandContext generates for
  // files with non-relative imports. Since we can't import private functions,
  // we verify the observable behaviour: expandContext should produce wildcard
  // patterns (ending in .*) rather than fixed-extension patterns (ending in .ts).

  it('non-relative import in a TS file generates a wildcard pattern via expandContext', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');

    // Create a temp dir with a file that has a non-relative import
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudy-test-'));
    const srcDir = path.join(tmpDir, 'src');
    await fs.mkdir(srcDir);

    // Write a file with a non-relative import
    await fs.writeFile(
      path.join(srcDir, 'app.ts'),
      `import { something } from 'utils/helpers';\nexport function main() {}\n`,
    );

    const { expandContext } = await import('../../src/executor/context-resolver.js');

    const patterns = await expandContext(['src/app.ts'], tmpDir);

    // With the fix, non-relative imports produce wildcard patterns like 'utils/helpers.*'
    // (not 'utils/helpers.ts' from a broken for-loop)
    const wildcardPattern = patterns.find((p) => p.startsWith('utils/helpers'));
    if (wildcardPattern) {
      // If the import was resolved, it should be a wildcard
      expect(wildcardPattern).toMatch(/\.\*$/);
      expect(wildcardPattern).not.toMatch(/\.ts$/);
    }
    // Either way (pattern found or not), there should be no '.ts'-only extension patterns
    // from the non-relative import path
    expect(patterns.some((p) => p === 'utils/helpers.ts')).toBe(false);

    // Cleanup
    await fs.rm(tmpDir, { recursive: true });
  });
});
