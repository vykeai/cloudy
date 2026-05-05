import readline from 'node:readline';
import path from 'node:path';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import { loadConfig } from '../../config/config.js';
import { selectViaDaemon } from 'omnai';
import { createStreamFormatter } from '../../utils/stream-formatter.js';
import type { ApprovalRequest, ApprovalAction } from '../../core/approval.js';
import { mergeModelConfig, parseModelFlag } from '../../config/model-config.js';
import { loadState, loadOrCreateState, saveState, sanitizeStaleTasks, updatePlan } from '../../core/state.js';
import { createPlan } from '../../planner/planner.js';
import { Orchestrator } from '../../core/orchestrator.js';
import { formatCostSummary } from '../../cost/reporter.js';
import { initLogger, log } from '../../utils/logger.js';
import { topologicalSort, getTransitiveDeps } from '../../planner/dependency-graph.js';
import { c, bold, dim, red, green, yellow, cyan, greenBright, yellowBright, cyanBright } from '../../utils/colors.js';
import type { OrchestratorEvent } from '../../core/types.js';
import { notifyRunComplete, notifyRunFailed } from '../../notifications/notify.js';
import { acquireLock } from '../../utils/lock.js';
import { execa } from 'execa';
import { applyKeelTaskRuntime, loadKeelTaskRuntime } from '../../integrations/keel-task-runtime.js';
import { analyzePlanRisk } from '../../core/risk-preflight.js';

function formatRuntime(label: string, runtime: { engine?: string; provider?: string; account?: string; modelId?: string; effort?: string }): string {
  return `${label}: engine=${runtime.engine ?? '(default)'} provider=${runtime.provider ?? '(default)'} account=${runtime.account ?? '(default)'} modelId=${runtime.modelId ?? '(abstract)'} effort=${runtime.effort ?? '(default)'}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}

function summarizeKeelOutcome(
  tasks: Array<{ status: string; filesWritten?: string[]; outputArtifacts?: string[] }>,
  state: { costSummary: { totalEstimatedUsd: number }; startedAt?: string },
  opts: { keelSlug?: string; keelTask?: string },
  config: { keel?: { slug: string; taskId?: string; port?: number }; review: { failBlocksRun?: boolean } },
  orchestratorAborted: boolean,
  reviewVerdict?: 'PASS' | 'PASS_WITH_NOTES' | 'FAIL',
  error?: string,
) {
  const tasksDone = tasks.filter((t) => t.status === 'completed' || t.status === 'completed_without_changes').length;
  const tasksFailed = tasks.filter((t) => t.status === 'failed').length;
  const success =
    !error &&
    !orchestratorAborted &&
    tasksFailed === 0 &&
    !(config.review.failBlocksRun && reviewVerdict === 'FAIL');

  const topError =
    error ??
    (orchestratorAborted ? 'Run aborted.' : undefined) ??
    (tasksFailed > 0 ? `${tasksFailed} task(s) failed during the run.` : undefined) ??
    (config.review.failBlocksRun && reviewVerdict === 'FAIL' ? 'Holistic review failed.' : undefined);

  return {
    enabled: Boolean(opts.keelSlug ?? config.keel?.slug),
    ctx: {
      slug: opts.keelSlug ?? config.keel?.slug ?? '',
      taskId: opts.keelTask ?? config.keel?.taskId,
      port: config.keel?.port ?? 7842,
    },
    outcome: {
      success,
      tasksDone,
      tasksFailed,
      topError,
      costUsd: state.costSummary.totalEstimatedUsd,
      durationMs: state.startedAt ? Date.now() - new Date(state.startedAt).getTime() : 0,
      reviewVerdict,
      filesTouched: [...new Set(tasks.flatMap((task) => task.filesWritten ?? []))].sort(),
      artifactsProduced: [...new Set(
        tasks
          .filter((task) => task.status === 'completed' || task.status === 'completed_without_changes')
          .flatMap((task) => task.outputArtifacts ?? []),
      )].sort(),
    },
  };
}

/**
 * Present finishing options after a successful run: merge, PR, keep, or discard.
 * Inspired by the superpowers finishing-a-development-branch skill.
 */
async function runFinishingWorkflow(cwd: string): Promise<void> {
  try {
    // Detect current branch
    const branchResult = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, reject: false });
    const currentBranch = branchResult.stdout.trim();
    const isRunBranch = currentBranch.startsWith('cloudy/run-') || currentBranch.startsWith('cloudy/');

    if (!isRunBranch) return; // Only prompt when on a cloudy-managed branch

    // Detect base branch
    let baseBranch = 'main';
    for (const candidate of ['main', 'master', 'develop']) {
      const check = await execa('git', ['rev-parse', '--verify', candidate], { cwd, reject: false });
      if (check.exitCode === 0) { baseBranch = candidate; break; }
    }

    console.log(`\n${c(cyan + bold, '🏁 Implementation complete')}  ${c(dim, `branch: ${currentBranch}`)}`);
    console.log(c(dim, `\nWhat would you like to do?\n`));
    console.log(`  ${c(bold, '1')}  Merge into ${baseBranch} now`);
    console.log(`  ${c(bold, '2')}  Push and create a Pull Request`);
    console.log(`  ${c(bold, '3')}  Keep branch as-is (handle later)`);
    console.log(`  ${c(bold, '4')}  Discard branch and all changes`);
    console.log('');

    const choice = await p.select({
      message: 'Choose:',
      options: [
        { value: '1', label: `Merge into ${baseBranch}` },
        { value: '2', label: 'Push + open PR' },
        { value: '3', label: 'Keep branch as-is' },
        { value: '4', label: 'Discard this work' },
      ],
    });

    if (p.isCancel(choice)) return;

    if (choice === '1') {
      const uncommitted = await execa('git', ['status', '--porcelain'], { cwd, reject: false });
      if (uncommitted.stdout.trim()) {
        await execa('git', ['add', '-u'], { cwd });  // only tracked files — avoids staging .env, credentials, binaries
        await execa('git', ['commit', '-m', 'chore: wrap up cloudy run'], { cwd });
      }
      await execa('git', ['checkout', baseBranch], { cwd });
      const mergeResult = await execa('git', ['merge', '--no-ff', currentBranch, '-m', `chore: merge ${currentBranch}`], { cwd, reject: false });
      if (mergeResult.exitCode === 0) {
        console.log(c(green, `\n✓  Merged ${currentBranch} into ${baseBranch}`));
        await execa('git', ['branch', '-d', currentBranch], { cwd, reject: false });
      } else {
        console.error(c(red, '\n✗  Merge had conflicts. Resolve manually.'));
        await execa('git', ['checkout', currentBranch], { cwd, reject: false });
      }
    } else if (choice === '2') {
      const pushResult = await execa('git', ['push', '-u', 'origin', currentBranch], { cwd, reject: false });
      if (pushResult.exitCode !== 0) {
        console.error(c(red, `\n✗  Push failed:\n${pushResult.stderr}`));
        return;
      }
      // Try gh cli — use --title with branch name, body summarises the run
      const prTitle = currentBranch.replace(/^cloudy\//, '').replace(/-/g, ' ');
      const ghResult = await execa('gh', [
        'pr', 'create',
        '--title', prTitle,
        '--body', `Automated implementation via cloudy.\n\nBranch: \`${currentBranch}\``,
      ], { cwd, reject: false });
      if (ghResult.exitCode === 0) {
        console.log(c(green, `\n✓  PR created`));
        console.log(ghResult.stdout.trim());
      } else {
        console.log(c(green, `\n✓  Branch pushed.`));
        console.log(c(dim, 'Open a PR at your repository host.'));
      }
    } else if (choice === '3') {
      console.log(c(dim, `\nBranch ${currentBranch} kept. Switch back when ready.`));
    } else if (choice === '4') {
      const confirm = await p.confirm({ message: `Discard all changes on ${currentBranch}? This cannot be undone.` });
      if (!p.isCancel(confirm) && confirm) {
        await execa('git', ['checkout', baseBranch], { cwd, reject: false });
        await execa('git', ['branch', '-D', currentBranch], { cwd, reject: false });
        console.log(c(yellow, `\n⚠  Branch ${currentBranch} deleted.`));
      }
    }
  } catch {
    // Non-fatal — finishing workflow failure shouldn't affect the run result
  }
}

export const runCommand = new Command('run')
  .description('Execute the current plan')
  .option('--model <model>', 'Model for all phases')
  .option('--plan-model <model>', 'Model for plan phase (used with --goal)')
  .option('--build-model <model>', 'Model for build phase')
  .option('--build-model-id <id>', 'Provider-native build model ID (e.g. o3, codex-mini)')
  .option('--task-review-model <model>', 'Model for per-task validation')
  .option('--model-auto', 'Auto-route model per task complexity')
<<<<<<< Updated upstream
  .option('--plan-engine <engine>', 'Plan engine (e.g. claude-code, codex, pi-mono)')
  .option('--plan-provider <provider>', 'Plan provider/auth route (e.g. claude subscription, codex subscription, openai API)')
  .option('--plan-account <account>', 'Plan account route within the provider/runtime')
  .option('--plan-model-id <id>', 'Provider-native plan model ID')
  .option('--plan-effort <level>', 'Plan effort: low|medium|high|max')
  .option('--build-engine <engine>', 'Build engine (e.g. claude-code, codex, pi-mono)')
  .option('--build-provider <provider>', 'Build provider/auth route (e.g. claude subscription, codex subscription, openai API)')
  .option('--build-account <account>', 'Build account route within the provider/runtime')
  .option('--task-review-engine <engine>', 'Per-task review engine')
  .option('--task-review-provider <provider>', 'Per-task review provider/auth route')
  .option('--task-review-account <account>', 'Per-task review account route within the provider/runtime')
  .option('--task-review-model-id <id>', 'Provider-native per-task review model ID')
  .option('--task-review-effort <level>', 'Per-task review effort: low|medium|high|max')
  .option('--run-review-engine <engine>', 'Holistic run-review engine')
  .option('--run-review-provider <provider>', 'Holistic run-review provider/auth route')
  .option('--run-review-account <account>', 'Holistic run-review account route within the provider/runtime')
  .option('--run-review-model-id <id>', 'Provider-native run-review model ID')
  .option('--run-review-effort <level>', 'Holistic run-review effort: low|medium|high|max')
=======
  .option('--planning-engine <engine>', 'Planning engine (e.g. claude-code, codex, pi-mono)')
  .option('--planning-provider <provider>', 'Planning provider/auth route (e.g. claude subscription, codex subscription, openai API)')
  .option('--planning-model-id <id>', 'Provider-native planning model ID')
  .option('--planning-account-id <id>', 'Planning provider account/profile ID from omnai estate')
  .option('--engine <engine>', 'Execution engine (e.g. claude-code, codex, pi-mono)')
  .option('--provider <provider>', 'Execution provider/auth route (e.g. claude subscription, codex subscription, openai API)')
  .option('--execution-account-id <id>', 'Execution provider account/profile ID from omnai estate')
  .option('--validation-engine <engine>', 'Per-task AI validation engine')
  .option('--validation-provider <provider>', 'Per-task AI validation provider/auth route')
  .option('--validation-model-id <id>', 'Provider-native per-task AI validation model ID')
  .option('--validation-account-id <id>', 'Validation provider account/profile ID from omnai estate')
  .option('--review-engine <engine>', 'Holistic review / review-side prompt engine')
  .option('--review-provider <provider>', 'Holistic review / review-side provider/auth route')
  .option('--review-model-id <id>', 'Provider-native holistic review model ID')
  .option('--review-account-id <id>', 'Review provider account/profile ID from omnai estate')
>>>>>>> Stashed changes
  .option('--parallel', 'Enable parallel execution')
  .option('--max-parallel <n>', 'Max parallel tasks', parseInt)
  .option('--no-validate', 'Skip validation')
  .option('--no-dashboard', 'Do not open the dashboard (headless/CI mode)')
  .option('--only-task <id>', 'Run only this task and its transitive dependencies')
  .option('--start-from <id>', 'Skip tasks before this one in topological order')
  .option('--retry <id>', 'Reset a specific failed task to pending and re-run it')
  .option('--retry-failed', 'Reset ALL failed tasks to pending and re-run them')
  .option('--resume', 'Show already-completed tasks and ask to confirm before re-running')
  .option('--goal <goal>', 'Create a plan for this goal and run it immediately (skips cloudy init)')
  .option('--max-retries <n>', 'Max retries per task', parseInt)
  .option('--verbose', 'Show live agent output for each task as it runs')
  .option('--run-review-model <model>', 'Model for post-run holistic review (haiku/sonnet/opus)')
  .option('--quality-review-model <model>', 'Model for Phase 2b code quality review (default: same as --task-review-model)')

  .option('--worktrees', 'Isolate each task in its own git worktree (merges back on success, discards on failure)')
  .option('--heartbeat-interval <seconds>', 'Write status.json to run dir every N seconds during execution', parseInt)
  .option('--non-interactive', 'Skip all interactive prompts — requires explicit model flags, exits when run completes')
  .option('--agent-output', 'Emit structured plain-text lines (no ANSI, no emoji) — auto-enabled with --non-interactive')
  .option('--build-effort <level>', 'Thinking effort for build tasks: low|medium|high|max (high/max enable extended thinking; max requires opus)')
  .option('--strict-batch', 'Deterministic batch mode: no creative recovery, stop on terminal failures and risk-preflight blocks')
  .option('--keel-slug <slug>', 'Keel project slug to write outcomes back to')
  .option('--keel-task <id>', 'Keel task ID to update on completion')
  .action(
    async (opts: {
      model?: string;
      planModel?: string;
      buildModel?: string;
      buildModelId?: string;
      taskReviewModel?: string;
      qualityReviewModel?: string;
<<<<<<< Updated upstream
      planEngine?: string;
      planProvider?: string;
      planAccount?: string;
      planModelId?: string;
      planEffort?: string;
      buildEngine?: string;
      buildProvider?: string;
      buildAccount?: string;
      taskReviewEngine?: string;
      taskReviewProvider?: string;
      taskReviewAccount?: string;
      taskReviewModelId?: string;
      taskReviewEffort?: string;
      runReviewEngine?: string;
      runReviewProvider?: string;
      runReviewAccount?: string;
      runReviewModelId?: string;
      runReviewEffort?: string;
=======
      planningEngine?: string;
      planningProvider?: string;
      planningModelId?: string;
      planningAccountId?: string;
      engine?: string;
      provider?: string;
      executionAccountId?: string;
      validationEngine?: string;
      validationProvider?: string;
      validationModelId?: string;
      validationAccountId?: string;
      reviewEngine?: string;
      reviewProvider?: string;
      reviewModelId?: string;
      reviewAccountId?: string;
>>>>>>> Stashed changes
      modelAuto?: boolean;
      parallel?: boolean;
      maxParallel?: number;
      maxRetries?: number;
      validate?: boolean;
      dashboard: boolean; // true by default; --no-dashboard for headless CI
      onlyTask?: string;
      startFrom?: string;
      retry?: string;
      retryFailed?: boolean;
      resume?: boolean;
      goal?: string;
      verbose?: boolean;
      runReviewModel?: string;
      heartbeatInterval?: number;
      nonInteractive?: boolean;
      agentOutput?: boolean;
      worktrees?: boolean;
      buildEffort?: string;
      strictBatch?: boolean;
      keelSlug?: string;
      keelTask?: string;
    }) => {
      const isNonInteractive = opts.nonInteractive || !process.stdout.isTTY;
      const isAgentOutput = opts.agentOutput || isNonInteractive;

      /** Emit a structured plain-text line for AI agent consumption. */
      function agentLog(tag: string, ...parts: string[]) {
        const ts = new Date().toISOString();
        console.log(`[${ts}] [${tag}] ${parts.join(' ')}`);
      }
      if (isNonInteractive) {
        const missing: string[] = [];
        if (!opts.buildModel && !opts.model) missing.push('--build-model');
        if (!opts.taskReviewModel && !opts.model) missing.push('--task-review-model');
        if (!opts.runReviewModel) missing.push('--run-review-model');
        if (missing.length > 0) {
          console.error(c(red, `✖  --non-interactive requires explicit model flags: ${missing.join(', ')}`));
          process.exit(1);
        }
      }
      const cwd = process.cwd();
      await initLogger(cwd);

      // Global concurrency lock (max 2 across all projects)
      let releaseLock: (() => void) | undefined;
      try {
        releaseLock = await acquireLock('run', cwd);
      } catch (err) {
        console.error(c(red, `✖  ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }

      // Auto-register with daemon if running (fire-and-forget)
      import('../../cli/commands/daemon.js')
        .then(({ autoRegisterWithDaemon }) => autoRegisterWithDaemon(cwd))
        .catch(() => {});

      const baseConfig = await loadConfig(cwd);
      const keelTaskRuntime = await loadKeelTaskRuntime(cwd, opts.keelTask ?? baseConfig.keel?.taskId);
      const config = applyKeelTaskRuntime(baseConfig, keelTaskRuntime);

      // Apply planning/review/runtime overrides before any on-the-fly planning.
      config.models = mergeModelConfig(config.models, {
        model: opts.model ? parseModelFlag(opts.model) : undefined,
        planningModel: opts.planModel
          ? parseModelFlag(opts.planModel)
          : undefined,
      });
<<<<<<< Updated upstream
      if (opts.planEngine) config.planningRuntime = { ...config.planningRuntime, engine: opts.planEngine as typeof config.engine };
      if (opts.planProvider) config.planningRuntime = { ...config.planningRuntime, provider: opts.planProvider };
      if (opts.planAccount) config.planningRuntime = { ...config.planningRuntime, account: opts.planAccount };
      if (opts.planModelId) config.planningRuntime = { ...config.planningRuntime, modelId: opts.planModelId };
      if (opts.planEffort) config.planningRuntime = { ...config.planningRuntime, effort: opts.planEffort as any };
      if (opts.buildEngine) config.engine = opts.buildEngine as typeof config.engine;
      if (opts.buildProvider) config.provider = opts.buildProvider;
      if (opts.buildAccount) config.account = opts.buildAccount;
      if (opts.taskReviewEngine) config.validationRuntime = { ...config.validationRuntime, engine: opts.taskReviewEngine as typeof config.engine };
      if (opts.taskReviewProvider) config.validationRuntime = { ...config.validationRuntime, provider: opts.taskReviewProvider };
      if (opts.taskReviewAccount) config.validationRuntime = { ...config.validationRuntime, account: opts.taskReviewAccount };
      if (opts.taskReviewModelId) config.validationRuntime = { ...config.validationRuntime, modelId: opts.taskReviewModelId };
      if (opts.taskReviewEffort) config.validationRuntime = { ...config.validationRuntime, effort: opts.taskReviewEffort as any };
      if (opts.runReviewEngine) config.reviewRuntime = { ...config.reviewRuntime, engine: opts.runReviewEngine as typeof config.engine };
      if (opts.runReviewProvider) config.reviewRuntime = { ...config.reviewRuntime, provider: opts.runReviewProvider };
      if (opts.runReviewAccount) config.reviewRuntime = { ...config.reviewRuntime, account: opts.runReviewAccount };
      if (opts.runReviewModelId) config.reviewRuntime = { ...config.reviewRuntime, modelId: opts.runReviewModelId };
      if (opts.runReviewEffort) config.reviewRuntime = { ...config.reviewRuntime, effort: opts.runReviewEffort as any };

      console.log(c(dim, '[runtime] effective phase routes'));
      console.log(c(dim, `  ${formatRuntime('planning', config.planningRuntime ?? {})}`));
      console.log(c(dim, `  ${formatRuntime('execution', { engine: config.engine, provider: config.provider, account: config.account, modelId: config.executionModelId, effort: config.executionEffort })}`));
      console.log(c(dim, `  ${formatRuntime('validation', config.validationRuntime ?? {})}`));
      console.log(c(dim, `  ${formatRuntime('review', config.reviewRuntime ?? {})}`));
      if (keelTaskRuntime) {
        console.log(c(dim, `  [runtime source] keel task ${opts.keelTask ?? baseConfig.keel?.taskId ?? '(unknown)'} contributed runtime defaults`));
        if (
          keelTaskRuntime.execution?.engine !== undefined ||
          keelTaskRuntime.execution?.provider !== undefined ||
          keelTaskRuntime.execution?.account !== undefined
        ) {
          console.log(c(yellow, '  [stale-state check] task-level execution runtime override detected — make sure this worktree contains the latest keel/tasks/*.json before running.'));
        }
      }
=======
      if (opts.planningEngine) config.planningRuntime = { ...config.planningRuntime, engine: opts.planningEngine as typeof config.engine };
      if (opts.planningProvider) config.planningRuntime = { ...config.planningRuntime, provider: opts.planningProvider };
      if (opts.planningModelId) config.planningRuntime = { ...config.planningRuntime, modelId: opts.planningModelId };
      if (opts.planningAccountId) config.planningRuntime = { ...config.planningRuntime, accountId: opts.planningAccountId };
      if (opts.validationEngine) config.validationRuntime = { ...config.validationRuntime, engine: opts.validationEngine as typeof config.engine };
      if (opts.validationProvider) config.validationRuntime = { ...config.validationRuntime, provider: opts.validationProvider };
      if (opts.validationModelId) config.validationRuntime = { ...config.validationRuntime, modelId: opts.validationModelId };
      if (opts.validationAccountId) config.validationRuntime = { ...config.validationRuntime, accountId: opts.validationAccountId };
      if (opts.reviewEngine) config.reviewRuntime = { ...config.reviewRuntime, engine: opts.reviewEngine as typeof config.engine };
      if (opts.reviewProvider) config.reviewRuntime = { ...config.reviewRuntime, provider: opts.reviewProvider };
      if (opts.reviewModelId) config.reviewRuntime = { ...config.reviewRuntime, modelId: opts.reviewModelId };
      if (opts.reviewAccountId) config.reviewRuntime = { ...config.reviewRuntime, accountId: opts.reviewAccountId };
      if (opts.executionAccountId) config.executionAccountId = opts.executionAccountId;
>>>>>>> Stashed changes

      // ── Interactive model selection (when not provided via flags) ────────────
      const MODEL_OPTIONS = [
        { value: 'sonnet', label: 'sonnet', hint: 'recommended' },
        { value: 'haiku',  label: 'haiku',  hint: 'fast & cheap' },
        { value: 'opus',   label: 'opus',   hint: 'most capable' },
      ];

      if (!isNonInteractive && !opts.model && !opts.buildModel && !opts.goal) {
        const projectName = path.basename(cwd);
        p.intro(`${c(cyan + bold, '☁️  cloudy build')}  ${c(bold, projectName)}`);

        const execModel = await p.select({
          message: 'Execution model:',
          options: MODEL_OPTIONS,
          initialValue: config.models.execution ?? 'sonnet',
        });
        if (p.isCancel(execModel)) { p.cancel('Cancelled.'); process.exit(0); }
        opts.buildModel = execModel as string;

        if (!opts.taskReviewModel) {
          const valModel = await p.select({
            message: 'Task review model (per-task validation):',
            options: [
              { value: 'haiku',  label: 'haiku',  hint: 'recommended — saves cost' },
              { value: 'sonnet', label: 'sonnet',  hint: 'higher quality' },
              { value: 'opus',   label: 'opus',    hint: 'most capable' },
            ],
            initialValue: config.models.validation ?? 'haiku',
          });
          if (p.isCancel(valModel)) { p.cancel('Cancelled.'); process.exit(0); }
          opts.taskReviewModel = valModel as string;
        }

        if (!opts.runReviewModel) {
          const reviewModel = await p.select({
            message: 'Final review model (holistic post-run review):',
            options: [
              { value: 'sonnet', label: 'sonnet', hint: 'recommended — reads full spec + diff' },
              { value: 'haiku',  label: 'haiku',  hint: 'fast & cheap, less thorough' },
              { value: 'opus',   label: 'opus',   hint: 'deepest review, highest cost' },
            ],
            initialValue: config.review?.model ?? 'opus',
          });
          if (p.isCancel(reviewModel)) { p.cancel('Cancelled.'); process.exit(0); }
          opts.runReviewModel = reviewModel as string;
        }

      }

      // --goal: create a plan on the fly and proceed (skips cloudy init)
      if (opts.goal) {
        const existingState = await loadState(cwd);
        if (existingState?.plan) {
          console.log(c(yellow, `⚠️  existing plan will be replaced by --goal`));
        }
        const freshState = existingState ?? await loadOrCreateState(cwd);
        console.log(`\n${c(cyan, '☁️  planning:')} ${opts.goal}\n`);
        const plan = await createPlan(
          opts.goal,
          config.models.planning,
          cwd,
          (text) => process.stdout.write(text),
          undefined,
          undefined,
          undefined,
          config.planningRuntime,
        );
        updatePlan(freshState, plan);
        await saveState(cwd, freshState);
        console.log('\n');
      }

      const state = await loadState(cwd);
      if (!state?.plan) {
        console.error(c(red, '✖  no plan found — run "cloudy init <goal>" first'));
        process.exit(1);
      }

      // Apply model overrides
      config.models = mergeModelConfig(config.models, {
        model: opts.model ? parseModelFlag(opts.model) : undefined,
        planningModel: opts.planModel
          ? parseModelFlag(opts.planModel)
          : undefined,
        executionModel: opts.buildModel
          ? parseModelFlag(opts.buildModel)
          : undefined,
        taskReviewModel: opts.taskReviewModel
          ? parseModelFlag(opts.taskReviewModel)
          : undefined,
        qualityReviewModel: opts.qualityReviewModel
          ? parseModelFlag(opts.qualityReviewModel)
          : undefined,
      });

      if (opts.modelAuto) config.autoModelRouting = true;
      if (opts.buildEngine) config.engine = opts.buildEngine as typeof config.engine;
      if (opts.buildProvider) config.provider = opts.buildProvider;
      if (opts.buildAccount) config.account = opts.buildAccount;
      if (opts.buildModelId) config.executionModelId = opts.buildModelId;
      if (opts.planEngine) config.planningRuntime = { ...config.planningRuntime, engine: opts.planEngine as typeof config.engine };
      if (opts.planProvider) config.planningRuntime = { ...config.planningRuntime, provider: opts.planProvider };
      if (opts.planAccount) config.planningRuntime = { ...config.planningRuntime, account: opts.planAccount };
      if (opts.planModelId) config.planningRuntime = { ...config.planningRuntime, modelId: opts.planModelId };
      if (opts.planEffort) config.planningRuntime = { ...config.planningRuntime, effort: opts.planEffort as any };
      if (opts.taskReviewEngine) config.validationRuntime = { ...config.validationRuntime, engine: opts.taskReviewEngine as typeof config.engine };
      if (opts.taskReviewProvider) config.validationRuntime = { ...config.validationRuntime, provider: opts.taskReviewProvider };
      if (opts.taskReviewAccount) config.validationRuntime = { ...config.validationRuntime, account: opts.taskReviewAccount };
      if (opts.taskReviewModelId) config.validationRuntime = { ...config.validationRuntime, modelId: opts.taskReviewModelId };
      if (opts.taskReviewEffort) config.validationRuntime = { ...config.validationRuntime, effort: opts.taskReviewEffort as any };
      if (opts.runReviewEngine) config.reviewRuntime = { ...config.reviewRuntime, engine: opts.runReviewEngine as typeof config.engine };
      if (opts.runReviewProvider) config.reviewRuntime = { ...config.reviewRuntime, provider: opts.runReviewProvider };
      if (opts.runReviewAccount) config.reviewRuntime = { ...config.reviewRuntime, account: opts.runReviewAccount };
      if (opts.runReviewModelId) config.reviewRuntime = { ...config.reviewRuntime, modelId: opts.runReviewModelId };
      if (opts.runReviewEffort) config.reviewRuntime = { ...config.reviewRuntime, effort: opts.runReviewEffort as any };
      if (opts.parallel) config.parallel = true;
      if (opts.maxParallel) config.maxParallel = opts.maxParallel;
      if (opts.worktrees) config.worktrees = true;
      if (opts.strictBatch) config.strictBatch = true;
      if (opts.buildEffort) config.executionEffort = opts.buildEffort as typeof config.executionEffort;
      if (opts.maxRetries !== undefined) config.maxRetries = opts.maxRetries;
      if (!opts.dashboard) config.dashboard = false; // --no-dashboard for headless CI

      if (opts.validate === false) {
        config.validation = {
          typecheck: false,
          lint: false,
          build: false,
          test: false,
          aiReview: false,
          commands: [],
        };
      }

      // Verify the requested execution engine/provider is available.
      try {
        await selectViaDaemon({
          engine: config.engine,
          provider: config.provider,
          account: config.account,
          taskType: 'coding',
        });
      } catch (err) {
        console.error(c(red, `✖  ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }

      // Apply review configuration
      if (opts.runReviewModel) {
        const parsed = opts.runReviewModel.toLowerCase();
        if (parsed === 'haiku' || parsed === 'sonnet' || parsed === 'opus') {
          config.review = { ...config.review, model: parsed };
        } else {
          console.error(c(red, `✖  unknown review model "${opts.runReviewModel}" — use haiku, sonnet, or opus`));
          process.exit(1);
        }
      }

      // Validate mutual exclusion of --only-task and --start-from
      if (opts.onlyTask && opts.startFrom) {
        console.error(c(red, '✖  cannot use --only-task and --start-from together'));
        process.exit(1);
      }

      // Validate task IDs exist
      if (opts.onlyTask && !state.plan!.tasks.some((t) => t.id === opts.onlyTask)) {
        console.error(c(red, `✖  task "${opts.onlyTask}" not found in plan`));
        process.exit(1);
      }
      if (opts.startFrom && !state.plan!.tasks.some((t) => t.id === opts.startFrom)) {
        console.error(c(red, `✖  task "${opts.startFrom}" not found in plan`));
        process.exit(1);
      }
      if (opts.retry && !state.plan!.tasks.some((t) => t.id === opts.retry)) {
        console.error(c(red, `✖  task "${opts.retry}" not found in plan`));
        process.exit(1);
      }

      // ── Approval handler (CLI) ────────────────────────────────────────
      async function cliApprovalHandler(request: ApprovalRequest): Promise<ApprovalAction> {
        const stageLabel = request.stage === 'pre_task' ? 'approval needed' : 'failure escalation';
        console.log(`\n${c(yellow, '⏸')}  ${c(yellow + bold, `[${request.taskId}] ${request.title}`)}  ${c(dim, `— ${stageLabel}  (${request.timeoutSec}s timeout)`)}`);
        if (request.context) {
          console.log(`    ${c(dim, request.context.split('\n')[0])}`);
        }
        console.log(`    ${c(dim, '[a]pprove  [s]kip  [h]alt  [r <hint>] retry with hint:')}`);

        return new Promise<ApprovalAction>((resolve) => {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          let settled = false;

          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            rl.close();
            console.log(c(dim, `  → No response — auto-continuing (approval logged)`));
            resolve(request.autoAction === 'halt' ? { action: 'timeout_halt' } : { action: 'timeout_continue' });
          }, request.timeoutSec * 1000);

          rl.question(c(dim, '  ❯ '), (answer) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            rl.close();
            const trimmed = answer.trim();
            if (trimmed === 'a' || trimmed === 'approve') {
              resolve({ action: 'approved' });
            } else if (trimmed === 's' || trimmed === 'skip') {
              resolve({ action: 'skipped' });
            } else if (trimmed === 'h' || trimmed === 'halt') {
              resolve({ action: 'halt' });
            } else if (trimmed.startsWith('r ')) {
              resolve({ action: 'retry_with_hint', hint: trimmed.slice(2).trim() });
            } else {
              // Default: approve
              resolve({ action: 'approved' });
            }
          });
        });
      }

      // ── Event handler ─────────────────────────────────────────────────
      let lastReviewResult: import('../../reviewer.js').ReviewResult | null = null;

      function makeEventHandler(broadcast?: (event: OrchestratorEvent) => void) {
        let taskFormatter: ((chunk: string) => void) | null = null;
        let taskHeartbeat: ReturnType<typeof setInterval> | null = null;
        let taskStartTime = 0;
        let taskHasActivity = false;

        function clearHeartbeat() {
          if (taskHeartbeat) { clearInterval(taskHeartbeat); taskHeartbeat = null; }
        }

        return (event: OrchestratorEvent) => {
          broadcast?.(event);

          switch (event.type) {
            case 'task_started': {
              const retryLabel = event.attempt > 1
                ? c(dim, `  ·  retry ${event.attempt}/${event.maxAttempts}`)
                : '';
              if (isAgentOutput) {
                agentLog('TASK:STARTED', event.taskId, `"${event.title}"`, event.attempt > 1 ? `retry=${event.attempt}/${event.maxAttempts}` : '');
              } else {
              console.log(`\n${c(yellow, '⚡')}  ${c(yellowBright + bold, event.taskId)}  ${c(bold, event.title)}${retryLabel}`);
              console.log(`    ${c(dim, `📁 ${event.contextFileCount} file${event.contextFileCount !== 1 ? 's' : ''} in context`)}`);
              }
              if (opts.verbose) {
                clearHeartbeat();
                taskFormatter = createStreamFormatter((s) => process.stdout.write(s));
                taskStartTime = Date.now();
                taskHasActivity = false;
                console.log(`    ${c(dim, '─── live output ───────────────────────────')}`);
                taskHeartbeat = setInterval(() => {
                  if (!taskHasActivity) {
                    const elapsed = Math.floor((Date.now() - taskStartTime) / 1000);
                    process.stdout.write(c(dim, `  [${elapsed}s — still waiting for the runtime...]\n`));
                  }
                }, 10_000);
              }
              break;
            }

            case 'task_output': {
              if (opts.verbose && taskFormatter) {
                if (!taskHasActivity) {
                  taskHasActivity = true;
                  clearHeartbeat();
                }
                taskFormatter(event.text);
              }
              break;
            }

            case 'task_tool_call': {
              if (opts.verbose) {
                if (!taskHasActivity) {
                  taskHasActivity = true;
                  clearHeartbeat();
                }
                const summary =
                  typeof event.toolInput === 'object' && event.toolInput !== null
                    ? JSON.stringify(event.toolInput).slice(0, 160)
                    : String(event.toolInput ?? '');
                process.stdout.write(`    ${c(dim, `→ ${event.toolName}${summary ? ` ${summary}` : ''}`)}\n`);
              }
              break;
            }

            case 'task_tool_result': {
              if (opts.verbose) {
                if (!taskHasActivity) {
                  taskHasActivity = true;
                  clearHeartbeat();
                }
                const text = event.content.replace(/\s+/g, ' ').trim().slice(0, 160);
                const prefix = event.isError ? '✗' : '←';
                process.stdout.write(`    ${c(dim, `${prefix} ${event.toolName}${text ? ` ${text}` : ''}`)}\n`);
              }
              break;
            }

            case 'task_completed':
              clearHeartbeat();
              if (isAgentOutput) {
                agentLog('TASK:DONE', event.taskId, `"${event.title}"`, `duration=${formatDuration(event.durationMs)}`);
              } else {
                console.log(`${c(green, '✅')}  ${c(greenBright, event.taskId)}  ${event.title}  ${c(dim, formatDuration(event.durationMs))}`);
              }
              break;

            case 'task_failed':
              clearHeartbeat();
              if (isAgentOutput) {
                if (event.willRetry) {
                  agentLog('TASK:FAILED', event.taskId, `"${event.title}"`, `attempt=${event.attempt}/${event.maxAttempts}`, 'will_retry=true');
                } else {
                  agentLog('TASK:FAILED', event.taskId, `"${event.title}"`, 'gave_up=true', `error=${event.error.split('\n')[0]}`);
                }
              } else {
                if (event.willRetry) {
                  console.log(`${c(red, '❌')}  ${c(red, event.taskId)}  ${event.title}  ${c(dim, `attempt ${event.attempt}/${event.maxAttempts}`)}`);
                } else {
                  console.log(`${c(red, '❌')}  ${c(red, event.taskId)}  ${c(bold, event.title)}  ${c(dim, 'gave up')}`);
                  console.log(`    ${c(red + dim, event.error.split('\n')[0])}`);
                }
              }
              break;

            case 'task_retrying':
              if (isAgentOutput) {
                agentLog('TASK:RETRYING', event.taskId ?? '', `delay=${event.delaySec}s`);
              } else {
                console.log(`    ${c(yellow, '🔄')}  ${c(yellow, `retrying in ${event.delaySec}s`)}`);
              }
              break;

            case 'validation_started':
              if (isAgentOutput) {
                agentLog('VALIDATE:STARTED', event.taskId ?? '');
              } else {
                console.log(`\n    ${c(cyan, '🔍 checking acceptance criteria')}`);
              }
              break;

            case 'validation_result': {
              const { report } = event;
              if (isAgentOutput) {
                agentLog('VALIDATE:RESULT', event.taskId ?? '', `passed=${report.passed}`);
                for (const r of report.results) {
                  if (!r.passed) {
                    agentLog('VALIDATE:FAIL_REASON', `strategy=${r.strategy}`, r.output.split('\n')[0]);
                  }
                }
                if (event.criteriaResults) {
                  for (const cr of event.criteriaResults) {
                    agentLog('VALIDATE:CRITERION', `passed=${cr.passed}`, cr.criterion.slice(0, 120));
                  }
                }
              } else {
                if (report.passed) {
                  console.log(`    ${c(green, '✨ criteria met')}`);
                } else {
                  console.log(`    ${c(red, '⚠️  criteria not met')}`);
                  for (const r of report.results) {
                    if (!r.passed) {
                      console.log(`       ${c(dim, `[${r.strategy}]  ${r.output.split('\n')[0]}`)}`);
                    }
                  }
                }
                if (event.criteriaResults && event.criteriaResults.length > 0) {
                  for (const cr of event.criteriaResults) {
                    const icon = cr.passed ? c(green, '✓') : c(red, '✗');
                    console.log(`       ${icon} ${c(dim, cr.criterion.length > 80 ? cr.criterion.slice(0, 77) + '...' : cr.criterion)}`);
                  }
                }
              }
              break;
            }

            case 'progress': {
              if (isAgentOutput) {
                agentLog('PROGRESS', `${event.completed}/${event.total}`, `${event.percentage}%`);
              } else {
                const width = 28;
                const filled = Math.round((event.completed / event.total) * width);
                const empty = width - filled;
                const bar = c(green, '█'.repeat(filled)) + c(dim, '░'.repeat(empty));
                console.log(`\n   ${bar}  ${c(bold, `${event.completed} / ${event.total}`)}  ${c(dim, `${event.percentage}%`)}\n`);
              }
              break;
            }

            case 'cost_update':
              break;

            case 'run_completed': {
              // Print decision log if any planning Q&A decisions were made
              const decisions = liveState?.plan?.decisionLog;
              if (decisions && decisions.length > 0) {
                const humanCount = decisions.filter((d) => d.answeredBy === 'human').length;
                const agentCount = decisions.length - humanCount;
                if (isAgentOutput) {
                  agentLog('DECISION_LOG', `total=${decisions.length}`, `human=${humanCount}`, `agent=${agentCount}`);
                  for (const d of decisions) {
                    agentLog('DECISION', `id=${d.questionId}`, `by=${d.answeredBy}`, `"${d.answer}"`);
                  }
                } else {
                  console.log(`\n${c(cyan + bold, '📋 Planning Decisions')}  ${c(dim, `${decisions.length} resolved (${humanCount} human · ${agentCount} AI assumed)`)}`);
                  for (const d of decisions) {
                    const tag = d.answeredBy === 'human' ? c(green, '●') : c(yellow, '◐');
                    console.log(`  ${tag}  ${c(dim, d.question.slice(0, 80))}${d.question.length > 80 ? '…' : ''}`);
                    console.log(`     ${c(bold, d.answer)}${d.reasoning ? `  ${c(dim, `— ${d.reasoning}`)}` : ''}`);
                  }
                }
              }

              if (isAgentOutput) {
                const cost = event.summary.totalEstimatedUsd > 0 ? `cost=$${event.summary.totalEstimatedUsd.toFixed(4)}` : '';
                agentLog('RUN:DONE', cost);
              } else {
                console.log('\n' + formatCostSummary(event.summary));
                const cost = event.summary.totalEstimatedUsd > 0
                  ? `  ${c(dim, `~$${event.summary.totalEstimatedUsd.toFixed(4)}`)}`
                  : '';
                console.log(`\n${c(green, '✅')}  ${c(green + bold, 'all done!')}${cost}`);
              }
              break;
            }

            case 'run_failed':
              if (isAgentOutput) {
                agentLog('RUN:FAILED', event.error.split('\n')[0]);
              } else {
                console.error(`\n${c(red, '❌')}  ${c(red + bold, 'run failed:')}  ${c(red, event.error)}`);
              }
              break;

            case 'run_status':
              if (event.status === 'stopped') {
                if (isAgentOutput) {
                  agentLog('RUN:STOPPED', 'halted');
                } else {
                  console.log(`\n${c(yellow, '⏸️')}  ${c(yellow, 'halted by user')}`);
                }
              }
              break;

            case 'review_started':
              if (isAgentOutput) {
                agentLog('REVIEW:STARTED', `model=${event.model}`);
              } else {
                console.log(`\n${c(cyan, '🔎')}  ${c(cyan + bold, 'holistic review')}  ${c(dim, `model: ${event.model}`)}`);
              }
              break;

            case 'review_output':
              if (opts.verbose && taskFormatter) {
                taskFormatter(event.text);
              }
              break;

            case 'review_completed': {
              lastReviewResult = event.result;
              const { result } = event;
              if (isAgentOutput) {
                agentLog('REVIEW:RESULT', `verdict=${result.verdict}`, `cost=$${result.costUsd.toFixed(4)}`);
                agentLog('REVIEW:SUMMARY', result.summary);
                for (const issue of result.issues) {
                  const loc = issue.location ? ` location=${issue.location}` : '';
                  agentLog('REVIEW:ISSUE', `severity=${issue.severity}${loc}`, issue.description);
                }
                for (const v of result.conventionViolations) {
                  agentLog('REVIEW:CONVENTION', v);
                }
              } else {
                const verdictColor = result.verdict === 'PASS'
                  ? green
                  : result.verdict === 'FAIL'
                    ? red
                    : yellow;
                const verdictIcon = result.verdict === 'PASS' ? '✅' : result.verdict === 'FAIL' ? '❌' : '⚠️';
                console.log(`\n${c(verdictColor, verdictIcon)}  ${c(verdictColor + bold, `Review: ${result.verdict}`)}`);
                console.log(`    ${c(dim, result.summary)}`);
                if (result.issues.length > 0) {
                  for (const issue of result.issues) {
                    const ic = issue.severity === 'critical' ? red : issue.severity === 'major' ? yellow : dim;
                    console.log(`    ${c(ic, `[${issue.severity}] ${issue.description}`)}${issue.location ? c(dim, `  (${issue.location})`) : ''}`);
                  }
                }
                if (result.conventionViolations.length > 0) {
                  for (const v of result.conventionViolations) {
                    console.log(`    ${c(yellow, `⚠ ${v}`)}`);
                  }
                }
                console.log(`    ${c(dim, `cost: ~$${result.costUsd.toFixed(4)}  ·  ${Math.round(result.durationMs / 1000)}s`)}`);
              }
              break;
            }

            case 'review_failed':
              if (isAgentOutput) {
                agentLog('REVIEW:FAILED', event.error.split('\n')[0]);
              } else {
                console.log(`\n${c(red, '❌')}  ${c(red, 'Review failed:')}  ${c(dim, event.error)}`);
              }
              break;

            case 'review_model_requested':
              // In non-TUI mode, no interactive model selection — proceed with configured model
              break;
          }
        };
      }

      // Keep process alive until SIGINT/SIGTERM or 'q' keypress.
      function keepAliveUntilSignal(onSignal: () => void): Promise<void> {
        return new Promise((resolve) => {
          const cleanup = () => {
            process.removeListener('SIGINT', sigHandler);
            process.removeListener('SIGTERM', sigHandler);
            if (process.stdin.isTTY) {
              try { process.stdin.setRawMode(false); } catch {}
              process.stdin.pause();
              process.stdin.removeListener('data', keyHandler);
            }
            resolve();
          };
          const sigHandler = () => { onSignal(); cleanup(); };
          const keyHandler = (key: Buffer) => {
            const str = key.toString();
            // q/Q to quit; \u0003 is ctrl+c in raw mode
            if (str === 'q' || str === 'Q' || str === '\u0003') {
              onSignal();
              cleanup();
            }
          };
          process.once('SIGINT', sigHandler);
          process.once('SIGTERM', sigHandler);
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('data', keyHandler);
          }
        });
      }

      // ── State ─────────────────────────────────────────────────────────
      // liveState tracks the most recent state object used by executeRun
      // so that the dashboard always reflects current reality, not the startup snapshot.
      let liveState: typeof state = state;
      let isRunning = false;
      let currentOrchestrator: Orchestrator | null = null;
      let abortCurrentRun: (() => void) | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      async function executeRun(broadcast?: (event: OrchestratorEvent) => void) {
        const freshState = await loadState(cwd);
        if (freshState) liveState = freshState;
        if (!freshState?.plan) {
          console.error(c(red, '✖  no plan found — run "cloudy init <goal>" first'));
          return;
        }

        // Crash recovery: reset any in_progress tasks back to pending
        const staleIds = sanitizeStaleTasks(freshState.plan);
        if (staleIds.length > 0) {
          for (const id of staleIds) {
            console.log(c(yellow, `⚠️  [${id}] was interrupted — resetting to pending`));
          }
          await saveState(cwd, freshState);
        }

        // Apply --max-retries override to all pending tasks
        if (opts.maxRetries !== undefined) {
          for (const task of freshState.plan.tasks) {
            if (task.status === 'pending') task.maxRetries = opts.maxRetries;
          }
        }

        // Resume confirmation: show what's done vs. pending
        if (opts.resume) {
          const alreadyDone = freshState.plan.tasks.filter(
            (t) => t.status === 'completed' || t.status === 'skipped',
          );
          const stillPending = freshState.plan.tasks.filter((t) => t.status === 'pending');
          if (alreadyDone.length > 0) {
            console.log(`\n  ${c(dim, 'already done:  ')}${alreadyDone.map((t) => c(dim, t.id)).join(', ')}`);
            console.log(`  ${c(bold, 'ready to run:  ')}${stillPending.map((t) => c(bold, t.id)).join(', ') || c(dim, '(none)')}\n`);
            const answer = await new Promise<string>((resolve) => {
              const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
              rl.question(`${c(dim, '  Continue? (yes/no) ')}`, (a) => { rl.close(); resolve(a.trim().toLowerCase()); });
            });
            if (answer !== 'yes' && answer !== 'y') {
              console.log(c(dim, '  cancelled'));
              return;
            }
          }
        }

        // --retry: reset the target task to pending and treat it like --only-task
        if (opts.retry) {
          const retryTask = freshState.plan.tasks.find((t) => t.id === opts.retry);
          if (!retryTask) {
            console.error(c(red, `✖  task "${opts.retry}" not found in plan`));
            return;
          }
          retryTask.status = 'pending';
          retryTask.error = undefined;
          retryTask.retries = 0;
          retryTask.retryHistory = [];
          console.log(c(yellow, `🔁  ${opts.retry} reset for retry`));
          await saveState(cwd, freshState);
        }

        // --retry-failed: reset ALL failed tasks (and their blocked dependents) to pending
        if (opts.retryFailed) {
          const failedTasks = freshState.plan.tasks.filter((t) => t.status === 'failed');
          if (failedTasks.length === 0) {
            console.log(c(dim, 'No failed tasks to retry.'));
          } else {
            for (const task of failedTasks) {
              task.status = 'pending';
              task.error = undefined;
              task.retries = 0;
              task.retryHistory = [];
            }
            console.log(c(yellow, `🔁  reset ${failedTasks.length} failed task(s): ${failedTasks.map((t) => t.id).join(', ')}`));
            await saveState(cwd, freshState);
          }
        }

        // Apply --only-task filtering
        if (opts.onlyTask) {
          const needed = getTransitiveDeps(freshState.plan.tasks, opts.onlyTask);
          for (const task of freshState.plan.tasks) {
            if (!needed.has(task.id) && task.status === 'pending') {
              task.status = 'skipped';
              task.resultSummary = 'Skipped (--only-task)';
            }
          }
        }

        // Apply --start-from filtering
        if (opts.startFrom) {
          const sorted = topologicalSort(freshState.plan.tasks);
          const startIndex = sorted.indexOf(opts.startFrom);
          const predecessors = new Set(sorted.slice(0, startIndex));
          for (const task of freshState.plan.tasks) {
            if (predecessors.has(task.id) && task.status === 'pending') {
              task.status = 'completed';
              task.resultSummary = 'Skipped (--start-from)';
            }
          }
        }

        freshState.activeTaskIds = freshState.plan.tasks
          .filter((task) => task.status === 'pending' || task.status === 'in_progress')
          .map((task) => task.id);

        // #10 — main/master branch guard
        try {
          const branchResult = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, reject: false });
          const currentBranch = branchResult.stdout.trim();
          if (currentBranch === 'main' || currentBranch === 'master') {
            if (isNonInteractive) {
              console.error(c(yellow, `⚠  Running on ${currentBranch} branch in non-interactive mode — proceeding`));
            } else {
              const proceed = await p.confirm({ message: `You are on ${currentBranch}. Cloudy will make commits directly to ${currentBranch}. Continue?` });
              if (p.isCancel(proceed) || !proceed) {
                console.log(c(dim, 'Cancelled. Create a feature branch and try again.'));
                return;
              }
            }
          }
        } catch { /* non-fatal — git may not be available */ }

        const preflightRisks = analyzePlanRisk(freshState.plan);
        const blockingRisks = preflightRisks.filter((risk) => risk.shouldBlock);
        if (blockingRisks.length > 0) {
          console.error(c(red, `✖  risk preflight refused ${blockingRisks.length} task(s): ${blockingRisks.map((risk) => risk.taskId).join(', ')}`));
          for (const risk of blockingRisks) {
            console.error(c(dim, `   ${risk.taskId} [${risk.executionMode}] ${risk.reasons.join(', ')}`));
          }
          if (config.strictBatch) {
            return;
          }
        } else {
          const mediumRisks = preflightRisks.filter((risk) => risk.level !== 'low');
          if (mediumRisks.length > 0) {
            console.log(c(yellow, `⚠  risk preflight: ${mediumRisks.length} task(s) have elevated execution risk`));
          }
        }

        // #6 — Plan pre-flight review (interactive mode only — can't act on concerns in non-interactive)
        if (!isNonInteractive && !opts.retry && !opts.retryFailed) {
          try {
            const { buildPlanPreflightPrompt } = await import('../../planner/prompts.js');
            const { runPhaseModel } = await import('../../executor/model-runner.js');
            const preflightPrompt = buildPlanPreflightPrompt(
              freshState.plan.goal,
              freshState.plan.tasks.filter((t) => t.status === 'pending').map((t) => ({
                id: t.id, title: t.title, description: t.description, dependencies: t.dependencies,
              })),
            );
            const preflightResult = await runPhaseModel({
              prompt: preflightPrompt,
              model: 'haiku',
              cwd,
              engine: config.reviewRuntime?.engine,
              provider: config.reviewRuntime?.provider,
              account: config.reviewRuntime?.account,
              modelId: config.reviewRuntime?.modelId,
              effort: config.reviewRuntime?.effort,
              abortSignal: AbortSignal.timeout(30_000),
              taskType: 'review',
            });
            if (preflightResult.success) {
              try {
                const jsonMatch = preflightResult.output.match(/\{[\s\S]*\}/);
                const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) as { concerns: string[]; safe_to_proceed: boolean } : null;
                if (parsed && !parsed.safe_to_proceed && parsed.concerns.length > 0) {
                  console.log(c(yellow, '\n⚠  Plan pre-flight concerns:'));
                  for (const concern of parsed.concerns) {
                    console.log(c(yellow, `   • ${concern}`));
                  }
                  const proceed = await p.confirm({ message: 'Proceed despite concerns?' });
                  if (p.isCancel(proceed) || !proceed) {
                    console.log(c(dim, 'Run cancelled. Fix plan and try again.'));
                    return;
                  }
                }
              } catch { /* malformed JSON — skip silently */ }
            }
          } catch { /* non-fatal — preflight failure never blocks execution */ }
        }

        // Capture test baseline before first task runs so the validator can ignore pre-existing failures
        if (config.baselineTestCommand && !opts.resume && !opts.retry && !opts.retryFailed) {
          const { captureTestBaseline } = await import('../../core/baseline.js');
          await captureTestBaseline(config.baselineTestCommand, cwd);
        }

        const pending = freshState.plan.tasks.filter((t) => t.status === 'pending');
        const engine = config.engine ?? 'claude-code';
        const provider = config.provider ?? 'auto';
        const executionModel = config.autoModelRouting ? 'auto' : config.models.execution;
        const parallelLabel = config.parallel ? `parallel ×${config.maxParallel}` : 'sequential';
        const execLabel = engine === 'claude-code'
          ? executionModel
          : (config.executionModelId ?? 'default');

        if (isAgentOutput) {
          agentLog('RUN:STARTED', `tasks=${pending.length}`, `engine=${engine}`, `provider=${provider}`, `exec=${execLabel}`, `validate=${config.models.validation}`, parallelLabel);
        } else {
          console.log(`\n${c(cyan + bold, '☁️  cloudy')}  ${c(dim, '·')}  ${c(bold, `${pending.length} task${pending.length !== 1 ? 's' : ''}`)}`);
          console.log(`    ${c(dim, `🤖 ${engine}/${provider}  ·  exec:${execLabel}  ·  validate:${config.models.validation}  ·  ${parallelLabel}`)}`);
          console.log('');
        }

        isRunning = true;
        broadcast?.({ type: 'run_status', status: 'running' });

        const orchestrator = new Orchestrator({
          cwd,
          state: freshState,
          config,
          onEvent: makeEventHandler(broadcast),
          onApprovalRequest: config.approval?.mode !== 'never' ? cliApprovalHandler : undefined,
        });
        currentOrchestrator = orchestrator;
        abortCurrentRun = () => orchestrator.abort();

        // ── Heartbeat: write status.json every N seconds ──────────────────────
        if (opts.heartbeatInterval && opts.heartbeatInterval > 0) {
          const { getCurrentRunDir } = await import('../../utils/run-dir.js');
          const writeHeartbeat = async () => {
            try {
              const tasks = freshState.plan?.tasks ?? [];
              const completed = tasks.filter((t) => t.status === 'completed' || t.status === 'completed_without_changes').length;
              const failed = tasks.filter((t) => t.status === 'failed').length;
              const inProgress = tasks.find((t) => t.status === 'in_progress');
              const status = {
                timestamp: new Date().toISOString(),
                runId: freshState.runName,
                totalTasks: tasks.length,
                completedTasks: completed,
                failedTasks: failed,
                skippedTasks: tasks.filter((t) => t.status === 'skipped').length,
                inProgressTaskId: inProgress?.id ?? null,
                inProgressTaskTitle: inProgress?.title ?? null,
                inProgressSince: inProgress?.startedAt ?? null,
                costUsd: freshState.costSummary?.totalEstimatedUsd ?? 0,
                elapsedMs: freshState.startedAt ? Date.now() - new Date(freshState.startedAt).getTime() : 0,
                pipelineContext: freshState.plan?.pipelineContext ?? null,
              };
              const runDir = await getCurrentRunDir(cwd);
              await import('node:fs/promises').then((fs) =>
                fs.writeFile(`${runDir}/status.json`, JSON.stringify(status, null, 2), 'utf-8'),
              );
            } catch { /* non-fatal */ }
          };
          heartbeatTimer = setInterval(() => { void writeHeartbeat(); }, opts.heartbeatInterval * 1000);
          void writeHeartbeat(); // immediate first write
        }

        try {
          await orchestrator.run();
          if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
          isRunning = false;
          currentOrchestrator = null;
          abortCurrentRun = null;
          if (!orchestrator.aborted) {
            broadcast?.({ type: 'run_status', status: 'completed' });
            const completedCount = freshState.plan!.tasks.filter((t) => t.status === 'completed' || t.status === 'completed_without_changes').length;
            void notifyRunComplete(completedCount, freshState.costSummary.totalEstimatedUsd, config.notifications);

            // Re-run recovery is now handled automatically inside the orchestrator

            const keel = summarizeKeelOutcome(
              freshState.plan!.tasks,
              freshState,
              opts,
              config,
              orchestrator.aborted,
              lastReviewResult?.verdict,
            );
            if (keel.enabled) {
              const { writeRunOutcome } = await import('../../integrations/keel.js');
              await writeRunOutcome(keel.ctx, keel.outcome, cwd).catch((writeErr) => {
                const writeMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
                void log.warn(`[keel] Run write-back failed: ${writeMsg}`);
              });
            }

            // #8 — block exit when review says FAIL
            if (config.review.failBlocksRun && lastReviewResult?.verdict === 'FAIL') {
              console.error(c(red + bold, '\n✗  Review verdict: FAIL — exiting with code 1'));
              process.exit(1);
            }

            // Finishing workflow — present branch options when all tasks completed
            if (!isNonInteractive && completedCount > 0) {
              await runFinishingWorkflow(cwd);
            }
          } else {
            const keel = summarizeKeelOutcome(
              freshState.plan?.tasks ?? [],
              freshState,
              opts,
              config,
              true,
              lastReviewResult?.verdict,
            );
            if (keel.enabled) {
              const { writeRunOutcome } = await import('../../integrations/keel.js');
              await writeRunOutcome(keel.ctx, keel.outcome, cwd).catch((writeErr) => {
                const writeMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
                void log.warn(`[keel] Abort write-back failed: ${writeMsg}`);
              });
            }
          }
        } catch (err) {
          if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
          isRunning = false;
          currentOrchestrator = null;
          abortCurrentRun = null;
          broadcast?.({ type: 'run_status', status: 'failed' });
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(
            `\n${c(red, '❌')}  ${c(red + bold, 'orchestration failed:')}  ${errMsg}`,
          );
          void notifyRunFailed(errMsg, config.notifications);

          const keel = summarizeKeelOutcome(
            freshState?.plan?.tasks ?? [],
            freshState,
            opts,
            config,
            false,
            lastReviewResult?.verdict,
            errMsg,
          );
          if (keel.enabled) {
            const { writeRunOutcome } = await import('../../integrations/keel.js');
            await writeRunOutcome(keel.ctx, keel.outcome, cwd).catch((writeErr) => {
              const writeMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
              void log.warn(`[keel] Failure write-back failed: ${writeMsg}`);
            });
          }
        }
      }

      // ── Dashboard ─────────────────────────────────────────────────────
      if (config.dashboard) {
        const { DAEMON_DEFAULT_PORT } = await import('../../config/defaults.js');
        const { loadGlobalConfig } = await import('../../config/global-config.js');
        const gc = await loadGlobalConfig().catch(() => null);
        const port = gc?.daemonPort ?? DAEMON_DEFAULT_PORT;
        const pfActive = await import('node:fs/promises')
          .then((f) => f.access('/etc/pf.anchors/cloudy').then(() => true))
          .catch(() => false);
        const friendlyUrl = pfActive ? 'http://cloudy.local' : `http://localhost:${port}`;
        const techUrl = `http://localhost:${port}`;
        console.log(`${c(cyan, '🌐')}  ${c(cyanBright, friendlyUrl)}  ${pfActive ? c(dim, `· ${techUrl}`) : c(dim, '(daemon dashboard)')}\n`);
        import('open').then(({ default: open }) => open(friendlyUrl)).catch(() => {});
      }

      // ── Run ───────────────────────────────────────────────────────────
      await executeRun();
    },
  );
