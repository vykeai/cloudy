import fs from 'node:fs/promises';
import path from 'node:path';
import * as readline from 'node:readline';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import { createPlan } from '../../planner/planner.js';
import type { PlanQuestion } from '../../planner/planner.js';
import { loadConfig, saveConfig } from '../../config/config.js';
import {
  mergeModelConfig,
  parseModelFlag,
} from '../../config/model-config.js';
import { loadOrCreateState, saveState, updatePlan, generateRunName, createRunDir } from '../../core/state.js';
import { initLogger, log } from '../../utils/logger.js';
import { fileExists, ensureDir } from '../../utils/fs.js';
import { c, bold, dim, red, green, yellow, cyan } from '../../utils/colors.js';
import { acquireLock } from '../../utils/lock.js';
import type { ClaudeModel, DecisionLogEntry } from '../../core/types.js';
import { CLAWDASH_DIR } from '../../config/defaults.js';
import { createStreamFormatter } from '../../utils/stream-formatter.js';
import type { Plan } from '../../core/types.js';
import { getPhaseRuntime } from '../../config/phase-runtime.js';
import type { Task } from '../../core/types.js';
import { resolvePlanningRetryModel } from '../../planner/planning-fallback.js';
import type { TaskValidationOverrides } from '../../core/types.js';
import type { TaskExecutionMode } from '../../core/types.js';

interface ExternalTaskGraph {
  goal?: string;
  tasks: Array<{
    id: string;
    title: string;
    description: string;
    executionMode?: TaskExecutionMode;
    acceptanceCriteria: string[];
    proofRequirements?: string[];
    nonGoals?: string[];
    surfaceScope?: string[];
    collisionRisks?: string[];
    definitionOfDone?: string[];
    dependencies?: string[];
    contextPatterns?: string[];
    outputArtifacts?: string[];
    allowedWritePaths?: string[];
    validationOverrides?: TaskValidationOverrides;
    implementationSteps?: string[];
    timeoutMinutes?: number;
  }>;
  rationale?: string;
  questions?: PlanQuestion[];
}

function appendOptionalFlag(args: string[], flag: string, value?: string): void {
  if (value) {
    args.push(flag, value);
  }
}

function toPlannedTask(raw: ExternalTaskGraph['tasks'][number], maxRetries: number): Task {
  return {
    id: raw.id,
    title: raw.title,
    description: raw.description,
    executionMode: raw.executionMode,
    acceptanceCriteria: raw.acceptanceCriteria,
    proofRequirements: raw.proofRequirements,
    nonGoals: raw.nonGoals,
    surfaceScope: raw.surfaceScope,
    collisionRisks: raw.collisionRisks,
    definitionOfDone: raw.definitionOfDone,
    dependencies: raw.dependencies ?? [],
    contextPatterns: raw.contextPatterns ?? [],
    status: 'pending',
    retries: 0,
    maxRetries,
    ifFailed: 'skip',
    timeout: Math.min(Math.max(raw.timeoutMinutes ?? 30, 15), 60) * 60 * 1000,
    outputArtifacts: raw.outputArtifacts ?? [],
    allowedWritePaths: raw.allowedWritePaths ?? [],
    validationOverrides: raw.validationOverrides,
    implementationSteps: raw.implementationSteps,
  };
}

async function loadAdjacentTaskGraph(
  specPaths: string[],
  goal: string,
  maxRetries: number,
): Promise<Plan | null> {
  if (specPaths.length !== 1) return null;

  const specPath = specPaths[0];
  const ext = path.extname(specPath);
  if (!ext) return null;

  const taskGraphPath = specPath.slice(0, -ext.length) + '.tasks.json';
  if (!(await fileExists(taskGraphPath))) return null;

  const raw = JSON.parse(await fs.readFile(taskGraphPath, 'utf-8')) as ExternalTaskGraph;
  const now = new Date().toISOString();
  const plan: Plan = {
    goal: raw.goal ?? goal,
    tasks: raw.tasks.map((task) => toPlannedTask(task, maxRetries)),
    createdAt: now,
    updatedAt: now,
    rationale: raw.rationale,
  };

  if (raw.questions && raw.questions.length > 0) {
    (plan as any)._questions = raw.questions;
  }

  return plan;
}

/**
 * Prompt for input with a countdown timer. Returns the trimmed answer or null on timeout/empty.
 * onTick is called every second with remaining seconds so the caller can render a countdown.
 */
async function promptWithTimeout(
  prompt: string,
  timeoutMs: number,
  onTick?: (remainingSec: number) => void,
): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let resolved = false;

    const totalSec = Math.round(timeoutMs / 1000);
    let remaining = totalSec;
    onTick?.(remaining);

    const tick = setInterval(() => {
      remaining--;
      onTick?.(remaining);
      if (remaining <= 0) clearInterval(tick);
    }, 1000);

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        clearInterval(tick);
        rl.close();
        resolve(null);
      }
    }, timeoutMs);

    rl.question(prompt, (answer) => {
      if (!resolved) {
        resolved = true;
        clearInterval(tick);
        clearTimeout(timer);
        rl.close();
        resolve(answer.trim() || null);
      }
    });

    rl.on('close', () => {
      if (!resolved) {
        resolved = true;
        clearInterval(tick);
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}

const MODEL_OPTIONS = [
  { value: 'sonnet', label: 'sonnet', hint: 'recommended — smart & fast' },
  { value: 'haiku', label: 'haiku', hint: 'cheap & quick' },
  { value: 'opus', label: 'opus', hint: 'most capable, slowest' },
];

async function ensureGitignore(cwd: string): Promise<void> {
  const gitignorePath = path.join(cwd, '.gitignore');
  const entry = '.cloudy/';
  try {
    const content = await fs.readFile(gitignorePath, 'utf-8');
    if (!content.includes(entry)) {
      await fs.appendFile(gitignorePath, `\n${entry}\n`, 'utf-8');
    }
  } catch {
    await fs.writeFile(gitignorePath, `${entry}\n`, 'utf-8');
  }
}

function formatPlanNote(plan: Plan): string {
  const lines: string[] = [];
  for (let i = 0; i < plan.tasks.length; i++) {
    const task = plan.tasks[i];
    const deps = task.dependencies.length > 0
      ? `  ← ${task.dependencies.join(', ')}`
      : '';
    const desc = task.description.length > 60
      ? task.description.slice(0, 57) + '...'
      : task.description;
    lines.push(`${String(i + 1).padStart(3)}  ${task.id.padEnd(8)}  ${task.title}${deps}`);
    lines.push(`         ${desc}`);
  }
  return lines.join('\n');
}

export const initCommand = new Command('plan')
  .description('Decompose a goal into tasks using the configured planning runtime')
  .argument('[goal]', 'The project goal to decompose into tasks')
  .option('--model <model>', 'Model for all phases')
<<<<<<< Updated upstream
  .option('--plan-model <model>', 'Model for plan phase')
  .option('--plan-engine <engine>', 'Plan engine (e.g. claude-code, codex, pi-mono)')
  .option('--plan-provider <provider>', 'Plan provider/auth route (e.g. claude subscription, codex subscription, openai API)')
  .option('--plan-account <account>', 'Plan account route within the provider/runtime')
  .option('--plan-model-id <id>', 'Provider-native plan model ID')
  .option('--plan-effort <level>', 'Plan effort: low|medium|high|max')
=======
  .option('--planning-model <model>', 'Model for planning phase')
  .option('--planning-engine <engine>', 'Planning engine (e.g. claude-code, codex, pi-mono)')
  .option('--planning-provider <provider>', 'Planning provider/auth route (e.g. claude subscription, codex subscription, openai API)')
  .option('--planning-model-id <id>', 'Provider-native planning model ID')
  .option('--planning-account-id <id>', 'Planning provider account/profile ID from omnai estate')
>>>>>>> Stashed changes
  .option('--spec <file>', 'Spec/PRD file (repeatable: --spec A --spec B)', (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option('--no-review', 'Auto-approve the generated plan without interactive review')
  .option('--yes', 'Skip "Run now?" confirmation and proceed automatically')
  .option('--verbose', 'Show live planning output during execution')
  .option('--run-name <name>', 'Explicit run directory name (used by pipeline command)')
  .option('--questions-auto-answering-model <model>', 'Model used to auto-answer planning questions on timeout (default: planning model)')
  .option('--questions-timeout <seconds>', 'Seconds to wait for human answer before auto-assuming (default: 60)', parseInt)
  .option('--brainstorm', 'Show 2-3 candidate approaches before planning (interactive only, skipped for simple goals)')
  .action(async (goalArg: string | undefined, opts: {
    model?: string;
<<<<<<< Updated upstream
    planModel?: string;
    planEngine?: string;
    planProvider?: string;
    planAccount?: string;
    planModelId?: string;
    planEffort?: string;
=======
    planningModel?: string;
    planningEngine?: string;
    planningProvider?: string;
    planningModelId?: string;
    planningAccountId?: string;
>>>>>>> Stashed changes
    spec: string[];
    review: boolean;
    verbose?: boolean;
    runName?: string;
    questionsAutoAnsweringModel?: string;
    questionsTimeout?: number;
    brainstorm?: boolean;
  }) => {
    const cwd = process.cwd();
    const projectName = path.basename(cwd);
    await initLogger(cwd);

    // Global concurrency lock (max 2 across all projects)
    let releaseLock: (() => void) | undefined;
    try {
      releaseLock = await acquireLock('init', cwd);
    } catch (err) {
      console.error(c(red, `✖  ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }

    p.intro(`${c(cyan + bold, '☁️  cloudy plan')}  ${c(bold, projectName)}  ${c(dim, cwd)}`);

    const config = await loadConfig(cwd);
<<<<<<< Updated upstream
    if (opts.planEngine) config.planningRuntime = { ...config.planningRuntime, engine: opts.planEngine as typeof config.engine };
    if (opts.planProvider) config.planningRuntime = { ...config.planningRuntime, provider: opts.planProvider };
    if (opts.planAccount) config.planningRuntime = { ...config.planningRuntime, account: opts.planAccount };
    if (opts.planModelId) config.planningRuntime = { ...config.planningRuntime, modelId: opts.planModelId };
    if (opts.planEffort) config.planningRuntime = { ...config.planningRuntime, effort: opts.planEffort as any };
=======
    if (opts.planningEngine) config.planningRuntime = { ...config.planningRuntime, engine: opts.planningEngine as typeof config.engine };
    if (opts.planningProvider) config.planningRuntime = { ...config.planningRuntime, provider: opts.planningProvider };
    if (opts.planningModelId) config.planningRuntime = { ...config.planningRuntime, modelId: opts.planningModelId };
    if (opts.planningAccountId) config.planningRuntime = { ...config.planningRuntime, accountId: opts.planningAccountId };
>>>>>>> Stashed changes

    // ── Spec file(s) ──────────────────────────────────────────────────────────
    let specContent: string | undefined;
    let specPaths: string[] = opts.spec;

    if (specPaths.length === 0 && !goalArg) {
      const input = await p.text({
        message: 'Spec file path (or leave blank to type a goal):',
        placeholder: '/tmp/my-spec.md',
      });
      if (p.isCancel(input)) { p.cancel('Cancelled.'); process.exit(0); }
      const entered = (input as string).trim();
      if (entered) specPaths = [entered];
    }

    let wrapUpPrompt: string | undefined;

    if (specPaths.length > 0) {
      const parts: string[] = [];
      const multipleSpecs = specPaths.length > 1;

      if (multipleSpecs) {
        parts.push(`<!-- Combined spec from ${specPaths.length} files: ${specPaths.map(p => path.basename(p)).join(', ')} -->\n`);
      }

      for (const specPath of specPaths) {
        try {
          let content = await fs.readFile(specPath, 'utf-8');
          // Extract ## Wrap-up section
          const wrapUpMatch = content.match(/^##\s+Wrap-?up\b.*\n([\s\S]*?)(?=\n##\s|\s*$)/im);
          if (wrapUpMatch) {
            wrapUpPrompt = (wrapUpPrompt ? wrapUpPrompt + '\n\n' : '') + wrapUpMatch[1].trim();
            content = content.replace(/^##\s+Wrap-?up\b[\s\S]*$/im, '').trim();
          }
          if (multipleSpecs) {
            parts.push(`<!-- spec: ${path.basename(specPath)} -->\n${content}`);
          } else {
            parts.push(content);
          }
          // Guard: reject individual files that are too large
          const MAX_FILE_BYTES = 30_000; // ~7.5K tokens — one focused feature
          if (content.length > MAX_FILE_BYTES) {
            p.log.error(
              `Spec file "${path.basename(specPath)}" is ${Math.round(content.length / 1024)}KB — exceeds the ${Math.round(MAX_FILE_BYTES / 1024)}KB per-file limit.\n\n` +
              `  Good specs are focused: one feature or a handful of related tasks.\n` +
              `  Large files like TASKS.md / ARCHITECTURE.md are reference docs — not specs.\n\n` +
              `  ✦ Write a dedicated spec file for the feature you want to build:\n` +
              `      ## Title\n` +
              `      Goal, background, steps, acceptance criteria.\n` +
              `      Aim for 2–10KB. Run cloudy plan once per feature.\n\n` +
              `  ✦ Or split this file and pass the relevant section only:\n` +
              `      cloudy plan --spec ./specs/feature-x.md`
            );
            process.exit(1);
          }
          p.log.info(`Spec loaded: ${specPath}  (${Math.round(content.length / 1024)}KB)`);
        } catch (err) {
          p.log.error(`Cannot read spec file "${specPath}": ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      }

      if (wrapUpPrompt) {
        p.log.info(`Wrap-up section extracted (will run after all tasks complete)`);
      }

      specContent = parts.join('\n\n---\n\n');

      // Guard: reject if combined spec is too large
      const MAX_COMBINED_BYTES = 50_000; // ~12.5K tokens — hard ceiling for planner
      if (specContent.length > MAX_COMBINED_BYTES) {
        p.log.error(
          `Combined spec is ${Math.round(specContent.length / 1024)}KB — exceeds the ${Math.round(MAX_COMBINED_BYTES / 1024)}KB combined limit.\n\n` +
          `  Split into separate cloudy plan runs, one feature at a time.`
        );
        process.exit(1);
      }

      // spec.md is saved to run dir below (after run dir is created)
    }

    // ── Goal ──────────────────────────────────────────────────────────────────
    let goal = goalArg;
    if (!goal) {
      if (specContent) {
        // Skip HTML comments and blank lines to find the real title
        const firstLine = specContent.split('\n').find((l) => {
          const t = l.trim();
          return t.length > 0 && !t.startsWith('<!--');
        });
        goal = firstLine?.replace(/^#+\s*/, '').trim() ?? 'Implement the specification';
        // For multiple specs, combine their titles
        if (specPaths.length > 1) {
          const titles = specPaths.map((p) => path.basename(p, '.md').replace(/^[a-z0-9-]+-/, ''));
          goal = titles.join(' + ');
        }
      } else {
        const input = await p.text({
          message: 'What do you want to build?',
          placeholder: 'e.g. Add authentication to the API',
          validate: (v) => (v ?? '').trim() ? undefined : 'Goal is required',
        });
        if (p.isCancel(input)) { p.cancel('Cancelled.'); process.exit(0); }
        goal = (input as string).trim();
      }
    }

    p.log.info(`Goal: ${goal}`);

    // ── Planning model ────────────────────────────────────────────────────────
    let planningModel = opts.model
      ? parseModelFlag(opts.model)
      : opts.planModel
        ? parseModelFlag(opts.planModel)
        : undefined;

    if (!planningModel) {
      const selected = await p.select({
        message: 'Planning model:',
        options: MODEL_OPTIONS,
        initialValue: 'sonnet',
      });
      if (p.isCancel(selected)) { p.cancel('Cancelled.'); process.exit(0); }
      planningModel = selected as ClaudeModel;
    }

    // Apply planning model config only — execution/validation/review are asked at run time
    config.models = mergeModelConfig(config.models, {
      model: opts.model ? parseModelFlag(opts.model) : undefined,
      planningModel: planningModel,
    });

    // ── Run directory ─────────────────────────────────────────────────────────
    // Create a named run dir after we know the goal (or use --run-name if provided by pipeline)
    const runName = opts.runName ?? generateRunName(goal!);
    const runDir = await createRunDir(cwd, runName);

    // Re-init logger now that run dir exists — logs go into run dir
    await initLogger(cwd);

    // Save spec to run dir for holistic reviewer
    if (specContent) {
      try {
        await fs.writeFile(path.join(runDir, 'spec.md'), specContent, 'utf-8');
      } catch {
        // Non-fatal — reviewer falls back to task descriptions
      }
    }

    // ── Setup ─────────────────────────────────────────────────────────────────
    await ensureGitignore(cwd);

    const claudeMdPath = path.join(cwd, 'CLAUDE.md');
    let claudeMdContent: string | undefined;
    if (await fileExists(claudeMdPath)) {
      try {
        claudeMdContent = await fs.readFile(claudeMdPath, 'utf-8');
        p.log.info('CLAUDE.md found — included as planning context');
      } catch { /* ignore */ }
    }

    // Inject pipeline context from previous phases (if running as part of a pipeline)
    const pipelineContextPath = path.join(cwd, '.cloudy/pipeline-context.md');
    try {
      const pipelineContext = await fs.readFile(pipelineContextPath, 'utf-8');
      if (pipelineContext.trim()) {
        claudeMdContent = claudeMdContent
          ? `${claudeMdContent}\n\n---\n\n${pipelineContext}`
          : pipelineContext;
        p.log.info('Pipeline context found — injected into planning');
      }
    } catch { /* no pipeline context — normal single-phase run */ }

    // ── Pre-planning size warning ─────────────────────────────────────────────
    const specKb   = Math.round((specContent?.length ?? 0) / 1024);
    const claudeKb = Math.round((claudeMdContent?.length ?? 0) / 1024);
    const totalKb  = specKb + claudeKb;
    if (totalKb > 30) {
      p.log.warn(
        `Large planning context: spec ${specKb}KB + CLAUDE.md ${claudeKb}KB = ${totalKb}KB total.\n` +
        `  Planning may take longer. Consider splitting the spec into smaller phases if this hangs.`
      );
    } else {
      p.log.info(`Planning context: spec ${specKb}KB + CLAUDE.md ${claudeKb}KB = ${totalKb}KB`);
    }

    // ── Brainstorm gate (opt-in, interactive only, skipped for simple goals) ──
    if (opts.brainstorm && process.stdout.isTTY && process.stdin.isTTY) {
      const { brainstorm: runBrainstorm, isGoalComplexEnoughForBrainstorm } = await import('../../planner/brainstorm.js');
      if (isGoalComplexEnoughForBrainstorm(goal)) {
        const brainstormSpinner = p.spinner();
        brainstormSpinner.start('Brainstorming approaches…');
        const result = await runBrainstorm(goal, config.models.planning, cwd, getPhaseRuntime(config, 'planning'));
        brainstormSpinner.stop('Approaches ready');

        if (result) {
          console.log('\n  Candidate approaches:\n');
          for (const approach of result.approaches) {
            console.log(`  ${c(bold, approach.name)}`);
            for (const pro of approach.pros) console.log(`    ${c(green, '+')} ${pro}`);
            for (const con of approach.cons) console.log(`    ${c(yellow, '-')} ${con}`);
            console.log('');
          }

          const chosen = await p.select({
            message: `Recommended: "${result.recommended}" — ${result.rationale}. Proceed with:`,
            options: [
              ...result.approaches.map((a) => ({ value: a.name, label: a.name })),
              { value: '__custom', label: 'Describe my own approach…' },
            ],
          });

          if (!p.isCancel(chosen)) {
            let approachContext: string;
            if (chosen === '__custom') {
              const custom = await p.text({ message: 'Describe your preferred approach:' });
              approachContext = p.isCancel(custom) ? result.recommended : (custom as string);
            } else {
              approachContext = chosen as string;
            }
            goal = `${goal}\n\nChosen implementation approach: ${approachContext}`;
          }
        }
      } else {
        p.log.info('Goal is concise — skipping brainstorm (use --brainstorm for complex goals with 20+ words)');
      }
    }

    // ── Planning ──────────────────────────────────────────────────────────────
    const PLANNING_TIMEOUT_MS = Number(process.env['CLOUDY_PLANNING_TIMEOUT_MS']) || 15 * 60 * 1000;
    const planningAbort = new AbortController();
    const planningStart = Date.now();

    const spinner = p.spinner();
    spinner.start(`Planning with ${planningModel?.split('-')[1] ?? planningModel}…`);

    // Tick elapsed time every second for a readable live counter
    const tickInterval = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - planningStart) / 1000);
      spinner.message(`Planning with ${planningModel?.split('-')[1] ?? planningModel}… (${elapsedSec}s)`);
    }, 1000);
    const planningTimeout = setTimeout(() => planningAbort.abort(), PLANNING_TIMEOUT_MS);

    let plan: Plan;
    const adjacentTaskGraph = await loadAdjacentTaskGraph(specPaths, goal, config.maxRetries);
    if (adjacentTaskGraph) {
      clearInterval(tickInterval);
      clearTimeout(planningTimeout);
      plan = adjacentTaskGraph;
      spinner.stop(`Plan loaded from task graph  ·  ${plan.tasks.length} tasks`);
      p.log.info(`Using adjacent task graph: ${path.basename(specPaths[0]).replace(/\.[^.]+$/, '.tasks.json')}`);
    } else {
      try {
        const onOutput = opts.verbose
          ? (() => {
              const fmt = createStreamFormatter((s) => process.stdout.write(s));
              return (text: string) => fmt(text);
            })()
          : undefined;

        plan = await createPlan(
          goal,
          config.models.planning,
          cwd,
          onOutput ?? (() => {}),
          specContent,
          claudeMdContent,
          planningAbort.signal,
          getPhaseRuntime(config, 'planning'),
        );
      } catch (err) {
        const retryModel = resolvePlanningRetryModel(config.models.planning, err);
        if (!retryModel) {
          clearInterval(tickInterval);
          clearTimeout(planningTimeout);
          spinner.stop('Planning failed');
          p.log.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }

        clearInterval(tickInterval);
        clearTimeout(planningTimeout);
        spinner.stop(`Planning with ${config.models.planning} timed out — retrying with ${retryModel}`);

        const retryAbort = new AbortController();
        const retryStart = Date.now();
        const retrySpinner = p.spinner();
        retrySpinner.start(`Re-planning with ${retryModel}…`);
        const retryTick = setInterval(() => {
          const elapsedSec = Math.floor((Date.now() - retryStart) / 1000);
          retrySpinner.message(`Re-planning with ${retryModel}… (${elapsedSec}s)`);
        }, 1000);
        const retryTimeout = setTimeout(() => retryAbort.abort(), PLANNING_TIMEOUT_MS);

        try {
          const onOutput = opts.verbose
            ? (() => {
                const fmt = createStreamFormatter((s) => process.stdout.write(s));
                return (text: string) => fmt(text);
              })()
            : undefined;

          plan = await createPlan(
            goal,
            retryModel,
            cwd,
            onOutput ?? (() => {}),
            specContent,
            claudeMdContent,
            retryAbort.signal,
            getPhaseRuntime(config, 'planning'),
          );
          clearInterval(retryTick);
          clearTimeout(retryTimeout);
          const elapsed = Math.round((Date.now() - retryStart) / 1000);
          retrySpinner.stop(`Fallback plan ready  ·  ${plan.tasks.length} tasks  ·  ${elapsed}s`);
        } catch (retryErr) {
          clearInterval(retryTick);
          clearTimeout(retryTimeout);
          retrySpinner.stop('Planning failed');
          p.log.error(retryErr instanceof Error ? retryErr.message : String(retryErr));
          process.exit(1);
        }
      }
      clearInterval(tickInterval);
      clearTimeout(planningTimeout);

      const elapsed = Math.round((Date.now() - planningStart) / 1000);
      spinner.stop(`Plan ready  ·  ${plan.tasks.length} tasks  ·  ${elapsed}s`);
    }
    if (wrapUpPrompt) {
      plan.wrapUpPrompt = wrapUpPrompt;
    }

    // ── Planning Q&A ──────────────────────────────────────────────────────────
    const planQuestions: PlanQuestion[] = (plan as any)._questions ?? [];
    delete (plan as any)._questions;

    const autoAnswerModel: ClaudeModel = opts.questionsAutoAnsweringModel
      ? (parseModelFlag(opts.questionsAutoAnsweringModel) as ClaudeModel)
      : (planningModel as ClaudeModel);
    const questionTimeoutMs = (opts.questionsTimeout ?? 60) * 1000;
    const timeoutSec = opts.questionsTimeout ?? 60;
    const isInteractive = opts.review && process.stdout.isTTY && process.stdin.isTTY;

    if (planQuestions.length > 0) {
      const decisionLog: DecisionLogEntry[] = [];

      p.log.info(`💭  ${planQuestions.length} planning question(s) — answer to refine the plan:`);

      for (let qi = 0; qi < planQuestions.length; qi++) {
        const q = planQuestions[qi];
        const questionId = `q${qi + 1}`;
        let answer: string | null = null;

        // Sequential Q&A: skip questions whose keywords are already resolved in prior answers.
        // Avoids asking "which session expiry?" after "use JWT or sessions?" was answered "JWT".
        // Ted's heuristic: keyword overlap in question text vs. prior answer text — no LLM needed.
        if (decisionLog.length > 0) {
          const priorAnswers = decisionLog.map((d) => d.answer.toLowerCase());
          const questionWords = q.text.toLowerCase().split(/\W+/).filter((w) => w.length > 4);
          const alreadyCovered = questionWords.some((word) =>
            priorAnswers.some((ans) => ans.includes(word)),
          );
          if (alreadyCovered) {
            await log.info(`Skipping question ${qi + 1} — keywords already addressed in prior answers`);
            // Auto-answer with AI assumption so decisionLog stays complete
            decisionLog.push({
              questionId,
              question: q.text,
              answeredBy: 'agent',
              answer: `Skipped — context resolved by earlier answers`,
              reasoning: 'Prior answers already addressed the key decision this question covers.',
              timestamp: new Date().toISOString(),
            });
            continue;
          }
        }

        // Always show the question so it's visible in logs and CI output
        console.log(`\n  ${c(cyan + bold, `Question ${qi + 1}/${planQuestions.length}:`)}  ${q.text}`);
        if (q.options && q.options.length > 0) {
          console.log(`  ${c(dim, 'Options: ' + q.options.join(' / '))}`);
        }

        if (isInteractive) {
          console.log(`  ${c(dim, `(${timeoutSec}s to answer — press Enter to skip and let the AI assume)`)}`);

          if (q.type === 'select' && q.options && q.options.length > 0) {
            const selected = await p.select({
              message: q.text,
              options: q.options.map((v) => ({ value: v, label: v })),
            });
            answer = p.isCancel(selected) ? null : (selected as string);
          } else if (q.type === 'multiselect' && q.options && q.options.length > 0) {
            const selected = await p.multiselect({
              message: q.text,
              options: q.options.map((v) => ({ value: v, label: v })),
              required: false,
            });
            answer = p.isCancel(selected) ? null : (selected as string[]).join(', ');
          } else if (q.type === 'confirm') {
            const confirmed = await p.confirm({ message: q.text });
            answer = p.isCancel(confirmed) ? null : (confirmed ? 'yes' : 'no');
          } else {
            // text (default) — use existing promptWithTimeout
            answer = await promptWithTimeout(
              `  ${c(bold, '→')} `,
              questionTimeoutMs,
              (remaining) => {
                process.stdout.write(`\r  ${c(dim, `⏱  ${remaining}s remaining…`)}  `);
              },
            );
          }

          if (answer !== null) {
            process.stdout.write('\r' + ' '.repeat(40) + '\r');
            console.log(`  ${c(green, '✓')} ${c(dim, 'Your answer recorded.')}`);
          } else {
            process.stdout.write('\r' + ' '.repeat(40) + '\r');
            console.log(`  ${c(yellow, '⏱  timeout — asking the AI to assume…')}`);
          }
        } else if (process.stdin.readable && !process.stdin.isTTY) {
          // Daemon / piped mode — emit structured marker so the web UI can show a question card,
          // then wait on stdin for the answer with a timeout.
          process.stdout.write(`\nCLOUDY_PLAN_QUESTION:${JSON.stringify({
            questionType: q.type,
            options: q.options,
            question: q.text,
            index: qi + 1,
            total: planQuestions.length,
            timeoutSec,
          })}\n`);
          const rawAnswer = await new Promise<string | null>((resolve) => {
            let buf = '';
            const timer = setTimeout(() => { resolve(null); }, timeoutSec * 1000);
            const onData = (chunk: Buffer) => {
              buf += chunk.toString();
              const nl = buf.indexOf('\n');
              if (nl !== -1) {
                clearTimeout(timer);
                process.stdin.off('data', onData);
                const line = buf.slice(0, nl).trim();
                resolve(line || null);
              }
            };
            process.stdin.on('data', onData);
          });
          // For select/multiselect/confirm, the answer from stdin may be JSON-encoded
          if (rawAnswer !== null) {
            try {
              const parsed = JSON.parse(rawAnswer);
              if (Array.isArray(parsed)) {
                answer = parsed.join(', ');
              } else if (typeof parsed === 'boolean') {
                answer = parsed ? 'yes' : 'no';
              } else {
                answer = String(parsed);
              }
            } catch {
              answer = rawAnswer;
            }
          } else {
            answer = null;
          }
        } else {
          console.log(`  ${c(dim, '(non-interactive — AI will auto-decide)')}`);
        }

        if (answer === null) {
          // AI auto-assumption using the configured model
          const optionsHint = q.options && q.options.length > 0
            ? `\nAvailable options: ${q.options.join(', ')}`
            : '';
          const assumptionPrompt = `You are a technical planner resolving an ambiguous design question so that implementation can proceed.
${specContent ? `\n## Spec Context (first 3000 chars)\n${specContent.slice(0, 3000)}\n` : ''}${claudeMdContent ? `\n## Project Context (CLAUDE.md)\n${claudeMdContent.slice(0, 2000)}\n` : ''}
## Question
${q.text}${optionsHint}

## Your Task
Make a reasonable technical assumption to resolve this question. Base your assumption on:
- Evidence in the spec or project context
- Common industry patterns and conservative defaults
- Existing patterns visible in the codebase context

Respond with ONLY valid JSON:
{"assumption": "One concise sentence stating the decision", "reasoning": "One sentence explaining why"}`;

          let assumptionResult = { assumption: `Proceeding with default approach for: ${q.text}`, reasoning: 'Spec context insufficient for a specific assumption; defaulting to common patterns.' };
          try {
            const { runPhaseModel } = await import('../../executor/model-runner.js');
            const result = await Promise.race([
              runPhaseModel({
                prompt: assumptionPrompt,
                model: autoAnswerModel,
                cwd,
                engine: config.planningRuntime?.engine,
                provider: config.planningRuntime?.provider,
                modelId: config.planningRuntime?.modelId,
                taskType: 'planning',
              }),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('assumption timeout')), 30_000)),
            ]);
            if (result.success) {
              const jsonMatch = result.output.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.assumption) assumptionResult = parsed;
              }
            }
          } catch { /* non-fatal — use default */ }

          console.log(`  ${c(cyan, `🤖 AI assumes:`)} ${assumptionResult.assumption}`);
          if (assumptionResult.reasoning) {
            console.log(`  ${c(dim, assumptionResult.reasoning)}`);
          }

          decisionLog.push({
            questionId,
            question: q.text,
            answeredBy: 'agent',
            answer: assumptionResult.assumption,
            reasoning: assumptionResult.reasoning,
            timestamp: new Date().toISOString(),
          });
        } else {
          decisionLog.push({
            questionId,
            question: q.text,
            answeredBy: 'human',
            answer,
            timestamp: new Date().toISOString(),
          });
        }
      }

      // Attach decision log to plan for executor injection
      plan.decisionLog = decisionLog;
      console.log('');
    }

    // ── Display plan ──────────────────────────────────────────────────────────
    p.note(formatPlanNote(plan), `📋 ${plan.tasks.length} tasks`);

    if (plan.rationale) {
      console.log(`  ${c(dim, 'Rationale: .cloudy/rationale.md')}`);
    }

    // ── Approval ──────────────────────────────────────────────────────────────
    if (opts.review && !(opts as any).yes && process.stdout.isTTY) {
      let approved = false;
      while (!approved) {
        const action = await p.select({
          message: 'What would you like to do?',
          options: [
            { value: 'approve', label: '✅  Approve & queue', hint: 'run `cloudy run` to execute' },
            { value: 'revise', label: '✏️   Revise the plan', hint: 'describe what to change' },
            { value: 'cancel', label: '✖   Cancel' },
          ],
        });
        if (p.isCancel(action) || action === 'cancel') {
          p.cancel('Cancelled.');
          process.exit(0);
        }
        if (action === 'approve') {
          approved = true;
        } else {
          const feedback = await p.text({
            message: 'Describe what to change:',
            placeholder: 'e.g. Split task-3 into two smaller tasks',
            validate: (v) => (v ?? '').trim() ? undefined : 'Please describe the change',
          });
          if (p.isCancel(feedback)) { p.cancel('Cancelled.'); process.exit(0); }

          const reviseSpinner = p.spinner();
          reviseSpinner.start('Revising plan…');
          try {
            plan = await createPlan(
              `${goal}\n\nUser feedback on previous plan:\n${(feedback as string).trim()}`,
              config.models.planning,
              cwd,
              () => {},
              specContent,
              claudeMdContent,
              undefined,
              getPhaseRuntime(config, 'planning'),
            );
            reviseSpinner.stop(`Revised  ·  ${plan.tasks.length} tasks`);
            p.note(formatPlanNote(plan), `📋 ${plan.tasks.length} tasks`);
          } catch (err) {
            reviseSpinner.stop('Revision failed');
            p.log.error(err instanceof Error ? err.message : String(err));
          }
        }
      }
    }

    // ── Save ──────────────────────────────────────────────────────────────────
    const readmePath = path.join(cwd, 'README.md');
    if (!(await fileExists(readmePath))) {
      const readmeContent = `# ${projectName}\n\n${goal}\n\n## Tasks\n\n${plan.tasks.map((t, i) => `${i + 1}. **${t.title}** — ${t.description.split('\n')[0]}`).join('\n')}\n\n---\n*Managed by cloudy*\n`;
      await fs.writeFile(readmePath, readmeContent, 'utf-8');
    }

    const state = await loadOrCreateState(cwd, config);
    updatePlan(state, plan);
    state.runName = runName;
    await saveState(cwd, state);

    await log.info(`Plan saved: ${plan.tasks.length} tasks`);

    // ── Run now? ──────────────────────────────────────────────────────────────
    // Pipeline mode (--run-name set): init is planning-only — pipeline calls `cloudy run` separately.
    // Interactive mode: ask the user. Auto-run with --yes or in non-TTY contexts.
    if (opts.runName) {
      // Pipeline mode — planning complete, pipeline will handle execution
      p.outro(`${c(green + bold, '✅  plan ready')}  ${plan.tasks.length} tasks queued for pipeline`);
      return;
    }

    const autoRun = (opts as any).yes || !process.stdout.isTTY;
    const runNow = autoRun ? true : await p.confirm({
      message: `Run ${plan.tasks.length} tasks now?`,
      initialValue: true,
    });

    if (!autoRun && (p.isCancel(runNow) || !runNow)) {
      p.outro(`${c(green + bold, '✅  ready!')}  ${plan.tasks.length} tasks queued  ·  run ${c(bold, 'cloudy run')} to execute`);
      return;
    }

    p.outro(`${c(cyan + bold, '🚀  launching...')}  ${plan.tasks.length} tasks`);

    // Spawn `cloudy run` — it will ask for execution/validation/review models interactively
    const { execa } = await import('execa');
    const runArgs = [
      'run',
      '--build-model', config.models.execution,
      '--task-review-model', config.models.validation,
      '--run-review-model', config.review.model,
    ];
    appendOptionalFlag(runArgs, '--build-engine', config.engine);
    appendOptionalFlag(runArgs, '--build-provider', config.provider);
    appendOptionalFlag(runArgs, '--build-account', config.account);
    appendOptionalFlag(runArgs, '--build-model-id', config.executionModelId);
    appendOptionalFlag(runArgs, '--build-effort', config.executionEffort);
    appendOptionalFlag(runArgs, '--task-review-engine', config.validationRuntime?.engine);
    appendOptionalFlag(runArgs, '--task-review-provider', config.validationRuntime?.provider);
    appendOptionalFlag(runArgs, '--task-review-account', config.validationRuntime?.account);
    appendOptionalFlag(runArgs, '--task-review-model-id', config.validationRuntime?.modelId);
    appendOptionalFlag(runArgs, '--task-review-effort', config.validationRuntime?.effort);
    appendOptionalFlag(runArgs, '--run-review-engine', config.reviewRuntime?.engine);
    appendOptionalFlag(runArgs, '--run-review-provider', config.reviewRuntime?.provider);
    appendOptionalFlag(runArgs, '--run-review-account', config.reviewRuntime?.account);
    appendOptionalFlag(runArgs, '--run-review-model-id', config.reviewRuntime?.modelId);
    appendOptionalFlag(runArgs, '--run-review-effort', config.reviewRuntime?.effort);
    if (config.models.qualityReview) {
      runArgs.push('--quality-review-model', config.models.qualityReview);
    }
    // Release init lock before spawning run — run acquires its own slot
    releaseLock?.();
    try {
      await execa(process.argv[0], [process.argv[1], ...runArgs], { stdio: 'inherit' });
    } catch (err: any) {
      // SIGTERM = user pressed q in TUI — normal exit, not an error
      if (err?.signal !== 'SIGTERM') throw err;
    }
  });
