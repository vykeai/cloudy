// ── Model types ──────────────────────────────────────────────────────
export type ClaudeModel = 'opus' | 'sonnet' | 'haiku';
export type ThinkingEffort = 'low' | 'medium' | 'high' | 'max';

export type Engine =
  | 'claude-code'
  | 'codex'
  | 'pi-mono'
  | 'copilot'
  | 'gemini-cli'
  | 'qwen-code'
  | 'amazon-q'
  | 'opencode'
  | 'goose';

export type Provider =
  | 'claude'
  | 'codex'
  | 'anthropic'
  | 'openai'
  | 'github'
  | 'copilot'
  | 'google'
  | 'gemini'
  | 'qwen'
  | 'amazon-q'
  | 'ollama'
  | 'openrouter'
  | 'deepseek'
  | 'groq'
  | 'cerebras'
  | 'xai'
  | 'mistral'
  | 'minimax'
  | 'kimi'
  | 'azure'
  | 'bedrock'
  | 'vercel'
  | 'dashscope'
  | string;

export interface ModelConfig {
  planning: ClaudeModel;
  execution: ClaudeModel;
  validation: ClaudeModel;
  /** Model for Phase 2b code quality review. Defaults to `validation` if not set. */
  qualityReview?: ClaudeModel;
}

export interface PhaseRuntimeConfig {
  engine?: Engine;
  provider?: Provider;
  /**
   * Named account/credential route within the provider.
   *
   * Examples:
   * - `claude-main`
   * - `claude-backup`
   * - `dashscope-prod`
   */
  account?: string;
  modelId?: string;
<<<<<<< Updated upstream
  effort?: ThinkingEffort;
=======
  accountId?: string;
>>>>>>> Stashed changes
  configDir?: string;
}

export type TaskType =
  | 'implement'
  | 'verify'
  | 'review'
  | 'closeout';

export type TaskExecutionMode =
  | 'generic'
  | 'implement_ui_surface'
  | 'implement_api_endpoint'
  | 'implement_cli_command'
  | 'verify_proof'
  | 'closeout_keel'
  | 'refactor_bounded'
  | 'write_or_stop';

export type TaskFailureType =
  | 'implementation_failure'
  | 'acceptance_failure'
  | 'timeout'
  | 'executor_nonperformance'
  | 'already_satisfied'
  | 'environment_failure'
  | 'validation_problem'
  | 'out_of_scope_drift'
  | 'task_spec_problem';

// ── Task types ───────────────────────────────────────────────────────
export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'completed_without_changes'
  | 'failed'
  | 'skipped'
  | 'rolled_back';

export interface RetryHistoryEntry {
  attempt: number;
  timestamp: string;
  failureType: TaskFailureType;
  reason: string;
  fullError: string;
  durationMs: number;
}

export interface TaskExecutionMetrics {
  timeToFirstWriteMs?: number;
  discoveryOpsBeforeFirstWrite: number;
  subagentCalls: number;
  writeCount: number;
  verificationOps: number;
  executionMode: TaskExecutionMode;
  riskLevel?: 'low' | 'medium' | 'high';
  riskReasons?: string[];
}

export interface TaskValidationOverrides {
  commands?: string[];
  iosBuildCommand?: string;
  androidBuildCommand?: string;
  skipAutoPlatformBuild?: boolean;
}

export interface AcceptanceCriterionResult {
  criterion: string;
  passed: boolean;
  explanation: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  type?: TaskType;
  executionMode?: TaskExecutionMode;
  acceptanceCriteria: string[];
  proofRequirements?: string[];
  nonGoals?: string[];
  surfaceScope?: string[];
  collisionRisks?: string[];
  definitionOfDone?: string[];
  dependencies: string[]; // task IDs this task depends on
  contextPatterns: string[]; // file globs relevant to this task
  status: TaskStatus;
  retries: number;
  maxRetries: number;
  ifFailed: 'skip' | 'halt';
  timeout: number; // ms
  checkpointSha?: string;
  costData?: TaskCostData;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  resultSummary?: string;
  retryHistory?: RetryHistoryEntry[];
  acceptanceCriteriaResults?: AcceptanceCriterionResult[];
  outputArtifacts?: string[]; // file paths that must exist after completion
  allowedWritePaths?: string[]; // relative glob-like prefixes or explicit paths that writes must stay within
  validationOverrides?: TaskValidationOverrides;
  implementationSteps?: string[]; // planner-generated numbered steps (e.g. TDD red-green-refactor)
  parentTaskId?: string;     // set when this task was dynamically created by another task
  requiresApproval?: boolean; // per-task override: require human approval before running
  sessionId?: string;        // SDK session ID from last execution — used for resume on retry
  filesWritten?: string[];   // auto-tracked via SDK PostToolUse hooks
  implementationCandidateReady?: boolean; // true when code looks ready but validation config/environment blocked closure
  implementationCandidateReason?: string;
  executionMetrics?: TaskExecutionMetrics;
  failureClass?: TaskFailureType;
}

// ── Plan types ───────────────────────────────────────────────────────
export interface PipelineContext {
  pipelineId: string;
  phaseIndex: number;    // 1-based
  totalPhases: number;
  phaseLabel: string;
}

export interface DecisionLogEntry {
  questionId: string;
  question: string;
  /** 'human' if the user typed an answer within the timeout; 'agent' if haiku assumed */
  answeredBy: 'human' | 'agent';
  answer: string;
  /** One-sentence reasoning — only present when answeredBy === 'agent' */
  reasoning?: string;
  timestamp: string;
}

export interface Plan {
  goal: string;
  tasks: Task[];
  createdAt: string;
  updatedAt: string;
  /** Raw prompt to execute after all tasks finish (from ## Wrap-up section in spec). */
  wrapUpPrompt?: string;
  /** Set by pipeline command — carries phase structure for TUI/dashboard display. */
  pipelineContext?: PipelineContext;
  /** Decisions made during planning Q&A (injected into executor context). */
  decisionLog?: DecisionLogEntry[];
  /** One-paragraph rationale: approach chosen, alternatives rejected, key assumptions. */
  rationale?: string;
}

// ── Validation types ─────────────────────────────────────────────────
export type ValidationStrategyName =
  | 'typecheck'
  | 'lint'
  | 'build'
  | 'test'
  | 'ai-review'
  | 'ai-review-quality'
  | 'command'
  | 'artifacts';

export interface ValidationResult {
  strategy: ValidationStrategyName;
  passed: boolean;
  output: string;
  durationMs: number;
}

export interface ValidationReport {
  taskId: string;
  passed: boolean;
  results: ValidationResult[];
  alreadySatisfied?: boolean;
}

// ── Cost types ───────────────────────────────────────────────────────
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TaskCostData {
  model: string;
  engine: Engine;
  phase: 'planning' | 'execution' | 'validation';
  usage: TokenUsage;
  estimatedUsd: number;
}

export interface CostSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalEstimatedUsd: number;
  byPhase: Record<string, number>;
  byModel: Record<string, number>;
}

// ── Approval config types ────────────────────────────────────────────
export interface ApprovalConfig {
  mode: 'never' | 'always' | 'on-failure';
  timeoutSec: number;
  autoAction: 'continue' | 'halt';
}

// ── Config types ─────────────────────────────────────────────────────
export interface ValidationConfig {
  typecheck: boolean;
  lint: boolean;
  build: boolean;
  test: boolean;
  aiReview: boolean;
  commands: string[]; // arbitrary shell commands that must exit 0
}

export interface NotificationsConfig {
  desktop: boolean;
  sound: boolean;
}

export interface ReviewConfig {
  enabled: boolean;        // default true
  model: ClaudeModel;      // default 'sonnet'
  failBlocksRun?: boolean; // exit 1 when verdict is FAIL
}

export interface CloudyConfig {
  models: ModelConfig;
  validation: ValidationConfig;
  maxRetries: number;
  parallel: boolean;
  maxParallel: number;
  retryDelaySec: number;
  taskTimeoutMs: number;
  autoModelRouting: boolean;
  dashboard: boolean;
  dashboardPort: number;
  notifications: NotificationsConfig;
  contextBudgetTokens: number;              // max tokens of context to load per task (0 = unlimited)
  contextBudgetMode: 'warn' | 'enforce';    // warn = skip over-budget files; enforce = throw
  preflightCommands: string[];              // shell commands that must exit 0 before first task
  baselineTestCommand?: string;            // command to capture pre-run test baseline (optional)
  maxCostPerTaskUsd: number;   // abort task if cumulative cost exceeds this (0 = unlimited)
  maxCostPerRunUsd: number;    // abort entire run if cumulative cost exceeds this (0 = unlimited)
  worktrees: boolean;          // use git worktrees for parallel task isolation
  runBranch: boolean;          // create a dedicated cloudy/run-* branch before executing tasks
  strictBatch?: boolean;       // deterministic batch mode: stop on terminal failures and avoid creative recovery
  approval: ApprovalConfig;
  engine: Engine;              // execution engine for task implementation
  provider?: Provider;         // provider/auth route (e.g. claude, codex, openai)
  account?: string;           // named account route within the provider/runtime
  executionModelId?: string;   // provider-native execution model ID (e.g. o3, codex-mini)
<<<<<<< Updated upstream
  executionEffort?: ThinkingEffort; // execution thinking budget (CLI --effort overrides)
=======
  executionAccountId?: string; // provider account/profile ID from omnai estate (e.g. claude-main)
>>>>>>> Stashed changes
  planningRuntime?: PhaseRuntimeConfig;   // provider/engine route for planning calls
  validationRuntime?: PhaseRuntimeConfig; // provider/engine route for per-task AI validation
  reviewRuntime?: PhaseRuntimeConfig;     // provider/engine route for holistic review and review-side prompts
  review: ReviewConfig;        // post-run holistic review configuration
  keel?: {
    slug: string;
    taskId?: string;
    port?: number;     // default 7842
  };
}

// ── State types ──────────────────────────────────────────────────────
export interface ProjectState {
  version: number;
  plan: Plan | null;
  config: CloudyConfig;
  costSummary: CostSummary;
  /**
   * Task IDs that were actually selected for this invocation after applying
   * filters like --only-task / --start-from / retry. Holistic review should
   * not re-run tasks outside this active execution slice.
   */
  activeTaskIds?: string[];
  startedAt?: string;
  completedAt?: string;
  /** Name of the run directory (e.g. 2026-03-08-1430-implement-ai-chain). */
  runName?: string;
}

// ── Claude CLI types ─────────────────────────────────────────────────
export interface ClaudeStreamMessage {
  type: string;
  subtype?: string;
  content?: string;
  message?: string;
  // cost_info fields from stream-json
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  // result message fields
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
}

export interface ClaudeRunResult {
  success: boolean;
  output: string;
  error?: string;
  usage: TokenUsage;
  durationMs: number;
  costUsd: number;
  sessionId?: string;      // SDK session ID — pass as resumeSessionId on retry
  filesWritten?: string[]; // files tracked via SDK PostToolUse hooks
}

// ── Review types ─────────────────────────────────────────────────────
export interface ReviewResult {
  verdict: 'PASS' | 'PASS_WITH_NOTES' | 'FAIL';
  summary: string;
  criteriaResults: Array<{ criterion: string; passed: boolean; note: string }>;
  issues: Array<{ severity: 'critical' | 'major' | 'minor'; description: string; location?: string }>;
  conventionViolations: string[];
  suggestions: string[];
  /** Task IDs that should be re-run (skipped, failed, or missing implementation) */
  rerunTaskIds: string[];
  specCoverageScore?: number;
  costUsd: number;
  durationMs: number;
  model: string;
}

// ── Event types (for UI) ─────────────────────────────────────────────
export type OrchestratorEvent =
  | { type: 'plan_created'; plan: Plan }
  | { type: 'task_started'; taskId: string; title: string; attempt: number; maxAttempts: number; contextFileCount: number; engine?: Engine; model?: string }
  | { type: 'task_output'; taskId: string; text: string }
  | { type: 'task_tool_call'; taskId: string; toolName: string; toolInput: unknown }
  | { type: 'task_tool_result'; taskId: string; toolName: string; content: string; isError: boolean }
  | { type: 'task_completed'; taskId: string; title: string; durationMs: number; resultSummary?: string }
  | { type: 'task_failed'; taskId: string; title: string; error: string; attempt: number; maxAttempts: number; willRetry: boolean }
  | { type: 'task_retrying'; taskId: string; title: string; delaySec: number; attempt: number }
  | { type: 'validation_started'; taskId: string }
  | { type: 'validation_result'; taskId: string; report: ValidationReport; criteriaResults?: AcceptanceCriterionResult[] }
  | { type: 'cost_update'; summary: CostSummary }
  | { type: 'progress'; completed: number; total: number; percentage: number }
  | { type: 'run_completed'; summary: CostSummary }
  | { type: 'run_failed'; error: string }
  | { type: 'run_status'; status: 'idle' | 'running' | 'completed' | 'failed' | 'stopped' }
  | { type: 'subtasks_created'; parentTaskId: string; count: number; ids: string[] }
  | { type: 'approval_requested'; taskId: string; title: string; stage: 'pre_task' | 'failure_escalation'; context?: string; timeoutSec: number }
  | { type: 'approval_resolved'; taskId: string; action: string; autoTriggered: boolean }
  | { type: 'review_started'; model: string }
  | { type: 'review_output'; text: string }
  | { type: 'review_completed'; result: ReviewResult }
  | { type: 'review_failed'; error: string }
  | { type: 'review_model_requested' }
  | { type: 'rerun_started'; taskIds: string[] };

export type OrchestratorEventHandler = (event: OrchestratorEvent) => void;

// ── Dashboard command types ─────────────────────────────────────────
export type DashboardCommand =
  | { type: 'start_run' }
  | { type: 'stop_run' }
  | { type: 'approval_response'; taskId: string; action: 'approved' | 'skipped' | 'halt' | 'retry_with_hint'; hint?: string };

// ── Global config types ──────────────────────────────────────────────
export interface GlobalConfig {
  defaultModels: {
    planning: ClaudeModel;
    execution: ClaudeModel;
    validation: ClaudeModel;
    review: ClaudeModel;
  };
  defaultMaxRetries: number;
  defaultParallel: boolean;
  defaultMaxParallel: number;
  defaultWorktrees: boolean;
  defaultMaxCostPerTaskUsd: number;
  defaultMaxCostPerRunUsd: number;
  daemonPort: number;
  scanPaths: string[];
  autoRegister: boolean;
  planningQuestionTimeoutSec: number;
}

export interface ProjectMeta {
  id: string;         // project slug, e.g. 'demo-project'
  name: string;       // display name, e.g. 'The Only Suite'
  path: string;       // absolute path to project root
  registeredAt: string; // ISO timestamp
}

export interface ProjectStatusSnapshot {
  id: string;
  name: string;
  path: string;
  status: 'idle' | 'planning' | 'running' | 'completed' | 'failed';
  lastRunAt: string | null;
  activePlan: boolean;
  taskProgress: { done: number; total: number } | null;
  costUsd: number | null;
  activeProcess: 'init' | 'run' | 'chain' | null;
  processes?: Array<{
    id: string;
    type: 'init' | 'run' | 'chain';
    specName?: string;
    startedAt: string;
  }>;
}

export interface SpecFile {
  path: string;
  relativePath: string;
  title: string;
  headings: string[];
  sizeBytes: number;
}
