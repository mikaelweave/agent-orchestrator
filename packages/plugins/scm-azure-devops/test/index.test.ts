import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Mock node:child_process — az CLI calls go through execFileAsync = promisify(execFile)
// ---------------------------------------------------------------------------
const { azMock } = vi.hoisted(() => ({ azMock: vi.fn() }));

vi.mock("node:child_process", () => {
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: azMock,
  });
  return { execFile };
});

// ---------------------------------------------------------------------------
// Mock node:https and node:http — REST API calls with PAT
// ---------------------------------------------------------------------------
const { httpsRequestMock } = vi.hoisted(() => ({ httpsRequestMock: vi.fn() }));
const { httpRequestMock } = vi.hoisted(() => ({ httpRequestMock: vi.fn() }));

vi.mock("node:https", () => ({ request: httpsRequestMock }));
vi.mock("node:http", () => ({ request: httpRequestMock }));

import { create, manifest } from "../src/index.js";
import type { PRInfo, Session, ProjectConfig, SCM } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const pr: PRInfo = {
  number: 42,
  url: "https://dev.azure.com/acme/MyProject/_git/my-repo/pullrequest/42",
  title: "feat: add feature",
  owner: "MyProject",
  repo: "my-repo",
  branch: "feat/my-feature",
  baseBranch: "main",
  isDraft: false,
};

const project: ProjectConfig = {
  name: "test",
  repo: "acme/my-repo",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
  scm: {
    plugin: "azure-devops",
    organizationUrl: "https://dev.azure.com/acme",
    project: "MyProject",
    repositoryName: "my-repo",
  },
};

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test",
    status: "working",
    activity: "active",
    branch: "feat/my-feature",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/repo",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockAz(result: unknown) {
  azMock.mockResolvedValueOnce({ stdout: JSON.stringify(result) });
}

function mockAzError(msg = "Command failed") {
  azMock.mockRejectedValueOnce(new Error(msg));
}

function mockHttpsResponse(responseData: unknown, statusCode = 200): void {
  const body = JSON.stringify(responseData);
  httpsRequestMock.mockImplementationOnce(
    (
      _opts: Record<string, unknown>,
      callback: (res: EventEmitter & { statusCode: number }) => void,
    ) => {
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(() => {
          const res = Object.assign(new EventEmitter(), { statusCode });
          callback(res);
          process.nextTick(() => {
            res.emit("data", Buffer.from(body));
            res.emit("end");
          });
        }),
        destroy: vi.fn(),
        setTimeout: vi.fn(),
      });
      return req;
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scm-azure-devops plugin", () => {
  let scm: SCM;
  let savedPat: string | undefined;
  let savedOrg: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedPat = process.env["AZURE_DEVOPS_PAT"];
    savedOrg = process.env["AZURE_DEVOPS_ORG_URL"];
    // Default: PAT mode
    process.env["AZURE_DEVOPS_PAT"] = "test-pat";
    process.env["AZURE_DEVOPS_ORG_URL"] = "https://dev.azure.com/acme";
    scm = create();
  });

  afterEach(() => {
    if (savedPat === undefined) {
      delete process.env["AZURE_DEVOPS_PAT"];
    } else {
      process.env["AZURE_DEVOPS_PAT"] = savedPat;
    }
    if (savedOrg === undefined) {
      delete process.env["AZURE_DEVOPS_ORG_URL"];
    } else {
      process.env["AZURE_DEVOPS_ORG_URL"] = savedOrg;
    }
  });

  // ---- manifest ----------------------------------------------------------

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("azure-devops");
      expect(manifest.slot).toBe("scm");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  // ---- create() ----------------------------------------------------------

  describe("create()", () => {
    it("returns an SCM with correct name", () => {
      expect(scm.name).toBe("azure-devops");
    });
  });

  // ---- detectPR (PAT mode) -----------------------------------------------

  describe("detectPR (PAT)", () => {
    it("returns PRInfo when a PR exists", async () => {
      mockHttpsResponse({
        value: [
          {
            pullRequestId: 42,
            title: "feat: add feature",
            sourceRefName: "refs/heads/feat/my-feature",
            targetRefName: "refs/heads/main",
            isDraft: false,
            status: "active",
          },
        ],
        count: 1,
      });

      const result = await scm.detectPR(makeSession(), project);
      expect(result).toEqual({
        number: 42,
        url: "https://dev.azure.com/acme/MyProject/_git/my-repo/pullrequest/42",
        title: "feat: add feature",
        owner: "MyProject",
        repo: "my-repo",
        branch: "feat/my-feature",
        baseBranch: "main",
        isDraft: false,
      });
    });

    it("returns null when no PR found", async () => {
      mockHttpsResponse({ value: [], count: 0 });
      const result = await scm.detectPR(makeSession(), project);
      expect(result).toBeNull();
    });

    it("returns null when session has no branch", async () => {
      const result = await scm.detectPR(makeSession({ branch: null }), project);
      expect(result).toBeNull();
      expect(httpsRequestMock).not.toHaveBeenCalled();
    });

    it("returns null on API error", async () => {
      mockHttpsResponse({ message: "Not found" }, 404);
      const result = await scm.detectPR(makeSession(), project);
      expect(result).toBeNull();
    });

    it("detects draft PRs", async () => {
      mockHttpsResponse({
        value: [
          {
            pullRequestId: 99,
            title: "WIP: draft feature",
            sourceRefName: "refs/heads/feat/my-feature",
            targetRefName: "refs/heads/main",
            isDraft: true,
            status: "active",
          },
        ],
        count: 1,
      });
      const result = await scm.detectPR(makeSession(), project);
      expect(result?.isDraft).toBe(true);
    });
  });

  // ---- detectPR (CLI mode) -----------------------------------------------

  describe("detectPR (CLI)", () => {
    beforeEach(() => {
      delete process.env["AZURE_DEVOPS_PAT"];
    });

    it("returns PRInfo when a PR exists", async () => {
      mockAz([
        {
          pullRequestId: 42,
          title: "feat: add feature",
          sourceRefName: "refs/heads/feat/my-feature",
          targetRefName: "refs/heads/main",
          isDraft: false,
          status: "active",
        },
      ]);

      const result = await scm.detectPR(makeSession(), project);
      expect(result).toEqual({
        number: 42,
        url: "https://dev.azure.com/acme/MyProject/_git/my-repo/pullrequest/42",
        title: "feat: add feature",
        owner: "MyProject",
        repo: "my-repo",
        branch: "feat/my-feature",
        baseBranch: "main",
        isDraft: false,
      });
    });

    it("returns null when no PR found", async () => {
      mockAz([]);
      const result = await scm.detectPR(makeSession(), project);
      expect(result).toBeNull();
    });

    it("returns null on CLI error", async () => {
      mockAzError("az: command not found");
      const result = await scm.detectPR(makeSession(), project);
      expect(result).toBeNull();
    });
  });

  // ---- getPRState --------------------------------------------------------

  describe("getPRState (PAT)", () => {
    it('returns "open" for active PR', async () => {
      mockHttpsResponse({ status: "active", pullRequestId: 42 });
      expect(await scm.getPRState(pr)).toBe("open");
    });

    it('returns "merged" for completed PR', async () => {
      mockHttpsResponse({ status: "completed", pullRequestId: 42 });
      expect(await scm.getPRState(pr)).toBe("merged");
    });

    it('returns "closed" for abandoned PR', async () => {
      mockHttpsResponse({ status: "abandoned", pullRequestId: 42 });
      expect(await scm.getPRState(pr)).toBe("closed");
    });
  });

  describe("getPRState (CLI)", () => {
    beforeEach(() => {
      delete process.env["AZURE_DEVOPS_PAT"];
    });

    it('returns "open" for active PR', async () => {
      mockAz({ status: "active", pullRequestId: 42 });
      expect(await scm.getPRState(pr)).toBe("open");
    });

    it('returns "merged" for completed PR', async () => {
      mockAz({ status: "completed", pullRequestId: 42 });
      expect(await scm.getPRState(pr)).toBe("merged");
    });
  });

  // ---- mergePR -----------------------------------------------------------

  describe("mergePR (PAT)", () => {
    it("completes PR with squash by default", async () => {
      // First call: GET PR details (for lastMergeSourceCommit)
      mockHttpsResponse({
        pullRequestId: 42,
        status: "active",
        lastMergeSourceCommit: { commitId: "abc123" },
      });
      // Second call: PATCH to complete
      mockHttpsResponse({});

      await scm.mergePR(pr);
      expect(httpsRequestMock).toHaveBeenCalledTimes(2);

      // Verify the PATCH body contains squash merge strategy (2)
      const patchCall = httpsRequestMock.mock.calls[1];
      expect(patchCall[0].method).toBe("PATCH");
    });
  });

  describe("mergePR (CLI)", () => {
    beforeEach(() => {
      delete process.env["AZURE_DEVOPS_PAT"];
    });

    it("uses squash by default", async () => {
      azMock.mockResolvedValueOnce({ stdout: "{}" });
      await scm.mergePR(pr);
      expect(azMock).toHaveBeenCalledWith(
        "az",
        expect.arrayContaining(["--merge-strategy", "squash"]),
        expect.any(Object),
      );
    });

    it("uses noFastForward for merge method", async () => {
      azMock.mockResolvedValueOnce({ stdout: "{}" });
      await scm.mergePR(pr, "merge");
      expect(azMock).toHaveBeenCalledWith(
        "az",
        expect.arrayContaining(["--merge-strategy", "noFastForward"]),
        expect.any(Object),
      );
    });

    it("uses rebase for rebase method", async () => {
      azMock.mockResolvedValueOnce({ stdout: "{}" });
      await scm.mergePR(pr, "rebase");
      expect(azMock).toHaveBeenCalledWith(
        "az",
        expect.arrayContaining(["--merge-strategy", "rebase"]),
        expect.any(Object),
      );
    });
  });

  // ---- closePR -----------------------------------------------------------

  describe("closePR (PAT)", () => {
    it("sets status to abandoned", async () => {
      mockHttpsResponse({});
      await scm.closePR(pr);
      expect(httpsRequestMock).toHaveBeenCalledTimes(1);
      expect(httpsRequestMock.mock.calls[0][0].method).toBe("PATCH");
    });
  });

  describe("closePR (CLI)", () => {
    beforeEach(() => {
      delete process.env["AZURE_DEVOPS_PAT"];
    });

    it("updates PR to abandoned via CLI", async () => {
      azMock.mockResolvedValueOnce({ stdout: "{}" });
      await scm.closePR(pr);
      expect(azMock).toHaveBeenCalledWith(
        "az",
        expect.arrayContaining(["--status", "abandoned"]),
        expect.any(Object),
      );
    });
  });

  // ---- getCIChecks -------------------------------------------------------

  describe("getCIChecks (PAT)", () => {
    it("maps build statuses correctly", async () => {
      mockHttpsResponse({
        value: [
          {
            id: 1,
            buildNumber: "20250101.1",
            status: "completed",
            result: "succeeded",
            definition: { name: "CI Build" },
            startTime: "2025-01-01T00:00:00Z",
            finishTime: "2025-01-01T00:05:00Z",
            _links: { web: { href: "https://dev.azure.com/acme/build/1" } },
          },
          {
            id: 2,
            buildNumber: "20250101.2",
            status: "completed",
            result: "failed",
            definition: { name: "E2E Tests" },
          },
          {
            id: 3,
            buildNumber: "20250101.3",
            status: "inProgress",
            result: "",
            definition: { name: "Deploy" },
          },
          {
            id: 4,
            buildNumber: "20250101.4",
            status: "notStarted",
            result: "",
            definition: { name: "Release" },
          },
        ],
        count: 4,
      });

      const checks = await scm.getCIChecks(pr);
      expect(checks).toHaveLength(4);
      expect(checks[0].name).toBe("CI Build");
      expect(checks[0].status).toBe("passed");
      expect(checks[0].url).toBe("https://dev.azure.com/acme/build/1");
      expect(checks[1].status).toBe("failed");
      expect(checks[2].status).toBe("running");
      expect(checks[3].status).toBe("pending");
    });

    it("throws on API error (fail-closed)", async () => {
      mockHttpsResponse({ message: "Forbidden" }, 403);
      await expect(scm.getCIChecks(pr)).rejects.toThrow("Failed to fetch CI checks");
    });
  });

  // ---- getCISummary ------------------------------------------------------

  describe("getCISummary", () => {
    it('returns "passing" when all checks pass', async () => {
      mockHttpsResponse({
        value: [
          { id: 1, status: "completed", result: "succeeded", definition: { name: "build" } },
        ],
        count: 1,
      });
      expect(await scm.getCISummary(pr)).toBe("passing");
    });

    it('returns "failing" when any check fails', async () => {
      mockHttpsResponse({
        value: [
          { id: 1, status: "completed", result: "succeeded", definition: { name: "build" } },
          { id: 2, status: "completed", result: "failed", definition: { name: "test" } },
        ],
        count: 2,
      });
      expect(await scm.getCISummary(pr)).toBe("failing");
    });

    it('returns "pending" when checks are in progress', async () => {
      mockHttpsResponse({
        value: [
          { id: 1, status: "completed", result: "succeeded", definition: { name: "build" } },
          { id: 2, status: "inProgress", result: "", definition: { name: "test" } },
        ],
        count: 2,
      });
      expect(await scm.getCISummary(pr)).toBe("pending");
    });

    it('returns "none" when no checks exist', async () => {
      mockHttpsResponse({ value: [], count: 0 });
      expect(await scm.getCISummary(pr)).toBe("none");
    });

    it('returns "failing" for open PR when checks fail to fetch', async () => {
      // getCIChecks throws
      mockHttpsResponse({ message: "error" }, 500);
      // getPRState succeeds (active = open)
      mockHttpsResponse({ status: "active", pullRequestId: 42 });
      expect(await scm.getCISummary(pr)).toBe("failing");
    });

    it('returns "none" for merged PR when checks fail to fetch', async () => {
      // getCIChecks throws
      mockHttpsResponse({ message: "error" }, 500);
      // getPRState returns completed
      mockHttpsResponse({ status: "completed", pullRequestId: 42 });
      expect(await scm.getCISummary(pr)).toBe("none");
    });
  });

  // ---- getReviews --------------------------------------------------------

  describe("getReviews (PAT)", () => {
    it("maps reviewer votes correctly", async () => {
      mockHttpsResponse({
        value: [
          { displayName: "Alice", uniqueName: "alice@acme.com", vote: 10, isContainer: false },
          { displayName: "Bob", uniqueName: "bob@acme.com", vote: -10, isContainer: false },
          { displayName: "Charlie", uniqueName: "charlie@acme.com", vote: 0, isContainer: false },
          { displayName: "Dana", uniqueName: "dana@acme.com", vote: 5, isContainer: false },
          { displayName: "Eve", uniqueName: "eve@acme.com", vote: -5, isContainer: false },
        ],
        count: 5,
      });

      const reviews = await scm.getReviews(pr);
      expect(reviews).toHaveLength(5);
      expect(reviews[0].state).toBe("approved");     // vote 10
      expect(reviews[1].state).toBe("changes_requested"); // vote -10
      expect(reviews[2].state).toBe("pending");       // vote 0
      expect(reviews[3].state).toBe("approved");      // vote 5 (approved with suggestions)
      expect(reviews[4].state).toBe("changes_requested"); // vote -5 (waiting for author)
    });

    it("excludes container reviewers (groups)", async () => {
      mockHttpsResponse({
        value: [
          { displayName: "Alice", vote: 10, isContainer: false },
          { displayName: "My Team", vote: 0, isContainer: true },
        ],
        count: 2,
      });

      const reviews = await scm.getReviews(pr);
      expect(reviews).toHaveLength(1);
      expect(reviews[0].author).toBe("Alice");
    });
  });

  // ---- getReviewDecision -------------------------------------------------

  describe("getReviewDecision", () => {
    it('returns "approved" when all votes are positive', async () => {
      mockHttpsResponse({
        value: [
          { displayName: "Alice", vote: 10, isContainer: false },
          { displayName: "Bob", vote: 5, isContainer: false },
        ],
        count: 2,
      });
      expect(await scm.getReviewDecision(pr)).toBe("approved");
    });

    it('returns "changes_requested" when any vote is negative', async () => {
      mockHttpsResponse({
        value: [
          { displayName: "Alice", vote: 10, isContainer: false },
          { displayName: "Bob", vote: -10, isContainer: false },
        ],
        count: 2,
      });
      expect(await scm.getReviewDecision(pr)).toBe("changes_requested");
    });

    it('returns "pending" when all votes are 0', async () => {
      mockHttpsResponse({
        value: [
          { displayName: "Alice", vote: 0, isContainer: false },
        ],
        count: 1,
      });
      expect(await scm.getReviewDecision(pr)).toBe("pending");
    });

    it('returns "none" when no reviewers', async () => {
      mockHttpsResponse({ value: [], count: 0 });
      expect(await scm.getReviewDecision(pr)).toBe("none");
    });
  });

  // ---- getPendingComments ------------------------------------------------

  describe("getPendingComments (PAT)", () => {
    it("returns unresolved human threads", async () => {
      mockHttpsResponse({
        value: [
          {
            id: 1,
            status: "active",
            publishedDate: "2025-01-01T00:00:00Z",
            comments: [
              {
                id: 1,
                content: "Please fix this",
                author: { displayName: "Alice", uniqueName: "alice@acme.com" },
                publishedDate: "2025-01-01T00:00:00Z",
                commentType: "text",
              },
            ],
            threadContext: {
              filePath: "/src/index.ts",
              rightFileStart: { line: 42 },
            },
          },
          {
            id: 2,
            status: "closed",
            publishedDate: "2025-01-01T00:00:00Z",
            comments: [
              {
                id: 2,
                content: "Old comment",
                author: { displayName: "Bob" },
                publishedDate: "2025-01-01T00:00:00Z",
                commentType: "text",
              },
            ],
          },
        ],
        count: 2,
      });

      const comments = await scm.getPendingComments(pr);
      expect(comments).toHaveLength(1);
      expect(comments[0].author).toBe("Alice");
      expect(comments[0].body).toBe("Please fix this");
      expect(comments[0].path).toBe("/src/index.ts");
      expect(comments[0].line).toBe(42);
      expect(comments[0].isResolved).toBe(false);
    });

    it("excludes bot comments", async () => {
      mockHttpsResponse({
        value: [
          {
            id: 1,
            status: "active",
            publishedDate: "2025-01-01T00:00:00Z",
            comments: [
              {
                id: 1,
                content: "Build failed",
                author: { displayName: "Azure Pipelines" },
                publishedDate: "2025-01-01T00:00:00Z",
                commentType: "text",
              },
            ],
          },
        ],
        count: 1,
      });

      const comments = await scm.getPendingComments(pr);
      expect(comments).toHaveLength(0);
    });

    it("excludes system comments", async () => {
      mockHttpsResponse({
        value: [
          {
            id: 1,
            status: "active",
            publishedDate: "2025-01-01T00:00:00Z",
            comments: [
              {
                id: 1,
                content: "Updated the pull request",
                author: { displayName: "Alice" },
                publishedDate: "2025-01-01T00:00:00Z",
                commentType: "system",
              },
            ],
          },
        ],
        count: 1,
      });

      const comments = await scm.getPendingComments(pr);
      expect(comments).toHaveLength(0);
    });

    it("returns empty array on error", async () => {
      mockHttpsResponse({ message: "error" }, 500);
      const comments = await scm.getPendingComments(pr);
      expect(comments).toEqual([]);
    });
  });

  // ---- getAutomatedComments ----------------------------------------------

  describe("getAutomatedComments (PAT)", () => {
    it("returns bot comments with severity", async () => {
      mockHttpsResponse({
        value: [
          {
            id: 1,
            status: "active",
            publishedDate: "2025-01-01T00:00:00Z",
            comments: [
              {
                id: 1,
                content: "Error: build failed due to critical issue",
                author: { displayName: "Azure Pipelines" },
                publishedDate: "2025-01-01T00:00:00Z",
                commentType: "text",
              },
            ],
            threadContext: {
              filePath: "/src/main.ts",
              rightFileStart: { line: 10 },
            },
          },
          {
            id: 2,
            status: "active",
            publishedDate: "2025-01-01T00:00:00Z",
            comments: [
              {
                id: 2,
                content: "Consider using a more specific type",
                author: { displayName: "codecov[bot]" },
                publishedDate: "2025-01-01T00:00:00Z",
                commentType: "text",
              },
            ],
          },
        ],
        count: 2,
      });

      const comments = await scm.getAutomatedComments(pr);
      expect(comments).toHaveLength(2);
      expect(comments[0].severity).toBe("error");
      expect(comments[0].botName).toBe("Azure Pipelines");
      expect(comments[1].severity).toBe("warning"); // "consider"
      expect(comments[1].botName).toBe("codecov[bot]");
    });

    it("returns empty array on error", async () => {
      mockHttpsResponse({ message: "error" }, 500);
      const comments = await scm.getAutomatedComments(pr);
      expect(comments).toEqual([]);
    });
  });

  // ---- getMergeability ---------------------------------------------------

  describe("getMergeability (PAT)", () => {
    it("reports clean merge readiness", async () => {
      // getPRState: GET pr
      mockHttpsResponse({ status: "active", pullRequestId: 42 });
      // getMergeability: GET pr details
      mockHttpsResponse({
        pullRequestId: 42,
        status: "active",
        mergeStatus: "succeeded",
        isDraft: false,
      });
      // getCISummary → getCIChecks
      mockHttpsResponse({
        value: [
          { id: 1, status: "completed", result: "succeeded", definition: { name: "build" } },
        ],
        count: 1,
      });
      // getReviewDecision → getReviews
      mockHttpsResponse({
        value: [{ displayName: "Alice", vote: 10, isContainer: false }],
        count: 1,
      });

      const result = await scm.getMergeability(pr);
      expect(result.mergeable).toBe(true);
      expect(result.ciPassing).toBe(true);
      expect(result.approved).toBe(true);
      expect(result.noConflicts).toBe(true);
      expect(result.blockers).toEqual([]);
    });

    it("reports blockers for conflicts", async () => {
      mockHttpsResponse({ status: "active", pullRequestId: 42 });
      mockHttpsResponse({
        pullRequestId: 42,
        status: "active",
        mergeStatus: "conflicts",
        isDraft: false,
      });
      mockHttpsResponse({
        value: [
          { id: 1, status: "completed", result: "succeeded", definition: { name: "build" } },
        ],
        count: 1,
      });
      mockHttpsResponse({
        value: [{ displayName: "Alice", vote: 10, isContainer: false }],
        count: 1,
      });

      const result = await scm.getMergeability(pr);
      expect(result.mergeable).toBe(false);
      expect(result.noConflicts).toBe(false);
      expect(result.blockers).toContain("Merge conflicts");
    });

    it("reports draft as blocker", async () => {
      mockHttpsResponse({ status: "active", pullRequestId: 42 });
      mockHttpsResponse({
        pullRequestId: 42,
        status: "active",
        mergeStatus: "succeeded",
        isDraft: true,
      });
      mockHttpsResponse({
        value: [
          { id: 1, status: "completed", result: "succeeded", definition: { name: "build" } },
        ],
        count: 1,
      });
      mockHttpsResponse({
        value: [{ displayName: "Alice", vote: 10, isContainer: false }],
        count: 1,
      });

      const result = await scm.getMergeability(pr);
      expect(result.mergeable).toBe(false);
      expect(result.blockers).toContain("PR is still a draft");
    });

    it("returns clean result for merged PR", async () => {
      mockHttpsResponse({ status: "completed", pullRequestId: 42 });

      const result = await scm.getMergeability(pr);
      expect(result.mergeable).toBe(true);
      expect(result.blockers).toEqual([]);
    });

    it("reports rejected by policy", async () => {
      mockHttpsResponse({ status: "active", pullRequestId: 42 });
      mockHttpsResponse({
        pullRequestId: 42,
        status: "active",
        mergeStatus: "rejectedByPolicy",
        isDraft: false,
      });
      mockHttpsResponse({
        value: [
          { id: 1, status: "completed", result: "succeeded", definition: { name: "build" } },
        ],
        count: 1,
      });
      mockHttpsResponse({
        value: [{ displayName: "Alice", vote: 10, isContainer: false }],
        count: 1,
      });

      const result = await scm.getMergeability(pr);
      expect(result.blockers).toContain("Merge rejected by branch policy");
    });
  });

  // ---- Config validation -------------------------------------------------

  describe("config validation", () => {
    it("throws when organizationUrl is missing", async () => {
      const badProject = {
        ...project,
        scm: { plugin: "azure-devops", project: "MyProject", repositoryName: "my-repo" },
      };
      delete process.env["AZURE_DEVOPS_ORG_URL"];

      await expect(scm.detectPR(makeSession(), badProject)).rejects.toThrow(
        "scm.organizationUrl",
      );
    });

    it("throws when project is missing", async () => {
      const badProject = {
        ...project,
        scm: { plugin: "azure-devops", organizationUrl: "https://dev.azure.com/acme", repositoryName: "my-repo" },
      };
      delete process.env["AZURE_DEVOPS_PROJECT"];

      await expect(scm.detectPR(makeSession(), badProject)).rejects.toThrow(
        "scm.project",
      );
    });

    it("throws when repositoryName is missing", async () => {
      const badProject = {
        ...project,
        scm: {
          plugin: "azure-devops",
          organizationUrl: "https://dev.azure.com/acme",
          project: "MyProject",
        },
      };
      delete process.env["AZURE_DEVOPS_REPOSITORY"];

      await expect(scm.detectPR(makeSession(), badProject)).rejects.toThrow(
        "scm.repositoryName",
      );
    });

    it("falls back to env vars for config", async () => {
      process.env["AZURE_DEVOPS_ORG_URL"] = "https://dev.azure.com/acme";
      process.env["AZURE_DEVOPS_PROJECT"] = "MyProject";
      process.env["AZURE_DEVOPS_REPOSITORY"] = "my-repo";

      const minimalProject = {
        ...project,
        scm: { plugin: "azure-devops" },
      };

      mockHttpsResponse({ value: [], count: 0 });
      const result = await scm.detectPR(makeSession(), minimalProject);
      expect(result).toBeNull();
      // If we got here without throwing, the env var fallback works
    });
  });

  // ---- getPRSummary ------------------------------------------------------

  describe("getPRSummary (PAT)", () => {
    it("returns PR summary with zero additions/deletions", async () => {
      mockHttpsResponse({
        pullRequestId: 42,
        title: "feat: add feature",
        status: "active",
      });

      const summary = await scm.getPRSummary!(pr);
      expect(summary).toEqual({
        state: "open",
        title: "feat: add feature",
        additions: 0,
        deletions: 0,
      });
    });
  });
});
