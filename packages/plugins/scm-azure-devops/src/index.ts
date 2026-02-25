/**
 * scm-azure-devops plugin — Azure DevOps PRs, CI checks, reviews, merge readiness.
 *
 * Dual auth: uses AZURE_DEVOPS_PAT (REST API) when set, otherwise falls back
 * to the `az` CLI (`az repos pr` commands, requires `az login`).
 */

import { execFile } from "node:child_process";
import { request } from "node:https";
import { request as httpRequest } from "node:http";
import { promisify } from "node:util";
import {
  CI_STATUS,
  type PluginModule,
  type SCM,
  type Session,
  type ProjectConfig,
  type PRInfo,
  type PRState,
  type MergeMethod,
  type CICheck,
  type CIStatus,
  type Review,
  type ReviewDecision,
  type ReviewComment,
  type AutomatedComment,
  type MergeReadiness,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

const API_VERSION = "7.1";

/** Known bot / service identities in Azure DevOps */
const BOT_AUTHORS = new Set([
  "Azure Pipelines",
  "Microsoft.VisualStudio.Services.TFS",
  "Project Collection Build Service",
  "Build Service",
  "Boards",
  "codecov[bot]",
  "sonarcloud[bot]",
  "dependabot[bot]",
  "renovate[bot]",
]);

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

interface SCMSettings {
  organizationUrl: string;
  projectName: string;
  repositoryName: string;
}

function getSCMSettings(project: ProjectConfig): SCMSettings {
  const scm = project.scm;

  const orgValue = scm?.["organizationUrl"] ?? process.env["AZURE_DEVOPS_ORG_URL"];
  const projectValue = scm?.["project"] ?? process.env["AZURE_DEVOPS_PROJECT"];
  const repoValue = scm?.["repositoryName"] ?? process.env["AZURE_DEVOPS_REPOSITORY"];

  if (typeof orgValue !== "string" || orgValue.trim() === "") {
    throw new Error(
      "Azure DevOps SCM requires scm.organizationUrl (or AZURE_DEVOPS_ORG_URL env var)",
    );
  }
  if (typeof projectValue !== "string" || projectValue.trim() === "") {
    throw new Error(
      "Azure DevOps SCM requires scm.project (or AZURE_DEVOPS_PROJECT env var)",
    );
  }
  if (typeof repoValue !== "string" || repoValue.trim() === "") {
    throw new Error(
      "Azure DevOps SCM requires scm.repositoryName (or AZURE_DEVOPS_REPOSITORY env var)",
    );
  }

  return {
    organizationUrl: orgValue.trim().replace(/\/+$/, ""),
    projectName: projectValue.trim(),
    repositoryName: repoValue.trim(),
  };
}

function getPat(): string | null {
  const pat = process.env["AZURE_DEVOPS_PAT"];
  if (!pat || pat.trim() === "") return null;
  return pat.trim();
}

// ---------------------------------------------------------------------------
// CLI helper — `az repos pr` (fallback when no PAT)
// ---------------------------------------------------------------------------

async function az(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("az", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`az ${args.slice(0, 4).join(" ")} failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

// ---------------------------------------------------------------------------
// REST API helper — direct HTTPS with PAT auth
// ---------------------------------------------------------------------------

function requestAzureDevOps<T>(
  method: "GET" | "POST" | "PATCH",
  url: URL,
  pat: string,
  body?: unknown,
): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const auth = `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? request : httpRequest;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const req = transport(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          Accept: "application/json",
          Authorization: auth,
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("error", (err: Error) => settle(() => reject(err)));
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          settle(() => {
            const text = Buffer.concat(chunks).toString("utf-8");
            const status = res.statusCode ?? 0;

            if (status < 200 || status >= 300) {
              reject(
                new Error(`Azure DevOps API returned HTTP ${status}: ${text.slice(0, 400)}`),
              );
              return;
            }

            if (text.trim() === "") {
              resolve(undefined as T);
              return;
            }

            try {
              resolve(JSON.parse(text) as T);
            } catch (err) {
              reject(
                new Error(
                  `Failed to parse Azure DevOps API JSON response: ${(err as Error).message}`,
                ),
              );
            }
          });
        });
      },
    );

    req.setTimeout(30_000, () => {
      settle(() => {
        req.destroy();
        reject(new Error("Azure DevOps API request timed out after 30s"));
      });
    });

    req.on("error", (err) => settle(() => reject(err)));
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function parseDate(val: string | undefined | null): Date {
  if (!val) return new Date(0);
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

function mapPRState(status: string): PRState {
  const s = status.toLowerCase();
  if (s === "completed") return "merged";
  if (s === "abandoned") return "closed";
  return "open"; // "active" or anything else
}

/**
 * Map Azure DevOps reviewer vote to Review state.
 * Votes: 10 = approved, 5 = approved with suggestions, 0 = no vote,
 *       -5 = waiting for author, -10 = rejected
 */
function mapVoteToReviewState(vote: number): Review["state"] {
  if (vote >= 10) return "approved";
  if (vote === 5) return "approved"; // approved with suggestions
  if (vote <= -10) return "changes_requested";
  if (vote === -5) return "changes_requested"; // waiting for author
  return "pending";
}

function buildApiUrl(settings: SCMSettings, path: string): URL {
  const url = new URL(
    `${settings.organizationUrl}/${encodeURIComponent(settings.projectName)}/_apis/${path}`,
  );
  url.searchParams.set("api-version", API_VERSION);
  return url;
}

function buildPrUrl(settings: SCMSettings, prId: number): string {
  return `${settings.organizationUrl}/${encodeURIComponent(settings.projectName)}/_git/${encodeURIComponent(settings.repositoryName)}/pullrequest/${prId}`;
}

// ---------------------------------------------------------------------------
// Azure DevOps API response types
// ---------------------------------------------------------------------------

interface AzureDevOpsPR {
  pullRequestId: number;
  title: string;
  status: string;
  sourceRefName: string;
  targetRefName: string;
  isDraft: boolean;
  url: string;
  mergeStatus?: string;
  repository?: {
    id: string;
    name: string;
    project?: {
      name: string;
    };
  };
}

interface AzureDevOpsReviewer {
  displayName: string;
  uniqueName?: string;
  vote: number;
  isContainer?: boolean;
}

interface AzureDevOpsThread {
  id: number;
  status: string;
  publishedDate: string;
  comments: Array<{
    id: number;
    content: string;
    author: {
      displayName: string;
      uniqueName?: string;
    };
    publishedDate: string;
    commentType: string;
  }>;
  threadContext?: {
    filePath?: string;
    rightFileStart?: {
      line: number;
    };
  };
}

interface AzureDevOpsBuild {
  id: number;
  buildNumber: string;
  status: string;
  result: string;
  definition: {
    name: string;
  };
  startTime?: string;
  finishTime?: string;
  _links?: {
    web?: {
      href?: string;
    };
  };
}

interface AzureDevOpsListResponse<T> {
  value: T[];
  count: number;
}

// ---------------------------------------------------------------------------
// SCM implementation
// ---------------------------------------------------------------------------

function createAzureDevOpsSCM(): SCM {
  return {
    name: "azure-devops",

    // ----- detectPR -----

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      if (!session.branch) return null;

      const settings = getSCMSettings(project);
      const pat = getPat();

      try {
        if (pat) {
          const url = buildApiUrl(
            settings,
            `git/repositories/${encodeURIComponent(settings.repositoryName)}/pullrequests`,
          );
          url.searchParams.set("searchCriteria.sourceRefName", `refs/heads/${session.branch}`);
          url.searchParams.set("searchCriteria.status", "active");
          url.searchParams.set("$top", "1");

          const data = await requestAzureDevOps<AzureDevOpsListResponse<AzureDevOpsPR>>(
            "GET",
            url,
            pat,
          );

          if (!data.value || data.value.length === 0) return null;

          const pr = data.value[0];
          return {
            number: pr.pullRequestId,
            url: buildPrUrl(settings, pr.pullRequestId),
            title: pr.title,
            owner: settings.projectName,
            repo: settings.repositoryName,
            branch: pr.sourceRefName.replace("refs/heads/", ""),
            baseBranch: pr.targetRefName.replace("refs/heads/", ""),
            isDraft: pr.isDraft ?? false,
          };
        }

        // CLI fallback
        const raw = await az([
          "repos",
          "pr",
          "list",
          "--repository",
          settings.repositoryName,
          "--project",
          settings.projectName,
          "--org",
          settings.organizationUrl,
          "--source-branch",
          session.branch,
          "--status",
          "active",
          "--top",
          "1",
          "--output",
          "json",
        ]);

        const prs: AzureDevOpsPR[] = JSON.parse(raw);
        if (!Array.isArray(prs) || prs.length === 0) return null;

        const pr = prs[0];
        return {
          number: pr.pullRequestId,
          url: buildPrUrl(settings, pr.pullRequestId),
          title: pr.title,
          owner: settings.projectName,
          repo: settings.repositoryName,
          branch: pr.sourceRefName.replace("refs/heads/", ""),
          baseBranch: pr.targetRefName.replace("refs/heads/", ""),
          isDraft: pr.isDraft ?? false,
        };
      } catch {
        return null;
      }
    },

    // ----- getPRState -----

    async getPRState(pr: PRInfo): Promise<PRState> {
      const settings = settingsFromPR(pr);
      const pat = getPat();

      if (pat) {
        const url = buildApiUrl(
          settings,
          `git/pullrequests/${pr.number}`,
        );
        const data = await requestAzureDevOps<AzureDevOpsPR>("GET", url, pat);
        return mapPRState(data.status);
      }

      const raw = await az([
        "repos",
        "pr",
        "show",
        "--id",
        String(pr.number),
        "--org",
        settings.organizationUrl,
        "--output",
        "json",
      ]);
      const data: AzureDevOpsPR = JSON.parse(raw);
      return mapPRState(data.status);
    },

    // ----- getPRSummary -----

    async getPRSummary(pr: PRInfo) {
      const settings = settingsFromPR(pr);
      const pat = getPat();

      let prData: AzureDevOpsPR;
      if (pat) {
        const url = buildApiUrl(settings, `git/pullrequests/${pr.number}`);
        prData = await requestAzureDevOps<AzureDevOpsPR>("GET", url, pat);
      } else {
        const raw = await az([
          "repos",
          "pr",
          "show",
          "--id",
          String(pr.number),
          "--org",
          settings.organizationUrl,
          "--output",
          "json",
        ]);
        prData = JSON.parse(raw);
      }

      // Azure DevOps doesn't provide additions/deletions in the PR response.
      // We'd need to iterate over iterations/changes which is expensive.
      // Return 0 as a reasonable default — callers handle this gracefully.
      return {
        state: mapPRState(prData.status),
        title: prData.title ?? "",
        additions: 0,
        deletions: 0,
      };
    },

    // ----- mergePR -----

    async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
      const settings = settingsFromPR(pr);
      const pat = getPat();

      // Azure DevOps merge type IDs:
      // 1 = noFastForward (merge), 2 = squash, 3 = rebase, 4 = rebaseMerge
      const mergeStrategy =
        method === "rebase" ? 3 : method === "merge" ? 1 : 2; // default squash

      if (pat) {
        const url = buildApiUrl(settings, `git/pullrequests/${pr.number}`);

        // We need the last merge source commit to complete the PR
        const prData = await requestAzureDevOps<AzureDevOpsPR & { lastMergeSourceCommit?: { commitId: string } }>(
          "GET",
          url,
          pat,
        );

        const completeUrl = buildApiUrl(settings, `git/pullrequests/${pr.number}`);
        await requestAzureDevOps<unknown>("PATCH", completeUrl, pat, {
          status: "completed",
          lastMergeSourceCommit: prData.lastMergeSourceCommit,
          completionOptions: {
            mergeStrategy,
            deleteSourceBranch: true,
          },
        });
        return;
      }

      const strategyFlag =
        method === "rebase"
          ? "--merge-strategy rebase"
          : method === "merge"
            ? "--merge-strategy noFastForward"
            : "--merge-strategy squash";

      await az([
        "repos",
        "pr",
        "update",
        "--id",
        String(pr.number),
        "--org",
        settings.organizationUrl,
        "--status",
        "completed",
        ...strategyFlag.split(" "),
        "--delete-source-branch",
        "true",
        "--output",
        "json",
      ]);
    },

    // ----- closePR -----

    async closePR(pr: PRInfo): Promise<void> {
      const settings = settingsFromPR(pr);
      const pat = getPat();

      if (pat) {
        const url = buildApiUrl(settings, `git/pullrequests/${pr.number}`);
        await requestAzureDevOps<unknown>("PATCH", url, pat, {
          status: "abandoned",
        });
        return;
      }

      await az([
        "repos",
        "pr",
        "update",
        "--id",
        String(pr.number),
        "--org",
        settings.organizationUrl,
        "--status",
        "abandoned",
        "--output",
        "json",
      ]);
    },

    // ----- getCIChecks -----

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      const settings = settingsFromPR(pr);
      const pat = getPat();

      try {
        if (pat) {
          // Get builds associated with this PR's source branch
          const url = buildApiUrl(settings, "build/builds");
          url.searchParams.set(
            "repositoryId",
            settings.repositoryName,
          );
          url.searchParams.set("repositoryType", "TfsGit");
          url.searchParams.set("branchName", `refs/pull/${pr.number}/merge`);
          url.searchParams.set("$top", "50");

          const data = await requestAzureDevOps<AzureDevOpsListResponse<AzureDevOpsBuild>>(
            "GET",
            url,
            pat,
          );

          return (data.value ?? []).map(mapBuildToCheck);
        }

        // CLI fallback — no direct `az pipelines builds list` for PR, use REST-style
        // az pipelines runs list can work but doesn't filter by PR well.
        // Use `az rest` instead for reliable access.
        const raw = await az([
          "rest",
          "--method",
          "get",
          "--uri",
          `${settings.organizationUrl}/${encodeURIComponent(settings.projectName)}/_apis/build/builds?repositoryId=${encodeURIComponent(settings.repositoryName)}&repositoryType=TfsGit&branchName=refs/pull/${pr.number}/merge&$top=50&api-version=${API_VERSION}`,
          "--output",
          "json",
        ]);

        const data: AzureDevOpsListResponse<AzureDevOpsBuild> = JSON.parse(raw);
        return (data.value ?? []).map(mapBuildToCheck);
      } catch (err) {
        // Propagate — do NOT silently return []. Same fail-closed pattern as scm-github.
        throw new Error("Failed to fetch CI checks", { cause: err });
      }
    },

    // ----- getCISummary -----

    async getCISummary(pr: PRInfo): Promise<CIStatus> {
      let checks: CICheck[];
      try {
        checks = await this.getCIChecks(pr);
      } catch {
        // Before fail-closing, check if the PR is merged/closed
        try {
          const state = await this.getPRState(pr);
          if (state === "merged" || state === "closed") return "none";
        } catch {
          // Can't determine state either
        }
        return "failing";
      }

      if (checks.length === 0) return "none";

      const hasFailing = checks.some((c) => c.status === "failed");
      if (hasFailing) return "failing";

      const hasPending = checks.some((c) => c.status === "pending" || c.status === "running");
      if (hasPending) return "pending";

      const hasPassing = checks.some((c) => c.status === "passed");
      if (!hasPassing) return "none";

      return "passing";
    },

    // ----- getReviews -----

    async getReviews(pr: PRInfo): Promise<Review[]> {
      const settings = settingsFromPR(pr);
      const pat = getPat();

      let reviewers: AzureDevOpsReviewer[];

      if (pat) {
        const url = buildApiUrl(
          settings,
          `git/pullrequests/${pr.number}/reviewers`,
        );
        const data = await requestAzureDevOps<AzureDevOpsListResponse<AzureDevOpsReviewer>>(
          "GET",
          url,
          pat,
        );
        reviewers = data.value ?? [];
      } else {
        const raw = await az([
          "repos",
          "pr",
          "reviewer",
          "list",
          "--id",
          String(pr.number),
          "--org",
          settings.organizationUrl,
          "--output",
          "json",
        ]);
        reviewers = JSON.parse(raw);
        if (!Array.isArray(reviewers)) reviewers = [];
      }

      return reviewers
        .filter((r) => !r.isContainer) // exclude group reviewers
        .map((r) => ({
          author: r.displayName ?? r.uniqueName ?? "unknown",
          state: mapVoteToReviewState(r.vote),
          submittedAt: new Date(), // Azure DevOps reviewer endpoint doesn't include timestamp
        }));
    },

    // ----- getReviewDecision -----

    async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
      const reviews = await this.getReviews(pr);
      if (reviews.length === 0) return "none";

      const hasRejection = reviews.some((r) => r.state === "changes_requested");
      if (hasRejection) return "changes_requested";

      const hasApproval = reviews.some((r) => r.state === "approved");
      if (hasApproval) return "approved";

      return "pending";
    },

    // ----- getPendingComments -----

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      try {
        const settings = settingsFromPR(pr);
        const pat = getPat();

        let threads: AzureDevOpsThread[];

        if (pat) {
          const url = buildApiUrl(
            settings,
            `git/pullrequests/${pr.number}/threads`,
          );
          const data = await requestAzureDevOps<AzureDevOpsListResponse<AzureDevOpsThread>>(
            "GET",
            url,
            pat,
          );
          threads = data.value ?? [];
        } else {
          const raw = await az([
            "rest",
            "--method",
            "get",
            "--uri",
            `${settings.organizationUrl}/${encodeURIComponent(settings.projectName)}/_apis/git/pullrequests/${pr.number}/threads?api-version=${API_VERSION}`,
            "--output",
            "json",
          ]);
          const data: AzureDevOpsListResponse<AzureDevOpsThread> = JSON.parse(raw);
          threads = data.value ?? [];
        }

        return threads
          .filter((t) => {
            // Only unresolved threads with human comments
            const status = (t.status ?? "").toLowerCase();
            if (status === "closed" || status === "fixed" || status === "wontFix") return false;
            const firstComment = t.comments?.[0];
            if (!firstComment || firstComment.commentType === "system") return false;
            const author = firstComment.author?.displayName ?? "";
            return !BOT_AUTHORS.has(author);
          })
          .map((t) => {
            const c = t.comments[0];
            return {
              id: String(t.id),
              author: c.author?.displayName ?? c.author?.uniqueName ?? "unknown",
              body: c.content ?? "",
              path: t.threadContext?.filePath || undefined,
              line: t.threadContext?.rightFileStart?.line ?? undefined,
              isResolved: false, // we filtered to unresolved only
              createdAt: parseDate(c.publishedDate),
              url: buildPrUrl(settingsFromPR(pr), pr.number),
            };
          });
      } catch {
        return [];
      }
    },

    // ----- getAutomatedComments -----

    async getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]> {
      try {
        const settings = settingsFromPR(pr);
        const pat = getPat();

        let threads: AzureDevOpsThread[];

        if (pat) {
          const url = buildApiUrl(
            settings,
            `git/pullrequests/${pr.number}/threads`,
          );
          const data = await requestAzureDevOps<AzureDevOpsListResponse<AzureDevOpsThread>>(
            "GET",
            url,
            pat,
          );
          threads = data.value ?? [];
        } else {
          const raw = await az([
            "rest",
            "--method",
            "get",
            "--uri",
            `${settings.organizationUrl}/${encodeURIComponent(settings.projectName)}/_apis/git/pullrequests/${pr.number}/threads?api-version=${API_VERSION}`,
            "--output",
            "json",
          ]);
          const data: AzureDevOpsListResponse<AzureDevOpsThread> = JSON.parse(raw);
          threads = data.value ?? [];
        }

        return threads
          .filter((t) => {
            const firstComment = t.comments?.[0];
            if (!firstComment || firstComment.commentType === "system") return false;
            const author = firstComment.author?.displayName ?? "";
            return BOT_AUTHORS.has(author);
          })
          .map((t) => {
            const c = t.comments[0];
            const body = c.content ?? "";
            const bodyLower = body.toLowerCase();

            let severity: AutomatedComment["severity"] = "info";
            if (
              bodyLower.includes("error") ||
              bodyLower.includes("bug") ||
              bodyLower.includes("critical") ||
              bodyLower.includes("potential issue")
            ) {
              severity = "error";
            } else if (
              bodyLower.includes("warning") ||
              bodyLower.includes("suggest") ||
              bodyLower.includes("consider")
            ) {
              severity = "warning";
            }

            return {
              id: String(t.id),
              botName: c.author?.displayName ?? "unknown",
              body,
              path: t.threadContext?.filePath || undefined,
              line: t.threadContext?.rightFileStart?.line ?? undefined,
              severity,
              createdAt: parseDate(c.publishedDate),
              url: buildPrUrl(settingsFromPR(pr), pr.number),
            };
          });
      } catch {
        return [];
      }
    },

    // ----- getMergeability -----

    async getMergeability(pr: PRInfo): Promise<MergeReadiness> {
      const blockers: string[] = [];

      const state = await this.getPRState(pr);
      if (state === "merged") {
        return {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        };
      }

      const settings = settingsFromPR(pr);
      const pat = getPat();

      // Fetch PR details for merge status
      let mergeStatus: string;
      let isDraft: boolean;

      if (pat) {
        const url = buildApiUrl(settings, `git/pullrequests/${pr.number}`);
        const data = await requestAzureDevOps<AzureDevOpsPR>("GET", url, pat);
        mergeStatus = (data.mergeStatus ?? "").toLowerCase();
        isDraft = data.isDraft ?? false;
      } else {
        const raw = await az([
          "repos",
          "pr",
          "show",
          "--id",
          String(pr.number),
          "--org",
          settings.organizationUrl,
          "--output",
          "json",
        ]);
        const data: AzureDevOpsPR = JSON.parse(raw);
        mergeStatus = (data.mergeStatus ?? "").toLowerCase();
        isDraft = data.isDraft ?? false;
      }

      // CI
      const ciStatus = await this.getCISummary(pr);
      const ciPassing = ciStatus === CI_STATUS.PASSING || ciStatus === CI_STATUS.NONE;
      if (!ciPassing) {
        blockers.push(`CI is ${ciStatus}`);
      }

      // Reviews
      const reviewDecision = await this.getReviewDecision(pr);
      const approved = reviewDecision === "approved";
      if (reviewDecision === "changes_requested") {
        blockers.push("Changes requested in review");
      } else if (reviewDecision === "pending") {
        blockers.push("Review pending");
      }

      // Merge conflicts
      // Azure DevOps mergeStatus: conflicts, failure, notSet, queued, rejectedByPolicy, succeeded
      const noConflicts = mergeStatus !== "conflicts";
      if (mergeStatus === "conflicts") {
        blockers.push("Merge conflicts");
      } else if (mergeStatus === "failure") {
        blockers.push("Merge failed");
      } else if (mergeStatus === "rejectedbypolicy") {
        blockers.push("Merge rejected by branch policy");
      } else if (mergeStatus === "queued" || mergeStatus === "notset") {
        blockers.push("Merge status is being computed");
      }

      // Draft
      if (isDraft) {
        blockers.push("PR is still a draft");
      }

      return {
        mergeable: blockers.length === 0,
        ciPassing,
        approved,
        noConflicts,
        blockers,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Utility — reconstruct SCMSettings from PRInfo
// ---------------------------------------------------------------------------

function settingsFromPR(pr: PRInfo): SCMSettings {
  // pr.owner = projectName, pr.repo = repositoryName
  // We need the organizationUrl — read from env or scm config.
  // Since PRInfo doesn't carry organizationUrl, read from env.
  const orgUrl = process.env["AZURE_DEVOPS_ORG_URL"];
  if (!orgUrl || orgUrl.trim() === "") {
    throw new Error(
      "AZURE_DEVOPS_ORG_URL is required to interact with Azure DevOps PRs",
    );
  }

  return {
    organizationUrl: orgUrl.trim().replace(/\/+$/, ""),
    projectName: pr.owner,
    repositoryName: pr.repo,
  };
}

// ---------------------------------------------------------------------------
// Build → CICheck mapping
// ---------------------------------------------------------------------------

function mapBuildToCheck(build: AzureDevOpsBuild): CICheck {
  const buildStatus = (build.status ?? "").toLowerCase();
  const buildResult = (build.result ?? "").toLowerCase();

  let status: CICheck["status"];

  if (buildStatus === "inprogress") {
    status = "running";
  } else if (buildStatus === "notstarted" || buildStatus === "postponed") {
    status = "pending";
  } else if (buildStatus === "completed") {
    if (buildResult === "succeeded" || buildResult === "partiallysucceeded") {
      status = "passed";
    } else if (
      buildResult === "failed" ||
      buildResult === "canceled" ||
      buildResult === "cancelled"
    ) {
      status = "failed";
    } else {
      status = "failed"; // Unknown result → fail closed
    }
  } else {
    status = "pending";
  }

  return {
    name: build.definition?.name ?? `Build ${build.id}`,
    status,
    url: build._links?.web?.href || undefined,
    conclusion: buildResult || undefined,
    startedAt: build.startTime ? new Date(build.startTime) : undefined,
    completedAt: build.finishTime ? new Date(build.finishTime) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "azure-devops",
  slot: "scm" as const,
  description: "SCM plugin: Azure DevOps PRs, CI checks, reviews, merge readiness",
  version: "0.1.0",
};

export function create(): SCM {
  return createAzureDevOpsSCM();
}

export default { manifest, create } satisfies PluginModule<SCM>;
