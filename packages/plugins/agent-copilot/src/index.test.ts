import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks — available inside vi.mock factories
// ---------------------------------------------------------------------------
const {
  mockExecFileAsync,
  mockWriteFile,
  mockMkdir,
  mockReadFile,
  mockRename,
  mockHomedir,
} = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn(),
  mockRename: vi.fn().mockResolvedValue(undefined),
  mockHomedir: vi.fn(() => "/mock/home"),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn };
});

vi.mock("node:fs/promises", () => ({
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  readFile: mockReadFile,
  rename: mockRename,
}));

vi.mock("node:crypto", () => ({
  randomBytes: () => ({ toString: () => "abc123" }),
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

import { create, manifest, default as defaultExport } from "./index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test-project",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/workspace/test",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeTmuxHandle(id = "test-session"): RuntimeHandle {
  return { id, runtimeName: "tmux", data: {} };
}

function makeProcessHandle(pid?: number | string): RuntimeHandle {
  return { id: "proc-1", runtimeName: "process", data: pid !== undefined ? { pid } : {} };
}

function makeLaunchConfig(overrides: Partial<AgentLaunchConfig> = {}): AgentLaunchConfig {
  return {
    sessionId: "sess-1",
    projectConfig: {
      name: "my-project",
      repo: "owner/repo",
      path: "/workspace/repo",
      defaultBranch: "main",
      sessionPrefix: "my",
    },
    ...overrides,
  };
}

function mockTmuxWithProcess(processName: string, args = "", found = true) {
  mockExecFileAsync.mockImplementation((cmd: string, cmdArgs: string[]) => {
    if (cmd === "tmux" && cmdArgs[0] === "list-panes") {
      return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
    }
    if (cmd === "ps") {
      const line = found
        ? `  789 ttys003  ${processName}${args ? " " + args : ""}`
        : "  789 ttys003  bash";
      return Promise.resolve({
        stdout: `  PID TT       ARGS\n${line}\n`,
        stderr: "",
      });
    }
    return Promise.reject(new Error(`Unexpected: ${cmd} ${cmdArgs.join(" ")}`));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHomedir.mockReturnValue("/mock/home");
});

// =========================================================================
// Manifest & Exports
// =========================================================================
describe("plugin manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "copilot",
      slot: "agent",
      description: "Agent plugin: GitHub Copilot CLI (gh copilot)",
      version: "0.1.0",
    });
  });

  it("create() returns agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("copilot");
    expect(agent.processName).toBe("gh");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

// =========================================================================
// getLaunchCommand
// =========================================================================
describe("getLaunchCommand", () => {
  const agent = create();

  it("generates base command with gh copilot suggest --target shell", () => {
    expect(agent.getLaunchCommand(makeLaunchConfig())).toBe(
      "gh copilot suggest --target shell",
    );
  });

  it("includes --model with shell-escaped value", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "gpt-4o" }));
    expect(cmd).toContain("--model 'gpt-4o'");
  });

  it("supports model with dots and dashes (e.g. claude-3.5-sonnet)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "claude-3.5-sonnet" }));
    expect(cmd).toContain("--model 'claude-3.5-sonnet'");
  });

  it("supports o3-mini model", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "o3-mini" }));
    expect(cmd).toContain("--model 'o3-mini'");
  });

  it("appends shell-escaped prompt after flags", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix the bug" }));
    expect(cmd).toContain("'Fix the bug'");
  });

  it("combines model and prompt correctly", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ model: "gpt-4o", prompt: "Add tests" }),
    );
    expect(cmd).toBe("gh copilot suggest --target shell --model 'gpt-4o' 'Add tests'");
  });

  it("escapes single quotes in prompt (POSIX shell escaping)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "it's broken" }));
    expect(cmd).toContain("'it'\\''s broken'");
  });

  it("escapes dangerous characters in prompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ prompt: "$(rm -rf /); `evil`; $HOME" }),
    );
    // Single-quoted strings prevent shell expansion
    expect(cmd).toContain("'$(rm -rf /); `evil`; $HOME'");
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("--full-auto");
  });

  it("ignores permissions=skip (no equivalent flag for gh copilot)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "skip" }));
    // No --full-auto or --dangerously-skip-permissions for gh copilot
    expect(cmd).not.toContain("skip");
  });
});

// =========================================================================
// getEnvironment
// =========================================================================
describe("getEnvironment", () => {
  const agent = create();

  it("sets AO_SESSION_ID but not AO_PROJECT_ID (caller's responsibility)", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
    expect(env["AO_PROJECT_ID"]).toBeUndefined();
  });

  it("sets AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "GH-42" }));
    expect(env["AO_ISSUE_ID"]).toBe("GH-42");
  });

  it("omits AO_ISSUE_ID when not provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
  });

  it("prepends ~/.ao/bin to PATH for shell wrappers", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["PATH"]).toMatch(/^.*\/\.ao\/bin:/);
  });

  it("PATH starts with the ao bin dir specifically", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["PATH"]?.startsWith("/mock/home/.ao/bin:")).toBe(true);
  });

  it("falls back to /usr/bin:/bin when process.env.PATH is undefined", () => {
    const originalPath = process.env["PATH"];
    delete process.env["PATH"];
    try {
      const env = agent.getEnvironment(makeLaunchConfig());
      expect(env["PATH"]).toContain("/usr/bin:/bin");
    } finally {
      process.env["PATH"] = originalPath;
    }
  });
});

// =========================================================================
// isProcessRunning
// =========================================================================
describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when 'gh copilot' found on tmux pane TTY", async () => {
    mockTmuxWithProcess("gh", "copilot suggest --target shell");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when gh is running but not copilot subcommand", async () => {
    mockTmuxWithProcess("gh", "pr list");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns false when gh copilot not on tmux pane TTY", async () => {
    mockTmuxWithProcess("bash", "", true);
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns false when tmux list-panes returns empty", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true for process handle with alive PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 0);
    killSpy.mockRestore();
  });

  it("returns false for process handle with dead PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(false);
    killSpy.mockRestore();
  });

  it("returns false for unknown runtime without PID", async () => {
    const handle: RuntimeHandle = { id: "x", runtimeName: "other", data: {} };
    expect(await agent.isProcessRunning(handle)).toBe(false);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("returns false on tmux command failure", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux not running"));
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true when PID exists but throws EPERM", async () => {
    const epermErr = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw epermErr;
    });
    expect(await agent.isProcessRunning(makeProcessHandle(789))).toBe(true);
    killSpy.mockRestore();
  });

  it("finds gh copilot on any pane in multi-pane session", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n/dev/ttys002\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout:
            "  PID TT ARGS\n  100 ttys001  bash\n  200 ttys002  gh copilot suggest --model gpt-4o\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("does not match 'gh' without 'copilot' argument", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  gh pr status\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("handles string PID by converting to number", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle("456"))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(456, 0);
    killSpy.mockRestore();
  });

  it("returns false for non-numeric PID", async () => {
    expect(await agent.isProcessRunning(makeProcessHandle("not-a-pid"))).toBe(false);
  });
});

// =========================================================================
// detectActivity — terminal output classification
// =========================================================================
describe("detectActivity", () => {
  const agent = create();

  it("returns idle for empty terminal output", () => {
    expect(agent.detectActivity("")).toBe("idle");
  });

  it("returns idle for whitespace-only terminal output", () => {
    expect(agent.detectActivity("   \n  ")).toBe("idle");
  });

  it("returns idle when last line is a bare > prompt", () => {
    expect(agent.detectActivity("some output\n> ")).toBe("idle");
  });

  it("returns idle when last line is a bare $ prompt", () => {
    expect(agent.detectActivity("some output\n$ ")).toBe("idle");
  });

  it("returns idle when last line is a bare # prompt", () => {
    expect(agent.detectActivity("some output\n# ")).toBe("idle");
  });

  it("returns idle when last line is a bare ? prompt", () => {
    expect(agent.detectActivity("some output\n? ")).toBe("idle");
  });

  it("returns waiting_input for '? What would you like to' prompt", () => {
    expect(
      agent.detectActivity("Suggestion: ls -la\n? What would you like to do?\n"),
    ).toBe("waiting_input");
  });

  it("returns waiting_input for (y)es / (n)o prompt", () => {
    expect(agent.detectActivity("Continue?\n(y)es / (n)o\n")).toBe("waiting_input");
  });

  it("returns waiting_input for 'Press Enter' prompt", () => {
    expect(agent.detectActivity("Suggestion ready\nPress Enter to confirm\n")).toBe(
      "waiting_input",
    );
  });

  it("returns active for non-empty terminal output with no special patterns", () => {
    expect(agent.detectActivity("Fetching suggestions from GitHub Copilot...\n")).toBe("active");
  });

  it("returns active for multi-line output with no prompt", () => {
    expect(
      agent.detectActivity("Thinking about your request\nSearching codebase\nGenerating...\n"),
    ).toBe("active");
  });
});

// =========================================================================
// getActivityState
// =========================================================================
describe("getActivityState", () => {
  const agent = create();

  it("returns exited when no runtimeHandle", async () => {
    const session = makeSession({ runtimeHandle: null });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("exited");
  });

  it("returns exited when process is not running", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux not running"));
    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("exited");
  });

  it("returns null (unknown) when process is running", async () => {
    mockTmuxWithProcess("gh", "copilot suggest --target shell");
    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    expect(await agent.getActivityState(session)).toBeNull();
  });

  it("returns exited when process handle has dead PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const session = makeSession({ runtimeHandle: makeProcessHandle(999) });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("exited");
    killSpy.mockRestore();
  });
});

// =========================================================================
// getSessionInfo
// =========================================================================
describe("getSessionInfo", () => {
  const agent = create();

  it("always returns null (not implemented)", async () => {
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
    expect(await agent.getSessionInfo(makeSession({ workspacePath: "/some/path" }))).toBeNull();
  });

  it("returns null even with null workspacePath", async () => {
    expect(await agent.getSessionInfo(makeSession({ workspacePath: null }))).toBeNull();
  });
});

// =========================================================================
// setupWorkspaceHooks — file writing behavior
// =========================================================================
describe("setupWorkspaceHooks", () => {
  const agent = create();

  it("has setupWorkspaceHooks method", () => {
    expect(typeof agent.setupWorkspaceHooks).toBe("function");
  });

  it("creates ~/.ao/bin directory", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });

    expect(mockMkdir).toHaveBeenCalledWith("/mock/home/.ao/bin", { recursive: true });
  });

  it("writes ao-metadata-helper.sh with executable permissions via atomic write", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });

    const helperWriteCall = mockWriteFile.mock.calls.find(
      (call: [string, string, object]) =>
        typeof call[0] === "string" && call[0].includes("ao-metadata-helper.sh.tmp."),
    );
    expect(helperWriteCall).toBeDefined();
    expect(helperWriteCall![1]).toContain("update_ao_metadata()");
    expect(helperWriteCall![2]).toEqual({ encoding: "utf-8", mode: 0o755 });

    const helperRenameCall = mockRename.mock.calls.find(
      (call: string[]) => typeof call[1] === "string" && call[1].endsWith("ao-metadata-helper.sh"),
    );
    expect(helperRenameCall).toBeDefined();
  });

  it("writes gh and git wrappers atomically when version marker is missing", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });

    const ghWriteCall = mockWriteFile.mock.calls.find(
      (call: [string, string, object]) =>
        typeof call[0] === "string" && call[0].includes("/gh.tmp."),
    );
    expect(ghWriteCall).toBeDefined();
    expect(ghWriteCall![1]).toContain("ao gh wrapper");

    const ghRenameCall = mockRename.mock.calls.find(
      (call: string[]) => typeof call[1] === "string" && call[1].endsWith("/gh"),
    );
    expect(ghRenameCall).toBeDefined();

    const gitWriteCall = mockWriteFile.mock.calls.find(
      (call: [string, string, object]) =>
        typeof call[0] === "string" && call[0].includes("/git.tmp."),
    );
    expect(gitWriteCall).toBeDefined();
    expect(gitWriteCall![1]).toContain("ao git wrapper");

    const gitRenameCall = mockRename.mock.calls.find(
      (call: string[]) => typeof call[1] === "string" && call[1].endsWith("/git"),
    );
    expect(gitRenameCall).toBeDefined();
  });

  it("skips wrapper writes when version marker matches", async () => {
    mockReadFile.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".ao-version")) {
        return Promise.resolve("0.1.0");
      }
      return Promise.reject(new Error("ENOENT"));
    });

    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });

    // Should still write the metadata helper (always written)
    const helperWriteCall = mockWriteFile.mock.calls.find(
      (call: [string, string, object]) =>
        typeof call[0] === "string" && call[0].includes("ao-metadata-helper.sh.tmp."),
    );
    expect(helperWriteCall).toBeDefined();

    // But should NOT write gh/git wrappers (version matches)
    const ghWriteCall = mockWriteFile.mock.calls.find(
      (call: [string, string, object]) =>
        typeof call[0] === "string" && call[0].includes("/gh.tmp."),
    );
    expect(ghWriteCall).toBeUndefined();
  });

  it("uses atomic write (temp + rename) to prevent partial reads", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });

    const tmpWrites = mockWriteFile.mock.calls.filter(
      (call: [string, string, object]) =>
        typeof call[0] === "string" && call[0].includes(".tmp."),
    );
    const renames = mockRename.mock.calls;

    // helper, gh, git, version marker = 4
    expect(tmpWrites.length).toBe(4);
    expect(renames.length).toBe(4);

    for (const [src, dst] of renames) {
      expect(src).toContain(".tmp.");
      expect(dst).not.toContain(".tmp.");
    }
  });

  it("appends ao section to AGENTS.md when not present", async () => {
    mockReadFile.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".ao-version")) {
        return Promise.resolve("0.1.0");
      }
      if (typeof path === "string" && path.endsWith("AGENTS.md")) {
        return Promise.resolve("# Existing Content\n\nSome stuff here.\n");
      }
      return Promise.reject(new Error("ENOENT"));
    });

    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });

    const agentsMdCall = mockWriteFile.mock.calls.find(
      (call: string[]) => typeof call[0] === "string" && call[0].endsWith("AGENTS.md"),
    );
    expect(agentsMdCall).toBeDefined();
    expect(agentsMdCall![1]).toContain("Agent Orchestrator (ao) Session");
    expect(agentsMdCall![1]).toContain("# Existing Content");
  });

  it("does not duplicate ao section in AGENTS.md if already present", async () => {
    mockReadFile.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".ao-version")) {
        return Promise.resolve("0.1.0");
      }
      if (typeof path === "string" && path.endsWith("AGENTS.md")) {
        return Promise.resolve(
          "# Existing\n\n## Agent Orchestrator (ao) Session\n\nAlready here.\n",
        );
      }
      return Promise.reject(new Error("ENOENT"));
    });

    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });

    const agentsMdCall = mockWriteFile.mock.calls.find(
      (call: string[]) => typeof call[0] === "string" && call[0].endsWith("AGENTS.md"),
    );
    expect(agentsMdCall).toBeUndefined();
  });
});

// =========================================================================
// postLaunchSetup
// =========================================================================
describe("postLaunchSetup", () => {
  const agent = create();

  it("has postLaunchSetup method", () => {
    expect(typeof agent.postLaunchSetup).toBe("function");
  });

  it("runs setup when session has workspacePath", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    await agent.postLaunchSetup!(makeSession({ workspacePath: "/workspace/test" }));
    expect(mockMkdir).toHaveBeenCalled();
  });

  it("returns early when session has no workspacePath", async () => {
    await agent.postLaunchSetup!(makeSession({ workspacePath: undefined }));
    expect(mockMkdir).not.toHaveBeenCalled();
  });
});
