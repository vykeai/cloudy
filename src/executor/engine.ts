import type { ClaudeModel, ClaudeRunResult, Engine, Provider } from '../core/types.js';
import { runModel } from './model-runner.js';
import type { ThinkingLevel } from 'omnai';
import { resolveModelId } from '../config/model-config.js';

export interface EngineRunOptions {
  prompt: string;
  engine?: Engine;
  provider?: Provider;
<<<<<<< Updated upstream
  account?: string;
=======
  accountId?: string;
>>>>>>> Stashed changes
  claudeModel?: ClaudeModel;
  modelId?: string;
  cwd: string;
  onOutput?: (text: string) => void;
  onToolUse?: (toolName: string, toolInput: unknown) => void;
  onToolResult?: (toolName: string, content: string, isError: boolean) => void;
  onFilesWritten?: (paths: string[]) => void;
  abortSignal?: AbortSignal;
  resumeSessionId?: string;
  maxBudgetUsd?: number;
  effort?: 'low' | 'medium' | 'high' | 'max';
  thinking?: ThinkingLevel;
  allowedTools?: string[];
  disallowedTools?: string[];
  allowedReadPathsBeforeWrite?: string[];
}

export async function runEngine(options: EngineRunOptions): Promise<ClaudeRunResult> {
  const {
    prompt,
    engine,
    provider,
<<<<<<< Updated upstream
    account,
=======
    accountId,
>>>>>>> Stashed changes
    claudeModel,
    modelId,
    cwd,
    onOutput,
    onToolUse,
    onToolResult,
    onFilesWritten,
    abortSignal,
    resumeSessionId,
    maxBudgetUsd,
    effort,
    thinking,
    allowedTools,
    disallowedTools,
    allowedReadPathsBeforeWrite,
  } = options;

  const resolvedModelId =
    engine === 'claude-code' || !engine
      ? resolveModelId(claudeModel ?? 'sonnet')
      : modelId;

  return runModel({
    prompt,
    engine: engine ?? 'claude-code',
    provider,
<<<<<<< Updated upstream
    account,
=======
    accountId,
>>>>>>> Stashed changes
    modelId: resolvedModelId,
    cwd,
    onOutput,
    onToolUse,
    onToolResult,
    onFilesWritten,
    abortSignal,
    resumeSessionId,
    maxBudgetUsd,
    effort,
    thinking,
    allowedTools,
    disallowedTools,
    allowedReadPathsBeforeWrite,
  });
}
