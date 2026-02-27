import {
  createLifecycleManager,
  createPluginRegistry,
  createSessionManager,
  type LifecycleManager,
  type OrchestratorConfig,
} from "@composio/ao-core";

export const DEFAULT_LIFECYCLE_POLL_INTERVAL_MS = 10_000;

export interface LifecycleRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface LifecycleRunnerOptions {
  config: OrchestratorConfig;
  intervalMs?: number;
}

export function createLifecycleRunner(options: LifecycleRunnerOptions): LifecycleRunner {
  const { config, intervalMs = DEFAULT_LIFECYCLE_POLL_INTERVAL_MS } = options;
  let manager: LifecycleManager | null = null;

  return {
    async start(): Promise<void> {
      const registry = createPluginRegistry();
      await registry.loadFromConfig(config, (pkg: string) =>
        import(/* webpackIgnore: true */ pkg),
      );
      const sessionManager = createSessionManager({ config, registry });
      manager = createLifecycleManager({ config, registry, sessionManager });
      manager.start(intervalMs);
    },

    async stop(): Promise<void> {
      if (manager) {
        manager.stop();
        manager = null;
      }
    },
  };
}
