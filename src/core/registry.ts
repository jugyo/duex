import { ConfigError } from "./errors.ts";
import type { WorkflowDefinition } from "./types.ts";

/**
 * Resolves a workflow name to the handler compiled into this process.
 *
 * The registry deliberately holds exactly one version per name: an invocation
 * pinned to a different version is never executed automatically (design D6).
 */
export class WorkflowRegistry {
  #workflows = new Map<string, WorkflowDefinition>();

  constructor(workflows: WorkflowDefinition[] = []) {
    for (const workflow of workflows) this.register(workflow);
  }

  register(workflow: WorkflowDefinition): void {
    const existing = this.#workflows.get(workflow.name);
    if (existing && existing !== workflow) {
      throw new ConfigError(
        `workflow ${JSON.stringify(workflow.name)} is already registered`,
      );
    }
    this.#workflows.set(workflow.name, workflow);
  }

  has(name: string): boolean {
    return this.#workflows.has(name);
  }

  get(name: string): WorkflowDefinition | null {
    return this.#workflows.get(name) ?? null;
  }

  require(name: string): WorkflowDefinition {
    const workflow = this.#workflows.get(name);
    if (!workflow) {
      throw new ConfigError(
        `unknown workflow ${JSON.stringify(name)}; registered: ${
          this.names().join(", ") || "(none)"
        }`,
      );
    }
    return workflow;
  }

  names(): string[] {
    return [...this.#workflows.keys()].sort();
  }

  list(): WorkflowDefinition[] {
    return this.names().map((name) => this.#workflows.get(name)!);
  }
}
