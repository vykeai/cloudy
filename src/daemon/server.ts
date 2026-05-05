import http from 'node:http';
import { registerTool, discoverTools as fedDiscoverTools, type Peer } from '@vykeai/fed';
import { selectViaDaemon, type EngineId as OmnaiEngineId, type Provider as OmnaiProvider } from 'omnai';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Dirent } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import type { ProjectMeta, ProjectStatusSnapshot, SpecFile } from '../core/types.js';
import { listProjects, addProject, removeProject, findProject } from './registry.js';
import { detectSpecFiles, scanClaudeCodeSessions, loadClaudeCodeMessages, computeSessionStats } from './scanner.js';
import { CLAWDASH_DIR, RUNS_DIR } from '../config/defaults.js';
import { loadConfig } from '../config/config.js';
import { readJson, ensureDir, writeJson } from '../utils/fs.js';
import { applyKeelTaskRuntime, loadKeelTaskRuntime } from '../integrations/keel-task-runtime.js';

// ── Fed event client (lazy — cloudy works fine without fed) ──────────

const FED_URL = 'http://localhost:7840';
function fedPublish(type: string, data: Record<string, unknown>): void {
  fetch(`${FED_URL}/fed/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, source: 'cloudy', data }),
  }).catch(() => {});
}

// ── Stuck task cleanup ────────────────────────────────────────────────

/**
 * When a child process exits unexpectedly, any tasks left as `in_progress`
 * are stuck forever. This function reads the current state.json and marks
 * them as `failed`, then returns the count so callers can broadcast an SSE.
 */
function runGit(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function runExecFile(cmd: string, args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
      resolve({ exitCode: err ? 1 : 0, stdout, stderr });
    });
  });
}

async function cleanupStuckTasks(projectPath: string): Promise<number> {
  try {
    const currentFile = path.join(projectPath, CLAWDASH_DIR, 'current');
    const currentRun = await fs.readFile(currentFile, 'utf-8').then((s) => s.trim()).catch(() => '');
    const stateFile = currentRun
      ? path.join(projectPath, CLAWDASH_DIR, RUNS_DIR, currentRun, 'state.json')
      : path.join(projectPath, CLAWDASH_DIR, 'state.json');
    const state = await readJson<{ plan?: { tasks?: Array<{ id: string; status: string; error?: string }> } }>(stateFile);
    const tasks = state?.plan?.tasks ?? [];
    const stuck = tasks.filter((t) => t.status === 'in_progress');
    if (stuck.length === 0) return 0;
    for (const t of stuck) {
      t.status = 'failed';
      t.error = 'Process ended unexpectedly during execution';
    }
    await writeJson(stateFile, state);
    return stuck.length;
  } catch {
    return 0;
  }
}

// ── CC session resume tracker ─────────────────────────────────────────
// Tracks active web-initiated claude --resume processes so we can detect
// when the CLI takes over the same session file.
interface CcResumeEntry {
  child: ChildProcess;
  projectId: string;
  jsonlPath: string;
  watchTimer: ReturnType<typeof setInterval>;
  cleanupTimer: ReturnType<typeof setTimeout>;
  sizeAtExit: number;
  exited: boolean;
}
const ccResumeSessions = new Map<string, CcResumeEntry>(); // keyed by bare ccSessionId

function getCcJsonlPath(projectPath: string, ccSessionId: string): string {
  const encoded = projectPath.replace(/\//g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded, `${ccSessionId}.jsonl`);
}

function stopCcWatcher(ccSessionId: string) {
  const entry = ccResumeSessions.get(ccSessionId);
  if (!entry) return;
  clearInterval(entry.watchTimer);
  clearTimeout(entry.cleanupTimer);
  ccResumeSessions.delete(ccSessionId);
}

const PLANS_DIR_NAME = 'plans';

// ── SavedPlan type ────────────────────────────────────────────────────

interface SavedPlan {
  id: string;
  name: string;
  goal: string;
  tasks: Array<{ id: string; title: string; status: string; description?: string }>;
  specPaths: string[];
  status: 'ready' | 'running' | 'completed' | 'failed';
  createdAt: string;
  taskCount: number;
  completedCount: number;
  deliveredAt?: string;   // ISO timestamp when the run completed successfully
  specSha?: string;       // Short SHA-256 of the first spec file (8 hex chars)
}

function makePlanningState(runName?: string): {
  runName?: string;
  status: 'planning';
  plan: { tasks: [] };
  costSummary: { totalEstimatedUsd: number };
} {
  return {
    ...(runName ? { runName } : {}),
    status: 'planning',
    plan: { tasks: [] },
    costSummary: { totalEstimatedUsd: 0 },
  };
}

// ── Plan persistence helpers ──────────────────────────────────────────

async function updatePlanStatus(
  projectPath: string,
  planId: string,
  status: SavedPlan['status'],
  deliveredAt?: string,
): Promise<void> {
  try {
    const planFile = path.join(getPlansDir(projectPath), `${planId}.json`);
    const plan = await readJson<SavedPlan>(planFile);
    if (!plan) return;
    plan.status = status;
    if (deliveredAt) plan.deliveredAt = deliveredAt;
    await writeJson(planFile, plan);
  } catch { /* ignore */ }
}

function getPlansDir(projectPath: string): string {
  return path.join(projectPath, CLAWDASH_DIR, PLANS_DIR_NAME);
}

async function savePlanFromState(projectPath: string, planName: string, specPaths: string[]): Promise<SavedPlan | null> {
  try {
    // Read the current run name to find the correct state.json
    // (the root .cloudy/state.json is from a previous run and would be stale)
    const currentFile = path.join(projectPath, CLAWDASH_DIR, 'current');
    const currentRun = await fs.readFile(currentFile, 'utf-8').then((s) => s.trim()).catch(() => '');
    const stateFile = currentRun
      ? path.join(projectPath, CLAWDASH_DIR, RUNS_DIR, currentRun, 'state.json')
      : path.join(projectPath, CLAWDASH_DIR, 'state.json');
    const state = await readJson<{ plan?: { goal?: string; tasks?: Array<{ id: string; title: string; status: string; description?: string }> } }>(stateFile);
    if (!state?.plan) return null;

    const id = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const tasks = state.plan.tasks ?? [];
    const plan: SavedPlan = {
      id,
      name: planName || state.plan.goal || 'Unnamed Plan',
      goal: state.plan.goal ?? '',
      tasks,
      specPaths,
      status: 'ready',
      createdAt: new Date().toISOString(),
      taskCount: tasks.length,
      completedCount: tasks.filter((t) => t.status === 'completed').length,
    };

    // Compute short SHA of first spec file
    let specSha: string | undefined;
    if (specPaths[0]) {
      try {
        const content = await fs.readFile(specPaths[0], 'utf-8');
        specSha = crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
      } catch { /* ignore */ }
    }
    if (specSha) plan.specSha = specSha;

    await ensureDir(getPlansDir(projectPath));
    await writeJson(path.join(getPlansDir(projectPath), `${id}.json`), plan);
    return plan;
  } catch {
    return null;
  }
}

async function loadAllPlans(projectPath: string): Promise<SavedPlan[]> {
  const dir = getPlansDir(projectPath);
  try {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
    const plans = await Promise.all(
      files.map((f) => readJson<SavedPlan>(path.join(dir, f)).catch(() => null))
    );
    return (plans.filter(Boolean) as SavedPlan[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

// ── Chat session types ────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: string;
}

interface ChatSession {
  id: string;
  projectId: string;
  name: string;
  model: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  streamingContent: string; // in-progress assistant message
}

// ── Chat disk persistence ─────────────────────────────────────────────

const CHATS_DIR = 'chats';
const CC_PREFIX = 'cc:';
const CC_NAMES_DIR = 'cc-names';

async function getCCName(projectPath: string, sessionId: string): Promise<string | null> {
  try {
    const f = path.join(projectPath, CLAWDASH_DIR, CC_NAMES_DIR, `${sessionId}.txt`);
    return (await fs.readFile(f, 'utf-8')).trim() || null;
  } catch { return null; }
}

async function setCCName(projectPath: string, sessionId: string, name: string): Promise<void> {
  const dir = path.join(projectPath, CLAWDASH_DIR, CC_NAMES_DIR);
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, `${sessionId}.txt`), name, 'utf-8');
}

function getChatsDir(projectPath: string): string {
  return path.join(projectPath, CLAWDASH_DIR, CHATS_DIR);
}

function getChatFile(projectPath: string, sessionId: string): string {
  return path.join(getChatsDir(projectPath), `${sessionId}.json`);
}

async function loadChatSession(projectPath: string, sessionId: string): Promise<ChatSession | null> {
  return readJson<ChatSession>(getChatFile(projectPath, sessionId));
}

async function saveChatSession(projectPath: string, session: ChatSession): Promise<void> {
  await ensureDir(getChatsDir(projectPath));
  const { streamingContent: _, ...toSave } = session; // don't persist streaming state
  await writeJson(getChatFile(projectPath, session.id), { ...toSave, streamingContent: '' });
}

async function listChatSessions(projectPath: string): Promise<ChatSession[]> {
  try {
    const dir = getChatsDir(projectPath);
    const entries = await fs.readdir(dir);
    const sessions: ChatSession[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const session = await readJson<ChatSession>(path.join(dir, entry));
      if (session?.id) sessions.push({ ...session, streamingContent: '' });
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

async function deleteChatSession(projectPath: string, sessionId: string): Promise<void> {
  try {
    await fs.unlink(getChatFile(projectPath, sessionId));
  } catch { /* already gone */ }
}

// ── SSE client tracking ──────────────────────────────────────────────

interface SseClient {
  res: http.ServerResponse;
  id: string;
}

let sseClients: SseClient[] = [];

function sendSse(client: SseClient, data: unknown): void {
  try {
    client.res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Client disconnected
  }
}

function broadcastSse(data: unknown): void {
  for (const client of sseClients) {
    sendSse(client, data);
  }
}

// ── Active child processes (per project) ────────────────────────────

interface ActiveProcess {
  id: string;          // unique processId (UUID-like)
  type: 'init' | 'run' | 'chain';
  child: ChildProcess;
  projectId: string;
  planIds?: string[];
  specName?: string;   // short name from spec path for display
  startedAt: string;   // ISO timestamp
}

const activeProcesses = new Map<string, ActiveProcess>(); // key: process.id (not projectId)

function getProjectProcesses(projectId: string): ActiveProcess[] {
  return [...activeProcesses.values()].filter((p) => p.projectId === projectId);
}

function getRunningProcess(projectId: string, type?: ActiveProcess['type']): ActiveProcess | undefined {
  return getProjectProcesses(projectId).find((p) => !type || p.type === type);
}

interface RuntimeRouteFields {
<<<<<<< Updated upstream
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
}

interface RunRuntimeRouteFields extends RuntimeRouteFields {
  buildEngine?: string;
  buildProvider?: string;
  buildAccount?: string;
  buildModelId?: string;
  buildEffort?: string;
  keelSlug?: string;
  keelTask?: string;
=======
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
}

interface RunRuntimeRouteFields extends RuntimeRouteFields {
  engine?: string;
  provider?: string;
  executionModelId?: string;
  executionAccountId?: string;
>>>>>>> Stashed changes
}

interface RuntimePreflight {
  engine?: string;
  provider?: string;
  account?: string;
  taskType: 'coding' | 'planning' | 'review';
}

interface RuntimeDefaults {
<<<<<<< Updated upstream
  build?: Pick<RunRuntimeRouteFields, 'buildEngine' | 'buildProvider' | 'buildAccount' | 'buildModelId' | 'buildEffort'>;
  plan?: Pick<RuntimeRouteFields, 'planEngine' | 'planProvider' | 'planAccount' | 'planModelId' | 'planEffort'>;
  taskReview?: Pick<RuntimeRouteFields, 'taskReviewEngine' | 'taskReviewProvider' | 'taskReviewAccount' | 'taskReviewModelId' | 'taskReviewEffort'>;
  runReview?: Pick<RuntimeRouteFields, 'runReviewEngine' | 'runReviewProvider' | 'runReviewAccount' | 'runReviewModelId' | 'runReviewEffort'>;
  models?: {
    planModel?: string;
    buildModel?: string;
    taskReviewModel?: string;
    runReviewModel?: string;
    qualityReviewModel?: string;
  };
=======
  execution?: Pick<RunRuntimeRouteFields, 'engine' | 'provider' | 'executionAccountId'>;
  planning?: Pick<RuntimeRouteFields, 'planningEngine' | 'planningProvider' | 'planningAccountId'>;
  validation?: Pick<RuntimeRouteFields, 'validationEngine' | 'validationProvider' | 'validationAccountId'>;
  review?: Pick<RuntimeRouteFields, 'reviewEngine' | 'reviewProvider' | 'reviewAccountId'>;
>>>>>>> Stashed changes
}

function appendOptionalFlag(args: string[], flag: string, value: string | undefined): void {
  if (value) args.push(flag, value);
}

function buildPlanRuntimeArgs(runtime: RuntimeRouteFields): string[] {
  const args: string[] = [];
<<<<<<< Updated upstream
  appendOptionalFlag(args, '--plan-engine', runtime.planEngine);
  appendOptionalFlag(args, '--plan-provider', runtime.planProvider);
  appendOptionalFlag(args, '--plan-account', runtime.planAccount);
  appendOptionalFlag(args, '--plan-model-id', runtime.planModelId);
  appendOptionalFlag(args, '--plan-effort', runtime.planEffort);
=======
  appendOptionalFlag(args, '--planning-engine', runtime.planningEngine);
  appendOptionalFlag(args, '--planning-provider', runtime.planningProvider);
  appendOptionalFlag(args, '--planning-model-id', runtime.planningModelId);
  appendOptionalFlag(args, '--planning-account-id', runtime.planningAccountId);
>>>>>>> Stashed changes
  return args;
}

function buildTaskReviewRuntimeArgs(runtime: RuntimeRouteFields): string[] {
  const args: string[] = [];
<<<<<<< Updated upstream
  appendOptionalFlag(args, '--task-review-engine', runtime.taskReviewEngine);
  appendOptionalFlag(args, '--task-review-provider', runtime.taskReviewProvider);
  appendOptionalFlag(args, '--task-review-account', runtime.taskReviewAccount);
  appendOptionalFlag(args, '--task-review-model-id', runtime.taskReviewModelId);
  appendOptionalFlag(args, '--task-review-effort', runtime.taskReviewEffort);
=======
  appendOptionalFlag(args, '--validation-engine', runtime.validationEngine);
  appendOptionalFlag(args, '--validation-provider', runtime.validationProvider);
  appendOptionalFlag(args, '--validation-model-id', runtime.validationModelId);
  appendOptionalFlag(args, '--validation-account-id', runtime.validationAccountId);
>>>>>>> Stashed changes
  return args;
}

function buildRunReviewRuntimeArgs(runtime: RuntimeRouteFields): string[] {
  const args: string[] = [];
<<<<<<< Updated upstream
  appendOptionalFlag(args, '--run-review-engine', runtime.runReviewEngine);
  appendOptionalFlag(args, '--run-review-provider', runtime.runReviewProvider);
  appendOptionalFlag(args, '--run-review-account', runtime.runReviewAccount);
  appendOptionalFlag(args, '--run-review-model-id', runtime.runReviewModelId);
  appendOptionalFlag(args, '--run-review-effort', runtime.runReviewEffort);
=======
  appendOptionalFlag(args, '--review-engine', runtime.reviewEngine);
  appendOptionalFlag(args, '--review-provider', runtime.reviewProvider);
  appendOptionalFlag(args, '--review-model-id', runtime.reviewModelId);
  appendOptionalFlag(args, '--review-account-id', runtime.reviewAccountId);
>>>>>>> Stashed changes
  return args;
}

function buildRunRuntimeArgs(runtime: RunRuntimeRouteFields): string[] {
  const args: string[] = [];
<<<<<<< Updated upstream
  appendOptionalFlag(args, '--build-engine', runtime.buildEngine);
  appendOptionalFlag(args, '--build-provider', runtime.buildProvider);
  appendOptionalFlag(args, '--build-account', runtime.buildAccount);
  appendOptionalFlag(args, '--build-model-id', runtime.buildModelId);
  appendOptionalFlag(args, '--build-effort', runtime.buildEffort);
  appendOptionalFlag(args, '--keel-slug', runtime.keelSlug);
  appendOptionalFlag(args, '--keel-task', runtime.keelTask);
=======
  appendOptionalFlag(args, '--engine', runtime.engine);
  appendOptionalFlag(args, '--provider', runtime.provider);
  appendOptionalFlag(args, '--execution-model-id', runtime.executionModelId);
  appendOptionalFlag(args, '--execution-account-id', runtime.executionAccountId);
>>>>>>> Stashed changes
  args.push(
    ...buildPlanRuntimeArgs(runtime),
    ...buildTaskReviewRuntimeArgs(runtime),
    ...buildRunReviewRuntimeArgs(runtime),
  );
  return args;
}

async function preflightRuntime(runtime: RuntimePreflight): Promise<void> {
  if (!runtime.engine && !runtime.provider) return;
  await selectViaDaemon({
    engine: runtime.engine as OmnaiEngineId | undefined,
    provider: runtime.provider as OmnaiProvider | undefined,
    account: runtime.account,
    taskType: runtime.taskType,
  });
}

function resolveRuntimePreflight(
  taskType: RuntimePreflight['taskType'],
  override: { engine?: string; provider?: string; account?: string },
  fallback?: { engine?: string; provider?: string; account?: string },
): RuntimePreflight {
  return {
    engine: override.engine ?? fallback?.engine,
    provider: override.provider ?? fallback?.provider,
    account: override.account ?? fallback?.account,
    taskType,
  };
}

async function loadRuntimeDefaults(projectPath: string, keelTaskId?: string): Promise<RuntimeDefaults> {
  const baseConfig = await loadConfig(projectPath);
  const keelTaskRuntime = await loadKeelTaskRuntime(projectPath, keelTaskId ?? baseConfig.keel?.taskId);
  const config = applyKeelTaskRuntime(baseConfig, keelTaskRuntime);
  const models = config.models ?? {
    planning: 'sonnet',
    execution: 'sonnet',
    validation: 'haiku',
  };
  const review = config.review ?? {
    enabled: true,
    model: 'sonnet',
    failBlocksRun: false,
  };
  return {
<<<<<<< Updated upstream
    build: {
      buildEngine: config.engine,
      buildProvider: config.provider,
      buildAccount: config.account,
      buildModelId: config.executionModelId,
      buildEffort: config.executionEffort,
    },
    plan: {
      planEngine: config.planningRuntime?.engine,
      planProvider: config.planningRuntime?.provider,
      planAccount: config.planningRuntime?.account,
      planModelId: config.planningRuntime?.modelId,
      planEffort: config.planningRuntime?.effort,
    },
    taskReview: {
      taskReviewEngine: config.validationRuntime?.engine,
      taskReviewProvider: config.validationRuntime?.provider,
      taskReviewAccount: config.validationRuntime?.account,
      taskReviewModelId: config.validationRuntime?.modelId,
      taskReviewEffort: config.validationRuntime?.effort,
    },
    runReview: {
      runReviewEngine: config.reviewRuntime?.engine,
      runReviewProvider: config.reviewRuntime?.provider,
      runReviewAccount: config.reviewRuntime?.account,
      runReviewModelId: config.reviewRuntime?.modelId,
      runReviewEffort: config.reviewRuntime?.effort,
    },
    models: {
      planModel: models.planning,
      buildModel: models.execution,
      taskReviewModel: models.validation,
      runReviewModel: review.model,
      qualityReviewModel: models.qualityReview,
=======
    execution: {
      engine: config.engine,
      provider: config.provider,
      executionAccountId: config.executionAccountId,
    },
    planning: {
      planningEngine: config.planningRuntime?.engine,
      planningProvider: config.planningRuntime?.provider,
      planningAccountId: config.planningRuntime?.accountId,
    },
    validation: {
      validationEngine: config.validationRuntime?.engine,
      validationProvider: config.validationRuntime?.provider,
      validationAccountId: config.validationRuntime?.accountId,
    },
    review: {
      reviewEngine: config.reviewRuntime?.engine,
      reviewProvider: config.reviewRuntime?.provider,
      reviewAccountId: config.reviewRuntime?.accountId,
>>>>>>> Stashed changes
    },
  };
}

// ── Per-project output ring buffer (for replay on reconnect) ─────────

const projectOutputBuffer = new Map<string, string[]>();
const OUTPUT_BUFFER_MAX = 200;

// ── Active streaming sessions (in-memory only, not persisted) ────────

const activeChatStreams = new Map<string, ChatSession>(); // sessionId → live session during streaming

// ── Project status snapshots ─────────────────────────────────────────

async function getProjectStatus(meta: ProjectMeta): Promise<ProjectStatusSnapshot> {
  const cloudyDir = path.join(meta.path, CLAWDASH_DIR);

  let status: ProjectStatusSnapshot['status'] = 'idle';
  let lastRunAt: string | null = null;
  let activePlan = false;
  let taskProgress: { done: number; total: number } | null = null;
  let costUsd: number | null = null;

  try {
    type StateShape = { plan?: { tasks?: Array<{ status: string }> }; completedAt?: string; costSummary?: { totalEstimatedUsd?: number } };

    // Prefer current run's state.json over root state.json — root is stale after pipeline runs
    const currentFile = path.join(cloudyDir, 'current');
    let currentRunDir: string | null = null;
    try {
      const currentRun = (await fs.readFile(currentFile, 'utf-8')).trim();
      currentRunDir = path.join(cloudyDir, RUNS_DIR, currentRun);
    } catch { /* no current pointer */ }

    // If current run dir exists but has no state.json yet → still planning
    if (currentRunDir) {
      const runStateFile = path.join(currentRunDir, 'state.json');
      const hasRunState = await fs.access(runStateFile).then(() => true).catch(() => false);
      if (!hasRunState) {
        status = 'planning';
      } else {
        // Use the current run's state.json as the authoritative source
        const state = await readJson<StateShape>(runStateFile);
        if (state?.plan) {
          activePlan = true;
          const tasks = state.plan.tasks ?? [];
          const done = tasks.filter((t) => t.status === 'completed' || t.status === 'skipped').length;
          const total = tasks.length;
          if (total > 0) taskProgress = { done, total };
          if (state.costSummary?.totalEstimatedUsd) costUsd = state.costSummary.totalEstimatedUsd;
          const inProgress = tasks.some((t) => t.status === 'in_progress');
          if (inProgress) {
            status = 'running';
          } else if (state.completedAt) {
            status = tasks.some((t) => t.status === 'failed') ? 'failed' : 'completed';
            lastRunAt = state.completedAt;
          }
        }
      }

      // Heartbeat status.json overrides task-derived status
      const runStatus = await readJson<{ timestamp?: string; completedTasks?: number; totalTasks?: number; costUsd?: number }>(path.join(currentRunDir, 'status.json'));
      if (runStatus) {
        if (runStatus.completedTasks !== undefined && runStatus.totalTasks !== undefined) {
          taskProgress = { done: runStatus.completedTasks, total: runStatus.totalTasks };
        }
        if (runStatus.costUsd) costUsd = runStatus.costUsd;
        if (runStatus.timestamp) lastRunAt = runStatus.timestamp;
        if (status === 'planning') status = 'running';
      }
    } else {
      // No active run — fall back to root state.json for last known status
      const stateFile = path.join(cloudyDir, 'state.json');
      const state = await readJson<StateShape>(stateFile);
      if (state?.plan) {
        activePlan = true;
        const tasks = state.plan.tasks ?? [];
        const done = tasks.filter((t) => t.status === 'completed' || t.status === 'skipped').length;
        const total = tasks.length;
        if (total > 0) taskProgress = { done, total };
        if (state.costSummary?.totalEstimatedUsd) costUsd = state.costSummary.totalEstimatedUsd;
        const inProgress = tasks.some((t) => t.status === 'in_progress');
        if (inProgress) {
          status = 'running';
        } else if (state.completedAt) {
          status = tasks.some((t) => t.status === 'failed') ? 'failed' : 'completed';
          lastRunAt = state.completedAt;
        }
      }
    }
  } catch { /* no state yet */ }

  const procs = getProjectProcesses(meta.id);
  const anyProc = procs[0];

  return {
    id: meta.id,
    name: meta.name,
    path: meta.path,
    status: anyProc ? 'running' : status,
    lastRunAt,
    activePlan,
    taskProgress,
    costUsd,
    activeProcess: anyProc?.type ?? null, // legacy compat: first process type
    processes: procs.map((p) => ({
      id: p.id,
      type: p.type,
      specName: p.specName,
      startedAt: p.startedAt,
    })),
  };
}

// ── Request body parsing ──────────────────────────────────────────────

function parseBody(req: http.IncomingMessage, maxBytes = 1_048_576 /* 1 MB */): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cl = req.headers['content-length'];
    if (cl && parseInt(cl, 10) > maxBytes) {
      req.resume(); // drain so socket stays reusable
      reject(new Error('Request body too large'));
      return;
    }
    let body = '';
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) { req.destroy(); reject(new Error('Request body too large')); return; }
      body += chunk.toString();
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(payload);
}

function send404(res: http.ServerResponse): void {
  sendJson(res, 404, { error: 'Not found' });
}

// ── Dashboard HTML ────────────────────────────────────────────────────

function getDashboardHtml(bundlePath: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>☁️ Cloudy Dashboard ☁️</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0d1117; color: #e6edf3; font-family: 'SF Mono', 'Cascadia Code', monospace; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="${bundlePath}"></script>
</body>
</html>`;
}

// ── Spawn child process ───────────────────────────────────────────────

function spawnCloudyProcess(
  projectId: string,
  projectPath: string,
  type: 'init' | 'run' | 'chain',
  args: string[],
  planName?: string,
  specPaths?: string[],
): ActiveProcess {
  const cloudyBin = process.argv[1]; // path to cloudy.js
  const child = spawn(process.execPath, [cloudyBin, ...args], {
    cwd: projectPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const processId = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const specName = specPaths?.[0]
    ? path.basename(specPaths[0], path.extname(specPaths[0]))
    : undefined;
  const proc: ActiveProcess = { id: processId, type, child, projectId, specName, startedAt: new Date().toISOString() };
  activeProcesses.set(processId, proc);

  const sseOutputType = type === 'init' ? 'plan_output' : 'run_output_daemon';

  // Line-buffer to avoid splitting mid-JSON-line
  function pushToBuffer(line: string) {
    const buf = projectOutputBuffer.get(projectId) ?? [];
    buf.push(line);
    if (buf.length > OUTPUT_BUFFER_MAX) buf.shift();
    projectOutputBuffer.set(projectId, buf);
  }

  // Strip ANSI codes and drop pure spinner/progress lines before broadcast
  // eslint-disable-next-line no-control-regex
  const _ansiRe = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;
  function isSpinnerLine(raw: string): boolean {
    const s = raw.replace(_ansiRe, '').trim();
    if (!s || s.length <= 2) return true;
    // "Planning with sonnet… (287s)..◎" — per-second progress ticker (any variant)
    if (/^Planning with \S+/.test(s)) return true;
    // "[project] Claude" / "[project]|" / "[project]□[?25l" — terminal UI chrome
    if (/^\[[\w-]+\]/.test(s)) return true;
    // clack interactive prompt chrome — "◆ What would you like to do?"
    if (/^[◆◇]\s/.test(s)) return true;
    // clack option rows — "● ✅ Approve" / "○ ✍ Revise" / "○ ✗ Cancel"
    if (/^[●○◉◎•]\s/.test(s)) return true;
    // clack box drawing — "└", "│" alone or with whitespace
    if (/^[└│┌┐┘├┤┬┴┼─]\s*$/.test(s)) return true;
    // lone spinner chars
    if (/^[.◎○◉oO|\\\/\-]+$/.test(s)) return true;
    return false;
  }

  let stdoutBuf = '';
  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        // Structured question marker from cloudy scope — broadcast as plan_question SSE, not output
        if (line.includes('CLOUDY_PLAN_QUESTION:')) {
          const jsonStr = line.slice(line.indexOf('CLOUDY_PLAN_QUESTION:') + 'CLOUDY_PLAN_QUESTION:'.length).trim();
          try {
            const q = JSON.parse(jsonStr);
            broadcastSse({ type: 'plan_question', projectId, processId, ...q });
          } catch { /* malformed — ignore */ }
          continue;
        }
        // Task validation marker — emit fed event
        if (line.includes('CLOUDY_TASK_VALIDATED:')) {
          const jsonStr = line.slice(line.indexOf('CLOUDY_TASK_VALIDATED:') + 'CLOUDY_TASK_VALIDATED:'.length).trim();
          try {
            const v = JSON.parse(jsonStr) as { taskId: string; title: string };
            fedPublish('cloudy.task.validated', { runId: processId, project: projectId, taskId: v.taskId, title: v.title });
          } catch { /* malformed — ignore */ }
          continue;
        }
        // Structured log marker — broadcast as plan_progress SSE (init only)
        if (line.includes('CLOUDY_LOG:') && type === 'init') {
          const jsonStr = line.slice(line.indexOf('CLOUDY_LOG:') + 'CLOUDY_LOG:'.length).trim();
          try {
            const entry = JSON.parse(jsonStr) as { level: string; msg: string };
            broadcastSse({ type: 'plan_progress', projectId, processId, level: entry.level, msg: entry.msg });
          } catch { /* malformed — ignore */ }
          continue;
        }
        if (!isSpinnerLine(line)) {
          broadcastSse({ type: sseOutputType, projectId, processId, line });
          pushToBuffer(line);
        }
      }
    });
  }

  let stderrBuf = '';
  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() && !isSpinnerLine(line)) {
          broadcastSse({ type: sseOutputType, projectId, processId, line });
          pushToBuffer(line);
        }
      }
    });
  }

  child.on('exit', (code) => {
    activeProcesses.delete(processId);
    // Only delete output buffer if no other processes remain for this project
    if (getProjectProcesses(projectId).length === 0) {
      projectOutputBuffer.delete(projectId);
    }
    if (type === 'init') {
      broadcastSse({ type: code === 0 ? 'plan_completed' : 'plan_failed', projectId, processId, code });
      if (code === 0 && planName) {
        savePlanFromState(projectPath, planName, specPaths ?? []).then((plan) => {
          if (plan) broadcastSse({ type: 'plan_saved', projectId, processId, plan });
        });
      }
    } else {
      // For run/pipeline: clean up any in_progress tasks left dangling by a crash
      cleanupStuckTasks(projectPath).then((stuckCount) => {
        broadcastSse({ type: code === 0 ? 'run_completed_daemon' : 'run_failed_daemon', projectId, processId, code });
        fedPublish(code === 0 ? 'cloudy.run.completed' : 'cloudy.run.failed', { runId: processId, project: projectId, exitCode: code });
        if (stuckCount > 0) {
          broadcastSse({ type: 'tasks_stuck', projectId, processId, count: stuckCount });
        }
        // Update plan statuses for queued planIds
        if (proc.planIds?.length) {
          const newStatus = code === 0 ? 'completed' : 'failed';
          const deliveredAt = code === 0 ? new Date().toISOString() : undefined;
          for (const planId of proc.planIds) {
            updatePlanStatus(projectPath, planId, newStatus, deliveredAt).catch(() => {});
          }
        }
      });
    }
  });

  return proc;
}

// ── Chat execution ────────────────────────────────────────────────────

async function streamChatMessage(
  projectPath: string,
  sessionId: string,
  userMessage: string,
  opts: { effort?: string; maxBudgetUsd?: number; skipPermissions?: boolean } = {},
): Promise<void> {
  // Load session from disk
  let session = await loadChatSession(projectPath, sessionId);
  if (!session) {
    // Create a default session if not found
    session = {
      id: sessionId,
      projectId: '',
      name: userMessage.slice(0, 40),
      model: 'sonnet',
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      streamingContent: '',
    };
  }

  // Add user message to history
  session.messages.push({ role: 'user', content: userMessage, ts: new Date().toISOString() });
  session.streamingContent = '';
  session.updatedAt = new Date().toISOString();

  // Keep in active streams map
  activeChatStreams.set(sessionId, session);

  // Build context prefix (embedded in prompt, not --system-prompt flag to avoid arg issues)
  let contextPrefix = '';
  try {
    const claudeMd = await fs.readFile(`${projectPath}/CLAUDE.md`, 'utf-8');
    contextPrefix = `<context>\nProject: ${projectPath}\n${claudeMd.slice(0, 1500)}\n</context>\n\n`;
  } catch { /* no CLAUDE.md */ }

  // Build conversation history as a single prompt
  const historyText = session.messages
    .slice(0, -1) // exclude the message we just added
    .map(m => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
    .join('\n\n');

  const fullPrompt = contextPrefix + (historyText
    ? `${historyText}\n\nHuman: ${userMessage}`
    : userMessage);

  // Spawn claude --print with the conversation
  const { findClaudeBinary } = await import('../utils/claude-path.js');
  const { resolveModelId, isValidModel } = await import('../config/model-config.js');

  let claudeBin: string;
  try {
    claudeBin = await findClaudeBinary();
  } catch {
    const errMsg = 'Claude binary not found';
    broadcastSse({ type: 'chat_error', sessionId: session.id, error: errMsg });
    activeChatStreams.delete(sessionId);
    return;
  }

  const modelKey = isValidModel(session.model) ? session.model : 'sonnet';
  const modelId = resolveModelId(modelKey);

  const args = [
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--model', modelId,
  ];
  // Default to skip permissions in dashboard chat (trusted local env). Can be toggled off per-message.
  if (opts.skipPermissions !== false) args.push('--dangerously-skip-permissions');
  if (opts.effort && ['low', 'medium', 'high', 'max'].includes(opts.effort)) {
    args.push('--effort', opts.effort);
  }
  if (opts.maxBudgetUsd && opts.maxBudgetUsd > 0) {
    args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  }
  args.push(fullPrompt);

  const { CLAUDECODE: _cc, CLAUDE_CODE_ENTRYPOINT: _cce, ...chatEnv } = process.env;
  const child = spawn(claudeBin, args, {
    cwd: projectPath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: chatEnv,
  });

  // Capture stderr for error reporting
  let stderrOutput = '';
  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => { stderrOutput += chunk.toString().slice(0, 500); });
  }

  let assistantContent = '';
  let chatStdoutBuf = '';

  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => {
      chatStdoutBuf += chunk.toString();
      const lines = chatStdoutBuf.split('\n');
      chatStdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'assistant' && msg.message?.content) {
            // Extract token usage from this assistant turn
            const usage = msg.message.usage as Record<string, number> | undefined;
            if (usage) {
              const model = (msg.message.model as string | undefined) ?? null;
              const m = (model ?? '').toLowerCase();
              const p = m.includes('opus') ? { input: 15/1e6, cacheWrite: 18.75/1e6, cacheRead: 1.5/1e6, output: 75/1e6 }
                      : m.includes('haiku') ? { input: 0.8/1e6, cacheWrite: 1/1e6, cacheRead: 0.08/1e6, output: 4/1e6 }
                      : { input: 3/1e6, cacheWrite: 3.75/1e6, cacheRead: 0.30/1e6, output: 15/1e6 };
              const inp = usage.input_tokens ?? 0;
              const out = usage.output_tokens ?? 0;
              const cw = usage.cache_creation_input_tokens ?? 0;
              const cr = usage.cache_read_input_tokens ?? 0;
              broadcastSse({
                type: 'chat_stats',
                sessionId: session!.id,
                costUsd: inp * p.input + out * p.output + cw * p.cacheWrite + cr * p.cacheRead,
                durationMs: 0,
                inputTokens: inp,
                outputTokens: out,
                cacheReadTokens: cr,
                cacheWriteTokens: cw,
                model,
              });
            }
            for (const block of msg.message.content) {
              if (block.type === 'text') {
                const newText = block.text.slice(assistantContent.length);
                assistantContent = block.text;
                session!.streamingContent = assistantContent;
                if (newText) {
                  broadcastSse({ type: 'chat_token', sessionId: session!.id, token: newText });
                }
              } else if (block.type === 'tool_use') {
                broadcastSse({ type: 'chat_tool_call', sessionId: session!.id, toolName: block.name, toolInput: block.input ?? {} });
              }
            }
          } else if (msg.type === 'tool_result') {
            const content = Array.isArray(msg.content)
              ? msg.content.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('')
              : (msg.content ?? '');
            if (content) broadcastSse({ type: 'chat_tool_result', sessionId: session!.id, content: String(content).slice(0, 300), isError: !!msg.is_error });
          } else if (msg.type === 'result') {
            // Broadcast usage stats to the dashboard
            broadcastSse({
              type: 'chat_stats',
              sessionId: session!.id,
              costUsd: msg.cost_usd ?? 0,
              durationMs: msg.duration_ms ?? 0,
              inputTokens: msg.input_tokens ?? 0,
              outputTokens: msg.output_tokens ?? 0,
              cacheReadTokens: msg.cache_read_tokens ?? 0,
              cacheWriteTokens: msg.cache_write_tokens ?? 0,
            });
            // Fallback: capture result field if no assistant messages were streamed
            if (msg.result && !assistantContent) {
              assistantContent = msg.result;
              broadcastSse({ type: 'chat_token', sessionId: session!.id, token: assistantContent });
            }
          }
        } catch { /* not JSON — ignore */ }
      }
    });
  }

  await new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
  });

  // Commit final assistant message
  if (assistantContent) {
    session.messages.push({ role: 'assistant', content: assistantContent, ts: new Date().toISOString() });
  } else {
    const errDetail = stderrOutput ? ` (${stderrOutput.trim().slice(0, 200)})` : '';
    session.messages.push({ role: 'assistant', content: `(no response${errDetail})`, ts: new Date().toISOString() });
  }
  session.streamingContent = '';
  session.updatedAt = new Date().toISOString();

  // Save to disk
  await saveChatSession(projectPath, session);

  // Remove from active streams
  activeChatStreams.delete(sessionId);

  broadcastSse({ type: 'chat_done', sessionId: session.id, message: session.messages[session.messages.length - 1] });
}

// ── Chat streaming for CC sessions (resume) ──────────────────────────

async function streamChatMessageResume(
  projectPath: string,
  ccSessionId: string,  // bare UUID, no cc: prefix
  userMessage: string,
  projectId: string,
): Promise<void> {
  const { findClaudeBinary } = await import('../utils/claude-path.js');
  let claudeBin: string;
  try {
    claudeBin = await findClaudeBinary();
  } catch {
    broadcastSse({ type: 'chat_error', sessionId: `${CC_PREFIX}${ccSessionId}`, error: 'Claude binary not found' });
    return;
  }

  const compositeId = `${CC_PREFIX}${ccSessionId}`;
  const jsonlPath = getCcJsonlPath(projectPath, ccSessionId);

  const args = [
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--resume', ccSessionId,
    userMessage,
  ];

  const { CLAUDECODE: _cc2, CLAUDE_CODE_ENTRYPOINT: _cce2, ...resumeEnv } = process.env;
  const child = spawn(claudeBin, args, {
    cwd: projectPath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: resumeEnv,
  });

  let assistantContent = '';
  let sizeAtExit = 0;
  let exited = false;
  let resumeStdoutBuf = '';

  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => {
      resumeStdoutBuf += chunk.toString();
      const lines = resumeStdoutBuf.split('\n');
      resumeStdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'assistant' && msg.message?.content) {
            const usage = msg.message.usage as Record<string, number> | undefined;
            if (usage) {
              const model = (msg.message.model as string | undefined) ?? null;
              const m = (model ?? '').toLowerCase();
              const p = m.includes('opus') ? { input: 15/1e6, cacheWrite: 18.75/1e6, cacheRead: 1.5/1e6, output: 75/1e6 }
                      : m.includes('haiku') ? { input: 0.8/1e6, cacheWrite: 1/1e6, cacheRead: 0.08/1e6, output: 4/1e6 }
                      : { input: 3/1e6, cacheWrite: 3.75/1e6, cacheRead: 0.30/1e6, output: 15/1e6 };
              const inp = usage.input_tokens ?? 0;
              const out = usage.output_tokens ?? 0;
              const cw = usage.cache_creation_input_tokens ?? 0;
              const cr = usage.cache_read_input_tokens ?? 0;
              broadcastSse({
                type: 'chat_stats', sessionId: compositeId,
                costUsd: inp * p.input + out * p.output + cw * p.cacheWrite + cr * p.cacheRead,
                durationMs: 0, inputTokens: inp, outputTokens: out,
                cacheReadTokens: cr, cacheWriteTokens: cw, model,
              });
            }
            for (const block of msg.message.content) {
              if (block.type === 'text') {
                const newText = block.text.slice(assistantContent.length);
                assistantContent = block.text;
                if (newText) {
                  broadcastSse({ type: 'chat_token', sessionId: compositeId, token: newText });
                }
              }
            }
          }
        } catch { /* skip */ }
      }
    });
  }

  child.on('exit', async () => {
    exited = true;
    try { sizeAtExit = (await fs.stat(jsonlPath)).size; } catch { sizeAtExit = 0; }
  });

  // Watch the JSONL file: if it grows AFTER our child exits, the CLI took over → re-lock
  const watchTimer = setInterval(async () => {
    if (!exited) return; // child still running — all writes are ours
    try {
      const stat = await fs.stat(jsonlPath);
      if (stat.size > sizeAtExit) {
        // External write detected — CLI has resumed this session
        stopCcWatcher(ccSessionId);
        broadcastSse({ type: 'cc_session_locked', sessionId: compositeId, projectId });
      }
    } catch { /* file gone — ignore */ }
  }, 1000);

  // Auto-clean watcher after 60s max (user unlikely to resume that far after)
  const cleanupTimer = setTimeout(() => stopCcWatcher(ccSessionId), 60_000);

  ccResumeSessions.set(ccSessionId, { child, projectId, jsonlPath, watchTimer, cleanupTimer, sizeAtExit, exited });

  await new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
  });

  const finalMessage = { role: 'assistant' as const, content: assistantContent || '(no response)', ts: new Date().toISOString() };
  broadcastSse({ type: 'chat_done', sessionId: compositeId, message: finalMessage });
}

// ── Identity / daemon config ──────────────────────────────────────────

const DAEMON_CONFIG_FILE = path.join(os.homedir(), '.cloudy', 'daemon.json');

interface DaemonConfig {
  identity?: string;
}

async function readDaemonConfig(): Promise<DaemonConfig> {
  try {
    const raw = await fs.readFile(DAEMON_CONFIG_FILE, 'utf8');
    return JSON.parse(raw) as DaemonConfig;
  } catch {
    return {};
  }
}

async function writeDaemonConfig(config: DaemonConfig): Promise<void> {
  await fs.mkdir(path.dirname(DAEMON_CONFIG_FILE), { recursive: true });
  await fs.writeFile(DAEMON_CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

const FED_CONFIG_FILE = path.join(os.homedir(), '.fed', 'config.json');

interface FedConfig { identity?: string | null; tools?: Record<string, { dash: number; fed: number }> }

async function readFedConfig(): Promise<FedConfig | null> {
  try {
    return JSON.parse(await fs.readFile(FED_CONFIG_FILE, 'utf8')) as FedConfig;
  } catch {
    return null;
  }
}

// ── Federation peer registry ──────────────────────────────────────────

const peers = new Map<string, Peer>(); // keyed by machine hostname

// ── HTTP request handler ──────────────────────────────────────────────

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, bundleDir: string): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost`);
  const pathname = url.pathname;
  const method = req.method ?? 'GET';

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // ── Static assets ────────────────────────────────────────────────
  if (pathname === '/bundle.js') {
    try {
      const bundleFile = path.join(bundleDir, 'bundle.js');
      const content = await fs.readFile(bundleFile);
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(content);
      return;
    } catch {
      send404(res);
      return;
    }
  }

  // ── SSE live stream ──────────────────────────────────────────────
  if (pathname === '/api/live' && method === 'GET') {
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':\n\n'); // keep-alive comment

    const client: SseClient = { res, id: clientId };
    sseClients.push(client);

    req.on('close', () => {
      sseClients = sseClients.filter((c) => c !== client);
    });

    // Send initial snapshot
    const projects = await listProjects().catch(() => [] as ProjectMeta[]);
    const snapshots = await Promise.all(projects.map(getProjectStatus));
    sendSse(client, { type: 'project_status', projects: snapshots });

    // Replay buffered output lines for any active process
    for (const [pid, lines] of projectOutputBuffer) {
      const proc = getProjectProcesses(pid)[0]; // get first process for this project
      const outputType = proc?.type === 'init' ? 'plan_output' : 'run_output_daemon';
      for (const line of lines) {
        sendSse(client, { type: outputType, projectId: pid, line });
      }
    }
    return;
  }

  // ── Projects list ────────────────────────────────────────────────
  if (pathname === '/api/projects' && method === 'GET') {
    const projects = await listProjects().catch(() => [] as ProjectMeta[]);
    const snapshots = await Promise.all(projects.map(getProjectStatus));
    sendJson(res, 200, snapshots);
    return;
  }

  // ── Register project ────────────────────────────────────────────
  if (pathname === '/api/projects/register' && method === 'POST') {
    try {
      const body = await parseBody(req) as Partial<ProjectMeta>;
      if (!body.id || !body.name || !body.path) {
        sendJson(res, 400, { error: 'id, name, and path are required' });
        return;
      }
      await addProject({
        id: body.id,
        name: body.name,
        path: body.path,
        registeredAt: new Date().toISOString(),
      });
      sendJson(res, 200, { ok: true });
      broadcastSse({ type: 'project_registered', projectId: body.id });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return;
  }

  // ── Project-specific routes ──────────────────────────────────────
  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
  if (projectMatch) {
    const projectId = projectMatch[1];
    const subpath = projectMatch[2] ?? '';

    // DELETE /api/projects/:id
    if (method === 'DELETE' && subpath === '') {
      await removeProject(projectId).catch(() => {});
      sendJson(res, 200, { ok: true });
      broadcastSse({ type: 'project_removed', projectId });
      return;
    }

    const meta = await findProject(projectId).catch(() => undefined);
    if (!meta && subpath !== '') {
      send404(res);
      return;
    }

    // GET /api/projects/:id
    if (method === 'GET' && subpath === '') {
      if (!meta) { send404(res); return; }
      const snapshot = await getProjectStatus(meta);
      sendJson(res, 200, snapshot);
      return;
    }

    // GET /api/projects/:id/specs
    if (method === 'GET' && subpath === '/specs') {
      if (!meta) { send404(res); return; }
      const specs = await detectSpecFiles(meta.path).catch(() => [] as SpecFile[]);
      sendJson(res, 200, specs);
      return;
    }

    // GET /api/projects/:id/state
    if (method === 'GET' && subpath === '/state') {
      if (!meta) { send404(res); return; }
      try {
        const currentRun = await fs.readFile(path.join(meta.path, CLAWDASH_DIR, 'current'), 'utf-8').then((s) => s.trim()).catch(() => '');
        const stateFile = currentRun
          ? path.join(meta.path, CLAWDASH_DIR, RUNS_DIR, currentRun, 'state.json')
          : path.join(meta.path, CLAWDASH_DIR, 'state.json');
        const state = await readJson(stateFile) ?? (currentRun ? makePlanningState(currentRun) : {});
        sendJson(res, 200, state ?? {});
      } catch {
        sendJson(res, 200, {});
      }
      return;
    }

    // GET /api/projects/:id/config
    if (method === 'GET' && subpath === '/config') {
      if (!meta) { send404(res); return; }
      try {
        const config = await loadConfig(meta.path);
        const runtime = await loadRuntimeDefaults(meta.path);
        sendJson(res, 200, {
          buildEngine: runtime.build?.buildEngine,
          buildProvider: runtime.build?.buildProvider,
          buildModelId: runtime.build?.buildModelId,
          buildEffort: runtime.build?.buildEffort,
          planRuntime: runtime.plan,
          taskReviewRuntime: runtime.taskReview,
          runReviewRuntime: runtime.runReview,
          keel: config.keel,
        });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /api/projects/:id/runs
    if (method === 'GET' && subpath === '/runs') {
      if (!meta) { send404(res); return; }
      try {
        const runsDir = path.join(meta.path, CLAWDASH_DIR, RUNS_DIR);
        const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => [] as Dirent[]);
        const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
        // Sort by embedded date (YYYY-MM-DD-HHMM) if present, otherwise by mtime desc
        const withMtime = await Promise.all(dirs.map(async (name) => {
          const m = name.match(/(\d{4}-\d{2}-\d{2}-\d{4})/);
          const dateKey = m ? m[1] : null;
          if (dateKey) return { name, key: dateKey };
          try {
            const s = await fs.stat(path.join(runsDir, name));
            return { name, key: s.mtimeMs.toString().padStart(20, '0') };
          } catch {
            return { name, key: '0' };
          }
        }));
        const runNames = withMtime
          .sort((a, b) => b.key.localeCompare(a.key))
          .map((x) => x.name)
          .slice(0, 50);
        sendJson(res, 200, runNames);
      } catch {
        sendJson(res, 200, []);
      }
      return;
    }

    // GET /api/projects/:id/run-log/:runName
    if (method === 'GET' && subpath.startsWith('/run-log/')) {
      if (!meta) { send404(res); return; }
      const runName = decodeURIComponent(subpath.slice('/run-log/'.length));
      const runDir = path.join(meta.path, CLAWDASH_DIR, RUNS_DIR, runName);
      // Try: logs/cloudy.log → synthesize from state.json → 404
      const logFile = path.join(runDir, 'logs', 'cloudy.log');
      const stateFile = path.join(runDir, 'state.json');
      try {
        const content = await fs.readFile(logFile, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(content.slice(-8000));
      } catch {
        try {
          const raw = await fs.readFile(stateFile, 'utf-8');
          const state = JSON.parse(raw) as { plan?: { tasks?: Array<{ id: string; title: string; status: string }> }; costSummary?: { totalEstimatedUsd?: number }; completedAt?: string };
          const tasks = state.plan?.tasks ?? [];
          const lines: string[] = [`Run: ${runName}`];
          if (state.completedAt) lines.push(`Completed: ${new Date(state.completedAt).toLocaleString()}`);
          if (state.costSummary?.totalEstimatedUsd) lines.push(`Cost: $${state.costSummary.totalEstimatedUsd.toFixed(4)}`);
          lines.push('');
          for (const t of tasks) {
            const icon = t.status === 'completed' ? '✓' : t.status === 'failed' ? '✗' : t.status === 'in_progress' ? '●' : '○';
            lines.push(`${icon} [${t.id}] ${t.title}  (${t.status})`);
          }
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(lines.join('\n'));
        } catch {
          res.writeHead(404);
          res.end('Log not found');
        }
      }
      return;
    }

    // GET /api/projects/:id/run-state/:runName — structured state for history cards
    if (method === 'GET' && subpath.startsWith('/run-state/')) {
      if (!meta) { send404(res); return; }
      const runName = decodeURIComponent(subpath.slice('/run-state/'.length));
      const stateFile = path.join(meta.path, CLAWDASH_DIR, RUNS_DIR, runName, 'state.json');
      try {
        const raw = await fs.readFile(stateFile, 'utf-8');
        sendJson(res, 200, JSON.parse(raw));
      } catch {
        const specFile = path.join(meta.path, CLAWDASH_DIR, RUNS_DIR, runName, 'spec.md');
        const hasSpec = await fs.access(specFile).then(() => true).catch(() => false);
        if (hasSpec) {
          sendJson(res, 200, makePlanningState(runName));
        } else {
          send404(res);
        }
      }
      return;
    }

    // GET /api/projects/:id/memory  (CLAUDE.md + .claude/MEMORY.md etc)
    if (method === 'GET' && subpath === '/memory') {
      if (!meta) { send404(res); return; }
      const candidates = [
        path.join(meta.path, 'CLAUDE.md'),
        path.join(meta.path, '.claude', 'MEMORY.md'),
        path.join(meta.path, '.claude', 'memory', 'MEMORY.md'),
      ];
      const files: Array<{ path: string; content: string }> = [];
      for (const f of candidates) {
        try {
          const content = await fs.readFile(f, 'utf-8');
          files.push({ path: f.replace(meta.path + '/', ''), content });
        } catch { /* file doesn't exist — skip */ }
      }
      const combined = files.map((r) => `# ${r.path}\n\n${r.content}`).join('\n\n---\n\n');
      sendJson(res, 200, { files, content: combined });
      return;
    }

    // GET /api/projects/:id/plans
    if (method === 'GET' && subpath === '/plans') {
      if (!meta) { send404(res); return; }
      const plans = await loadAllPlans(meta.path);
      sendJson(res, 200, plans);
      return;
    }

    // DELETE /api/projects/:id/plans/:planId
    if (method === 'DELETE' && subpath.startsWith('/plans/')) {
      if (!meta) { send404(res); return; }
      const planId = subpath.slice('/plans/'.length);
      const planFile = path.join(getPlansDir(meta.path), `${planId}.json`);
      try {
        await fs.unlink(planFile);
        sendJson(res, 200, { ok: true });
      } catch {
        sendJson(res, 404, { error: 'Plan not found' });
      }
      return;
    }

    // POST /api/projects/:id/plan
    if (method === 'POST' && subpath === '/plan') {
      if (!meta) { send404(res); return; }
      // No guard — allow parallel plan sessions
      try {
        const body = await parseBody(req) as {
          specPaths?: string[];
          planName?: string;
          planModel?: string;
          planIds?: string[];
<<<<<<< Updated upstream
          planEngine?: string;
          planProvider?: string;
          planAccount?: string;
          planModelId?: string;
          planEffort?: string;
          keelTask?: string;
=======
          planningEngine?: string;
          planningProvider?: string;
          planningModelId?: string;
          planningAccountId?: string;
>>>>>>> Stashed changes
        };
        const runtimeDefaults = await loadRuntimeDefaults(meta.path, body.keelTask);
        try {
          await preflightRuntime(resolveRuntimePreflight(
            'planning',
            {
<<<<<<< Updated upstream
              engine: body.planEngine,
              provider: body.planProvider,
              account: body.planAccount,
            },
            {
              engine: runtimeDefaults.plan?.planEngine,
              provider: runtimeDefaults.plan?.planProvider,
              account: runtimeDefaults.plan?.planAccount,
=======
              engine: body.planningEngine,
              provider: body.planningProvider,
              account: body.planningAccountId,
            },
            {
              engine: runtimeDefaults.planning?.planningEngine,
              provider: runtimeDefaults.planning?.planningProvider,
              account: runtimeDefaults.planning?.planningAccountId,
>>>>>>> Stashed changes
            },
          ));
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          return;
        }

        // Fast-fail: check spec sizes before spawning anything
        const MAX_FILE_BYTES = 30_000;
        const MAX_COMBINED_BYTES = 50_000;
        const specPaths = body.specPaths ?? [];
        let combinedBytes = 0;
        for (const sp of specPaths) {
          let stat: { size: number } | null = null;
          try { stat = await fs.stat(sp); } catch { /* file not found — let init handle it */ }
          if (stat && stat.size > MAX_FILE_BYTES) {
            sendJson(res, 422, {
              error: `Spec file "${path.basename(sp)}" is ${Math.round(stat.size / 1024)}KB — exceeds the ${Math.round(MAX_FILE_BYTES / 1024)}KB limit.`,
              hint: 'Good specs are focused: one feature, 2–10KB. Large files like TASKS.md are reference docs — not specs. Write a dedicated spec for the feature you want to build.',
            });
            return;
          }
          combinedBytes += stat?.size ?? 0;
        }
        if (combinedBytes > MAX_COMBINED_BYTES) {
          sendJson(res, 422, {
            error: `Combined specs are ${Math.round(combinedBytes / 1024)}KB — exceeds the ${Math.round(MAX_COMBINED_BYTES / 1024)}KB combined limit.`,
            hint: 'Plan one feature at a time. Split your work into separate spec files and run cloudy init once per feature.',
          });
          return;
        }

        const specArgs: string[] = [];
        for (const sp of specPaths) specArgs.push('--spec', sp);
        const modelArg = body.planModel ? ['--plan-model', body.planModel] : ['--plan-model', 'sonnet'];
        const runtimeArgs = buildPlanRuntimeArgs(body);
        // Generate a stable run-name so scope exits immediately after saving the plan
        // (--run-name triggers pipeline-mode exit, preventing scope from auto-spawning cloudy run)
        const ts = new Date().toISOString().slice(0, 16).replace('T', '-').replace(/:/g, '');
        const slug = specPaths[0]
          ? path.basename(specPaths[0], '.md').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 24)
          : 'plan';
        const runName = `scope-${ts}-${slug}`;
        const proc = spawnCloudyProcess(projectId, meta.path, 'init', [
          'plan', ...specArgs, ...modelArg, ...runtimeArgs, '--run-name', runName,
        ], body.planName, specPaths);
        if (body.planIds?.length) proc.planIds = body.planIds;
        sendJson(res, 200, { ok: true, started: true, processId: proc.id });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/projects/:id/plan-input
    if (method === 'POST' && subpath === '/plan-input') {
      try {
        const body = await parseBody(req) as { answer?: string; action?: string; feedback?: string; processId?: string };
        // Route to the specific process if processId provided, else fall back to first init proc
        const proc = body.processId
          ? [...activeProcesses.values()].find((p) => p.id === body.processId && p.projectId === projectId)
          : getRunningProcess(projectId, 'init');
        if (!proc || !proc.child.stdin) {
          sendJson(res, 404, { error: 'No active plan process' });
          return;
        }
        const line = (body.answer ?? body.action ?? '') + '\n';
        proc.child.stdin.write(line);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/projects/:id/run
    if (method === 'POST' && subpath === '/run') {
      if (!meta) { send404(res); return; }
      if (!!getRunningProcess(projectId, 'run')) {
        sendJson(res, 409, { error: 'A run is already in progress. Stop it first.' });
        return;
      }
      try {
        const body = await parseBody(req) as {
          buildModel?: string;
          taskReviewModel?: string;
          runReviewModel?: string;
          qualityReviewModel?: string;
          planIds?: string[];
          parallel?: boolean;
          maxParallel?: number;
          noValidate?: boolean;
          maxRetries?: number;
          buildEffort?: string;
          worktrees?: boolean;
<<<<<<< Updated upstream
          buildEngine?: string;
          buildProvider?: string;
          buildAccount?: string;
          buildModelId?: string;
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
          keelSlug?: string;
          keelTask?: string;
=======
          engine?: string;
          provider?: string;
          executionModelId?: string;
          executionAccountId?: string;
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
        };
        const runtimeDefaults = await loadRuntimeDefaults(meta.path, body.keelTask);
        try {
          await preflightRuntime(resolveRuntimePreflight(
            'coding',
            {
<<<<<<< Updated upstream
              engine: body.buildEngine,
              provider: body.buildProvider,
              account: body.buildAccount,
            },
            {
              engine: runtimeDefaults.build?.buildEngine,
              provider: runtimeDefaults.build?.buildProvider,
              account: runtimeDefaults.build?.buildAccount,
=======
              engine: body.engine,
              provider: body.provider,
              account: body.executionAccountId,
            },
            {
              engine: runtimeDefaults.execution?.engine,
              provider: runtimeDefaults.execution?.provider,
              account: runtimeDefaults.execution?.executionAccountId,
            },
          ));
          await preflightRuntime(resolveRuntimePreflight(
            'review',
            {
              engine: body.validationEngine,
              provider: body.validationProvider,
              account: body.validationAccountId,
            },
            {
              engine: runtimeDefaults.validation?.validationEngine,
              provider: runtimeDefaults.validation?.validationProvider,
              account: runtimeDefaults.validation?.validationAccountId,
>>>>>>> Stashed changes
            },
          ));
          await preflightRuntime(resolveRuntimePreflight(
            'review',
            {
<<<<<<< Updated upstream
              engine: body.taskReviewEngine,
              provider: body.taskReviewProvider,
              account: body.taskReviewAccount,
            },
            {
              engine: runtimeDefaults.taskReview?.taskReviewEngine,
              provider: runtimeDefaults.taskReview?.taskReviewProvider,
              account: runtimeDefaults.taskReview?.taskReviewAccount,
            },
          ));
          await preflightRuntime(resolveRuntimePreflight(
            'review',
            {
              engine: body.runReviewEngine,
              provider: body.runReviewProvider,
              account: body.runReviewAccount,
            },
            {
              engine: runtimeDefaults.runReview?.runReviewEngine,
              provider: runtimeDefaults.runReview?.runReviewProvider,
              account: runtimeDefaults.runReview?.runReviewAccount,
=======
              engine: body.reviewEngine,
              provider: body.reviewProvider,
              account: body.reviewAccountId,
            },
            {
              engine: runtimeDefaults.review?.reviewEngine,
              provider: runtimeDefaults.review?.reviewProvider,
              account: runtimeDefaults.review?.reviewAccountId,
>>>>>>> Stashed changes
            },
          ));
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          return;
        }
        const execModel = body.buildModel ?? runtimeDefaults.models?.buildModel ?? 'sonnet';
        const taskReviewModel = body.taskReviewModel ?? runtimeDefaults.models?.taskReviewModel ?? 'haiku';
        const runReviewModel = body.runReviewModel ?? runtimeDefaults.models?.runReviewModel ?? 'sonnet';

        const extraArgs = buildRunRuntimeArgs(body);
        if (body.parallel) { extraArgs.push('--parallel'); }
        if (body.maxParallel) { extraArgs.push('--max-parallel', String(body.maxParallel)); }
        if (body.noValidate) { extraArgs.push('--no-validate'); }
        if (body.maxRetries) { extraArgs.push('--max-retries', String(body.maxRetries)); }
        if (body.qualityReviewModel) { extraArgs.push('--quality-review-model', body.qualityReviewModel); }
        if (body.worktrees) { extraArgs.push('--worktrees'); }

        // planIds is used client-side to identify which plan was queued;
        // execution always goes through cloudy build using the current state.json

        const proc = spawnCloudyProcess(projectId, meta.path, 'run', [
          'run',
          '--non-interactive',
          '--agent-output',
          '--build-model', execModel,
          '--task-review-model', taskReviewModel,
          '--run-review-model', runReviewModel,
          '--heartbeat-interval', '5',
          ...extraArgs,
        ]);
        if (body.planIds?.length) proc.planIds = body.planIds;
        broadcastSse({ type: 'run_started', projectId });
        fedPublish('cloudy.run.started', { runId: proc.id, project: projectId });
        sendJson(res, 200, { ok: true, started: true });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/projects/:id/chain
    if (method === 'POST' && subpath === '/chain') {
      if (!meta) { send404(res); return; }
      if (!!getRunningProcess(projectId, 'chain')) {
        sendJson(res, 409, { error: 'A chain is already running. Stop it first.' });
        return;
      }
      try {
        const body = await parseBody(req) as {
          specPaths?: string[];
          buildModel?: string;
          planModel?: string;
          taskReviewModel?: string;
          runReviewModel?: string;
<<<<<<< Updated upstream
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
          keelSlug?: string;
          keelTask?: string;
=======
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
        };
        const runtimeDefaults = await loadRuntimeDefaults(meta.path, body.keelTask);
        try {
          await preflightRuntime(resolveRuntimePreflight(
            'planning',
            {
<<<<<<< Updated upstream
              engine: body.planEngine,
              provider: body.planProvider,
              account: body.planAccount,
            },
            {
              engine: runtimeDefaults.plan?.planEngine,
              provider: runtimeDefaults.plan?.planProvider,
              account: runtimeDefaults.plan?.planAccount,
=======
              engine: body.planningEngine,
              provider: body.planningProvider,
              account: body.planningAccountId,
            },
            {
              engine: runtimeDefaults.planning?.planningEngine,
              provider: runtimeDefaults.planning?.planningProvider,
              account: runtimeDefaults.planning?.planningAccountId,
>>>>>>> Stashed changes
            },
          ));
          await preflightRuntime(resolveRuntimePreflight(
            'review',
            {
<<<<<<< Updated upstream
              engine: body.taskReviewEngine,
              provider: body.taskReviewProvider,
              account: body.taskReviewAccount,
            },
            {
              engine: runtimeDefaults.taskReview?.taskReviewEngine,
              provider: runtimeDefaults.taskReview?.taskReviewProvider,
              account: runtimeDefaults.taskReview?.taskReviewAccount,
=======
              engine: body.validationEngine,
              provider: body.validationProvider,
              account: body.validationAccountId,
            },
            {
              engine: runtimeDefaults.validation?.validationEngine,
              provider: runtimeDefaults.validation?.validationProvider,
              account: runtimeDefaults.validation?.validationAccountId,
>>>>>>> Stashed changes
            },
          ));
          await preflightRuntime(resolveRuntimePreflight(
            'review',
            {
<<<<<<< Updated upstream
              engine: body.runReviewEngine,
              provider: body.runReviewProvider,
              account: body.runReviewAccount,
            },
            {
              engine: runtimeDefaults.runReview?.runReviewEngine,
              provider: runtimeDefaults.runReview?.runReviewProvider,
              account: runtimeDefaults.runReview?.runReviewAccount,
=======
              engine: body.reviewEngine,
              provider: body.reviewProvider,
              account: body.reviewAccountId,
            },
            {
              engine: runtimeDefaults.review?.reviewEngine,
              provider: runtimeDefaults.review?.reviewProvider,
              account: runtimeDefaults.review?.reviewAccountId,
>>>>>>> Stashed changes
            },
          ));
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          return;
        }
        const specArgs: string[] = [];
        for (const sp of body.specPaths ?? []) {
          specArgs.push('--spec', sp);
        }
        const runtimeArgs = [
          ...buildPlanRuntimeArgs(body),
          ...buildTaskReviewRuntimeArgs(body),
          ...buildRunReviewRuntimeArgs(body),
        ];
        const modelArgs: string[] = [
          '--build-model', body.buildModel ?? runtimeDefaults.models?.buildModel ?? 'sonnet',
          '--plan-model', body.planModel ?? runtimeDefaults.models?.planModel ?? 'sonnet',
          '--task-review-model', body.taskReviewModel ?? runtimeDefaults.models?.taskReviewModel ?? 'haiku',
          '--run-review-model', body.runReviewModel ?? runtimeDefaults.models?.runReviewModel ?? 'sonnet',
        ];
        const keelArgs = [
          ...(body.keelSlug ? ['--keel-slug', body.keelSlug] : []),
          ...(body.keelTask ? ['--keel-task', body.keelTask] : []),
        ];
        spawnCloudyProcess(projectId, meta.path, 'chain', [
          'chain', ...specArgs, ...modelArgs, ...runtimeArgs, ...keelArgs,
        ]);
        sendJson(res, 200, { ok: true, started: true });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/projects/:id/stop
    if (method === 'POST' && subpath === '/stop') {
      const procs = getProjectProcesses(projectId);
      if (procs.length === 0) {
        sendJson(res, 404, { error: 'No active process' });
        return;
      }
      for (const p of procs) p.child.kill('SIGTERM');
      sendJson(res, 200, { ok: true, stopped: procs.length });
      return;
    }

    // POST /api/projects/:id/finish
    if (method === 'POST' && subpath === '/finish') {
      if (!meta) { send404(res); return; }
      try {
        const body = await parseBody(req) as { action: 'merge' | 'push-pr' | 'keep' | 'discard' };
        const { action } = body;
        const cwd = meta.path;

        const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
        const currentBranch = branchResult.stdout.trim();

        if (action === 'keep') {
          sendJson(res, 200, { ok: true, message: `Branch ${currentBranch} kept.` });
          return;
        }

        let baseBranch = 'main';
        for (const candidate of ['main', 'master', 'develop']) {
          const check = await runGit(['rev-parse', '--verify', candidate], cwd);
          if (check.exitCode === 0) { baseBranch = candidate; break; }
        }

        if (action === 'merge') {
          const status = await runGit(['status', '--porcelain'], cwd);
          if (status.stdout.trim()) {
            await runGit(['add', '-A'], cwd);
            await runGit(['commit', '-m', 'chore: wrap up cloudy run'], cwd);
          }
          await runGit(['checkout', baseBranch], cwd);
          const merge = await runGit(['merge', '--no-ff', currentBranch, '-m', `chore: merge ${currentBranch}`], cwd);
          if (merge.exitCode === 0) {
            await runGit(['branch', '-d', currentBranch], cwd);
            sendJson(res, 200, { ok: true, message: `Merged ${currentBranch} into ${baseBranch}` });
          } else {
            await runGit(['checkout', currentBranch], cwd);
            sendJson(res, 409, { error: 'Merge had conflicts. Resolve manually.' });
          }
        } else if (action === 'push-pr') {
          const push = await runGit(['push', '-u', 'origin', currentBranch], cwd);
          if (push.exitCode !== 0) {
            sendJson(res, 500, { error: `Push failed: ${push.stderr}` });
            return;
          }
          const gh = await runExecFile('gh', ['pr', 'create', '--fill'], cwd);
          if (gh.exitCode === 0) {
            sendJson(res, 200, { ok: true, message: 'PR created', url: gh.stdout.trim() });
          } else {
            sendJson(res, 200, { ok: true, message: 'Branch pushed. Open a PR at your repository host.' });
          }
        } else if (action === 'discard') {
          await runGit(['checkout', baseBranch], cwd);
          await runGit(['branch', '-D', currentBranch], cwd);
          sendJson(res, 200, { ok: true, message: `Branch ${currentBranch} deleted.` });
        } else {
          sendJson(res, 400, { error: 'Invalid action' });
        }
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // POST /api/projects/:id/retry
    if (method === 'POST' && subpath === '/retry') {
      if (!meta) { send404(res); return; }
      if (!!getRunningProcess(projectId, 'run')) {
        sendJson(res, 409, { error: 'A run is already in progress. Stop it first.' });
        return;
      }
      try {
        const body = await parseBody(req) as {
          taskId?: string;
          buildModel?: string;
          taskReviewModel?: string;
          runReviewModel?: string;
          qualityReviewModel?: string;
          parallel?: boolean;
          maxParallel?: number;
          noValidate?: boolean;
          maxRetries?: number;
          buildEffort?: string;
          worktrees?: boolean;
<<<<<<< Updated upstream
          buildEngine?: string;
          buildProvider?: string;
          buildAccount?: string;
          buildModelId?: string;
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
=======
          engine?: string;
          provider?: string;
          executionModelId?: string;
          executionAccountId?: string;
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
        };
        const runtimeDefaults = await loadRuntimeDefaults(meta.path);
        try {
          await preflightRuntime(resolveRuntimePreflight(
            'coding',
            {
<<<<<<< Updated upstream
              engine: body.buildEngine,
              provider: body.buildProvider,
              account: body.buildAccount,
            },
            {
              engine: runtimeDefaults.build?.buildEngine,
              provider: runtimeDefaults.build?.buildProvider,
              account: runtimeDefaults.build?.buildAccount,
=======
              engine: body.engine,
              provider: body.provider,
              account: body.executionAccountId,
            },
            {
              engine: runtimeDefaults.execution?.engine,
              provider: runtimeDefaults.execution?.provider,
              account: runtimeDefaults.execution?.executionAccountId,
            },
          ));
          await preflightRuntime(resolveRuntimePreflight(
            'review',
            {
              engine: body.validationEngine,
              provider: body.validationProvider,
              account: body.validationAccountId,
            },
            {
              engine: runtimeDefaults.validation?.validationEngine,
              provider: runtimeDefaults.validation?.validationProvider,
              account: runtimeDefaults.validation?.validationAccountId,
>>>>>>> Stashed changes
            },
          ));
          await preflightRuntime(resolveRuntimePreflight(
            'review',
            {
<<<<<<< Updated upstream
              engine: body.taskReviewEngine,
              provider: body.taskReviewProvider,
              account: body.taskReviewAccount,
            },
            {
              engine: runtimeDefaults.taskReview?.taskReviewEngine,
              provider: runtimeDefaults.taskReview?.taskReviewProvider,
              account: runtimeDefaults.taskReview?.taskReviewAccount,
            },
          ));
          await preflightRuntime(resolveRuntimePreflight(
            'review',
            {
              engine: body.runReviewEngine,
              provider: body.runReviewProvider,
              account: body.runReviewAccount,
            },
            {
              engine: runtimeDefaults.runReview?.runReviewEngine,
              provider: runtimeDefaults.runReview?.runReviewProvider,
              account: runtimeDefaults.runReview?.runReviewAccount,
=======
              engine: body.reviewEngine,
              provider: body.reviewProvider,
              account: body.reviewAccountId,
            },
            {
              engine: runtimeDefaults.review?.reviewEngine,
              provider: runtimeDefaults.review?.reviewProvider,
              account: runtimeDefaults.review?.reviewAccountId,
>>>>>>> Stashed changes
            },
          ));
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          return;
        }
        const execModel = body.buildModel ?? runtimeDefaults.models?.buildModel ?? 'sonnet';
        const taskReviewModel = body.taskReviewModel ?? runtimeDefaults.models?.taskReviewModel ?? 'haiku';
        const runReviewModel = body.runReviewModel ?? runtimeDefaults.models?.runReviewModel ?? 'sonnet';
        const retryArgs = body.taskId ? ['--retry', body.taskId] : ['--retry-failed'];

        const extraArgs = buildRunRuntimeArgs(body);
        if (body.parallel) { extraArgs.push('--parallel'); }
        if (body.maxParallel) { extraArgs.push('--max-parallel', String(body.maxParallel)); }
        if (body.noValidate) { extraArgs.push('--no-validate'); }
        if (body.maxRetries) { extraArgs.push('--max-retries', String(body.maxRetries)); }
        if (body.qualityReviewModel) { extraArgs.push('--quality-review-model', body.qualityReviewModel); }
        if (body.worktrees) { extraArgs.push('--worktrees'); }

        const proc = spawnCloudyProcess(projectId, meta.path, 'run', [
          'run', '--non-interactive', '--agent-output',
          '--build-model', execModel,
          '--task-review-model', taskReviewModel,
          '--run-review-model', runReviewModel,
          '--heartbeat-interval', '5',
          ...retryArgs,
          ...extraArgs,
        ]);
        broadcastSse({ type: 'run_started', projectId });
        fedPublish('cloudy.run.started', { runId: proc.id, project: projectId });
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    // GET /api/projects/:id/chats
    if (method === 'GET' && subpath === '/chats') {
      if (!meta) { send404(res); return; }
      const [cloudySessions, ccSessions] = await Promise.all([
        listChatSessions(meta.path),
        scanClaudeCodeSessions(meta.path),
      ]);
      const cloudyItems = cloudySessions.map((s) => ({
        id: s.id,
        name: s.name,
        model: s.model,
        source: 'cloudy' as const,
        locked: false,
        messageCount: s.messages.length,
        updatedAt: s.updatedAt,
        preview: s.messages.find((m) => m.role === 'user')?.content.slice(0, 80) ?? '',
      }));
      const ccItems = await Promise.all(ccSessions.map(async (s) => {
        const override = await getCCName(meta!.path, s.id);
        return {
          id: `${CC_PREFIX}${s.id}`,
          name: override ?? s.name,
          model: 'claude-code',
          source: 'claude-code' as const,
          locked: s.active,
          messageCount: s.messageCount,
          updatedAt: s.updatedAt,
          preview: s.preview,
        };
      }));
      // Filter out trivial CC sessions (agent sub-tasks, tool invocations, etc.)
      const meaningfulCcItems = ccItems.filter((s) => s.messageCount >= 5);
      // Merge and sort by updatedAt descending
      const all = [...cloudyItems, ...meaningfulCcItems].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      sendJson(res, 200, all);
      return;
    }

    // POST /api/projects/:id/chats  (create session)
    if (method === 'POST' && subpath === '/chats') {
      if (!meta) { send404(res); return; }
      const body = await parseBody(req) as { model?: string; name?: string };
      const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const session: ChatSession = {
        id: sessionId,
        projectId,
        name: body.name ?? 'New chat',
        model: body.model ?? 'sonnet',
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        streamingContent: '',
      };
      await saveChatSession(meta.path, session);
      sendJson(res, 200, session);
      return;
    }

    // PATCH /api/projects/:id/chats/:sessionId  (rename/update)
    // GET /api/projects/:id/chats/:sessionId/stats  (CC session stats)
    if (method === 'GET' && subpath.match(/^\/chats\/cc:[^/]+\/stats$/)) {
      if (!meta) { send404(res); return; }
      const sessionId = subpath.replace('/chats/cc:', '').replace('/stats', '');
      const stats = await computeSessionStats(meta.path, sessionId);
      sendJson(res, 200, stats);
      return;
    }

    // PATCH /api/projects/:id/chats/cc:sessionId  (rename CC session)
    if (method === 'PATCH' && subpath.startsWith('/chats/cc:')) {
      if (!meta) { send404(res); return; }
      const sessionId = subpath.replace('/chats/cc:', '');
      const body = await parseBody(req) as { name?: string };
      if (body.name) {
        await setCCName(meta.path, sessionId, body.name.trim());
        sendJson(res, 200, { ok: true });
      } else {
        sendJson(res, 400, { error: 'name required' });
      }
      return;
    }

    // PATCH /api/projects/:id/chats/:sessionId  (rename/update cloudy session)
    const patchMatch = subpath.match(/^\/chats\/([^/]+)$/);
    if (method === 'PATCH' && patchMatch) {
      if (!meta) { send404(res); return; }
      const sessionId = patchMatch[1];
      const body = await parseBody(req) as { name?: string; model?: string };
      const session = await loadChatSession(meta.path, sessionId);
      if (!session) { send404(res); return; }
      if (body.name !== undefined) session.name = body.name;
      if (body.model !== undefined) session.model = body.model;
      session.updatedAt = new Date().toISOString();
      await saveChatSession(meta.path, session);
      sendJson(res, 200, session);
      return;
    }

    // GET /api/projects/:id/chats/:sessionId  (full session)
    const getSessionMatch = subpath.match(/^\/chats\/([^/]+)$/);
    if (method === 'GET' && getSessionMatch) {
      if (!meta) { send404(res); return; }
      const rawId = getSessionMatch[1];
      if (rawId.startsWith(CC_PREFIX)) {
        const ccId = rawId.slice(CC_PREFIX.length);
        const messages = await loadClaudeCodeMessages(meta.path, ccId);
        sendJson(res, 200, { id: rawId, name: '', model: 'claude-code', source: 'claude-code', messages, createdAt: '', updatedAt: '' });
        return;
      }
      const session = await loadChatSession(meta.path, rawId);
      if (!session) { send404(res); return; }
      sendJson(res, 200, session);
      return;
    }

    // DELETE /api/projects/:id/chats/:sessionId
    const chatDeleteMatch = subpath.match(/^\/chats\/([^/]+)$/);
    if (method === 'DELETE' && chatDeleteMatch) {
      if (!meta) { send404(res); return; }
      await deleteChatSession(meta.path, chatDeleteMatch[1]);
      sendJson(res, 200, { ok: true });
      return;
    }

    // POST /api/projects/:id/chat  (send message — creates session if needed)
    if (method === 'POST' && subpath === '/chat') {
      if (!meta) { send404(res); return; }
      try {
        const body = await parseBody(req) as { sessionId?: string; message: string; model?: string; effort?: string; maxBudgetUsd?: number; skipPermissions?: boolean };
        if (!body.message?.trim()) {
          sendJson(res, 400, { error: 'message required' });
          return;
        }

        // Reject if CC session is locked (CLI active or web resume already in-flight)
        if (body.sessionId?.startsWith(CC_PREFIX)) {
          const ccId = (body.sessionId as string).slice(CC_PREFIX.length);
          // Already streaming a reply for this session?
          if (ccResumeSessions.has(ccId)) {
            sendJson(res, 423, { error: 'Already streaming a response for this session' });
            return;
          }
          const { scanClaudeCodeSessions: scan } = await import('./scanner.js');
          const sessions = await scan(meta.path);
          const ccSession = sessions.find((s) => s.id === ccId);
          if (ccSession?.active) {
            sendJson(res, 423, { error: 'Session is currently open in Claude Code CLI' });
            return;
          }
        }

        let sessionId = body.sessionId;
        if (!sessionId) {
          // Create new session
          sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const newSession: ChatSession = {
            id: sessionId,
            projectId,
            name: body.message.slice(0, 40).trim(),
            model: body.model ?? 'sonnet',
            messages: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            streamingContent: '',
          };
          await saveChatSession(meta.path, newSession);
          broadcastSse({ type: 'chat_session_created', projectId, session: { id: sessionId, name: newSession.name, model: newSession.model } });
        }

        // Update model if provided
        if (body.model) {
          const s = await loadChatSession(meta.path, sessionId);
          if (s) { s.model = body.model; await saveChatSession(meta.path, s); }
        }

        // Send response immediately, stream via SSE
        sendJson(res, 200, { sessionId, ok: true });

        // Stream in background
        const streamFn = sessionId.startsWith(CC_PREFIX)
          ? streamChatMessageResume(meta.path, sessionId.slice(CC_PREFIX.length), body.message.trim(), projectId)
          : streamChatMessage(meta.path, sessionId, body.message.trim(), { effort: body.effort, maxBudgetUsd: body.maxBudgetUsd, skipPermissions: body.skipPermissions !== false });
        streamFn.catch((err: unknown) => {
          broadcastSse({ type: 'chat_error', sessionId, error: String(err) });
        });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }
  }

  // ── Root dashboard ──────────────────────────────────────────────
  if (pathname === '/api/pick-directory' && method === 'GET') {
    const picked = await new Promise<string | null>((resolve) => {
      if (process.platform === 'darwin') {
        execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "Select project directory")'],
          (err, stdout) => resolve(err ? null : stdout.trim().replace(/\/$/, '')));
      } else if (process.platform === 'linux') {
        execFile('zenity', ['--file-selection', '--directory', '--title=Select project directory'],
          (err, stdout) => resolve(err ? null : stdout.trim().replace(/\/$/, '')));
      } else {
        resolve(null);
      }
    });
    if (picked) return sendJson(res, 200, { path: picked });
    return sendJson(res, 200, { error: 'cancelled' });
  }

  if (pathname === '/' || pathname === '/index.html') {
    const html = getDashboardHtml('/bundle.js');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // ── GET /api/federation/peers ────────────────────────────────────────
  if (pathname === '/api/federation/peers' && method === 'GET') {
    const timeout = 2000;
    const results = await Promise.all(
      Array.from(peers.values()).map(async ({ machine, fedUrl }) => {
        try {
          const [infoRes, runsRes] = await Promise.all([
            fetchWithTimeout(`${fedUrl}/fed/info`, timeout),
            fetchWithTimeout(`${fedUrl}/fed/runs`, timeout),
          ]);
          if (!infoRes.ok || !runsRes.ok) {
            return { machine, fedUrl, online: false, projects: [] };
          }
          const runs = await runsRes.json() as unknown[];
          return { machine, fedUrl, online: true, projects: runs };
        } catch {
          return { machine, fedUrl, online: false, projects: [] };
        }
      }),
    );
    sendJson(res, 200, results);
    return;
  }

  // ── GET /embed/run/current/:projectId ───────────────────────────────
  const embedCurrentMatch = pathname.match(/^\/embed\/run\/current\/([^/]+)$/);
  if (embedCurrentMatch && method === 'GET') {
    const projectId = decodeURIComponent(embedCurrentMatch[1]);
    const meta = await findProject(projectId).catch(() => undefined);
    if (!meta) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end(getEmbedNoRunHtml('Project not found'));
      return;
    }
    const currentFile = path.join(meta.path, CLAWDASH_DIR, 'current');
    const currentRun = await fs.readFile(currentFile, 'utf-8').then((s) => s.trim()).catch(() => '');
    if (!currentRun) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getEmbedNoRunHtml('No active run'));
      return;
    }
    res.writeHead(302, { Location: `/embed/run/${encodeURIComponent(currentRun)}` });
    res.end();
    return;
  }

  // ── GET /embed/run/:runId ────────────────────────────────────────────
  const embedRunMatch = pathname.match(/^\/embed\/run\/([^/]+)$/);
  if (embedRunMatch && method === 'GET') {
    const runId = decodeURIComponent(embedRunMatch[1]);
    // Find the project that owns this runId
    const projects = await listProjects().catch(() => [] as ProjectMeta[]);
    let stateJson: unknown = null;
    let projectName = '';
    for (const meta of projects) {
      const stateFile = path.join(meta.path, CLAWDASH_DIR, RUNS_DIR, runId, 'state.json');
      const s = await readJson<unknown>(stateFile).catch(() => null);
      if (s) { stateJson = s; projectName = meta.name; break; }
    }
    if (!stateJson) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end(getEmbedNoRunHtml('Run not found'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getEmbedRunHtml(runId, projectName, stateJson));
    return;
  }

  send404(res);
}

// ── Embed HTML helpers ────────────────────────────────────────────────

function getEmbedNoRunHtml(message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{background:#080810;color:#6b7280;font-family:'SF Mono',monospace;font-size:13px;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
</style></head><body><span>${message}</span></body></html>`;
}

function getEmbedRunHtml(runId: string, projectName: string, state: unknown): string {
  const s = state as { plan?: { goal?: string; tasks?: Array<{ id: string; status: string; title?: string; error?: string }> }; completedAt?: string; startedAt?: string };
  const tasks = s?.plan?.tasks ?? [];
  const goal = s?.plan?.goal ?? '';

  const anyInProgress = tasks.some((t) => t.status === 'in_progress');
  const anyFailed = tasks.some((t) => t.status === 'failed');
  const allDone = tasks.length > 0 && tasks.every((t) => t.status === 'completed' || t.status === 'completed_without_changes' || t.status === 'skipped');

  let runStatus: string;
  let statusColor: string;
  if (anyInProgress) { runStatus = 'running'; statusColor = '#6366f1'; }
  else if (anyFailed) { runStatus = 'failed'; statusColor = '#ef4444'; }
  else if (allDone) { runStatus = 'done'; statusColor = '#22c55e'; }
  else if (s?.startedAt) { runStatus = 'running'; statusColor = '#6366f1'; }
  else { runStatus = 'planning'; statusColor = '#f59e0b'; }

  function dotFor(status: string): string {
    if (status === 'completed' || status === 'completed_without_changes' || status === 'skipped') return '<span style="color:#22c55e">●</span>';
    if (status === 'failed') return '<span style="color:#ef4444">●</span>';
    if (status === 'in_progress') return '<span style="color:#f59e0b">◌</span>';
    return '<span style="color:#3b82f6">○</span>';
  }

  const taskRows = tasks.map((t) => {
    const errPart = t.error ? ` <span style="color:#ef4444;font-size:11px">${escHtml(t.error.slice(0, 60))}</span>` : '';
    return `<tr><td style="padding:2px 8px 2px 0;white-space:nowrap">${dotFor(t.status)}</td><td style="padding:2px 8px 2px 0;color:#9ca3af;white-space:nowrap">${escHtml(t.id)}</td><td style="padding:2px 8px 2px 0;color:#d1d5db">${escHtml(t.title ?? '')}</td><td style="padding:2px 0;color:#6b7280;font-size:11px">${escHtml(t.status)}${errPart}</td></tr>`;
  }).join('');

  const shortRun = runId.slice(0, 12);

  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="2">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080810;color:#e5e7eb;font-family:'SF Mono','Cascadia Code',monospace;font-size:12px;padding:10px}
.header{display:flex;align-items:center;gap:8px;padding:6px 0 8px;border-bottom:1px solid #1f2937;margin-bottom:8px}
.badge{background:#1f2937;border:1px solid #374151;border-radius:4px;padding:2px 7px;font-size:11px;color:${statusColor}}
.proj{color:#6366f1;font-weight:bold}
.run{color:#6b7280;font-size:11px}
.goal{color:#9ca3af;font-size:11px;margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
table{width:100%;border-collapse:collapse}
</style>
</head><body>
<div class="header">
  <span class="proj">${escHtml(projectName)}</span>
  <span class="run">${escHtml(shortRun)}</span>
  <span class="badge">${escHtml(runStatus)}</span>
</div>
${goal ? `<div class="goal">${escHtml(goal)}</div>` : ''}
<table>${taskRows}</table>
</body></html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Federation HTTP handler ───────────────────────────────────────────

function sendFedJson(res: http.ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

async function getMostRecentRunState(projectPath: string): Promise<unknown | null> {
  const runsDir = path.join(projectPath, CLAWDASH_DIR, RUNS_DIR);
  try {
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    const dirs = entries.filter((e: Dirent) => e.isDirectory()).map((e: Dirent) => e.name);
    if (dirs.length === 0) return null;
    // Sort lexicographically descending (run dirs are typically timestamp-based)
    dirs.sort((a, b) => b.localeCompare(a));
    for (const dir of dirs) {
      const stateFile = path.join(runsDir, dir, 'state.json');
      const state = await readJson<unknown>(stateFile);
      if (state) return state;
    }
    return null;
  } catch {
    return null;
  }
}

async function handleFedRequest(req: http.IncomingMessage, res: http.ServerResponse, port: number): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://localhost`);
  const pathname = url.pathname;

  // All non-GET methods → 405
  if (method !== 'GET') {
    sendFedJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // GET /fed/info
  if (pathname === '/fed/info') {
    const cfg = await readDaemonConfig();
    sendFedJson(res, 200, {
      machine: os.hostname(),
      identity: cfg.identity ?? os.hostname(),
      version: '0.1.0',
      port,
      fedPort: (await readFedConfig())?.tools?.cloudy?.fed ?? (port + 334),
      platform: process.platform,
      uptime: process.uptime(),
    });
    return;
  }

  // GET /fed/runs
  if (pathname === '/fed/runs') {
    const projects = await listProjects().catch(() => [] as ProjectMeta[]);
    const results = await Promise.all(
      projects.map(async (meta: ProjectMeta) => {
        const state = await getMostRecentRunState(meta.path);
        return {
          projectId: meta.id,
          name: meta.name,
          path: meta.path,
          latestRun: state,
        };
      }),
    );
    sendFedJson(res, 200, results);
    return;
  }

  // GET /fed/runs/:projectId
  const runsMatch = pathname.match(/^\/fed\/runs\/([^/]+)$/);
  if (runsMatch) {
    const projectId = decodeURIComponent(runsMatch[1]);
    const projects = await listProjects().catch(() => [] as ProjectMeta[]);
    const meta = projects.find((p: ProjectMeta) => p.id === projectId);
    if (!meta) {
      sendFedJson(res, 404, { error: 'Project not found' });
      return;
    }
    const state = await getMostRecentRunState(meta.path);
    if (!state) {
      sendFedJson(res, 404, { error: 'No runs found for project' });
      return;
    }
    sendFedJson(res, 200, state);
    return;
  }

  sendFedJson(res, 404, { error: 'Not found' });
}

// ── Start server ──────────────────────────────────────────────────────

export async function startDaemonServer(port: number, bundleDir: string): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, bundleDir);
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
  });

  const fedCfgForPort = await readFedConfig();
  const fedPort = fedCfgForPort?.tools?.cloudy?.fed ?? (port + 334);

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '0.0.0.0', async () => {
      const daemonConfig = await readDaemonConfig();
      const fedCfg = await readFedConfig().catch(() => null);
      const identity = fedCfg?.identity ?? daemonConfig.identity ?? '';
      let cleanedUp = false;

      // ── Federation (via @vykeai/fed registerTool) ─────────────────────
      const stopFed = await registerTool({
        name: 'cloudy',
        displayName: 'Cloudy',
        port,
        fedPort,
        identity,
        version: '0.1.0',
        capabilities: ['projects', 'runs'],
        getInfo: async () => ({
          projectCount: (await listProjects().catch(() => [])).length,
          tools: [{
            id: 'cloudy',
            name: 'Cloudy',
            version: '0.1.0',
            actions: [
              { name: 'listProjects', method: 'GET', path: '/api/projects', description: 'List cloud projects' },
              { name: 'listRuns', method: 'GET', path: '/api/runs', description: 'List project runs' },
            ],
            docsUrl: 'https://github.com/vykeai/cloudy',
            healthPath: '/health',
          }],
        }),
        getRuns: async () => {
          const projects = await listProjects().catch(() => [] as ProjectMeta[]);
          return Promise.all(
            projects.map(async (meta: ProjectMeta) => {
              const state = await getMostRecentRunState(meta.path);
              return {
                projectId: meta.id,
                name: meta.name,
                path: meta.path,
                latestRun: state,
              };
            }),
          );
        },
      });

      // ── mDNS peer discovery ───────────────────────────────────────────
      const stopBrowsing = fedDiscoverTools(
        identity,
        (peer: Peer) => { peers.set(peer.machine, peer); },
        (name: string) => { peers.delete(name); },
      );

      // ── Register with keel daemon ─────────────────────────────────────
      const keelSocket = process.env.HOME + '/.keel.sock';
      try {
        const net = await import('node:net');
        const sock = net.createConnection(keelSocket);
        sock.on('connect', () => {
          sock.write(JSON.stringify({ type: 'register_service', name: 'cloudy', port, pid: process.pid, version: '0.1.0' }) + '\n');
          sock.end();
        });
        sock.on('error', () => { /* keel daemon not running — silent */ });
      } catch { /* ignore */ }

      const mdnsCleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        server.off('close', mdnsCleanup);
        process.off('SIGTERM', mdnsCleanup);
        process.off('SIGINT', mdnsCleanup);
        stopBrowsing();
        stopFed();
      };
      server.once('close', mdnsCleanup);
      process.on('SIGTERM', mdnsCleanup);
      process.on('SIGINT', mdnsCleanup);

      resolve(server);
    });
  });
}

// ── Background status broadcast ───────────────────────────────────────

export function startStatusBroadcast(intervalMs = 5000): NodeJS.Timeout {
  return setInterval(async () => {
    if (sseClients.length === 0) return;
    const projects = await listProjects().catch(() => [] as ProjectMeta[]);
    const snapshots = await Promise.all(projects.map(getProjectStatus));
    broadcastSse({ type: 'project_status', projects: snapshots });
  }, intervalMs);
}
