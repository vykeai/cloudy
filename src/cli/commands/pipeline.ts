import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { c, bold, dim, red, green, cyan, cyanBright, yellow } from '../../utils/colors.js';
import { initLogger } from '../../utils/logger.js';
import { CLAWDASH_DIR, DAEMON_DEFAULT_PORT, RUNS_DIR } from '../../config/defaults.js';
import { loadConfig } from '../../config/config.js';
import { getPhaseRuntime } from '../../config/phase-runtime.js';
import type { PhaseRuntimeConfig } from '../../core/types.js';
import { applyKeelTaskRuntime, loadKeelTaskRuntime } from '../../integrations/keel-task-runtime.js';

function formatRuntime(label: string, runtime: { engine?: string; provider?: string; account?: string; modelId?: string; effort?: string }): string {
  return `${label}: engine=${runtime.engine ?? '(default)'} provider=${runtime.provider ?? '(default)'} account=${runtime.account ?? '(default)'} modelId=${runtime.modelId ?? '(abstract)'} effort=${runtime.effort ?? '(default)'}`;
}

const PIPELINE_CONTEXT_FILE = '.cloudy/pipeline-context.md';

async function extractPhaseContracts(
  cwd: string,
  runDir: string,
  planGoal: string,
  runtime?: PhaseRuntimeConfig,
): Promise<string> {
  try {
    const { runPhaseModel } = await import('../../executor/model-runner.js');
    const { getGitDiff } = await import('../../git/git.js');

    // Get diff from this phase using oldest checkpoint SHA
    let diff = '';
    try {
      const checkpointsDir = path.join(runDir, 'checkpoints');
      let phaseSha: string | undefined;
      try {
        const files = await fs.readdir(checkpointsDir);
        let oldest = Infinity;
        for (const f of files.filter((f) => f.endsWith('.json'))) {
          const d = JSON.parse(await fs.readFile(path.join(checkpointsDir, f), 'utf-8'));
          const t = new Date(d.createdAt).getTime();
          if (t < oldest) { oldest = t; phaseSha = d.sha; }
        }
      } catch { /* non-fatal */ }
      diff = await getGitDiff(cwd, phaseSha);
      if (diff.length > 60000) diff = diff.slice(0, 60000) + '\n... [truncated]';
    } catch { /* non-fatal */ }

    if (!diff.trim()) return '';

    const prompt = `You are extracting a "phase contract" — a compact summary of what this implementation phase created or modified, for use by the NEXT phase's AI planner.

## Implementation Changes (git diff)
\`\`\`diff
${diff}
\`\`\`

## Phase Goal
${planGoal}

Extract the key contracts exposed by this phase. Be specific and concise. Focus on:
- New files created and their primary exports/classes/functions
- API endpoints added (method + path + key request/response fields)
- Database models/schemas added or modified (table name + key fields)
- Shared types, interfaces, enums added
- Environment variables or config keys required
- Any patterns or conventions established that future tasks must follow

Format as markdown bullet points under these headings:
## Files Created
## API Endpoints
## Models/Schemas
## Types & Interfaces
## Config & Env Vars
## Patterns Established

Keep each bullet to one line. Omit sections that are empty.`;

    const result = await runPhaseModel({
      prompt,
      model: 'haiku',
      cwd,
      engine: runtime?.engine,
      provider: runtime?.provider,
      account: runtime?.account,
      modelId: runtime?.modelId,
      taskType: 'review',
    });
    return result.output?.trim() ?? '';
  } catch {
    return '';
  }
}

export const pipelineCommand = new Command('chain')
  .description('Run multiple specs sequentially as a pipeline')
  .option('--spec <file>', 'Spec file (repeatable, in order)', (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option('--build-model <model>', 'Build model for all phases (haiku/sonnet/opus)')
  .option('--task-review-model <model>', 'Per-task validation model')
  .option('--run-review-model <model>', 'Post-phase holistic review model')
  .option('--plan-model <model>', 'Plan model (default: sonnet)')
  .option('--quality-review-model <model>', 'Model for Phase 2b code quality review (default: same as --task-review-model)')
<<<<<<< Updated upstream
  .option('--plan-engine <engine>', 'Plan engine for all phases')
  .option('--plan-provider <provider>', 'Plan provider/auth route for all phases (e.g. claude subscription, codex subscription, openai API)')
  .option('--plan-account <account>', 'Plan account route within the provider/runtime for all phases')
  .option('--plan-model-id <id>', 'Provider-native plan model ID for all phases')
  .option('--plan-effort <level>', 'Plan effort for all phases: low|medium|high|max')
  .option('--task-review-engine <engine>', 'Per-task review engine for all phases')
  .option('--task-review-provider <provider>', 'Per-task review provider/auth route for all phases (e.g. claude subscription, codex subscription, openai API)')
  .option('--task-review-account <account>', 'Per-task review account route within the provider/runtime for all phases')
  .option('--task-review-model-id <id>', 'Provider-native per-task review model ID for all phases')
  .option('--task-review-effort <level>', 'Per-task review effort for all phases: low|medium|high|max')
  .option('--run-review-engine <engine>', 'Holistic run-review engine for all phases')
  .option('--run-review-provider <provider>', 'Holistic run-review provider/auth route for all phases (e.g. claude subscription, codex subscription, openai API)')
  .option('--run-review-account <account>', 'Holistic run-review account route within the provider/runtime for all phases')
  .option('--run-review-model-id <id>', 'Provider-native holistic run-review model ID for all phases')
  .option('--run-review-effort <level>', 'Holistic run-review effort for all phases: low|medium|high|max')
  .option('--build-account <account>', 'Build account route within the provider/runtime for all phases')
  .option('--build-effort <level>', 'Build effort for all phases: low|medium|high|max')
  .option('--keel-slug <slug>', 'Keel project slug to write outcomes back to')
  .option('--keel-task <id>', 'Keel task ID to read runtime defaults from and update on completion')
=======
  .option('--planning-engine <engine>', 'Planning engine for all phases')
  .option('--planning-provider <provider>', 'Planning provider/auth route for all phases (e.g. claude subscription, codex subscription, openai API)')
  .option('--planning-model-id <id>', 'Provider-native planning model ID for all phases')
  .option('--planning-account-id <id>', 'Planning provider account/profile ID from omnai estate for all phases')
  .option('--validation-engine <engine>', 'Per-task AI validation engine for all phases')
  .option('--validation-provider <provider>', 'Per-task AI validation provider/auth route for all phases (e.g. claude subscription, codex subscription, openai API)')
  .option('--validation-model-id <id>', 'Provider-native per-task AI validation model ID for all phases')
  .option('--validation-account-id <id>', 'Validation provider account/profile ID from omnai estate for all phases')
  .option('--review-engine <engine>', 'Holistic review / review-side engine for all phases')
  .option('--review-provider <provider>', 'Holistic review / review-side provider/auth route for all phases (e.g. claude subscription, codex subscription, openai API)')
  .option('--review-model-id <id>', 'Provider-native holistic review model ID for all phases')
  .option('--review-account-id <id>', 'Review provider account/profile ID from omnai estate for all phases')
>>>>>>> Stashed changes
  .option('--no-auto-fix', 'Disable automatic fix-task generation from review notes')
  .option('--strict-batch', 'Deterministic batch mode: use task graphs as-is, disable creative recovery, and stop on terminal failures')
  .option('--verbose', 'Pass --verbose to each run')
  .option('--heartbeat-interval <seconds>', 'Write status.json every N seconds during each phase', parseInt)
  .option('--planning-timeout <seconds>', 'Max seconds to wait for planning before failing (default: 300)', parseInt)
  .action(async (opts: {
    spec: string[];
    buildModel?: string;
    taskReviewModel?: string;
    qualityReviewModel?: string;
    runReviewModel?: string;
<<<<<<< Updated upstream
    planModel?: string;
    planEngine?: string;
    planProvider?: string;
    planAccount?: string;
    planModelId?: string;
    planEffort?: string;
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
    buildAccount?: string;
    buildEffort?: string;
    keelSlug?: string;
    keelTask?: string;
=======
    planningModel?: string;
    planningEngine?: string;
    planningProvider?: string;
    planningModelId?: string;
    planningAccountId?: string;
    validationEngine?: string;
    validationProvider?: string;
    validationModelId?: string;
    validationAccountId?: string;
    reviewEngine?: string;
    reviewProvider?: string;
    reviewModelId?: string;
    reviewAccountId?: string;
>>>>>>> Stashed changes
    autoFix?: boolean;
    strictBatch?: boolean;
    verbose?: boolean;
    heartbeatInterval?: number;
    planningTimeout?: number;
  }) => {
    const cwd = process.cwd();
    await initLogger(cwd);
<<<<<<< Updated upstream
    const baseConfig = await loadConfig(cwd);
    const keelTaskRuntime = await loadKeelTaskRuntime(cwd, opts.keelTask ?? baseConfig.keel?.taskId);
    const config = applyKeelTaskRuntime(baseConfig, keelTaskRuntime);
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
    if (opts.buildAccount) config.account = opts.buildAccount;
    if (opts.buildEffort) config.executionEffort = opts.buildEffort as typeof config.executionEffort;

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
    const config = await loadConfig(cwd);
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
>>>>>>> Stashed changes

    if (opts.spec.length === 0) {
      console.error(c(red, '✖  --spec required (repeatable): cloudy chain --spec p1.md --spec p2.md'));
      process.exit(1);
    }

    const missing: string[] = [];
    if (!opts.buildModel && !config.models.execution) missing.push('--build-model');
    if (!opts.taskReviewModel && !config.models.validation) missing.push('--task-review-model');
    if (!opts.runReviewModel && !config.review.model) missing.push('--run-review-model');
    if (missing.length > 0) {
      console.error(c(red, `✖  pipeline requires: ${missing.join(', ')}`));
      process.exit(1);
    }

    const planningModel = opts.planModel ?? config.models.planning ?? 'sonnet';
    // opts.autoFix is true by default (commander inverts --no-auto-fix)
    const autoFix = opts.autoFix !== false;

    // Generate a stable pipeline ID for this run — used to group phases in `cloudy runs`
    const now = new Date();
    const datePart = now.toISOString().slice(0, 10);
    const timePart = now.toTimeString().slice(0, 5).replace(':', '');
    const pipelineId = `pipeline-${datePart}-${timePart}`;

    // Per-phase cost tracking
    interface PhaseCostEntry {
      phaseNum: number;
      specPath: string;
      runName: string;
      costUsd: number;
      taskCount: number;
      retryCount: number;
      durationMs: number;
    }
    const phaseCosts: PhaseCostEntry[] = [];

    console.log(`\n${c(cyan + bold, '☁️  cloudy chain')}  ${c(bold, `${opts.spec.length} phases`)}  ${c(dim, pipelineId)}`);
    for (let i = 0; i < opts.spec.length; i++) {
      console.log(`    ${c(dim, `phase ${i + 1}:`)}  ${opts.spec[i]}`);
    }
    console.log('');

    // Always open the dashboard in the browser when pipeline starts
    const dashboardPort = config.dashboardPort ?? DAEMON_DEFAULT_PORT;
    const dashboardUrl = `http://localhost:${dashboardPort}`;
    console.log(`${c(cyan, '🌐')}  ${c(cyanBright + bold, dashboardUrl)}  ${c(dim, '(dashboard — opens in browser)')}`);
    import('open').then(({ default: open }) => open(dashboardUrl)).catch(() => {});

    const { execa } = await import('execa');
    const cloudyBin = process.argv[1]; // path to cloudy.js

    for (let i = 0; i < opts.spec.length; i++) {
      const specPath = opts.spec[i];
      const phaseNum = i + 1;
      const phaseSlug = path.basename(specPath, path.extname(specPath))
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      const runName = `${pipelineId}-p${phaseNum}-${phaseSlug}`;
      const runDir = path.join(cwd, CLAWDASH_DIR, RUNS_DIR, runName);

      const phaseStartTime = Date.now();
    console.log(`\n${c(cyan, `━━━ Phase ${phaseNum}/${opts.spec.length}:`)}  ${c(bold, specPath)}  ${c(dim, runName)}`);

      // cloudy plan --spec <file> --no-review --plan-model <model> --run-name <name>
      console.log(c(dim, `    initialising plan…`));
      const planningTimeoutMs = (opts.planningTimeout ?? 300) * 1000;
      try {
        await execa(process.argv[0], [
          cloudyBin,
          'plan',
          '--spec', path.resolve(cwd, specPath),
          '--no-review',
          '--yes',
<<<<<<< Updated upstream
          '--plan-model', planningModel,
          ...(config.planningRuntime?.engine ? ['--plan-engine', config.planningRuntime.engine] : []),
          ...(config.planningRuntime?.provider ? ['--plan-provider', config.planningRuntime.provider] : []),
          ...(config.planningRuntime?.account ? ['--plan-account', config.planningRuntime.account] : []),
          ...(config.planningRuntime?.modelId ? ['--plan-model-id', config.planningRuntime.modelId] : []),
          ...(config.planningRuntime?.effort ? ['--plan-effort', config.planningRuntime.effort] : []),
=======
          '--planning-model', planningModel,
          ...(config.planningRuntime?.engine ? ['--planning-engine', config.planningRuntime.engine] : []),
          ...(config.planningRuntime?.provider ? ['--planning-provider', config.planningRuntime.provider] : []),
          ...(config.planningRuntime?.modelId ? ['--planning-model-id', config.planningRuntime.modelId] : []),
          ...(config.planningRuntime?.accountId ? ['--planning-account-id', config.planningRuntime.accountId] : []),
>>>>>>> Stashed changes
          '--run-name', runName,
        ], {
          stdio: 'inherit',
          cwd,
          env: { ...process.env, CLOUDY_PLANNING_TIMEOUT_MS: String(planningTimeoutMs), CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined },
        });
      } catch (err: any) {
        console.error(c(red, `✖  init failed for phase ${phaseNum}: ${err?.message ?? err}`));
        process.exit(1);
      }

      // Phase size check
      try {
        const stateData = JSON.parse(await fs.readFile(path.join(runDir, 'state.json'), 'utf-8'));
        const taskCount = stateData.plan?.tasks?.length ?? 0;
        if (taskCount > 10) {
          console.log(c(yellow, `  ⚠️  Large phase: ${taskCount} tasks planned. Consider splitting into 2 phases of ~${Math.ceil(taskCount/2)} tasks for better reliability.`));
        } else if (taskCount > 6) {
          console.log(c(dim, `  ℹ️  ${taskCount} tasks in this phase (recommended max: 6 for best quality)`));
        }
      } catch { /* non-fatal */ }

      // Inject pipelineContext into state.json
      try {
        const statePath = path.join(runDir, 'state.json');
        const state = JSON.parse(await fs.readFile(statePath, 'utf-8'));
        if (state.plan) {
          state.plan.pipelineContext = {
            pipelineId,
            phaseIndex: phaseNum,
            totalPhases: opts.spec.length,
            phaseLabel: phaseSlug,
          };
          await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
        }
      } catch { /* non-fatal */ }

      // Build run args (reused for fix-task re-runs)
      const runArgs = [
        cloudyBin,
        'run',
        '--non-interactive',
<<<<<<< Updated upstream
        '--build-model', opts.buildModel ?? config.models.execution,
        '--task-review-model', opts.taskReviewModel ?? config.models.validation,
        '--run-review-model', opts.runReviewModel ?? config.review.model,
        ...(config.executionEffort ? ['--build-effort', config.executionEffort] : []),
        ...(config.engine ? ['--build-engine', config.engine] : []),
        ...(config.provider ? ['--build-provider', config.provider] : []),
        ...(config.account ? ['--build-account', config.account] : []),
        ...(config.executionModelId ? ['--build-model-id', config.executionModelId] : []),
        ...(config.validationRuntime?.engine ? ['--task-review-engine', config.validationRuntime.engine] : []),
        ...(config.validationRuntime?.provider ? ['--task-review-provider', config.validationRuntime.provider] : []),
        ...(config.validationRuntime?.account ? ['--task-review-account', config.validationRuntime.account] : []),
        ...(config.validationRuntime?.modelId ? ['--task-review-model-id', config.validationRuntime.modelId] : []),
        ...(config.validationRuntime?.effort ? ['--task-review-effort', config.validationRuntime.effort] : []),
        ...(config.reviewRuntime?.engine ? ['--run-review-engine', config.reviewRuntime.engine] : []),
        ...(config.reviewRuntime?.provider ? ['--run-review-provider', config.reviewRuntime.provider] : []),
        ...(config.reviewRuntime?.account ? ['--run-review-account', config.reviewRuntime.account] : []),
        ...(config.reviewRuntime?.modelId ? ['--run-review-model-id', config.reviewRuntime.modelId] : []),
        ...(config.reviewRuntime?.effort ? ['--run-review-effort', config.reviewRuntime.effort] : []),
        ...(opts.keelSlug ?? config.keel?.slug ? ['--keel-slug', opts.keelSlug ?? config.keel?.slug ?? ''] : []),
        ...(opts.keelTask ?? config.keel?.taskId ? ['--keel-task', opts.keelTask ?? config.keel?.taskId ?? ''] : []),
=======
        '--execution-model', opts.executionModel!,
        '--task-review-model', opts.taskReviewModel!,
        '--run-review-model', opts.runReviewModel!,
        ...(config.validationRuntime?.engine ? ['--validation-engine', config.validationRuntime.engine] : []),
        ...(config.validationRuntime?.provider ? ['--validation-provider', config.validationRuntime.provider] : []),
        ...(config.validationRuntime?.modelId ? ['--validation-model-id', config.validationRuntime.modelId] : []),
        ...(config.validationRuntime?.accountId ? ['--validation-account-id', config.validationRuntime.accountId] : []),
        ...(config.reviewRuntime?.engine ? ['--review-engine', config.reviewRuntime.engine] : []),
        ...(config.reviewRuntime?.provider ? ['--review-provider', config.reviewRuntime.provider] : []),
        ...(config.reviewRuntime?.modelId ? ['--review-model-id', config.reviewRuntime.modelId] : []),
        ...(config.reviewRuntime?.accountId ? ['--review-account-id', config.reviewRuntime.accountId] : []),
>>>>>>> Stashed changes
      ];
      if (opts.strictBatch) runArgs.push('--strict-batch');
      if (opts.qualityReviewModel) runArgs.push('--quality-review-model', opts.qualityReviewModel);
      if (opts.verbose) runArgs.push('--verbose');
      if (opts.heartbeatInterval) runArgs.push('--heartbeat-interval', String(opts.heartbeatInterval));

      // Run the phase
      console.log(c(dim, `    running phase ${phaseNum}…`));
      try {
        await execa(process.argv[0], runArgs, { stdio: 'inherit', cwd, env: { ...process.env, CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined } });
      } catch (err: any) {
        if (err?.signal !== 'SIGTERM') {
          console.error(c(red, `✖  run failed for phase ${phaseNum}: ${err?.message ?? err}`));
          process.exit(1);
        }
      }

      // Extract phase cost from state.json after run
      try {
        const stateData = JSON.parse(await fs.readFile(path.join(runDir, 'state.json'), 'utf-8'));
        const costUsd = stateData.costSummary?.totalEstimatedUsd ?? 0;
        const taskCount = (stateData.plan?.tasks ?? []).length;
        const retryCount = (stateData.plan?.tasks ?? []).reduce((sum: number, t: any) => sum + (t.retries ?? 0), 0);
        const durationMs = Date.now() - phaseStartTime;
        const phaseSlugForCost = path.basename(specPath, path.extname(specPath)).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
        const label = `p${phaseNum}-${phaseSlugForCost}`;
        phaseCosts.push({ phaseNum, specPath: path.basename(specPath), runName, costUsd, taskCount, retryCount, durationMs });
        const durationSec = Math.round(durationMs / 1000);
        const mins = Math.floor(durationSec / 60);
        const secs = durationSec % 60;
        const durationStr = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
        console.log(c(dim, `[PHASE:COST] ${label} completed | tasks: ${taskCount} | cost: $${costUsd.toFixed(2)} | retries: ${retryCount} | duration: ${durationStr}`));
      } catch { /* non-fatal */ }

      // Check review result from run dir
      const reviewPath = path.join(runDir, 'review.json');
      let review: any = null;
      try {
        review = JSON.parse(await fs.readFile(reviewPath, 'utf-8'));
      } catch { /* no review file — non-fatal */ }

      if (review?.verdict === 'FAIL') {
        console.error(c(red, `✖  Phase ${phaseNum} review: FAIL — halting pipeline`));
        console.error(c(dim, `    ${review.summary}`));
        process.exit(1);
      }

      const score = review?.specCoverageScore != null ? ` (coverage: ${review.specCoverageScore}%)` : '';
      console.log(c(green, `✅  Phase ${phaseNum} review: ${review?.verdict ?? 'unknown'}${score}`));

      // ── Auto-fix: inject repair tasks for major/critical issues ──────────────
      if (autoFix && !opts.strictBatch && review) {
        const actionable: Array<{ severity: string; description: string; location?: string }> =
          (review.issues ?? []).filter(
            (iss: any) => iss.severity === 'major' || iss.severity === 'critical',
          );

        if (actionable.length > 0) {
          console.log(
            c(yellow, `    ⚠  ${actionable.length} major/critical issue(s) — generating fix tasks…`),
          );

          let fixTasks: any[] = [];
          try {
            const statePath = path.join(runDir, 'state.json');
            const state = JSON.parse(await fs.readFile(statePath, 'utf-8'));

            const { generateFixTasks } = await import('../../reviewer.js');
            fixTasks = await generateFixTasks(
              review,
              state.plan,
              cwd,
              'haiku',
            );

            if (fixTasks.length > 0) {
              // Inject fix tasks into state.json
              state.plan.tasks.push(...fixTasks);
              state.plan.updatedAt = new Date().toISOString();
              await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');

              console.log(
                c(dim, `    injected ${fixTasks.length} fix task(s): ${fixTasks.map((t: any) => t.id).join(', ')}`),
              );

              // Re-run — completed tasks are skipped, only new pending fix tasks execute
              console.log(c(dim, `    re-running with fix tasks…`));
              try {
                await execa(process.argv[0], runArgs, { stdio: 'inherit', cwd, env: { ...process.env, CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined } });
              } catch (err: any) {
                if (err?.signal !== 'SIGTERM') {
                  // Non-fatal: log but continue pipeline — fixes are best-effort
                  console.error(c(yellow, `    ⚠  fix run failed (non-fatal): ${err?.message ?? err}`));
                }
              }

              // Read updated review after fix run
              let review2: any = null;
              try {
                review2 = JSON.parse(await fs.readFile(reviewPath, 'utf-8'));
                if (review2.verdict === 'FAIL') {
                  console.error(c(red, `✖  Phase ${phaseNum} review after fixes: FAIL — halting pipeline`));
                  console.error(c(dim, `    ${review2.summary}`));
                  process.exit(1);
                }
                const score2 = review2.specCoverageScore != null
                  ? ` (coverage: ${review2.specCoverageScore}%)`
                  : '';
                console.log(c(green, `✅  Phase ${phaseNum} after fixes: ${review2.verdict}${score2}`));
              } catch { /* non-fatal */ }

              // ── Critical issue gate: if critical issues remain unfixed, attempt one more repair pass ──
              const reviewAfterFix = review2 ?? review;
              const unresolvedCriticals = (reviewAfterFix?.issues ?? []).filter(
                (iss: any) => iss.severity === 'critical',
              );
              if (unresolvedCriticals.length > 0) {
                console.error(c(red, `[PIPELINE:BLOCKED] Phase ${phaseNum} has ${unresolvedCriticals.length} unresolved critical issue(s) — attempting repair pass`));
                for (const crit of unresolvedCriticals) {
                  console.error(c(dim, `    • ${crit.description}${crit.location ? ` (${crit.location})` : ''}`));
                }

                try {
                  const stateForRepair = JSON.parse(await fs.readFile(path.join(runDir, 'state.json'), 'utf-8'));
                  const { generateFixTasks: gft } = await import('../../reviewer.js');
                  const repairTasks = await gft(reviewAfterFix, stateForRepair.plan, cwd, 'sonnet');

                  if (repairTasks.length > 0) {
                    stateForRepair.plan.tasks.push(...repairTasks);
                    stateForRepair.plan.updatedAt = new Date().toISOString();
                    await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify(stateForRepair, null, 2), 'utf-8');
                    console.log(c(dim, `    repair pass: injected ${repairTasks.length} task(s)`));

                    try {
                      await execa(process.argv[0], runArgs, { stdio: 'inherit', cwd, env: { ...process.env, CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined } });
                    } catch (repairErr: any) {
                      if (repairErr?.signal !== 'SIGTERM') {
                        console.error(c(red, `    repair run failed: ${repairErr?.message ?? repairErr}`));
                      }
                    }

                    // Check final state
                    try {
                      const review3 = JSON.parse(await fs.readFile(reviewPath, 'utf-8'));
                      const stillCritical = (review3.issues ?? []).filter((iss: any) => iss.severity === 'critical');
                      if (stillCritical.length > 0) {
                        console.error(c(red, `[PIPELINE:BLOCKED] Phase ${phaseNum} repair pass did not resolve ${stillCritical.length} critical issue(s) — manual intervention required`));
                        process.exit(1);
                      } else {
                        const score3 = review3.specCoverageScore != null ? ` (coverage: ${review3.specCoverageScore}%)` : '';
                        console.log(c(green, `✅  Phase ${phaseNum} after repair: ${review3.verdict}${score3}`));
                      }
                    } catch { /* non-fatal — let pipeline continue */ }
                  } else {
                    console.error(c(red, `[PIPELINE:BLOCKED] Phase ${phaseNum} repair pass generated no tasks — manual intervention required`));
                    process.exit(1);
                  }
                } catch (repairGenErr: any) {
                  console.error(c(red, `[PIPELINE:BLOCKED] Phase ${phaseNum} repair pass failed: ${repairGenErr?.message ?? repairGenErr} — manual intervention required`));
                  process.exit(1);
                }
              }
            } else {
              console.log(c(dim, `    no fix tasks generated — skipping fix run`));

              // Still check for unresolved critical issues even with no fix tasks
              const unresolvedCriticals = (review.issues ?? []).filter(
                (iss: any) => iss.severity === 'critical',
              );
              if (unresolvedCriticals.length > 0) {
                console.error(c(red, `[PIPELINE:BLOCKED] Phase ${phaseNum} has ${unresolvedCriticals.length} unresolved critical issue(s) and no fix tasks could be generated — manual intervention required`));
                process.exit(1);
              }
            }
          } catch (err: any) {
            console.log(c(dim, `    fix task generation failed (non-fatal): ${err?.message ?? err}`));
          }
        }
      }

      // ── Contract extraction: extract what this phase built for next phase ──
      if (i < opts.spec.length - 1) {
        console.log(c(dim, `    extracting phase contracts for next phase…`));
        try {
          const statePath = path.join(runDir, 'state.json');
          const stateForContracts = JSON.parse(await fs.readFile(statePath, 'utf-8'));
          const planGoal = stateForContracts.plan?.goal ?? phaseSlug;
          const contracts = await extractPhaseContracts(cwd, runDir, planGoal, getPhaseRuntime(config, 'review'));
          if (contracts) {
            // Append to pipeline-contracts.md (cumulative archive)
            const archivePath = path.join(cwd, CLAWDASH_DIR, 'pipeline-contracts.md');
            const archiveEntry = `\n## Phase ${phaseNum}: ${phaseSlug}\n${contracts}\n`;
            await fs.appendFile(archivePath, archiveEntry, 'utf-8').catch(() => {});

            // Write/update pipeline-context.md for planner injection
            const contextPath = path.join(cwd, PIPELINE_CONTEXT_FILE);
            let existing = '';
            try { existing = await fs.readFile(contextPath, 'utf-8'); } catch { /* new file */ }
            if (!existing) {
              existing = '# Pipeline Context — Contracts from Previous Phases\n\nThis file is auto-generated by cloudy chain. Use it to understand what previous phases built.\n';
            }
            await fs.writeFile(contextPath, existing + archiveEntry, 'utf-8');
            console.log(c(dim, `    phase contracts saved → ${PIPELINE_CONTEXT_FILE}`));
          }
        } catch (err: any) {
          console.log(c(dim, `    contract extraction failed (non-fatal): ${err?.message ?? err}`));
        }
      }
    }

    // Pipeline cost summary
    const totalCost = phaseCosts.reduce((sum, p) => sum + p.costUsd, 0);
    const totalTasks = phaseCosts.reduce((sum, p) => sum + p.taskCount, 0);
    const totalRetries = phaseCosts.reduce((sum, p) => sum + p.retryCount, 0);
    const totalMs = phaseCosts.reduce((sum, p) => sum + p.durationMs, 0);
    const totalMins = Math.floor(totalMs / 60000);
    const totalSecs = Math.round((totalMs % 60000) / 1000);
    console.log(`\n${c(green + bold, '✅  Pipeline complete!')}  ${opts.spec.length} phases ran successfully.\n`);
    if (phaseCosts.length > 0) {
      console.log(c(bold, 'Cost summary:'));
      for (const p of phaseCosts) {
        const label = path.basename(p.specPath, path.extname(p.specPath));
        console.log(`  ${c(dim, `p${p.phaseNum}`)}  ${label.padEnd(28)}  $${p.costUsd.toFixed(2).padStart(6)}  tasks: ${String(p.taskCount).padStart(2)}  retries: ${p.retryCount}`);
      }
      console.log(`  ${'─'.repeat(60)}`);
      console.log(`  ${c(bold, 'Total')}${''.padEnd(28)}  ${c(bold, `$${totalCost.toFixed(2).padStart(6)}`)}  tasks: ${String(totalTasks).padStart(2)}  retries: ${totalRetries}  duration: ${totalMins}m${totalSecs}s`);
      console.log('');
    }
  });
