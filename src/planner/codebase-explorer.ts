/**
 * Deterministic codebase snapshot for planning context.
 *
 * Runs shell commands to capture repo structure, dependencies, and test layout.
 * No LLM call — just raw output injected into buildPlanningPrompt() as a
 * `# Codebase Snapshot` section. The planner model interprets the listing directly.
 */

import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface CodebaseSnapshot {
  summary: string;   // formatted markdown block, ready to inject into planning prompt
}

/**
 * Gather a lightweight snapshot of the repo at `cwd`.
 * Never throws — returns empty string on any failure so planning still proceeds.
 */
export async function exploreCodebase(cwd: string): Promise<string> {
  const parts: string[] = [];

  // ── Directory structure (top 2 levels) ──────────────────────────────────
  try {
    const { stdout } = await execa('find', ['.', '-maxdepth', '2', '-not', '-path', './.git/*', '-not', '-path', './node_modules/*', '-not', '-path', './.cloudy/*', '-not', '-path', './dist/*', '-not', '-path', './.next/*', '-not', '-path', './build/*', '-not', '-path', './__pycache__/*', '-not', '-path', './.venv/*', '-not', '-path', './target/*'], {
      cwd,
      reject: false,
    });
    if (stdout.trim()) {
      // Limit to 80 lines to keep context reasonable
      const lines = stdout.trim().split('\n').slice(0, 80).join('\n');
      parts.push('## Directory Structure (top 2 levels)\n```\n' + lines + '\n```');
    }
  } catch { /* skip */ }

  // ── Package manifest ─────────────────────────────────────────────────────
  for (const manifest of ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'build.gradle', 'Podfile']) {
    try {
      const content = await fs.readFile(path.join(cwd, manifest), 'utf8');
      // Only show the first 60 lines (scripts, dependencies, not full lockfile)
      const lines = content.split('\n').slice(0, 60).join('\n');
      parts.push(`## ${manifest}\n\`\`\`\n${lines}\n\`\`\``);
      break; // only first manifest found
    } catch { /* skip */ }
  }

  // ── Test files ───────────────────────────────────────────────────────────
  try {
    // -prune node_modules (skips descending into it, not just filtering matches)
    // and group the -name alternation in ( ) so it binds to -type f as a whole.
    // A bare `-o` in the old command let the first branch traverse the entire
    // tree (including node_modules), which was slow on large/shared dirs.
    const { stdout } = await execa('find', ['.', '-maxdepth', '6', '-type', 'd', '-name', 'node_modules', '-prune', '-o', '-type', 'f', '(', '-name', '*.test.*', '-o', '-name', '*.spec.*', ')', '-print'], {
      cwd,
      reject: false,
    });
    if (stdout.trim()) {
      const lines = stdout.trim().split('\n').slice(0, 30).join('\n');
      parts.push('## Test Files\n```\n' + lines + '\n```');
    }
  } catch { /* skip */ }

  // ── Build scripts ────────────────────────────────────────────────────────
  try {
    const pkgRaw = await fs.readFile(path.join(cwd, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
      const scripts = Object.entries(pkg.scripts)
        .map(([k, v]) => `  "${k}": "${v}"`)
        .join('\n');
      parts.push('## npm Scripts\n```json\n{\n' + scripts + '\n}\n```');
    }
  } catch { /* skip */ }

  if (parts.length === 0) return '';

  return '# Codebase Snapshot\n\n' + parts.join('\n\n') + '\n';
}
