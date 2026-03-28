/**
 * Provider Dispatch for NanoClaw
 * Routes agent invocations to the configured LLM provider (claude or kiro).
 */
import { ChildProcess } from 'child_process';

import {
  ContainerInput,
  ContainerOutput,
  runContainerAgent,
} from './container-runner.js';
import { runKiroAgent } from './kiro-runner.js';
import { RegisteredGroup } from './types.js';

/**
 * Run an agent using the provider configured for the group.
 * Defaults to 'claude' (existing container-based agent) if no provider is set.
 */
export async function runProviderAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const provider = group.containerConfig?.provider || 'claude';

  if (provider === 'kiro') {
    return runKiroAgent(group, input, onProcess, onOutput);
  }

  return runContainerAgent(group, input, onProcess, onOutput);
}
