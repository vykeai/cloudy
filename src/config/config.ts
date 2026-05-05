import path from 'node:path';
import type { CloudyConfig } from '../core/types.js';
import { CLAWDASH_DIR, CONFIG_FILE, DEFAULT_CONFIG } from './defaults.js';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';
import { loadGlobalConfig } from './global-config.js';

const VALID_MODELS = new Set(['opus', 'sonnet', 'haiku']);
const VALID_ENGINES = new Set([
  'claude-code',
  'codex',
  'pi-mono',
  'copilot',
  'gemini-cli',
  'qwen-code',
  'amazon-q',
  'opencode',
  'goose',
]);
const VALID_APPROVAL_MODES = new Set(['never', 'always', 'on-failure']);
const VALID_AUTO_ACTIONS = new Set(['continue', 'halt']);
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'max']);

type ExternalModelConfig = {
  plan?: CloudyConfig['models']['planning'];
  build?: CloudyConfig['models']['execution'];
  taskReview?: CloudyConfig['models']['validation'];
  qualityReview?: CloudyConfig['models']['qualityReview'];
  runReview?: CloudyConfig['review']['model'];
};

type ExternalCloudyConfig = Omit<
  Partial<CloudyConfig>,
  'models' | 'engine' | 'provider' | 'account' | 'executionModelId' | 'executionEffort' | 'planningRuntime' | 'validationRuntime' | 'reviewRuntime'
> & {
  models?: ExternalModelConfig;
  buildEngine?: CloudyConfig['engine'];
  buildProvider?: CloudyConfig['provider'];
  buildAccount?: CloudyConfig['account'];
  buildModelId?: CloudyConfig['executionModelId'];
  buildEffort?: CloudyConfig['executionEffort'];
  planRuntime?: CloudyConfig['planningRuntime'];
  taskReviewRuntime?: CloudyConfig['validationRuntime'];
  runReviewRuntime?: CloudyConfig['reviewRuntime'];
};

export type { ExternalCloudyConfig };

function validatePhaseRuntime(prefix: string, runtime: CloudyConfig['planningRuntime'], errors: string[]): void {
  if (!runtime) return;
  if (runtime.engine && !VALID_ENGINES.has(runtime.engine)) {
    errors.push(`${prefix}.engine: invalid engine "${runtime.engine}"`);
  }
  if (runtime.effort && !VALID_EFFORTS.has(runtime.effort)) {
    errors.push(`${prefix}.effort: invalid effort "${runtime.effort}"`);
  }
}

export function validateConfig(config: CloudyConfig): string[] {
  const errors: string[] = [];

  if (!VALID_MODELS.has(config.models.planning)) {
    errors.push(`models.plan: invalid model "${config.models.planning}" (valid: opus, sonnet, haiku)`);
  }
  if (!VALID_MODELS.has(config.models.execution)) {
    errors.push(`models.build: invalid model "${config.models.execution}" (valid: opus, sonnet, haiku)`);
  }
  if (!VALID_MODELS.has(config.models.validation)) {
    errors.push(`models.taskReview: invalid model "${config.models.validation}" (valid: opus, sonnet, haiku)`);
  }
  if (!VALID_ENGINES.has(config.engine)) {
    errors.push(`buildEngine: invalid engine "${config.engine}"`);
  }
  if (config.executionEffort && !VALID_EFFORTS.has(config.executionEffort)) {
    errors.push(`buildEffort: invalid effort "${config.executionEffort}"`);
  }
  validatePhaseRuntime('planRuntime', config.planningRuntime, errors);
  validatePhaseRuntime('taskReviewRuntime', config.validationRuntime, errors);
  validatePhaseRuntime('runReviewRuntime', config.reviewRuntime, errors);
  if (typeof config.maxRetries !== 'number' || config.maxRetries < 0 || config.maxRetries > 10) {
    errors.push(`maxRetries: must be a number between 0 and 10 (got ${config.maxRetries})`);
  }
  if (typeof config.taskTimeoutMs !== 'number' || config.taskTimeoutMs < 60_000) {
    errors.push(`taskTimeoutMs: must be at least 60000ms / 1 minute (got ${config.taskTimeoutMs})`);
  }
  if (typeof config.dashboardPort !== 'number' || config.dashboardPort < 1024 || config.dashboardPort > 65535) {
    errors.push(`dashboardPort: must be between 1024 and 65535 (got ${config.dashboardPort})`);
  }
  if (!VALID_APPROVAL_MODES.has(config.approval.mode)) {
    errors.push(`approval.mode: invalid value "${config.approval.mode}" (valid: never, always, on-failure)`);
  }
  if (!VALID_AUTO_ACTIONS.has(config.approval.autoAction)) {
    errors.push(`approval.autoAction: invalid value "${config.approval.autoAction}" (valid: continue, halt)`);
  }
  if (typeof config.approval.timeoutSec !== 'number' || config.approval.timeoutSec < 10) {
    errors.push(`approval.timeoutSec: must be at least 10 seconds (got ${config.approval.timeoutSec})`);
  }
  if (config.keel?.port !== undefined && (!Number.isInteger(config.keel.port) || config.keel.port <= 0 || config.keel.port > 65535)) {
    errors.push(`keel.port: must be an integer between 1 and 65535 (got ${config.keel.port})`);
  }

  return errors;
}

function configPath(cwd: string): string {
  return path.join(cwd, CLAWDASH_DIR, CONFIG_FILE);
}

export function toExternalConfig(config: CloudyConfig): ExternalCloudyConfig {
  return {
    models: {
      plan: config.models.planning,
      build: config.models.execution,
      taskReview: config.models.validation,
      qualityReview: config.models.qualityReview,
      runReview: config.review.model,
    },
    validation: config.validation,
    maxRetries: config.maxRetries,
    parallel: config.parallel,
    maxParallel: config.maxParallel,
    retryDelaySec: config.retryDelaySec,
    taskTimeoutMs: config.taskTimeoutMs,
    autoModelRouting: config.autoModelRouting,
    dashboard: config.dashboard,
    dashboardPort: config.dashboardPort,
    notifications: config.notifications,
    contextBudgetTokens: config.contextBudgetTokens,
    contextBudgetMode: config.contextBudgetMode,
    preflightCommands: config.preflightCommands,
    baselineTestCommand: config.baselineTestCommand,
    maxCostPerTaskUsd: config.maxCostPerTaskUsd,
    maxCostPerRunUsd: config.maxCostPerRunUsd,
    worktrees: config.worktrees,
    runBranch: config.runBranch,
    approval: config.approval,
    buildEngine: config.engine,
    buildProvider: config.provider,
    buildAccount: config.account,
    buildModelId: config.executionModelId,
    buildEffort: config.executionEffort,
    planRuntime: config.planningRuntime,
    taskReviewRuntime: config.validationRuntime,
    runReviewRuntime: config.reviewRuntime,
    review: config.review,
    keel: config.keel,
  };
}

export async function loadConfig(cwd: string): Promise<CloudyConfig> {
  // Load global defaults first, then layer project config on top
  const globalCfg = await loadGlobalConfig().catch(() => null);

  // Build effective defaults from global config (falls back to DEFAULT_CONFIG)
  const effectiveDefaults: CloudyConfig = globalCfg ? {
    ...DEFAULT_CONFIG,
    models: {
      planning: globalCfg.defaultModels.planning,
      execution: globalCfg.defaultModels.execution,
      validation: globalCfg.defaultModels.validation,
    },
    maxRetries: globalCfg.defaultMaxRetries,
    parallel: globalCfg.defaultParallel,
    maxParallel: globalCfg.defaultMaxParallel,
    worktrees: globalCfg.defaultWorktrees,
    maxCostPerTaskUsd: globalCfg.defaultMaxCostPerTaskUsd,
    maxCostPerRunUsd: globalCfg.defaultMaxCostPerRunUsd,
    dashboardPort: globalCfg.daemonPort,
    review: { ...DEFAULT_CONFIG.review, model: globalCfg.defaultModels.review },
  } : { ...DEFAULT_CONFIG };

  const filePath = configPath(cwd);
  const saved = await readJson<ExternalCloudyConfig>(filePath);
  if (!saved) return effectiveDefaults;

  const savedModels = saved.models ?? {};
  const config: CloudyConfig = {
    models: {
      ...effectiveDefaults.models,
      planning: savedModels.plan ?? effectiveDefaults.models.planning,
      execution: savedModels.build ?? effectiveDefaults.models.execution,
      validation: savedModels.taskReview ?? effectiveDefaults.models.validation,
      qualityReview: savedModels.qualityReview ?? effectiveDefaults.models.qualityReview,
    },
    validation: {
      ...effectiveDefaults.validation,
      ...saved.validation,
      commands: saved.validation?.commands ?? effectiveDefaults.validation.commands,
    },
    maxRetries: saved.maxRetries ?? effectiveDefaults.maxRetries,
    parallel: saved.parallel ?? effectiveDefaults.parallel,
    maxParallel: saved.maxParallel ?? effectiveDefaults.maxParallel,
    retryDelaySec: saved.retryDelaySec ?? effectiveDefaults.retryDelaySec,
    taskTimeoutMs: saved.taskTimeoutMs ?? effectiveDefaults.taskTimeoutMs,
    autoModelRouting: saved.autoModelRouting ?? effectiveDefaults.autoModelRouting,
    dashboard: saved.dashboard ?? effectiveDefaults.dashboard,
    dashboardPort: saved.dashboardPort ?? effectiveDefaults.dashboardPort,
    notifications: { ...effectiveDefaults.notifications, ...saved.notifications },
    contextBudgetTokens: saved.contextBudgetTokens ?? effectiveDefaults.contextBudgetTokens,
    contextBudgetMode: saved.contextBudgetMode ?? effectiveDefaults.contextBudgetMode,
    preflightCommands: saved.preflightCommands ?? effectiveDefaults.preflightCommands,
    maxCostPerTaskUsd: saved.maxCostPerTaskUsd ?? effectiveDefaults.maxCostPerTaskUsd,
    maxCostPerRunUsd: saved.maxCostPerRunUsd ?? effectiveDefaults.maxCostPerRunUsd,
    worktrees: saved.worktrees ?? effectiveDefaults.worktrees,
    runBranch: saved.runBranch ?? effectiveDefaults.runBranch,
    approval: { ...effectiveDefaults.approval, ...saved.approval },
<<<<<<< Updated upstream
    engine: saved.buildEngine ?? effectiveDefaults.engine,
    provider: saved.buildProvider ?? effectiveDefaults.provider,
    account: saved.buildAccount ?? effectiveDefaults.account,
    executionModelId: saved.buildModelId ?? effectiveDefaults.executionModelId,
    executionEffort: saved.buildEffort ?? effectiveDefaults.executionEffort,
    planningRuntime: { ...effectiveDefaults.planningRuntime, ...saved.planRuntime },
    validationRuntime: { ...effectiveDefaults.validationRuntime, ...saved.taskReviewRuntime },
    reviewRuntime: { ...effectiveDefaults.reviewRuntime, ...saved.runReviewRuntime },
    review: {
      ...effectiveDefaults.review,
      ...saved.review,
      model: savedModels.runReview ?? effectiveDefaults.review.model,
    },
    keel: saved.keel ?? effectiveDefaults.keel,
=======
    engine: saved.engine ?? effectiveDefaults.engine,
    provider: saved.provider ?? effectiveDefaults.provider,
    executionModelId: saved.executionModelId ?? effectiveDefaults.executionModelId,
    executionAccountId: saved.executionAccountId ?? effectiveDefaults.executionAccountId,
    planningRuntime: { ...effectiveDefaults.planningRuntime, ...saved.planningRuntime },
    validationRuntime: { ...effectiveDefaults.validationRuntime, ...saved.validationRuntime },
    reviewRuntime: { ...effectiveDefaults.reviewRuntime, ...saved.reviewRuntime },
    review: { ...effectiveDefaults.review, ...saved.review },
>>>>>>> Stashed changes
  };

  const errors = validateConfig(config);
  if (errors.length > 0) {
    process.stderr.write(`⚠️  cloudy config warnings (.cloudy/config.json):\n${errors.map((e) => `   · ${e}`).join('\n')}\n\n`);
  }

  return config;
}

export async function saveConfig(
  cwd: string,
  config: CloudyConfig,
): Promise<void> {
  await ensureDir(path.join(cwd, CLAWDASH_DIR));
  await writeJson(configPath(cwd), toExternalConfig(config));
}
