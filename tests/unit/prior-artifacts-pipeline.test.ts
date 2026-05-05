import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, ValidationConfig } from '../../src/core/types.js';
import type { PriorArtifact } from '../../src/planner/prompts.js';

// Mock all external dependencies
vi.mock('../../src/validator/strategies/type-check.js', () => ({
  runTypeCheck: vi.fn(async () => ({ strategy: 'typecheck', passed: true, output: '', durationMs: 10 })),
}));
vi.mock('../../src/validator/strategies/lint-check.js', () => ({
  runLintCheck: vi.fn(async () => ({ strategy: 'lint', passed: true, output: '', durationMs: 10 })),
}));
vi.mock('../../src/validator/strategies/build-check.js', () => ({
  runBuildCheck: vi.fn(async () => ({ strategy: 'build', passed: true, output: '', durationMs: 10 })),
  detectPlatformBuildNeeds: vi.fn(() => ({ ios: false, android: false })),
  runIosBuildCheck: vi.fn(async () => null),
  runAndroidBuildCheck: vi.fn(async () => null),
}));
vi.mock('../../src/validator/strategies/test-runner.js', () => ({
  runTestRunner: vi.fn(async () => ({ strategy: 'test', passed: true, output: '', durationMs: 10 })),
}));
vi.mock('../../src/validator/strategies/artifact-check.js', () => ({
  runArtifactCheck: vi.fn(async () => ({ strategy: 'artifacts', passed: true, output: 'All present', durationMs: 5 })),
}));
vi.mock('../../src/git/git.js', () => ({
  getGitDiff: vi.fn(async () => `diff --git a/api/routes.py b/api/routes.py
--- a/api/routes.py
+++ b/api/routes.py
@@ -100,3 +100,5 @@
+@router.post("/messages")
+async def create_message(): pass`),
  getChangedFiles: vi.fn(async () => ['api/routes.py']),
}));
vi.mock('../../src/utils/logger.js', () => ({
  log: { info: vi.fn(async () => {}), warn: vi.fn(async () => {}), error: vi.fn(async () => {}) },
}));
vi.mock('node:fs/promises', () => ({
  default: { readFile: vi.fn(async () => '@router.post("/messages")\nasync def create_message(): pass') },
}));
vi.mock('../../src/validator/strategies/ai-review.js', () => ({
  runAiReview: vi.fn(async () => ({
    strategy: 'ai-review', passed: true, output: '{"passed":true,"summary":"ok","criteriaResults":[]}', durationMs: 200,
  })),
}));
vi.mock('../../src/validator/strategies/ai-review-quality.js', () => ({
  runAiQualityReview: vi.fn(async () => ({ strategy: 'ai-review-quality', passed: true, output: 'Code quality good', durationMs: 100 })),
}));

import { validateTask } from '../../src/validator/validator.js';
import { runAiReview } from '../../src/validator/strategies/ai-review.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'TASK-1802: Message REST API',
    description: 'Add message endpoints',
    acceptanceCriteria: ['send_message creates message in target inbox'],
    dependencies: ['task-7'],
    contextPatterns: [],
    status: 'completed',
    retries: 0,
    maxRetries: 2,
    ifFailed: 'halt',
    timeout: 3600000,
    ...overrides,
  };
}

const AI_REVIEW_ONLY: ValidationConfig = {
  typecheck: false, lint: false, build: false, test: false,
  aiReview: true, commands: [],
};

describe('prior artifacts threaded through validation pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runAiReview).mockResolvedValue({
      strategy: 'ai-review', passed: true, output: '{"passed":true,"summary":"ok","criteriaResults":[]}', durationMs: 200,
    });
  });

  it('passes priorArtifacts to runAiReview when provided', async () => {
    const priorArtifacts: PriorArtifact[] = [
      { file: 'api/messages.py', taskId: 'task-7', taskTitle: 'Agent message store' },
    ];
    await validateTask({
      task: makeTask(),
      config: AI_REVIEW_ONLY,
      model: 'haiku',
      cwd: '/tmp',
      priorArtifacts,
    });

<<<<<<< Updated upstream
    const call = vi.mocked(runAiReview).mock.calls[0];
    expect(call[6]).toEqual(priorArtifacts);
    expect(call[7]).toBeUndefined();
    expect(call[8]).toEqual([]);
    expect(call[9]).toEqual([]);
    expect(call[10]).toBeUndefined();
=======
    expect(runAiReview).toHaveBeenCalledWith(
      expect.any(String),         // taskTitle
      expect.any(Array),          // acceptanceCriteria
      expect.any(String),         // gitDiff
      expect.any(String),         // model
      expect.any(String),         // cwd
      expect.any(Array),          // changedFileSections
      priorArtifacts,             // ← must be forwarded
      undefined,                  // artifactCheckPassed (no outputArtifacts on task)
      undefined,                  // taskOutputArtifacts (no outputArtifacts on task)
      expect.any(Array),          // commandResults
    );
>>>>>>> Stashed changes
  });

  it('passes undefined priorArtifacts when not provided', async () => {
    await validateTask({
      task: makeTask(),
      config: AI_REVIEW_ONLY,
      model: 'haiku',
      cwd: '/tmp',
    });

<<<<<<< Updated upstream
    const call = vi.mocked(runAiReview).mock.calls[0];
    expect(call[6]).toBeUndefined();
    expect(call[7]).toBeUndefined();
    expect(call[8]).toEqual([]);
    expect(call[9]).toEqual([]);
    expect(call[10]).toBeUndefined();
=======
    expect(runAiReview).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(Array),
      undefined,            // priorArtifacts is undefined when not passed
      undefined,            // artifactCheckPassed (no outputArtifacts on task)
      undefined,            // taskOutputArtifacts (no outputArtifacts on task)
      expect.any(Array),   // commandResults
    );
>>>>>>> Stashed changes
  });

  it('passes artifact check result to runAiReview', async () => {
    const task = makeTask({ outputArtifacts: ['web/src/app/api/v1/messages/route.ts'] });
    await validateTask({
      task,
      config: AI_REVIEW_ONLY,
      model: 'haiku',
      cwd: '/tmp',
    });

    // artifactCheckPassed arg should be true (mock returns passed: true)
    const call = vi.mocked(runAiReview).mock.calls[0];
    const artifactCheckPassed = call[7]; // 8th argument
    expect(artifactCheckPassed).toBe(true);
  });

  it('passes task.outputArtifacts to runAiReview', async () => {
    const artifacts = ['web/src/components/AgentInbox.tsx', 'web/src/components/InboxBadge.tsx'];
    const task = makeTask({ outputArtifacts: artifacts });
    await validateTask({
      task,
      config: AI_REVIEW_ONLY,
      model: 'haiku',
      cwd: '/tmp',
    });

    const call = vi.mocked(runAiReview).mock.calls[0];
    const taskOutputArtifacts = call[8]; // 9th argument
    expect(taskOutputArtifacts).toEqual(artifacts);
  });

  it('still passes when priorArtifacts not relevant to outcome (AI returns passed)', async () => {
    const report = await validateTask({
      task: makeTask(),
      config: AI_REVIEW_ONLY,
      model: 'haiku',
      cwd: '/tmp',
      priorArtifacts: [{ file: 'api/messages.py', taskId: 'task-7', taskTitle: 'Store' }],
    });
    expect(report.passed).toBe(true);
  });
});
