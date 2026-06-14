/**
 * Tests for the 8 Cloudy improvements:
 * 1. maxCostPerRunUsd budget guard
 * 2. Plan quality warnings
 * 3. Known gaps in handoffs
 * 4. Spec coverage check
 * 5. Run branch creation
 * 6. Symbol-level context extraction
 * 7. Cross-run learning (loadRecentRunInsights)
 * 8. Differentiated retry formatting
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ── 1. maxCostPerRunUsd ───────────────────────────────────────────────────────

vi.mock('../../src/executor/model-runner.js', () => {
  const runPhaseModel = vi.fn().mockResolvedValue({
    success: true,
    output: 'done',
    error: undefined,
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    durationMs: 1000,
    costUsd: 5.0, // expensive — will trip the budget
  });
  return { runPhaseModel, runAbstractModel: runPhaseModel, runClaude: runPhaseModel };
});
vi.mock('../../src/executor/engine.js', () => ({
  runEngine: vi.fn().mockResolvedValue({
    success: true,
    output: 'done',
    error: undefined,
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    durationMs: 1000,
    costUsd: 5.0, // expensive — will trip the per-run budget in orchestrator tests
  }),
}));
vi.mock('../../src/executor/context-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/executor/context-resolver.js')>();
  return {
    ...actual,
    resolveContextFiles: vi.fn(async () => []),
    expandContext: vi.fn(async (p: string[]) => p),
    buildContextSection: vi.fn(() => ''),
  };
});
vi.mock('../../src/validator/validator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/validator/validator.js')>();
  return {
    ...actual,
    validateTask: vi.fn(async () => ({ taskId: 'task-1', passed: true, results: [] })),
  };
});
vi.mock('../../src/git/checkpoint.js', () => ({ createCheckpoint: vi.fn(async () => 'abc') }));
vi.mock('../../src/git/git.js', () => ({
  isGitRepo: vi.fn(async () => false),
  commitAll: vi.fn(async () => {}),
  getChangedFiles: vi.fn(async () => []),
  createRunBranch: vi.fn(async () => 'cloudy/run-test'),
}));
vi.mock('../../src/core/state.js', () => ({ saveState: vi.fn(async () => {}) }));
vi.mock('../../src/config/auto-routing.js', () => ({ routeModelForTask: vi.fn(() => 'sonnet') }));
// Stub the deterministic codebase snapshot — it shells out to `find` over the
// real cwd (/tmp here), which is slow/non-deterministic and irrelevant to the
// plan-quality / spec-coverage warnings under test.
vi.mock('../../src/planner/codebase-explorer.js', () => ({
  exploreCodebase: vi.fn(async () => ''),
}));
vi.mock('../../src/utils/logger.js', () => ({
  log: { info: vi.fn(async () => {}), warn: vi.fn(async () => {}), error: vi.fn(async () => {}) },
  logTaskOutput: vi.fn(async () => {}),
}));

import type { CloudyConfig, Plan, ProjectState, Task } from '../../src/core/types.js';

function makeTask(id: string, deps: string[] = []): Task {
  return {
    id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: ['File exists'],
    dependencies: deps,
    contextPatterns: [],
    status: 'pending',
    retries: 0,
    maxRetries: 0, // no retries
    ifFailed: 'skip',
    timeout: 3600000,
  };
}

function makeConfig(overrides: Partial<CloudyConfig> = {}): CloudyConfig {
  return {
    models: { planning: 'sonnet', execution: 'sonnet', validation: 'haiku' },
    validation: { typecheck: false, lint: false, build: false, test: false, aiReview: false, commands: [] },
    maxRetries: 0,
    parallel: false,
    maxParallel: 2,
    retryDelaySec: 0,
    taskTimeoutMs: 3600000,
    autoModelRouting: false,
    dashboard: false,
    dashboardPort: 3456,
    notifications: { desktop: false, sound: false },
    contextBudgetTokens: 0,
    contextBudgetMode: 'warn',
    preflightCommands: [],
    maxCostPerTaskUsd: 0,
    maxCostPerRunUsd: 0,
    worktrees: false,
    runBranch: false,
    approval: { mode: 'never', timeoutSec: 300, autoAction: 'continue' },
    engine: 'claude-code',
    review: { enabled: false, model: 'sonnet', failBlocksRun: false },
    ...overrides,
  };
}

function makeState(tasks: Task[]): ProjectState {
  return {
    version: 1,
    plan: { goal: 'test', tasks, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
    config: makeConfig(),
    costSummary: {
      totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0, totalEstimatedUsd: 0, byPhase: {}, byModel: {},
    },
  };
}

const { Orchestrator } = await import('../../src/core/orchestrator.js');
const { log } = await import('../../src/utils/logger.js');
const { extractTypeScriptSymbols } = await import('../../src/executor/context-resolver.js');
const { formatValidationErrors } = await import('../../src/validator/validator.js');

describe('1. maxCostPerRunUsd budget guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('aborts run and emits run_failed when cumulative cost exceeds limit', async () => {
    const tasks = [makeTask('task-1'), makeTask('task-2', ['task-1'])];
    const events: Array<{ type: string; error?: string }> = [];
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudy-improvements-'));

    const orchestrator = new Orchestrator({
      cwd,
      state: makeState(tasks),
      config: makeConfig({ maxCostPerRunUsd: 1.0 }), // limit $1, but runEngine costs $5
      onEvent: (e) => events.push(e as { type: string; error?: string }),
    });

    await orchestrator.run();

    const failEvent = events.find((e) => e.type === 'run_failed');
    expect(failEvent).toBeDefined();
    expect(failEvent?.error).toMatch(/budget exceeded/i);
  });

  it('does not abort when maxCostPerRunUsd is 0 (unlimited)', async () => {
    const tasks = [makeTask('task-1')];
    const events: Array<{ type: string }> = [];
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudy-improvements-'));

    const orchestrator = new Orchestrator({
      cwd,
      state: makeState(tasks),
      config: makeConfig({ maxCostPerRunUsd: 0 }),
      onEvent: (e) => events.push(e as { type: string }),
    });

    await orchestrator.run();

    // No run_failed event
    const failEvent = events.find((e) => e.type === 'run_failed');
    expect(failEvent).toBeUndefined();
  });
});

// ── 2 & 4. Plan quality warnings + spec coverage ──────────────────────────────

describe('2. Plan quality warnings', () => {
  it('warns when a task has zero acceptance criteria', async () => {
    const { runPhaseModel } = await import('../../src/executor/model-runner.js');
    vi.mocked(runPhaseModel).mockResolvedValueOnce({
      success: true,
      output: JSON.stringify({
        tasks: [{
          id: 'task-1', title: 'Empty task', description: 'something',
          acceptanceCriteria: [], dependencies: [], contextPatterns: [], outputArtifacts: [],
        }],
      }),
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 0, costUsd: 0,
    });
    // Second call (haiku verification) returns empty success
    vi.mocked(runPhaseModel).mockResolvedValueOnce({
      success: true, output: '{"task-1":[]}',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 0, costUsd: 0,
    });

    const { createPlan } = await import('../../src/planner/planner.js');
    await createPlan('build something', 'sonnet', '/tmp');

    const warnCalls = (vi.mocked(log.warn) as ReturnType<typeof vi.fn>).mock.calls;
    const warningTexts = warnCalls.map((c) => String(c[0]));
    expect(warningTexts.some((t) => /no acceptance criteria/i.test(t))).toBe(true);
  });

  it('warns when acceptance criteria are too vague (< 15 chars)', async () => {
    const { runPhaseModel } = await import('../../src/executor/model-runner.js');
    vi.mocked(runPhaseModel).mockResolvedValueOnce({
      success: true,
      output: JSON.stringify({
        tasks: [{
          id: 'task-1', title: 'Vague task', description: 'do it',
          acceptanceCriteria: ['It works', 'Done'], dependencies: [], contextPatterns: [], outputArtifacts: [],
        }],
      }),
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 0, costUsd: 0,
    });
    vi.mocked(runPhaseModel).mockResolvedValueOnce({
      success: true, output: '{"task-1":[]}',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 0, costUsd: 0,
    });

    const { createPlan } = await import('../../src/planner/planner.js');
    await createPlan('build something', 'sonnet', '/tmp');

    const warnCalls = (vi.mocked(log.warn) as ReturnType<typeof vi.fn>).mock.calls;
    const warningTexts = warnCalls.map((c) => String(c[0]));
    expect(warningTexts.some((t) => /vague/i.test(t))).toBe(true);
  });
});

describe('4. Spec coverage check', () => {
  it('warns when spec Acceptance Criteria are not covered by any task AC', async () => {
    const { runPhaseModel } = await import('../../src/executor/model-runner.js');
    vi.mocked(runPhaseModel).mockResolvedValueOnce({
      success: true,
      output: JSON.stringify({
        tasks: [{
          id: 'task-1', title: 'Some task', description: 'foo',
          acceptanceCriteria: ['Some unrelated thing is implemented correctly'], // doesn't cover spec AC
          dependencies: [], contextPatterns: [], outputArtifacts: [],
        }],
      }),
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 0, costUsd: 0,
    });
    vi.mocked(runPhaseModel).mockResolvedValueOnce({
      success: true, output: '{"task-1":[]}',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 0, costUsd: 0,
    });

    const { log } = await import('../../src/utils/logger.js');
    const { createPlan } = await import('../../src/planner/planner.js');

    const specContent = `
# My Feature Spec

## Acceptance Criteria
- POST /api/v1/workouts returns 201 with workout_id field in response
- GET /api/v1/workouts/:id returns 404 when workout does not exist
`;

    await createPlan('build something', 'sonnet', '/tmp', undefined, specContent);

    const warnCalls = (vi.mocked(log.warn) as ReturnType<typeof vi.fn>).mock.calls;
    const warningTexts = warnCalls.map((c) => String(c[0]));
    expect(warningTexts.some((t) => /spec coverage/i.test(t))).toBe(true);
  });
});

// ── 3. Known gaps in handoffs ────────────────────────────────────────────────

describe('3. Known gaps in handoffs', () => {
  it('includes Known gaps section when result summary contains TODO/stub lines', async () => {
    const { writeHandoff } = await import('../../src/knowledge/handoffs.js');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudy-test-'));

    await writeHandoff(
      'task-1',
      'Build auth module',
      'Implemented the login endpoint. TODO: add refresh token rotation. Left for next task: the logout endpoint. Stub: email verification is mocked.',
      [],
      tmpDir,
    );

    const handoffPath = path.join(tmpDir, '.cloudy', 'handoffs', 'task-1.md');
    const content = await fs.readFile(handoffPath, 'utf-8');

    expect(content).toContain('Known gaps / stubs');
    expect(content).toContain('TODO');

    await fs.rm(tmpDir, { recursive: true });
  });

  it('omits Known gaps section when result summary has no stubs or TODOs', async () => {
    const { writeHandoff } = await import('../../src/knowledge/handoffs.js');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudy-test-'));

    await writeHandoff(
      'task-2',
      'Clean task',
      'Implemented and tested the full feature. All criteria met. No outstanding work.',
      [],
      tmpDir,
    );

    const handoffPath = path.join(tmpDir, '.cloudy', 'handoffs', 'task-2.md');
    const content = await fs.readFile(handoffPath, 'utf-8');

    expect(content).not.toContain('Known gaps / stubs');

    await fs.rm(tmpDir, { recursive: true });
  });
});

// ── 5. Run branch ─────────────────────────────────────────────────────────────

describe('5. createRunBranch', () => {
  it('creates a branch named cloudy/run-<timestamp>', async () => {
    const { createRunBranch } = await import('../../src/git/git.js');
    // The mock always returns 'cloudy/run-test'
    const branch = await createRunBranch('/tmp/repo');
    expect(branch).toMatch(/cloudy\/run-/);
  });
});

// ── 6. Symbol-level context extraction ───────────────────────────────────────

describe('6. Symbol-level context extraction', () => {
  it('returns original content for files under the line threshold', () => {
    const content = 'const x = 1;\nexport function foo() { return x; }';
    expect(extractTypeScriptSymbols(content, 'src/small.ts')).toBe(content);
  });

  it('returns original content for non-TypeScript files regardless of length', () => {
    const longContent = 'def foo():\n    pass\n'.repeat(200); // 400 lines
    expect(extractTypeScriptSymbols(longContent, 'src/script.py')).toBe(longContent);
  });

  it('extracts symbols from large TypeScript files', () => {
    // Build a file > 150 lines with exported functions and bodies
    const lines = [
      'import { Thing } from "./thing.js";',
      'export interface Config { name: string; value: number; }',
    ];
    for (let i = 0; i < 160; i++) {
      lines.push(`export function fn${i}(x: number): number {`);
      lines.push(`  const result = x * ${i};`);
      lines.push(`  return result;`);
      lines.push(`}`);
    }
    const content = lines.join('\n');
    const result = extractTypeScriptSymbols(content, 'src/large.ts');

    // Should be a symbol extract, shorter than the original
    expect(result.length).toBeLessThan(content.length);
    expect(result).toContain('symbol extract');
    // Imports and exports should be present
    expect(result).toContain('import { Thing }');
    expect(result).toContain('export interface Config');
    expect(result).toContain('export function fn0');
    // Implementation bodies should be elided
    expect(result).toContain('// ...');
    // Raw implementation detail should not appear
    expect(result).not.toContain('const result = x * 0;');
  });
});

// ── 7. Cross-run learning ─────────────────────────────────────────────────────

describe('7. Cross-run learning (loadRecentRunInsights)', () => {
  it('returns undefined when no run files exist', async () => {
    const { loadRecentRunInsights } = await import('../../src/knowledge/run-logger.js');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudy-insights-'));
    const result = await loadRecentRunInsights(tmpDir);
    expect(result).toBeUndefined();
    await fs.rm(tmpDir, { recursive: true });
  });

  it('returns insights summary when failed tasks exist in run logs', async () => {
    const { loadRecentRunInsights } = await import('../../src/knowledge/run-logger.js');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudy-insights-'));
    const runsDir = path.join(tmpDir, '.cloudy', 'runs');
    await fs.mkdir(runsDir, { recursive: true });

    const failedEntry = JSON.stringify({
      ts: new Date().toISOString(),
      event: 'task_failed',
      taskId: 'task-3',
      title: 'Set up database',
      totalAttempts: 3,
      totalDurationMs: 60000,
      costUsd: 0.12,
      finalError: 'TypeScript error in schema',
      retryHistory: [
        { attempt: 1, timestamp: new Date().toISOString(), failureType: 'validation_problem', aiReview: 'Missing type annotation on entity field' },
      ],
      criteriaResults: [],
      lastAiReview: 'Missing type annotation on entity field',
    });

    await fs.writeFile(path.join(runsDir, 'run-20260101-120000.jsonl'), failedEntry + '\n', 'utf-8');

    const result = await loadRecentRunInsights(tmpDir);
    expect(result).toBeDefined();
    expect(result).toContain('failed');
    expect(result).toContain('task-3');

    await fs.rm(tmpDir, { recursive: true });
  });

  it('returns undefined when all runs had no failures or retries', async () => {
    const { loadRecentRunInsights } = await import('../../src/knowledge/run-logger.js');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudy-insights-'));
    const runsDir = path.join(tmpDir, '.cloudy', 'runs');
    await fs.mkdir(runsDir, { recursive: true });

    // Only a run_completed entry, no failures
    const completedEntry = JSON.stringify({
      ts: new Date().toISOString(),
      event: 'run_completed',
      runId: 'run-20260101',
      totalTasks: 5,
      completed: 5,
      failed: 0,
      skipped: 0,
      totalCostUsd: 0.1,
      totalInputTokens: 5000, totalOutputTokens: 1000, totalCacheReadTokens: 0,
      durationMs: 120000,
      failedTaskIds: [],
      costByModel: {}, costByPhase: {},
    });

    await fs.writeFile(path.join(runsDir, 'run-20260101-120000.jsonl'), completedEntry + '\n', 'utf-8');

    const result = await loadRecentRunInsights(tmpDir);
    expect(result).toBeUndefined();

    await fs.rm(tmpDir, { recursive: true });
  });
});

// ── 8. Differentiated retry formatting ───────────────────────────────────────

describe('8. Differentiated retry formatting (formatValidationErrors)', () => {
  it('extracts only failing criteria from ai-review output', () => {
    const aiReviewOutput = JSON.stringify({
      verdict: 'FAIL',
      summary: 'Two criteria failed',
      criteriaResults: [
        { criterion: 'POST /api/v1/workouts returns 201', met: true, reason: 'endpoint exists' },
        { criterion: 'GET /api/v1/workouts/:id returns 404 for missing', met: false, reason: 'returns 500 instead of 404' },
        { criterion: 'Response includes workout_id field', met: false, reason: 'field missing from response body' },
      ],
      issues: [],
      conventionViolations: [],
      suggestions: [],
      rerunTaskIds: [],
    });

    const report = {
      taskId: 'task-1',
      passed: false,
      results: [{ strategy: 'ai-review' as const, passed: false, output: aiReviewOutput, durationMs: 100 }],
    };

    const formatted = formatValidationErrors(report);

    // Should show failing criteria with reasons
    expect(formatted).toContain('GET /api/v1/workouts/:id returns 404 for missing');
    expect(formatted).toContain('returns 500 instead of 404');
    expect(formatted).toContain('Response includes workout_id field');
    expect(formatted).toContain('field missing from response body');

    // Should NOT include the passing criterion
    expect(formatted).not.toContain('POST /api/v1/workouts returns 201');

    // Should NOT be a raw JSON blob
    expect(formatted).not.toContain('"criteriaResults"');
  });

  it('formats artifact failures as a clean list', () => {
    const report = {
      taskId: 'task-1',
      passed: false,
      results: [{
        strategy: 'artifacts' as const,
        passed: false,
        output: 'Missing required output artifacts:\n- src/auth/routes.ts\n- migrations/001_users.sql',
        durationMs: 10,
      }],
    };

    const formatted = formatValidationErrors(report);

    expect(formatted).toContain('missing files');
    expect(formatted).toContain('src/auth/routes.ts');
    expect(formatted).toContain('migrations/001_users.sql');
  });

  it('keeps raw output for typecheck failures', () => {
    const typecheckOutput = `src/auth/service.ts(42,7): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`;

    const report = {
      taskId: 'task-1',
      passed: false,
      results: [{ strategy: 'typecheck' as const, passed: false, output: typecheckOutput, durationMs: 2000 }],
    };

    const formatted = formatValidationErrors(report);

    expect(formatted).toContain('src/auth/service.ts(42,7)');
    expect(formatted).toContain('TS2345');
    expect(formatted).toContain('[typecheck]');
  });

  it('falls back gracefully when ai-review output is not valid JSON', () => {
    const report = {
      taskId: 'task-1',
      passed: false,
      results: [{ strategy: 'ai-review' as const, passed: false, output: 'The implementation looks wrong but I could not format this as JSON', durationMs: 100 }],
    };

    const formatted = formatValidationErrors(report);

    // Should still produce some output
    expect(formatted).toBeTruthy();
    expect(formatted).toContain('[ai-review]');
  });
});

// ── New improvements (#1–#8) ──────────────────────────────────────────────────

describe('#8 failBlocksRun — ReviewConfig defaults', () => {
  it('DEFAULT_CONFIG has failBlocksRun: false', async () => {
    const { DEFAULT_CONFIG } = await import('../../src/config/defaults.js');
    expect(DEFAULT_CONFIG.review.failBlocksRun).toBe(false);
  });
});

describe('#7 contextBudgetMode — config defaults', () => {
  it('DEFAULT_CONFIG has contextBudgetMode: warn', async () => {
    const { DEFAULT_CONFIG } = await import('../../src/config/defaults.js');
    expect(DEFAULT_CONFIG.contextBudgetMode).toBe('warn');
  });
});

describe('#6 preflightCommands — config defaults', () => {
  it('DEFAULT_CONFIG has empty preflightCommands', async () => {
    const { DEFAULT_CONFIG } = await import('../../src/config/defaults.js');
    expect(DEFAULT_CONFIG.preflightCommands).toEqual([]);
  });
});

describe('#3 mid-task escalation marker', () => {
  const ESCALATE_RE = /<ESCALATE>([\s\S]*?)<\/ESCALATE>/i;

  it('matches escalate tag and extracts the question', () => {
    const text = 'I need clarification. <ESCALATE>Should I use PostgreSQL or SQLite?</ESCALATE>';
    const m = text.match(ESCALATE_RE);
    expect(m?.[1].trim()).toBe('Should I use PostgreSQL or SQLite?');
  });

  it('matches case-insensitively', () => {
    const text = '<escalate>What auth strategy?</escalate>';
    expect(text.match(ESCALATE_RE)?.[1].trim()).toBe('What auth strategy?');
  });

  it('does not match normal assistant text', () => {
    expect('I will now implement the feature.'.match(ESCALATE_RE)).toBeNull();
  });
});

describe('#2 AC path validator — regex', () => {
  const PATH_RE = /(?:^|\s)((?:\.\.?\/|src\/|packages?\/|apps?\/|lib\/|tests?\/)\S+\.\w{1,10})(?:\s|$|[,;])/g;

  it('extracts a src-relative path from an AC string', () => {
    const ac = 'src/utils/helper.ts exports a doThing function';
    PATH_RE.lastIndex = 0;
    expect(PATH_RE.exec(ac)?.[1]).toBe('src/utils/helper.ts');
  });

  it('extracts tests/ paths', () => {
    const ac = 'tests/unit/foo.test.ts passes all assertions';
    PATH_RE.lastIndex = 0;
    expect(PATH_RE.exec(ac)?.[1]).toBe('tests/unit/foo.test.ts');
  });

  it('does not match plain prose without file extensions', () => {
    PATH_RE.lastIndex = 0;
    expect(PATH_RE.exec('The API should return 200 OK for valid requests')).toBeNull();
  });
});
