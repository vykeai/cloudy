import { describe, it, expect, vi } from 'vitest';

// Mock dependencies before importing the module under test
<<<<<<< Updated upstream
// Default planning-runner mock — returns an empty success so verification passes gracefully
const DEFAULT_RUN_RESULT = {
=======
// Default runClaude mock — returns an empty success so verification passes gracefully
const DEFAULT_RUN_CLAUDE_RESULT = {
>>>>>>> Stashed changes
  success: true,
  output: '{}',
  error: undefined,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  durationMs: 100,
  costUsd: 0,
};

<<<<<<< Updated upstream
vi.mock('../../src/executor/model-runner.js', () => {
  const runPhaseModel = vi.fn().mockResolvedValue(DEFAULT_RUN_RESULT);
  return { runPhaseModel, runAbstractModel: runPhaseModel, runClaude: runPhaseModel };
});
=======
vi.mock('../../src/executor/claude-runner.js', () => ({
  runClaude: vi.fn().mockResolvedValue(DEFAULT_RUN_CLAUDE_RESULT),
}));
>>>>>>> Stashed changes

vi.mock('../../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  initLogger: vi.fn(),
}));

vi.mock('../../src/utils/claude-path.js', () => ({
  findClaudeBinary: vi.fn().mockResolvedValue('/usr/bin/claude'),
}));

function makePlanResponse(tasks: Array<{ id: string; timeoutMinutes?: number }>): string {
  return JSON.stringify({
    tasks: tasks.map((t) => ({
      id: t.id,
      title: `Task ${t.id}`,
      description: 'A task',
      acceptanceCriteria: ['It works'],
      dependencies: [],
      contextPatterns: [],
      ...(t.timeoutMinutes !== undefined ? { timeoutMinutes: t.timeoutMinutes } : {}),
    })),
  });
}

function makePathPlanResponse(cwd: string): string {
  return JSON.stringify({
    tasks: [
      {
        id: 'task-1',
        title: 'Task task-1',
        description: 'Create the output file',
        acceptanceCriteria: [
          `cd ${cwd} && test -f ${cwd}/SMOKE_RESULT.md exits 0`,
        ],
        dependencies: [],
        contextPatterns: [`${cwd}/src/**/*.ts`],
        outputArtifacts: [`${cwd}/SMOKE_RESULT.md`],
      },
    ],
  });
}

describe('createPlan — per-task timeout', () => {
  it('maps timeoutMinutes to timeout in ms', async () => {
    const { runPhaseModel } = await import('../../src/executor/model-runner.js');
    const mockRunPhaseModel = runPhaseModel as ReturnType<typeof vi.fn>;

    mockRunPhaseModel.mockResolvedValueOnce({
      success: true,
      output: makePlanResponse([{ id: 'task-1', timeoutMinutes: 30 }]),
      error: undefined,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 1000,
      costUsd: 0.001,
    });

    const { createPlan } = await import('../../src/planner/planner.js');
    const plan = await createPlan('Build something', 'sonnet', '/tmp');

    expect(plan.tasks[0].timeout).toBe(30 * 60_000); // 1_800_000 ms
  });

  it('uses 60 min default when timeoutMinutes is missing', async () => {
    const { runPhaseModel } = await import('../../src/executor/model-runner.js');
    const mockRunPhaseModel = runPhaseModel as ReturnType<typeof vi.fn>;

    mockRunPhaseModel.mockResolvedValueOnce({
      success: true,
      output: makePlanResponse([{ id: 'task-1' }]),
      error: undefined,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 1000,
      costUsd: 0.001,
    });

    const { createPlan } = await import('../../src/planner/planner.js');
    const plan = await createPlan('Build something', 'sonnet', '/tmp');

    expect(plan.tasks[0].timeout).toBe(60 * 60_000); // 3_600_000 ms
  });

  it('handles different timeoutMinutes per task', async () => {
    const { runPhaseModel } = await import('../../src/executor/model-runner.js');
    const mockRunPhaseModel = runPhaseModel as ReturnType<typeof vi.fn>;

    mockRunPhaseModel.mockResolvedValueOnce({
      success: true,
      output: makePlanResponse([
        { id: 'task-1', timeoutMinutes: 15 },
        { id: 'task-2', timeoutMinutes: 120 },
        { id: 'task-3' },
      ]),
      error: undefined,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 1000,
      costUsd: 0.001,
    });

    const { createPlan } = await import('../../src/planner/planner.js');
    const plan = await createPlan('Build something', 'sonnet', '/tmp');

    expect(plan.tasks[0].timeout).toBe(15 * 60_000);
    expect(plan.tasks[1].timeout).toBe(60 * 60_000); // capped at 60 min
    expect(plan.tasks[2].timeout).toBe(60 * 60_000); // default
  });

  it('forwards planning runtime overrides to the abstract runner', async () => {
    const { runPhaseModel } = await import('../../src/executor/model-runner.js');
    const mockRunPhaseModel = runPhaseModel as ReturnType<typeof vi.fn>;

    mockRunPhaseModel.mockResolvedValueOnce({
      success: true,
      output: makePlanResponse([{ id: 'task-1', timeoutMinutes: 30 }]),
      error: undefined,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 1000,
      costUsd: 0.001,
    });

    const { createPlan } = await import('../../src/planner/planner.js');
    await createPlan('Build something', 'sonnet', '/tmp', undefined, undefined, undefined, undefined, {
      engine: 'codex',
      provider: 'codex',
      modelId: 'o3',
    });

    expect(mockRunPhaseModel).toHaveBeenCalledWith(expect.objectContaining({
      engine: 'codex',
      provider: 'codex',
      modelId: 'o3',
      taskType: 'planning',
    }));
  });

  it('normalizes repo-absolute planner output back to repo-relative paths', async () => {
    const cwd = '/tmp/project';
    const { runPhaseModel } = await import('../../src/executor/model-runner.js');
    const mockRunPhaseModel = runPhaseModel as ReturnType<typeof vi.fn>;

    mockRunPhaseModel.mockResolvedValueOnce({
      success: true,
      output: makePathPlanResponse(cwd),
      error: undefined,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 1000,
      costUsd: 0.001,
    });

    const { createPlan } = await import('../../src/planner/planner.js');
    const plan = await createPlan('Build something', 'sonnet', cwd);

    expect(plan.tasks[0].acceptanceCriteria).toEqual([
      'cd . && test -f SMOKE_RESULT.md exits 0',
    ]);
    expect(plan.tasks[0].contextPatterns).toEqual(['src/**/*.ts']);
    expect(plan.tasks[0].outputArtifacts).toEqual(['SMOKE_RESULT.md']);
  });
});
