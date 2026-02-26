/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@composio/ao-core"],
  serverExternalPackages: [
    // Plugin packages are loaded dynamically via import(pkg) at runtime.
    // Mark them as external so webpack doesn't try to bundle/analyze them.
    "@composio/ao-plugin-runtime-tmux",
    "@composio/ao-plugin-runtime-process",
    "@composio/ao-plugin-agent-claude-code",
    "@composio/ao-plugin-agent-codex",
    "@composio/ao-plugin-agent-aider",
    "@composio/ao-plugin-agent-copilot",
    "@composio/ao-plugin-workspace-worktree",
    "@composio/ao-plugin-workspace-clone",
    "@composio/ao-plugin-tracker-github",
    "@composio/ao-plugin-tracker-linear",
    "@composio/ao-plugin-tracker-azure-devops",
    "@composio/ao-plugin-scm-github",
    "@composio/ao-plugin-scm-azure-devops",
    "@composio/ao-plugin-notifier-composio",
    "@composio/ao-plugin-notifier-desktop",
    "@composio/ao-plugin-notifier-slack",
    "@composio/ao-plugin-notifier-webhook",
    "@composio/ao-plugin-terminal-iterm2",
    "@composio/ao-plugin-terminal-web",
    // Composio SDK — optional peer dep of tracker-linear
    "@composio/core",
  ],
};

export default nextConfig;
