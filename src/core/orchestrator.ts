import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CloudyConfig,
  ClaudeModel,
  Engine,
  OrchestratorEventHandler,
  Plan,
  ProjectState,
  RetryHistoryEntry,
  Task,
  TaskExecutionMode,
} from './types.js';
import { TaskQueue } from './task-queue.js';
import { ParallelScheduler } from './parallel-scheduler.js';
import { runEngine } from '../executor/engine.js';
import {
  buildExecutionPrompt,
  buildRetryPrompt,
} from '../executor/prompt-builder.js';
import {
  resolveContextFiles,
  expandContext,
} from '../executor/context-resolver.js';
import { validateTask, formatValidationErrors } from '../validator/validator.js';
import { createCheckpoint } from '../git/checkpoint.js';
import { commitAll, isGitRepo, getGitDiff, getChangedFiles, rollbackToCheckpoint, createRunBranch } from '../git/git.js';
import {
  createWorktree,
  mergeWorktree,
  removeWorktree,
  type WorktreeInfo,
} from '../git/worktree.js';
import { CostTracker } from '../cost/tracker.js';
import { routeModelForTask } from '../config/auto-routing.js';
import { getPhaseRuntime } from '../config/phase-runtime.js';
import { saveState } from './state.js';
import { log, logTaskOutput } from '../utils/logger.js';
import { execa } from 'execa';
import {
  writeHandoff,
  readHandoffs,
  appendLearning,
  readLearnings,
  extractLearning,
} from '../knowledge/handoffs.js';
import { RunLogger } from '../knowledge/run-logger.js';
import { parseSubtasks } from './subtask-parser.js';
import { waitForApproval, type ApprovalHandler } from './approval.js';
import { logApproval } from '../utils/approval-log.js';
import { assessTaskRisk, getExecutionDefaults, getTaskToolPolicy, inferExecutionMode, isTerminalFailureType } from './task-shape.js';

const DISCOVERY_READ_TOOL_NAMES = new Set(['Read', 'LS', 'Glob', 'Grep', 'Find', 'ToolSearch']);
const WRITE_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit']);
const VERIFY_FIRST_TASK_TYPES = new Set(['verify', 'review', 'closeout']);
const SCOPED_IMPLEMENT_FIRST_WRITE_DISCOVERY_LIMIT = 8;
const SCOPED_IMPLEMENT_FIRST_WRITE_TIME_MS = 75_000;
const SCOPED_IMPLEMENT_FIRST_WRITE_MIN_DISCOVERY_OPS = 6;
const SCOPED_IMPLEMENT_PREWRITE_SHELL_DISCOVERY_LIMIT = 2;

function getScopedFirstWriteDiscoveryLimit(task: Task): number {
  const writeScopeSize = task.allowedWritePaths?.length ?? 0;
  if (writeScopeSize <= 2) return SCOPED_IMPLEMENT_FIRST_WRITE_DISCOVERY_LIMIT;
  return Math.min(12, SCOPED_IMPLEMENT_FIRST_WRITE_DISCOVERY_LIMIT + (writeScopeSize - 2));
}

function getScopedFirstWriteMinDiscoveryOps(task: Task): number {
  const discoveryLimit = getScopedFirstWriteDiscoveryLimit(task);
  const writeScopeSize = task.allowedWritePaths?.length ?? 0;
  return Math.min(discoveryLimit - 1, SCOPED_IMPLEMENT_FIRST_WRITE_MIN_DISCOVERY_OPS + Math.max(0, writeScopeSize - 2));
}

function getScopedFirstWriteTimeMs(task: Task): number {
  const writeScopeSize = task.allowedWritePaths?.length ?? 0;
  if (writeScopeSize <= 2) return SCOPED_IMPLEMENT_FIRST_WRITE_TIME_MS;
  return SCOPED_IMPLEMENT_FIRST_WRITE_TIME_MS + Math.min(30_000, (writeScopeSize - 2) * 10_000);
}

function classifyRetryFailure(error: string | undefined): RetryHistoryEntry['failureType'] {
  const message = (error ?? '').toLowerCase();
  if (message.includes('out-of-scope') || message.includes('outside allowed task scope')) return 'out_of_scope_drift';
  if (message.includes('validation configuration') || message.includes('validator mismatch') || message.includes('build override required')) {
    return 'validation_problem';
  }
  if (message.includes('over-exploration') || message.includes('no file writes after') || message.includes('pre-write shell discovery')) return 'executor_nonperformance';
  if (message.includes('already satisf') || message.includes('already complete')) return 'already_satisfied';
  if (message.includes('task spec') || message.includes('missing validation override') || message.includes('risk preflight refused')) return 'task_spec_problem';
  if (message.includes('timed out') || message.includes('hung engine')) return 'timeout';
  if (message.includes('daemon') || message.includes('config profile') || message.includes('not found') || message.includes('engine "') || message.includes('install')) {
    return 'environment_failure';
  }
  if (message.includes('acceptance criteria') || message.includes('criteria not met')) return 'acceptance_failure';
  return 'implementation_failure';
}

function isBroadDiscoveryCommand(command: string): boolean {
  return /\b(find|grep\s+-r|grep\s+-R|ls\s+-R|tree)\b/.test(command) || /\| head\b/.test(command);
}

function normalizePathForScope(candidate: string, cwd: string): string {
  const expanded = candidate.startsWith('~/')
    ? path.join(process.env.HOME ?? '', candidate.slice(2))
    : candidate;
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.normalize(path.join(cwd, expanded));
}

function pathWithin(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function matchesAllowedWritePath(filePath: string, cwd: string, allowedWritePaths: string[]): boolean {
  if (allowedWritePaths.length === 0) return pathWithin(cwd, filePath);
  const relative = path.relative(cwd, filePath).replace(/\\/g, '/');
  return allowedWritePaths.some((allowed) => {
    const normalized = allowed.replace(/\\/g, '/').replace(/\/+$/, '');
    return relative === normalized || relative.startsWith(`${normalized}/`);
  });
}

function findOutOfScopeRepoPath(command: string, allowedRoots: string[]): string | null {
  const matches = command.match(/\/Users\/[^\s"'`]+/g) ?? [];
  for (const match of matches) {
    const normalized = path.normalize(match);
    const withinAllowedRoot = allowedRoots.some((root) => pathWithin(root, normalized));
    if (normalized.includes('/dev/') && !withinAllowedRoot) {
      return normalized;
    }
  }
  return null;
}

function recordFirstWriteProgress(
  task: Task,
  executionMode: TaskExecutionMode,
  engineStartMs: number,
  firstWriteDeadlineId: NodeJS.Timeout | undefined,
): void {
  if (firstWriteDeadlineId) {
    clearTimeout(firstWriteDeadlineId);
  }
  if (!task.executionMetrics?.timeToFirstWriteMs) {
    task.executionMetrics = {
      ...(task.executionMetrics ?? {
        discoveryOpsBeforeFirstWrite: 0,
        subagentCalls: 0,
        writeCount: 0,
        verificationOps: 0,
        executionMode,
      }),
      timeToFirstWriteMs: Date.now() - engineStartMs,
    };
  }
}

function extractWriteCandidates(toolName: string, toolInput: unknown, cwd: string): string[] {
  if (!WRITE_TOOL_NAMES.has(toolName)) return [];
  const input = (toolInput ?? {}) as Record<string, unknown>;
  const candidates = new Set<string>();
  for (const key of ['file_path', 'path']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      candidates.add(normalizePathForScope(value, cwd));
    }
  }
  return [...candidates];
}

function classifyValidationConfigError(report: Awaited<ReturnType<typeof validateTask>>): string | null {
  const failing = report.results.find((result) => !result.passed);
  if (!failing) return null;
  const output = failing.output.toLowerCase();
  if (failing.strategy === 'build' && (
    output.includes('xcodebuild') ||
    output.includes('scheme') ||
    output.includes('destination') ||
    output.includes('simulator') ||
    output.includes('generic/platform=ios simulator') ||
    output.includes('assembledebug') ||
    output.includes('gradle')
  )) {
    return 'Validation configuration error: platform build command needs an explicit task-level override. Preserve the implementation diff, stop retrying, and surface the failing command/output for manual review.';
  }
  return null;
}

// ── Project conventions loader ────────────────────────────────────────────────

/**
 * Read project conventions from CLAUDE.md, AGENTS.md, or CONVENTIONS.md.
 * These are injected into every execution prompt so Claude knows the rules.
 */
async function readConventions(cwd: string): Promise<string | undefined> {
  const candidates = [
    'CLAUDE.md',
    'AGENTS.md',
    '.claude/CLAUDE.md',
    'CONVENTIONS.md',
    '.cursorrules',
  ];
  for (const name of candidates) {
    try {
      const content = await fs.readFile(path.join(cwd, name), 'utf-8');
      if (content.trim()) {
        await log.info(`  Loaded conventions from ${name} (${content.length} chars)`);
        return content.trim();
      }
    } catch {
      // not found, try next
    }
  }
  return undefined;
}

// ── Error context extractor ───────────────────────────────────────────────────

/**
 * Parse validation error text for file:line references and return code snippets.
 * This gives the retry prompt precise context about what broke and where.
 */
async function extractErrorFileContext(errors: string, cwd: string): Promise<string> {
  // Match patterns like: src/file.ts:45, api/routes.py:123:5, ./lib/foo.js:7
  const fileLineRe = /(?:^|\s)(\.?\.?\/)?(?:[\w./\-]+\/)?[\w.\-]+\.(ts|tsx|py|js|jsx|go|rs|swift):(\d+)/gm;
  const seen = new Set<string>();
  const snippets: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = fileLineRe.exec(errors)) !== null) {
    // Extract just the file path part
    const raw = match[0].trim();
    const colonIdx = raw.lastIndexOf(':');
    if (colonIdx < 0) continue;
    const filePart = raw.slice(0, colonIdx);
    const lineStr = raw.slice(colonIdx + 1).split(':')[0]; // strip extra :col

    const key = `${filePart}:${lineStr}`;
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const fullPath = path.isAbsolute(filePart) ? filePart : path.join(cwd, filePart);
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');
      const lineNum = parseInt(lineStr, 10) - 1;
      if (lineNum < 0 || lineNum >= lines.length) continue;

      const start = Math.max(0, lineNum - 4);
      const end = Math.min(lines.length - 1, lineNum + 4);
      const snippet = lines.slice(start, end + 1)
        .map((l, i) => {
          const n = start + i + 1;
          const marker = n === lineNum + 1 ? '>>>' : '   ';
          return `${marker} ${String(n).padStart(4)}: ${l}`;
        })
        .join('\n');

      snippets.push(`**${filePart}** (around line ${lineStr}):\n\`\`\`\n${snippet}\n\`\`\``);
    } catch {
      // File not readable — skip
    }
  }

  if (snippets.length === 0) return '';
  return `# Failing Code Snippets\n\n${snippets.join('\n\n')}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export interface OrchestratorOptions {
  cwd: string;
  state: ProjectState;
  config: CloudyConfig;
  onEvent?: OrchestratorEventHandler;
  dryRun?: boolean;
  onApprovalRequest?: ApprovalHandler;
  onReviewModelRequest?: () => Promise<ClaudeModel | 'skip'>;
}

export class Orchestrator {
  private cwd: string;
  private state: ProjectState;
  private config: CloudyConfig;
  private onEvent: OrchestratorEventHandler;
  private costTracker: CostTracker;
  private dryRun: boolean;
  private abortController = new AbortController();
  private onApprovalRequest?: ApprovalHandler;
  private onReviewModelRequest?: () => Promise<ClaudeModel | 'skip'>;
  private runLogger!: RunLogger;
  private taskStartCostUsd = new Map<string, number>();
  private rollingContextSummary = '';
  private completedTasksForSummary = 0;
  private reviewBaseSha?: string;

  constructor(options: OrchestratorOptions) {
    this.cwd = options.cwd;
    this.state = options.state;
    this.config = options.config;
    this.onEvent = options.onEvent ?? (() => {});
    this.costTracker = new CostTracker();
    this.dryRun = options.dryRun ?? false;
    this.onApprovalRequest = options.onApprovalRequest;
    this.onReviewModelRequest = options.onReviewModelRequest;
    this.reviewBaseSha = this.state.plan?.tasks.find((task) => task.checkpointSha)?.checkpointSha;
  }

  private needsApproval(task: Task): boolean {
    const mode = this.config.approval?.mode ?? 'never';
    return task.requiresApproval === true || mode === 'always';
  }

  abort(): void {
    this.abortController.abort();
  }

  get aborted(): boolean {
    return this.abortController.signal.aborted;
  }

  private async finalizeSuccessfulTask(
    task: Task,
    queue: TaskQueue,
    plan: Plan,
    taskCwd: string,
    checkpointSha: string | undefined,
    report: Awaited<ReturnType<typeof validateTask>>,
    attempt: number,
    taskStartTime: number,
    engineModel: string,
    engine: Engine,
  ): Promise<void> {
    task.durationMs = Date.now() - taskStartTime;
    queue.updateStatus(task.id, report.alreadySatisfied ? 'completed_without_changes' : 'completed');
    this.onEvent({
      type: 'task_completed',
      taskId: task.id,
      title: task.title,
      durationMs: task.durationMs,
      resultSummary: task.resultSummary,
    });
    this.emitProgress(queue);
    await log.info(`  Task "${task.id}" completed successfully`);

    const filesChanged = await getChangedFiles(taskCwd, checkpointSha).catch(() => []);
    await writeHandoff(
      task.id,
      task.title,
      `${task.resultSummary ?? ''}${report.alreadySatisfied ? '\nAlready satisfied: verified existing implementation/proof without code changes.' : ''}`,
      task.acceptanceCriteriaResults ?? [],
      this.cwd,
      filesChanged,
    ).catch(() => {});

    const taskCostUsd = this.costTracker.getSummary().totalEstimatedUsd
      - (this.taskStartCostUsd.get(task.id) ?? 0);
    await this.runLogger.logTaskCompleted({
      taskId: task.id,
      title: task.title,
      attempt,
      durationMs: task.durationMs ?? 0,
      costUsd: Math.round(taskCostUsd * 10000) / 10000,
      model: String(engineModel),
      engine,
      filesChanged,
      criteriaResults: task.acceptanceCriteriaResults ?? [],
      resultSummary: task.resultSummary ?? '',
      validationStrategies: report.results.map((r) => r.strategy),
    }).catch(() => {});

    plan.tasks = queue.getAllTasks();
    this.state.costSummary = this.costTracker.getSummary();
    await saveState(this.cwd, this.state);
  }

  async run(): Promise<void> {
    const plan = this.state.plan;
    if (!plan) {
      throw new Error('No plan found. Run "cloudy init" first.');
    }

    this.state.startedAt = new Date().toISOString();
    const queue = new TaskQueue(plan.tasks);

    // Run logger — appends JSONL on each task event for post-run AI analysis
    this.runLogger = new RunLogger(this.cwd);
    await this.runLogger.init();
    this.taskStartCostUsd = new Map();

    // Create a dedicated branch for this run so all task commits stay off main
    if (this.config.runBranch && await isGitRepo(this.cwd)) {
      try {
        const branch = await createRunBranch(this.cwd);
        await log.info(`Created run branch: ${branch}`);
        this.onEvent({ type: 'run_status', status: 'running' });
      } catch (err) {
        await log.warn(`Could not create run branch (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await log.info(`Starting execution of ${plan.tasks.length} tasks`);

    // #6 — Run preflight commands before first task (e.g. sentinel validate, simctl check)
    const preflightCmds: string[] = (this.config as any).preflightCommands ?? [];
    if (preflightCmds.length > 0 && !this.dryRun) {
      await log.info(`Running ${preflightCmds.length} preflight command(s)…`);
      for (const cmd of preflightCmds) {
        await log.info(`  $ ${cmd}`);
        const parts = cmd.split(/\s+/);
        const result = await execa(parts[0]!, parts.slice(1), { cwd: this.cwd, reject: false, shell: false });
        if (result.exitCode !== 0) {
          const errText = (result.stderr || result.stdout || '').slice(0, 500);
          throw new Error(`Preflight command failed: ${cmd}\n${errText}`);
        }
      }
      await log.info('Preflight checks passed');
    }

    if (this.dryRun) {
      this.runDryRun(queue);
      return;
    }

    if (this.config.parallel) {
      const useWorktrees = this.config.worktrees && await isGitRepo(this.cwd);
      const scheduler = new ParallelScheduler(queue, {
        maxParallel: this.config.maxParallel,
        executeTask: async (task) => {
          let worktree: WorktreeInfo | null = null;
          let taskCwd = this.cwd;

          if (useWorktrees) {
            try {
              worktree = await createWorktree(this.cwd, task.id);
              taskCwd = worktree.path;
            } catch (err) {
              await log.warn(
                `Failed to create worktree for ${task.id}: ${err instanceof Error ? err.message : String(err)} — running in main cwd`,
              );
            }
          }

          try {
            await this.executeTask(task, queue, plan, taskCwd);
          } finally {
            if (worktree) {
              const mergeResult = await mergeWorktree(this.cwd, worktree).catch(() => ({
                merged: false,
                conflict: true,
              }));
              if (!mergeResult.merged && mergeResult.conflict) {
                if (queue.getTask(task.id)?.status === 'completed') {
                  queue.setError(task.id, 'Merge conflict when integrating changes');
                  queue.updateStatus(task.id, 'failed');
                }
              }
              await removeWorktree(this.cwd, worktree).catch(() => {});
            }
          }
        },
        cwd: this.cwd,
      });
      this.abortController.signal.addEventListener('abort', () => scheduler.abort(), { once: true });
      await scheduler.run();
    } else {
      await this.runSequential(queue, plan);
    }

    // Update plan tasks from queue
    plan.tasks = queue.getAllTasks();
    plan.updatedAt = new Date().toISOString();

    // Finalize
    this.state.costSummary = this.costTracker.getSummary();
    this.state.completedAt = new Date().toISOString();
    await saveState(this.cwd, this.state);

    // Write run summary to log
    const allTasks = queue.getAllTasks();
    const completedTasks = allTasks.filter((t) => t.status === 'completed');
    const failedTasks = allTasks.filter((t) => t.status === 'failed');
    const skippedTasks = allTasks.filter((t) => t.status === 'skipped');
    await this.runLogger.logRunCompleted({
      totalTasks: allTasks.length,
      completed: completedTasks.length,
      failed: failedTasks.length,
      skipped: skippedTasks.length,
      failedTaskIds: failedTasks.map((t) => t.id),
      costSummary: this.costTracker.getSummary(),
      tasks: allTasks,
    }).catch(() => {});

    // Wrap-up: run after all tasks finish, even if some failed, unless aborted
    if (!this.aborted && plan.wrapUpPrompt) {
      await this.runWrapUp(plan.wrapUpPrompt);
    }

    // Post-run holistic review + auto-recovery loop
    if (!this.aborted && this.config.review?.enabled !== false) {
      const reviewResult = await this.runHolisticReview();

      // Auto-recovery: if reviewer flagged tasks for re-run, reset and re-execute them
      // If verdict is FAIL but rerunTaskIds is empty (truncated/malformed review), fall back
      // to re-running all failed tasks
      // #8 — PASS_WITH_NOTES: log notes prominently; run a second pass if doublePass is configured
      if (reviewResult && reviewResult.verdict === 'PASS_WITH_NOTES') {
        await log.info('Holistic review passed with notes — implementation complete but has minor concerns');
        if ((this.config.review as any)?.doublePass) {
          await log.info('Running second holistic review pass (review.doublePass enabled)');
          const secondResult = await this.runHolisticReview();
          if (secondResult && secondResult.verdict === 'PASS_WITH_NOTES') {
            await log.info('Second holistic pass also has notes — accepting (no further passes)');
          }
          // Do NOT recurse further — max 2 holistic passes to avoid infinite loops
        }
      }

      if (reviewResult && reviewResult.verdict === 'FAIL') {
        let ids = reviewResult.rerunTaskIds;
        if (ids.length === 0) {
          ids = plan.tasks.filter((t) => t.status === 'failed').map((t) => t.id);
          if (ids.length > 0) {
            await log.info(`Reviewer FAIL with empty rerunTaskIds — falling back to failed tasks: ${ids.join(', ')}`);
          }
        }
        const activeTaskIds = new Set(this.state.activeTaskIds ?? []);
        if (activeTaskIds.size > 0) {
          const outOfScopeIds = ids.filter((id) => !activeTaskIds.has(id));
          if (outOfScopeIds.length > 0) {
            await log.info(`Skipping reviewer re-run outside active task scope: ${outOfScopeIds.join(', ')}`);
          }
          ids = ids.filter((id) => activeTaskIds.has(id));
        }
        if (ids.length === 0) {
          await log.info('Reviewer FAIL but no tasks to re-run (all completed). Review issues may need manual attention.');
        } else {
        const filteredIds = ids.filter((id) => {
          const task = plan.tasks.find((candidate) => candidate.id === id);
          const lastFailureType = task?.retryHistory?.[task.retryHistory.length - 1]?.failureType;
          return !lastFailureType || !isTerminalFailureType(lastFailureType);
        });
        const blockedIds = ids.filter((id) => !filteredIds.includes(id));
        if (blockedIds.length > 0) {
          await log.info(`Skipping reviewer re-run for terminal failure tasks: ${blockedIds.join(', ')}`);
        }
        ids = filteredIds;
        if (ids.length === 0) {
          await log.info('Reviewer requested only terminal-failure tasks for re-run — leaving run failed for manual intervention.');
        } else {
        await log.info(`Reviewer flagged ${ids.length} task(s) for re-run: ${ids.join(', ')}`);
        this.onEvent({ type: 'rerun_started', taskIds: ids });

        let anyReset = false;
        for (const id of ids) {
          const task = plan.tasks.find((t) => t.id === id);
          if (task) {
            task.status = 'pending';
            task.error = undefined;
            task.retries = 0;
            task.retryHistory = [];
            anyReset = true;
          }
        }

        if (anyReset) {
          plan.updatedAt = new Date().toISOString();
          await saveState(this.cwd, this.state);

          // Re-run the queue with reset tasks
          const { TaskQueue } = await import('./task-queue.js');
          const rerunQueue = new TaskQueue(plan.tasks);
          await this.runSequential(rerunQueue, plan);

          // Update plan tasks from re-run queue
          plan.tasks = rerunQueue.getAllTasks();
          plan.updatedAt = new Date().toISOString();
          this.state.costSummary = this.costTracker.getSummary();
          await saveState(this.cwd, this.state);

          // Second review after re-run
          await this.runHolisticReview();
        }
        }
        } // else (ids.length > 0)
      }
    }

    if (this.aborted) {
      this.onEvent({ type: 'run_status', status: 'stopped' });
      await log.info('Run stopped by user');
    } else if (queue.isComplete()) {
      this.onEvent({ type: 'run_completed', summary: this.costTracker.getSummary() });
      await log.info('All tasks completed successfully');
    } else if (queue.hasFailures()) {
      const failed = queue.getTasksByStatus('failed');
      const deadlocked = queue.getDeadlockedTasks();

      let msg = `${failed.length} task(s) failed: ${failed.map((t) => t.id).join(', ')}`;
      if (deadlocked.length > 0) {
        msg += `\n  ⚠️  unreachable tasks (blocked by upstream failures): ${deadlocked.map((t) => t.id).join(', ')}`;
      }
      this.onEvent({ type: 'run_failed', error: msg });
      await log.error(msg);
    }
  }

  private async runHolisticReview(): Promise<import('../reviewer.js').ReviewResult | null> {
    let reviewModel: ClaudeModel | 'skip' = this.config.review?.model ?? 'sonnet';

    // If TUI is connected with model selector, ask for model choice
    if (this.onReviewModelRequest) {
      this.onEvent({ type: 'review_model_requested' });
      reviewModel = await this.onReviewModelRequest();
    }

    if (reviewModel === 'skip') return null;

    this.onEvent({ type: 'review_started', model: reviewModel });

    try {
      const { runHolisticReview } = await import('../reviewer.js');
      const result = await runHolisticReview(
        this.cwd,
        this.state.plan!,
        reviewModel,
        (text) => this.onEvent({ type: 'review_output', text }),
        this.reviewBaseSha,
        getPhaseRuntime(this.config, 'review'),
        this.state.activeTaskIds,
      );
      this.onEvent({ type: 'review_completed', result });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onEvent({ type: 'review_failed', error: msg });
      return null;
    }
  }

  private async runWrapUp(prompt: string): Promise<void> {
    await log.info('Running wrap-up task…');
    this.onEvent({ type: 'run_status', status: 'running' });
    try {
      const result = await runEngine({
        prompt,
        engine: this.config.engine,
        provider: this.config.provider,
<<<<<<< Updated upstream
        account: this.config.account,
=======
        accountId: this.config.executionAccountId,
>>>>>>> Stashed changes
        claudeModel: this.config.models.execution,
        modelId: this.config.executionModelId,
        effort: this.config.executionEffort,
        cwd: this.cwd,
        onOutput: (text) => this.onEvent({ type: 'task_output', taskId: 'wrap-up', text }),
        abortSignal: this.abortController.signal,
      });
      if (result.success) {
        await log.info('Wrap-up completed');
      } else {
        await log.warn(`Wrap-up finished with error: ${result.error ?? 'unknown'}`);
      }
    } catch (err) {
      await log.warn(`Wrap-up failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async runSequential(queue: TaskQueue, plan: Plan): Promise<void> {
    const useWorktrees = this.config.worktrees && await isGitRepo(this.cwd);

    while (!queue.isComplete() && !this.aborted) {
      if (queue.hasFailures()) {
        // Check for halt-on-failure tasks
        const failedWithHalt = queue
          .getTasksByStatus('failed')
          .find((t) => t.ifFailed === 'halt');
        if (failedWithHalt) break;
      }

      const ready = queue.getReadyTasks();
      if (ready.length === 0) {
        // No ready tasks — check for deadlock
        if (queue.isDeadlocked()) {
          const blocked = queue.getDeadlockedTasks();
          await log.warn(
            `Deadlock detected: tasks [${blocked.map((t) => t.id).join(', ')}] are unreachable due to upstream failures`,
          );
        }
        break;
      }
      const taskToRun = ready[0];

      // Worktree isolation for sequential tasks — each task gets its own branch.
      // On success: merge back. On failure: discard cleanly.
      let worktree: WorktreeInfo | null = null;
      let taskCwd = this.cwd;
      if (useWorktrees) {
        try {
          worktree = await createWorktree(this.cwd, taskToRun.id);
          taskCwd = worktree.path;
        } catch (err) {
          await log.warn(
            `Failed to create worktree for ${taskToRun.id}: ${err instanceof Error ? err.message : String(err)} — running in main cwd`,
          );
        }
      }

      try {
        await this.executeTask(taskToRun, queue, plan, taskCwd);
      } finally {
        if (worktree) {
          const taskStatus = queue.getTask(taskToRun.id)?.status;
          if (taskStatus === 'completed') {
            const mergeResult = await mergeWorktree(this.cwd, worktree).catch(() => ({
              merged: false,
              conflict: true,
            }));
            if (!mergeResult.merged && mergeResult.conflict) {
              await log.warn(`Merge conflict integrating ${taskToRun.id} — task marked failed`);
              queue.setError(taskToRun.id, 'Merge conflict when integrating worktree changes');
              queue.updateStatus(taskToRun.id, 'failed');
            }
          } else {
            await log.info(`Task ${taskToRun.id} did not complete — discarding worktree without merging`);
          }
          await removeWorktree(this.cwd, worktree).catch(() => {});
        }
      }
      // Track completed tasks for rolling summary refresh
      const justCompleted = queue.getTask(taskToRun.id);
      if (justCompleted?.status === 'completed') {
        this.completedTasksForSummary++;
        if (this.completedTasksForSummary % 5 === 0) {
          await this.refreshRollingSummary(queue, plan);
        }
      }
    }
  }

  private async refreshRollingSummary(queue: TaskQueue, plan: Plan): Promise<void> {
    try {
      const { runPhaseModel } = await import('../executor/model-runner.js');
      const reviewRuntime = getPhaseRuntime(this.config, 'review');
      const completedTasks = queue.getTasksByStatus('completed');
      const summaryList = completedTasks
        .map((t) => `- ${t.id}: ${t.title}${(t as any).resultSummary ? ` — ${(t as any).resultSummary}` : ''}${t.outputArtifacts?.length ? ` (files: ${t.outputArtifacts.join(', ')})` : ''}`)
        .join('\n');

      const prompt = `Summarize what has been implemented so far in this coding session for an AI assistant who is about to work on the next task.

Project goal: ${plan.goal}

Completed tasks:
${summaryList}

Write a concise paragraph (max 150 words) covering: what files/modules were created, what patterns were established, what still needs to be done. This summary will be shown to the AI before each subsequent task. Be specific about file names and function signatures where important.`;

      const result = await runPhaseModel({
        prompt,
        model: 'haiku',
        cwd: this.cwd,
        engine: reviewRuntime.engine,
        provider: reviewRuntime.provider,
        account: reviewRuntime.account,
        modelId: reviewRuntime.modelId,
<<<<<<< Updated upstream
        effort: reviewRuntime.effort,
=======
        accountId: reviewRuntime.accountId,
>>>>>>> Stashed changes
        taskType: 'review',
      });
      if (result.success && result.output?.trim()) {
        this.rollingContextSummary = result.output.trim();
        await log.info('Rolling context summary refreshed');
      }
    } catch { /* non-fatal */ }
  }

  private runDryRun(queue: TaskQueue): void {
    const tasks = queue.getAllTasks();
    console.log('\n=== Dry Run Preview ===\n');
    console.log(`Total tasks: ${tasks.length}`);
    console.log(`Models: planning=${this.config.models.planning}, execution=${this.config.models.execution}, validation=${this.config.models.validation}`);
    console.log(`Auto model routing: ${this.config.autoModelRouting ? 'yes' : 'no'}`);
    console.log(`Parallel: ${this.config.parallel ? `yes (max ${this.config.maxParallel})` : 'no'}`);
    console.log(`Worktrees: ${this.config.worktrees ? 'yes' : 'no'}`);
    console.log(`Validation: ${Object.entries(this.config.validation).filter(([k, v]) => k !== 'commands' && v).map(([k]) => k).join(', ')}`);
    if (this.config.validation.commands?.length > 0) {
      console.log(`Validation commands: ${this.config.validation.commands.join(', ')}`);
    }
    console.log(`Retry delay: ${this.config.retryDelaySec}s`);
    console.log(`Task timeout: ${Math.round(this.config.taskTimeoutMs / 60000)}min`);
    if (this.config.contextBudgetTokens > 0) {
      console.log(`Context budget: ${this.config.contextBudgetTokens.toLocaleString()} tokens`);
    }
    if (this.config.maxCostPerTaskUsd > 0) {
      console.log(`Max cost per task: $${this.config.maxCostPerTaskUsd}`);
    }
    if (this.config.maxCostPerRunUsd > 0) {
      console.log(`Max cost per run: $${this.config.maxCostPerRunUsd}`);
    }
    if (this.config.runBranch) {
      console.log(`Run branch: yes (cloudy/run-*)`);
    }
    console.log('');

    for (const task of tasks) {
      const model = this.config.autoModelRouting
        ? routeModelForTask(task)
        : this.config.models.execution;
      const timeoutMin = Math.round(task.timeout / 60000);
      console.log(`[${task.id}] ${task.title}`);
      console.log(`  Model: ${model}${this.config.autoModelRouting ? ' (auto)' : ''}`);
      console.log(`  Dependencies: ${task.dependencies.length > 0 ? task.dependencies.join(', ') : 'none'}`);
      console.log(`  Context: ${task.contextPatterns.length} pattern(s)`);
      console.log(`  Criteria: ${task.acceptanceCriteria.length}`);
      console.log(`  Timeout: ${timeoutMin}min`);
      console.log('');
    }

    console.log('=== No changes will be made (dry run) ===');
  }

  private getModelForTask(task: Task): ClaudeModel {
    if (this.config.autoModelRouting) {
      return routeModelForTask(task);
    }
    return this.config.models.execution;
  }

  private emitProgress(queue: TaskQueue): void {
    const progress = queue.getProgress();
    this.onEvent({
      type: 'progress',
      completed: progress.completed,
      total: progress.total,
      percentage: progress.percentage,
    });
  }

  private async executeTask(
    task: Task,
    queue: TaskQueue,
    plan: Plan,
    taskCwd: string,
  ): Promise<void> {
    const maxAttempts = task.maxRetries + 1;
    const executionDefaults = getExecutionDefaults(task);
    const toolPolicy = getTaskToolPolicy(task);
    task.executionMode = task.executionMode ?? inferExecutionMode(task);
    const taskRisk = assessTaskRisk(task);
    task.executionMetrics = {
      timeToFirstWriteMs: task.executionMetrics?.timeToFirstWriteMs,
      discoveryOpsBeforeFirstWrite: 0,
      subagentCalls: 0,
      writeCount: task.filesWritten?.length ?? 0,
      verificationOps: 0,
      executionMode: task.executionMode,
      riskLevel: taskRisk.level,
      riskReasons: taskRisk.reasons,
    };
    const executionModel = this.config.autoModelRouting
      ? executionDefaults.model
      : this.getModelForTask(task);
    const engine = this.config.engine ?? 'claude-code';
    const provider = this.config.provider;
    const taskType = task.type ?? 'implement';
    const engineModel =
      engine === 'claude-code'
        ? executionModel
        : (this.config.executionModelId ?? 'default');
    const allowedWritePaths = task.allowedWritePaths ?? [];
    let currentPatterns = [...task.contextPatterns];
    const budget = this.config.contextBudgetTokens;
    const budgetMode = this.config.contextBudgetMode ?? 'warn';

    // Load conventions (CLAUDE.md / AGENTS.md), learnings, and dependency handoffs
    let conventionsContent = await readConventions(taskCwd);

    // #12 — session-start.sh extension point: inject dynamic project context
    // Project authors can place .cloudy/session-start.sh (or .ts) to prime each task
    // with environment-specific info: git log, open issues, simulator state, etc.
    try {
      const sessionStartSh = path.join(this.cwd, '.cloudy', 'session-start.sh');
      const sessionStartTs = path.join(this.cwd, '.cloudy', 'session-start.ts');
      const { execa: execaLocal } = await import('execa');
      let sessionOut = '';
      try {
        await fs.access(sessionStartSh);
        const r = await execaLocal('bash', [sessionStartSh], { cwd: this.cwd, timeout: 10_000, reject: false });
        sessionOut = r.stdout?.trim() ?? '';
      } catch {
        try {
          await fs.access(sessionStartTs);
          const r = await execaLocal('npx', ['tsx', sessionStartTs], { cwd: this.cwd, timeout: 15_000, reject: false });
          sessionOut = r.stdout?.trim() ?? '';
        } catch { /* no session-start script present */ }
      }
      if (sessionOut) conventionsContent = (conventionsContent ?? '') + '\n\n' + sessionOut;
    } catch { /* non-fatal */ }

    const learningsContent = await readLearnings(this.cwd) ?? undefined;
    const handoffSummaries = task.dependencies.length > 0
      ? await readHandoffs(task.dependencies, this.cwd)
      : undefined;

    // #5 — Architectural scene-setting: derive where this task fits in the dependency graph
    const depTitles = task.dependencies
      .map((id) => plan.tasks.find((t) => t.id === id)?.title)
      .filter(Boolean) as string[];
    const dependentTitles = plan.tasks
      .filter((t) => t.dependencies.includes(task.id))
      .map((t) => t.title);
    const architecturalContext = [
      depTitles.length ? `Depends on: ${depTitles.join(', ')}` : '',
      dependentTitles.length ? `Required by (downstream tasks that import from this): ${dependentTitles.join(', ')}` : '',
    ].filter(Boolean).join('\n') || undefined;

    // Resolve initial context files with token budget
    let contextFiles = await resolveContextFiles(currentPatterns, taskCwd, budget, budgetMode);
    const providedContextPaths = new Set(
      contextFiles.map((file) => normalizePathForScope(file.path, taskCwd)),
    );
    const allowedReadPathsBeforeWrite = [
      ...providedContextPaths,
      ...allowedWritePaths.map((candidate) => normalizePathForScope(candidate, taskCwd)),
    ];

    await log.info(`Starting task "${task.id}": ${task.title}`);
    this.onEvent({
      type: 'task_started',
      taskId: task.id,
      title: task.title,
      attempt: 1,
      maxAttempts,
      contextFileCount: contextFiles.length,
      engine,
      model: String(engineModel),
    });
    queue.updateStatus(task.id, 'in_progress');
    this.taskStartCostUsd.set(task.id, this.costTracker.getSummary().totalEstimatedUsd);

    // Persist in_progress immediately so external tools (status command, scripts) see accurate state
    plan.tasks = queue.getAllTasks();
    await saveState(this.cwd, this.state);

    // Create git checkpoint (in the task's working directory).
    // On retry, reuse the original checkpoint so the diff covers ALL work
    // done across all previous attempts — not just the latest attempt.
    let checkpointSha: string | undefined;
    if (await isGitRepo(taskCwd)) {
      if (task.checkpointSha) {
        checkpointSha = task.checkpointSha;
      } else {
        checkpointSha = await createCheckpoint(taskCwd, task.id);
        queue.setCheckpoint(task.id, checkpointSha);
        this.reviewBaseSha ??= checkpointSha;
        // Persist checkpoint SHA immediately so it survives across runs
        plan.tasks = queue.getAllTasks();
        await saveState(this.cwd, this.state);
      }
    }

    const completedTitles = queue
      .getTasksByStatus('completed')
      .map((t) => t.title);

    const taskStartTime = Date.now();
    let attempt = 0;
    let lastValidationErrors = '';
    let lastErrorFileContext = '';
    let lastPriorFilesCreated: string[] = [];
    let taskCostUsd = 0;
    task.retryHistory = [];

    // Pre-task approval gate (only on first attempt)
    if (this.onApprovalRequest && this.needsApproval(task)) {
      const approvalCfg = this.config.approval;
      this.onEvent({
        type: 'approval_requested',
        taskId: task.id,
        title: task.title,
        stage: 'pre_task',
        timeoutSec: approvalCfg.timeoutSec,
      });

      const action = await waitForApproval(
        {
          taskId: task.id,
          title: task.title,
          description: task.description,
          stage: 'pre_task',
          timeoutSec: approvalCfg.timeoutSec,
          autoAction: approvalCfg.autoAction,
        },
        this.onApprovalRequest,
        this.abortController.signal,
      );

      const autoTriggered = action.action === 'timeout_continue' || action.action === 'timeout_halt';
      await logApproval(this.cwd, {
        timestamp: new Date().toISOString(),
        taskId: task.id,
        stage: 'pre_task',
        action: action.action,
        autoTriggered,
      }).catch(() => {});
      this.onEvent({ type: 'approval_resolved', taskId: task.id, action: action.action, autoTriggered });

      if (action.action === 'halt' || action.action === 'timeout_halt') {
        this.abort();
        return;
      }
      if (action.action === 'skipped') {
        queue.updateStatus(task.id, 'skipped');
        this.emitProgress(queue);
        return;
      }
    }

    while (attempt <= task.maxRetries) {
      if (this.aborted) return;
      attempt++;
      const attemptStart = Date.now();
      const scopedFirstWriteDiscoveryLimit = getScopedFirstWriteDiscoveryLimit(task);
      const scopedFirstWriteMinDiscoveryOps = getScopedFirstWriteMinDiscoveryOps(task);
      const scopedFirstWriteTimeMs = getScopedFirstWriteTimeMs(task);
      await log.info(`  Attempt ${attempt}/${maxAttempts}`);

      // On retry, expand context and roll back to a clean slate
      if (attempt > 1) {
        currentPatterns = await expandContext(currentPatterns, taskCwd, budget);
        contextFiles = await resolveContextFiles(currentPatterns, taskCwd, budget);

        // Always roll back to the checkpoint on any retry.
        // Resume-on-retry causes empty diffs: the agent sees completed work,
        // declares done, produces no commit, and fails artifact checks.
        // Rolling back to a clean checkpoint ensures every retry starts fresh.
        // Safe when: sequential mode (one task at a time) OR the task runs in
        // its own isolated worktree (taskCwd !== this.cwd).
        // NOT safe for parallel mode without worktrees (shared working tree).
        if (checkpointSha) {
          const isIsolated = !this.config.parallel || taskCwd !== this.cwd;
          if (isIsolated) {
            // Clear session ID so the retry never resumes a prior session
            task.sessionId = undefined;
            try {
              await rollbackToCheckpoint(taskCwd, checkpointSha);
              await log.info(`  Rolled back to checkpoint ${checkpointSha.slice(0, 8)} for clean retry`);
            } catch (err) {
              await log.warn(`  Rollback failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }

        this.onEvent({
          type: 'task_started',
          taskId: task.id,
          title: task.title,
          attempt,
          maxAttempts,
          contextFileCount: contextFiles.length,
          engine,
          model: String(engineModel),
        });
      }

      if (attempt === 1 && VERIFY_FIRST_TASK_TYPES.has(taskType)) {
        const preflightReport = await validateTask({
          task,
          config: this.config.validation,
          model: this.config.models.validation,
          qualityModel: this.config.models.qualityReview ?? this.config.models.validation,
          runtime: getPhaseRuntime(this.config, 'validation'),
          cwd: taskCwd,
          checkpointSha,
        });
        this.onEvent({
          type: 'validation_result',
          taskId: task.id,
          report: preflightReport,
          criteriaResults: task.acceptanceCriteriaResults,
        });

        const preflightDiff = await getGitDiff(taskCwd, checkpointSha).catch(() => '');
        const noChangesDetected = !preflightDiff.trim() && !(task.filesWritten?.length);
        await log.info(
          `  Preflight verify check: passed=${preflightReport.passed} alreadySatisfied=${preflightReport.alreadySatisfied ? 'true' : 'false'} noChangesDetected=${noChangesDetected ? 'true' : 'false'}`,
        );

        if (preflightReport.passed && (preflightReport.alreadySatisfied || noChangesDetected)) {
          if (noChangesDetected) {
            preflightReport.alreadySatisfied = true;
          }
          task.resultSummary = 'Already satisfied: verified existing artifacts and checks before execution.';
          await log.info(`  Task "${task.id}" already satisfied before execution — skipping engine run`);
          await this.finalizeSuccessfulTask(task, queue, plan, taskCwd, checkpointSha, preflightReport, attempt, taskStartTime, engineModel, engine);
          return;
        }
      }

      // Build prompt with conventions + learnings + handoffs
      const prompt =
        lastValidationErrors && attempt > 1
          ? buildRetryPrompt(task, plan, completedTitles, lastValidationErrors, contextFiles, learningsContent, handoffSummaries, conventionsContent, lastErrorFileContext, lastPriorFilesCreated)
          : buildExecutionPrompt({ task, plan, completedTaskTitles: completedTitles, contextFiles, learningsContent, handoffSummaries, conventionsContent, rollingContextSummary: this.rollingContextSummary || undefined, decisionLog: plan.decisionLog, architecturalContext });

      // Run Claude with timeout
      const abortController = new AbortController();
      const timeoutId = setTimeout(
        () => abortController.abort(),
        task.timeout || this.config.taskTimeoutMs,
      );

      // Heartbeat: log every 2 min so the log file shows the engine is alive.
      // Tracks last stdout activity — real silence (no bytes from claude) is the
      // true hung signal, not just wall-clock time.
      const _engineStart = Date.now();
      let _lastOutputMs = Date.now();            // updated on every onOutput chunk
      const _SILENCE_WARN_MS  = 3 * 60 * 1000;  // 3 min no output → warn
      const _SILENCE_ABORT_MS = 5 * 60 * 1000;  // 5 min no output → abort via AbortController (was 10 min)
      let forcedAbortReason: string | undefined;
      let discoveryOps = 0;
      let verificationOps = 0;
      let subagentCalls = 0;
      const scopedImplementationTask = !VERIFY_FIRST_TASK_TYPES.has(taskType) && allowedWritePaths.length > 0;
      const maxDiscoveryOps = VERIFY_FIRST_TASK_TYPES.has(taskType)
        ? 10
        : scopedImplementationTask
          ? scopedFirstWriteDiscoveryLimit
          : 18;
      const _firstWriteDeadlineId = scopedImplementationTask
        ? setTimeout(() => {
            if (!(task.filesWritten?.length)) {
              forcedAbortReason = `Over-exploration detected: no file writes after ${Math.round(scopedFirstWriteTimeMs / 1000)}s for a scoped implementation task`;
              log.warn(`  ⏳ first-write deadline reached — "${task.title}" has not written any files`).catch(() => {});
              abortController.abort();
            }
          }, scopedFirstWriteTimeMs)
        : undefined;
      const _heartbeatId = setInterval(() => {
        const elapsedMs  = Date.now() - _engineStart;
        const silenceMs  = Date.now() - _lastOutputMs;
        const elapsedSec = Math.round(elapsedMs / 1000);
        const min = Math.floor(elapsedSec / 60);
        const sec = elapsedSec % 60;
        const elapsed = min > 0 ? `${min}m ${sec}s` : `${sec}s`;

        let suffix = '';
        if (silenceMs >= _SILENCE_ABORT_MS) {
          const silenceSec = Math.round(silenceMs / 1000);
          suffix = ` 🚨 no output for ${silenceSec}s — aborting (hung engine)`;
          log.warn(`  ⏳ still running — "${task.title}" attempt ${attempt}/${maxAttempts} | ${elapsed} elapsed${suffix}`).catch(() => {});
          abortController.abort(); // trigger the existing timeout path
        } else if (silenceMs >= _SILENCE_WARN_MS) {
          const silenceSec = Math.round(silenceMs / 1000);
          suffix = ` ⚠️  no output for ${silenceSec}s — may be hung`;
          log.info(`  ⏳ still running — "${task.title}" attempt ${attempt}/${maxAttempts} | ${elapsed} elapsed${suffix}`).catch(() => {});
        } else {
          log.info(`  ⏳ still running — "${task.title}" attempt ${attempt}/${maxAttempts} | ${elapsed} elapsed`).catch(() => {});
        }
      }, 120_000); // every 2 minutes

      // When resuming a session, skip the checkpoint rollback — the SDK session
      // already has the full transcript of what was written; rolling back would
      // lose that context and confuse the resume.
      const isResuming = attempt > 1 && !!task.sessionId;

      let result;
      try {
        result = await runEngine({
          prompt,
          engine,
          provider,
<<<<<<< Updated upstream
          account: this.config.account,
=======
          accountId: this.config.executionAccountId,
>>>>>>> Stashed changes
          modelId: this.config.executionModelId,
          claudeModel: executionModel,
          effort: this.config.executionEffort ?? executionDefaults.effort,
          allowedTools: VERIFY_FIRST_TASK_TYPES.has(taskType)
            ? undefined
            : toolPolicy.allowedTools,
          disallowedTools: VERIFY_FIRST_TASK_TYPES.has(taskType)
            ? ['Agent']
            : toolPolicy.disallowedTools,
          allowedReadPathsBeforeWrite: scopedImplementationTask ? allowedReadPathsBeforeWrite : undefined,
          cwd: taskCwd,
          onOutput: (text) => {
            _lastOutputMs = Date.now(); // reset silence timer on any stdout activity
            this.onEvent({ type: 'task_output', taskId: task.id, text });
            logTaskOutput(task.id, text, this.cwd).catch(() => {});
          },
          onToolUse: (toolName, toolInput) => {
            _lastOutputMs = Date.now(); // tool activity means the runtime is alive
            const pendingWriteCandidates = extractWriteCandidates(toolName, toolInput, taskCwd);
            if (pendingWriteCandidates.length > 0) {
              const outOfScopeWrite = pendingWriteCandidates.find((candidate) => !matchesAllowedWritePath(candidate, taskCwd, allowedWritePaths));
              if (outOfScopeWrite) {
                forcedAbortReason = `Out-of-scope write detected: ${path.relative(taskCwd, outOfScopeWrite) || outOfScopeWrite}`;
                abortController.abort();
                return;
              }
            }
            if (toolName === 'Bash') {
              const command = typeof (toolInput as { command?: unknown })?.command === 'string'
                ? (toolInput as { command?: string }).command ?? ''
                : '';
              const outOfScopeRepoPath = findOutOfScopeRepoPath(command, [taskCwd, this.cwd]);
              if (outOfScopeRepoPath) {
                forcedAbortReason = `Out-of-scope repo access detected: ${outOfScopeRepoPath}`;
                abortController.abort();
                return;
              }
              if (/\b(gradlew|npm|pnpm|yarn|bun|swift build|xcodebuild|sentinel|simemu|keel)\b/.test(command)) {
                verificationOps++;
              }
              if (isBroadDiscoveryCommand(command)) {
                discoveryOps++;
                if (
                  scopedImplementationTask &&
                  !(task.filesWritten?.length) &&
                  verificationOps === 0 &&
                  discoveryOps >= SCOPED_IMPLEMENT_PREWRITE_SHELL_DISCOVERY_LIMIT
                ) {
                  forcedAbortReason = `Pre-write shell discovery is disallowed for scoped implementation tasks: ${discoveryOps} shell discovery operations without any file write`;
                  abortController.abort();
                  return;
                }
              }
            } else if (toolName === 'Agent' && scopedImplementationTask) {
              subagentCalls++;
              discoveryOps += 2;
            } else if (DISCOVERY_READ_TOOL_NAMES.has(toolName)) {
              const readTarget = typeof (toolInput as { file_path?: unknown; path?: unknown })?.file_path === 'string'
                ? normalizePathForScope((toolInput as { file_path: string }).file_path, taskCwd)
                : typeof (toolInput as { path?: unknown })?.path === 'string'
                  ? normalizePathForScope((toolInput as { path: string }).path, taskCwd)
                  : null;
              if (!readTarget || !providedContextPaths.has(readTarget)) {
                discoveryOps++;
              }
            }
            if (
              scopedImplementationTask &&
              discoveryOps >= scopedFirstWriteDiscoveryLimit &&
              verificationOps === 0 &&
              !(task.filesWritten?.length)
            ) {
              forcedAbortReason = `Over-exploration detected: ${discoveryOps} discovery operations before any file write for a scoped implementation task`;
              abortController.abort();
              return;
            }
            if (VERIFY_FIRST_TASK_TYPES.has(taskType) && discoveryOps > maxDiscoveryOps && verificationOps === 0 && !(task.filesWritten?.length)) {
              forcedAbortReason = `Over-exploration detected: ${discoveryOps} discovery operations before any verification or file writes`;
              abortController.abort();
            } else if (
              scopedImplementationTask &&
              discoveryOps >= scopedFirstWriteMinDiscoveryOps &&
              verificationOps === 0 &&
              !(task.filesWritten?.length) &&
              Date.now() - _engineStart >= scopedFirstWriteTimeMs
            ) {
              forcedAbortReason = `Over-exploration detected: ${discoveryOps} discovery operations and no file writes after ${Math.round((Date.now() - _engineStart) / 1000)}s for a scoped implementation task`;
              abortController.abort();
            }
            this.onEvent({ type: 'task_tool_call', taskId: task.id, toolName, toolInput });
            logTaskOutput(task.id, `[tool] ${toolName}`, this.cwd).catch(() => {});
          },
          onToolResult: (toolName, content, isError) => {
            _lastOutputMs = Date.now(); // tool results also count as progress
            if (!isError) {
              if (WRITE_TOOL_NAMES.has(toolName)) {
                recordFirstWriteProgress(task, task.executionMode ?? executionDefaults.executionMode, _engineStart, _firstWriteDeadlineId);
                task.executionMetrics = {
                  ...(task.executionMetrics ?? {
                    discoveryOpsBeforeFirstWrite: 0,
                    subagentCalls: 0,
                    writeCount: 0,
                    verificationOps: 0,
                    executionMode: task.executionMode ?? executionDefaults.executionMode,
                  }),
                  writeCount: Math.max(task.executionMetrics?.writeCount ?? 0, 1),
                };
              }
            }
            this.onEvent({ type: 'task_tool_result', taskId: task.id, toolName, content, isError });
            const prefix = isError ? `[tool-error] ${toolName}: ` : `[tool-result] ${toolName}: `;
            logTaskOutput(task.id, `${prefix}${content.slice(0, 500)}`, this.cwd).catch(() => {});
          },
          onFilesWritten: (paths) => {
            _lastOutputMs = Date.now(); // file writes prove the task is moving
            recordFirstWriteProgress(task, task.executionMode ?? executionDefaults.executionMode, _engineStart, _firstWriteDeadlineId);
            const normalizedPaths = paths.map((candidate) => normalizePathForScope(candidate, taskCwd));
            const outOfScopeWrite = normalizedPaths.find((candidate) => !matchesAllowedWritePath(candidate, taskCwd, allowedWritePaths));
            if (outOfScopeWrite) {
              forcedAbortReason = `Out-of-scope write detected: ${path.relative(taskCwd, outOfScopeWrite) || outOfScopeWrite}`;
              abortController.abort();
              return;
            }
            // Real-time file tracking from PostToolUse hooks
            task.filesWritten = [...(task.filesWritten ?? []), ...normalizedPaths];
            logTaskOutput(task.id, `[files] ${normalizedPaths.join(', ')}`, this.cwd).catch(() => {});
          },
          abortSignal: abortController.signal,
          // Pass session ID for resume — smarter retries that continue where Claude left off
          resumeSessionId: isResuming ? task.sessionId : undefined,
          // SDK-native cost ceiling per attempt (cumulative tracked separately below)
          maxBudgetUsd: this.config.maxCostPerTaskUsd > 0
            ? this.config.maxCostPerTaskUsd
            : undefined,
        });
      } catch (err) {
        const isTimeout = (err as Error)?.name === 'AbortError';
        result = {
          success: false,
          output: '',
          error: forcedAbortReason ?? (isTimeout ? 'Task timed out' : String(err)),
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          durationMs: Date.now() - attemptStart,
          costUsd: 0,
        };
      } finally {
        clearInterval(_heartbeatId);
        if (_firstWriteDeadlineId) {
          clearTimeout(_firstWriteDeadlineId);
        }
        clearTimeout(timeoutId);
      }

      // Persist session ID and file list for resume on next retry
      if (forcedAbortReason && (result.success || /timed out/i.test(result.error ?? ''))) {
        result = {
          ...result,
          success: false,
          error: forcedAbortReason,
        };
      }
      if (result.sessionId) {
        task.sessionId = result.sessionId;
      }
      if (result.filesWritten?.length) {
        const normalizedFilesWritten = result.filesWritten.map((candidate) => normalizePathForScope(candidate, taskCwd));
        const outOfScopeWrite = normalizedFilesWritten.find((candidate) => !matchesAllowedWritePath(candidate, taskCwd, allowedWritePaths));
        if (outOfScopeWrite) {
          result = {
            ...result,
            success: false,
            error: `Out-of-scope write detected: ${path.relative(taskCwd, outOfScopeWrite) || outOfScopeWrite}`,
          };
        }
        task.filesWritten = [
          ...new Set([...(task.filesWritten ?? []), ...normalizedFilesWritten]),
        ];
      }
      task.executionMetrics = {
        ...(task.executionMetrics ?? {
          executionMode: task.executionMode ?? executionDefaults.executionMode,
          discoveryOpsBeforeFirstWrite: 0,
          subagentCalls: 0,
          writeCount: 0,
          verificationOps: 0,
        }),
        discoveryOpsBeforeFirstWrite: task.executionMetrics?.timeToFirstWriteMs ? task.executionMetrics.discoveryOpsBeforeFirstWrite : discoveryOps,
        subagentCalls,
        writeCount: Math.max(task.executionMetrics?.writeCount ?? 0, task.filesWritten?.length ?? 0),
        verificationOps,
      };

      // Track cost
      this.costTracker.record(String(engineModel), 'execution', result, engine);
      taskCostUsd += result.costUsd;
      this.onEvent({ type: 'cost_update', summary: this.costTracker.getSummary() });

      // Per-task cost budget check
      if (
        this.config.maxCostPerTaskUsd > 0 &&
        taskCostUsd > this.config.maxCostPerTaskUsd &&
        result.success
      ) {
        result = {
          ...result,
          success: false,
          error: `Task cost $${taskCostUsd.toFixed(4)} exceeds maxCostPerTaskUsd ($${this.config.maxCostPerTaskUsd})`,
        };
      }

      // Per-run cost budget check — abort the entire run if over budget
      if (this.config.maxCostPerRunUsd > 0) {
        const runCost = this.costTracker.getSummary().totalEstimatedUsd;
        if (runCost > this.config.maxCostPerRunUsd) {
          await log.error(`Run cost $${runCost.toFixed(4)} exceeds maxCostPerRunUsd ($${this.config.maxCostPerRunUsd}) — aborting`);
          this.onEvent({ type: 'run_failed', error: `Run budget exceeded: $${runCost.toFixed(4)} > $${this.config.maxCostPerRunUsd}` });
          this.abort();
          return;
        }
      }

      if (!result.success) {
        // #3 — Mid-task escalation: Claude signalled it needs human input
        if (result.error?.startsWith('escalation:') && this.onApprovalRequest) {
          const question = result.error.slice('escalation:'.length).trim();
          await log.info(`  Task "${task.id}" escalated: ${question}`);
          this.onEvent({
            type: 'approval_requested',
            taskId: task.id,
            title: task.title,
            stage: 'pre_task',
            context: question,
            timeoutSec: this.config.approval?.timeoutSec ?? 300,
          });
          const escalationAnswer = await waitForApproval(
            {
              taskId: task.id,
              title: task.title,
              description: task.description,
              stage: 'pre_task',
              context: question,
              timeoutSec: this.config.approval?.timeoutSec ?? 300,
              autoAction: this.config.approval?.autoAction ?? 'continue',
            },
            this.onApprovalRequest,
            this.abortController.signal,
          );
          const escalationAutoTriggered = escalationAnswer.action === 'timeout_continue' || escalationAnswer.action === 'timeout_halt';
          this.onEvent({ type: 'approval_resolved', taskId: task.id, action: escalationAnswer.action, autoTriggered: escalationAutoTriggered });
          if (escalationAnswer.action === 'halt') {
            await log.error('  Escalation: user chose halt — stopping run');
            this.onEvent({ type: 'run_failed', error: `Task "${task.id}" escalated and user halted run` });
            this.abort();
            return;
          }
          // Inject the answer into the next retry prompt
          const hint = (escalationAnswer as { hint?: string }).hint ?? escalationAnswer.action;
          lastValidationErrors = `Human answered your escalation: ${hint}\n\nResume the task with this information.`;
          queue.incrementRetry(task.id);
          continue;
        }

        await log.error(`  Execution failed: ${result.error}`);

        const entry: RetryHistoryEntry = {
          attempt,
          timestamp: new Date().toISOString(),
          failureType: classifyRetryFailure(result.error),
          reason: result.error ?? 'Execution failed',
          fullError: result.error ?? '',
          durationMs: Date.now() - attemptStart,
        };
        task.retryHistory!.push(entry);
        task.failureClass = entry.failureType;
        const canRetry = isTerminalFailureType(entry.failureType)
          ? false
          : queue.incrementRetry(task.id);

        if (canRetry) {
          lastValidationErrors = result.error ?? 'Execution failed';
          lastPriorFilesCreated = checkpointSha
            ? await getChangedFiles(taskCwd, checkpointSha).catch(() => [])
            : [];
          this.onEvent({
            type: 'task_failed',
            taskId: task.id,
            title: task.title,
            error: result.error ?? '',
            attempt,
            maxAttempts,
            willRetry: true,
          });
          this.onEvent({
            type: 'task_retrying',
            taskId: task.id,
            title: task.title,
            delaySec: this.config.retryDelaySec,
            attempt,
          });
          await sleep(this.config.retryDelaySec * 1000, this.abortController.signal);
          continue;
        }

        // Failure escalation gate
        const executionError = result.error ?? 'Execution failed';
        if (this.onApprovalRequest && (this.config.approval?.mode ?? 'never') !== 'never') {
          const approvalCfg = this.config.approval;
          this.onEvent({
            type: 'approval_requested',
            taskId: task.id,
            title: task.title,
            stage: 'failure_escalation',
            context: executionError,
            timeoutSec: approvalCfg.timeoutSec,
          });

          const escalationAction = await waitForApproval(
            {
              taskId: task.id,
              title: task.title,
              description: task.description,
              stage: 'failure_escalation',
              context: executionError,
              timeoutSec: approvalCfg.timeoutSec,
              autoAction: approvalCfg.autoAction,
            },
            this.onApprovalRequest,
            this.abortController.signal,
          );

          const autoTriggered = escalationAction.action === 'timeout_continue' || escalationAction.action === 'timeout_halt';
          await logApproval(this.cwd, {
            timestamp: new Date().toISOString(),
            taskId: task.id,
            stage: 'failure_escalation',
            action: escalationAction.action,
            autoTriggered,
            hint: escalationAction.action === 'retry_with_hint' ? escalationAction.hint : undefined,
          }).catch(() => {});
          this.onEvent({ type: 'approval_resolved', taskId: task.id, action: escalationAction.action, autoTriggered });

          if (escalationAction.action === 'retry_with_hint') {
            lastValidationErrors = `${executionError}\nHuman hint: ${escalationAction.hint}`;
            queue.incrementRetry(task.id);
            continue;
          }
          if (escalationAction.action === 'skipped') {
            queue.updateStatus(task.id, 'skipped');
            this.emitProgress(queue);
            return;
          }
          if (escalationAction.action === 'halt' || escalationAction.action === 'timeout_halt') {
            this.abort();
            return;
          }
        }

        queue.setError(task.id, executionError);
        queue.updateStatus(task.id, 'failed');
        task.durationMs = Date.now() - taskStartTime;
        this.onEvent({
          type: 'task_failed',
          taskId: task.id,
          title: task.title,
          error: executionError,
          attempt,
          maxAttempts,
          willRetry: false,
        });
        this.emitProgress(queue);

        // Append to run log for AI post-analysis
        const failCostUsd = this.costTracker.getSummary().totalEstimatedUsd
          - (this.taskStartCostUsd.get(task.id) ?? 0);
        await this.runLogger.logTaskFailed({
          taskId: task.id,
          title: task.title,
          totalAttempts: attempt,
          totalDurationMs: task.durationMs ?? 0,
          costUsd: Math.round(failCostUsd * 10000) / 10000,
          finalError: executionError,
          retryHistory: task.retryHistory ?? [],
          criteriaResults: task.acceptanceCriteriaResults ?? [],
        }).catch(() => {});

        return;
      }

      // Warn if Claude made no file changes since the checkpoint
      if (checkpointSha && await isGitRepo(taskCwd)) {
        const diff = await getGitDiff(taskCwd, checkpointSha).catch(() => '');
        if (!diff.trim()) {
          await log.warn(`Task "${task.id}" completed but made no file changes`);
          this.onEvent({
            type: 'task_output',
            taskId: task.id,
            text: '⚠️  Warning: task completed but no file changes were detected\n',
          });
        }
      }

      // Store result summary
      task.resultSummary = result.output.slice(0, 500);

      // Parse and inject dynamic subtasks before committing
      const subtasks = parseSubtasks(result.output, task);
      if (subtasks.length > 0) {
        for (const st of subtasks) {
          try {
            queue.addTask(st);
          } catch (err) {
            await log.warn(`Failed to add subtask "${st.id}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        const addedIds = subtasks.map((t) => t.id);
        this.onEvent({
          type: 'subtasks_created',
          parentTaskId: task.id,
          count: addedIds.length,
          ids: addedIds,
        });
        await log.info(`  ${addedIds.length} subtask(s) created: ${addedIds.join(', ')}`);
      }

      // Commit changes
      if (await isGitRepo(taskCwd)) {
        await commitAll(taskCwd, `[cloudy] ${task.id}: ${task.title}`);
      }

      // Collect output artifacts from all completed dependency tasks so the
      // AI reviewer knows which files already exist and aren't in this diff
      const priorArtifacts = queue
        .getAllTasks()
        .filter((t) => t.status === 'completed' || t.status === 'completed_without_changes')
        .filter((t) => task.dependencies.includes(t.id))
        .flatMap((t) =>
          (t.outputArtifacts ?? []).map((file) => ({
            file,
            taskId: t.id,
            taskTitle: t.title,
          })),
        );

      // Validate
      this.onEvent({ type: 'validation_started', taskId: task.id });
      const report = await validateTask({
        task,
        config: this.config.validation,
        model: this.config.models.validation,
        qualityModel: this.config.models.qualityReview ?? this.config.models.validation,
        runtime: getPhaseRuntime(this.config, 'validation'),
        cwd: taskCwd,
        checkpointSha,
        priorArtifacts: priorArtifacts.length > 0 ? priorArtifacts : undefined,
      });

      // Store acceptance criteria results from AI review
      const aiResult = report.results.find((r) => r.strategy === 'ai-review');
      if (aiResult) {
        try {
          const json = aiResult.output.match(/\{[\s\S]*\}/)?.[0];
          if (json) {
            const parsed = JSON.parse(json);
            if (parsed.criteriaResults) {
              task.acceptanceCriteriaResults = parsed.criteriaResults.map(
                (cr: { criterion: string; met: boolean; reason: string }) => ({
                  criterion: cr.criterion,
                  passed: cr.met,
                  explanation: cr.reason,
                }),
              );
            }
          }
        } catch {
          // Best-effort parsing
        }
      }

      this.onEvent({ type: 'validation_result', taskId: task.id, report, criteriaResults: task.acceptanceCriteriaResults });

      if (report.passed && !process.stdout.isTTY) {
        process.stdout.write(`CLOUDY_TASK_VALIDATED:${JSON.stringify({ taskId: task.id, title: task.title })}\n`);
      }

      // Do NOT check this.aborted here — if validation already passed we must
      // save the completed state so the task isn't left as in_progress on the
      // next run.  Abort is checked before starting new tasks, not after a task
      // has already finished successfully.

      if (report.passed) {
        await this.finalizeSuccessfulTask(task, queue, plan, taskCwd, checkpointSha, report, attempt, taskStartTime, engineModel, engine);

        const learning = extractLearning(result.output);
        if (learning) {
          await appendLearning(task.id, learning, this.cwd).catch(() => {});
        }
        return;
      }

      // Validation failed — extract code snippets for surgical retry
      lastValidationErrors = formatValidationErrors(report);
      lastErrorFileContext = await extractErrorFileContext(lastValidationErrors, taskCwd);
      lastPriorFilesCreated = await getChangedFiles(taskCwd, checkpointSha).catch(() => []);
      await log.warn(`  Validation failed:\n${lastValidationErrors}`);

      const validationConfigError = classifyValidationConfigError(report);
      if (validationConfigError) {
        task.implementationCandidateReady = true;
        task.implementationCandidateReason = validationConfigError;
        lastValidationErrors = `${validationConfigError}\n\n${lastValidationErrors}`;
      }

      const canRetry = validationConfigError ? false : queue.incrementRetry(task.id);
      const entry: RetryHistoryEntry = {
        attempt,
        timestamp: new Date().toISOString(),
        failureType: validationConfigError
          ? 'validation_problem'
          : (report.alreadySatisfied ? 'already_satisfied' : 'acceptance_failure'),
        reason: validationConfigError ?? 'Validation failed',
        fullError: lastValidationErrors,
        durationMs: Date.now() - attemptStart,
      };
      task.retryHistory!.push(entry);
      task.failureClass = entry.failureType;

      if (!canRetry) {
        // Failure escalation gate for validation failure
        if (this.onApprovalRequest && (this.config.approval?.mode ?? 'never') !== 'never') {
          const approvalCfg = this.config.approval;
          this.onEvent({
            type: 'approval_requested',
            taskId: task.id,
            title: task.title,
            stage: 'failure_escalation',
            context: lastValidationErrors,
            timeoutSec: approvalCfg.timeoutSec,
          });

          const escalationAction = await waitForApproval(
            {
              taskId: task.id,
              title: task.title,
              description: task.description,
              stage: 'failure_escalation',
              context: lastValidationErrors,
              timeoutSec: approvalCfg.timeoutSec,
              autoAction: approvalCfg.autoAction,
            },
            this.onApprovalRequest,
            this.abortController.signal,
          );

          const autoTriggered = escalationAction.action === 'timeout_continue' || escalationAction.action === 'timeout_halt';
          await logApproval(this.cwd, {
            timestamp: new Date().toISOString(),
            taskId: task.id,
            stage: 'failure_escalation',
            action: escalationAction.action,
            autoTriggered,
            hint: escalationAction.action === 'retry_with_hint' ? escalationAction.hint : undefined,
          }).catch(() => {});
          this.onEvent({ type: 'approval_resolved', taskId: task.id, action: escalationAction.action, autoTriggered });

          if (escalationAction.action === 'retry_with_hint') {
            lastValidationErrors += `\nHuman hint: ${escalationAction.hint}`;
            queue.incrementRetry(task.id);
            continue;
          }
          if (escalationAction.action === 'skipped') {
            queue.updateStatus(task.id, 'skipped');
            this.emitProgress(queue);
            return;
          }
          if (escalationAction.action === 'halt' || escalationAction.action === 'timeout_halt') {
            this.abort();
            return;
          }
        }

        queue.setError(task.id, `Validation failed after ${attempt} attempts`);
        queue.updateStatus(task.id, 'failed');
        task.durationMs = Date.now() - taskStartTime;
        this.onEvent({
          type: 'task_failed',
          taskId: task.id,
          title: task.title,
          error: lastValidationErrors,
          attempt,
          maxAttempts,
          willRetry: false,
        });
        this.emitProgress(queue);
        return;
      }

      this.onEvent({
        type: 'task_failed',
        taskId: task.id,
        title: task.title,
        error: lastValidationErrors,
        attempt,
        maxAttempts,
        willRetry: true,
      });
      this.onEvent({
        type: 'task_retrying',
        taskId: task.id,
        title: task.title,
        delaySec: this.config.retryDelaySec,
        attempt,
      });
      await sleep(this.config.retryDelaySec * 1000, this.abortController.signal);
    }

    // Exhausted retries
    queue.setError(task.id, `Failed after ${attempt} attempts`);
    queue.updateStatus(task.id, 'failed');
    task.durationMs = Date.now() - taskStartTime;
    this.onEvent({
      type: 'task_failed',
      taskId: task.id,
      title: task.title,
      error: lastValidationErrors || 'Unknown error',
      attempt,
      maxAttempts,
      willRetry: false,
    });
    this.emitProgress(queue);
  }
}
