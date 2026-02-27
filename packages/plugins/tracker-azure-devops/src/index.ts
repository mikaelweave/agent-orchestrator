/**
 * tracker-azure-devops plugin — Azure DevOps Work Items as an issue tracker.
 *
 * Uses PAT authentication when AZURE_DEVOPS_PAT is set, otherwise falls back
 * to the Azure CLI (`az boards`).
 */

import { execFile } from "node:child_process";
import { request } from "node:https";
import { promisify } from "node:util";
import type {
  PluginModule,
  Tracker,
  Issue,
  IssueComment,
  IssueFilters,
  IssueUpdate,
  ProjectConfig,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

const API_VERSION = "7.1";
const WORK_ITEM_FIELDS = [
  "System.Title",
  "System.Description",
  "System.State",
  "System.Tags",
  "System.AssignedTo",
];

interface AzureDevOpsIdentityRef {
  displayName?: string;
  uniqueName?: string;
}

interface AzureDevOpsWorkItem {
  id: number;
  fields: Record<string, unknown>;
  _links?: {
    html?: {
      href?: string;
    };
  };
}

interface AzureDevOpsComment {
  id: number;
  text: string;
  createdDate: string | null;
  createdBy: AzureDevOpsIdentityRef | null;
  url: string | null;
}

interface AzureDevOpsCommentsResponse {
  comments: AzureDevOpsComment[];
}

interface TrackerSettings {
  organizationUrl: string;
  projectName: string;
}

function getTrackerSettings(project: ProjectConfig): TrackerSettings {
  const tracker = project.tracker;
  const orgValue = tracker?.["organizationUrl"] ?? process.env["AZURE_DEVOPS_ORG_URL"];
  const projectValue = tracker?.["project"] ?? process.env["AZURE_DEVOPS_PROJECT"];

  if (typeof orgValue !== "string" || orgValue.trim() === "") {
    throw new Error(
      "Azure DevOps tracker requires tracker.organizationUrl (or AZURE_DEVOPS_ORG_URL)",
    );
  }

  if (typeof projectValue !== "string" || projectValue.trim() === "") {
    throw new Error("Azure DevOps tracker requires tracker.project (or AZURE_DEVOPS_PROJECT)");
  }

  const organizationUrl = orgValue.trim().replace(/\/+$/, "");
  const projectName = projectValue.trim();
  return { organizationUrl, projectName };
}

function getPat(): string | null {
  const pat = process.env["AZURE_DEVOPS_PAT"];
  if (!pat || pat.trim() === "") {
    return null;
  }
  return pat;
}

async function az(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("az", args, { timeout: 30_000 });
  return stdout;
}

function normalizeIdentifier(identifier: string): string {
  const normalized = identifier.trim().replace(/^#/, "");
  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      `Azure DevOps work item identifier must be numeric (received "${identifier}")`,
    );
  }
  return normalized;
}

function mapState(state: string): Issue["state"] {
  const normalized = state.toLowerCase();

  if (normalized.includes("cancel") || normalized.includes("removed")) {
    return "cancelled";
  }
  if (
    normalized.includes("closed") ||
    normalized.includes("done") ||
    normalized.includes("resolved") ||
    normalized.includes("completed")
  ) {
    return "closed";
  }
  if (normalized.includes("active") || normalized.includes("progress") || normalized.includes("doing")) {
    return "in_progress";
  }
  return "open";
}

function parseTags(value: unknown): string[] {
  if (typeof value !== "string" || value.trim() === "") {
    return [];
  }
  return value
    .split(";")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function parseAssignee(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const identity = value as AzureDevOpsIdentityRef;
    if (typeof identity.displayName === "string" && identity.displayName.trim() !== "") {
      return identity.displayName;
    }
    if (typeof identity.uniqueName === "string" && identity.uniqueName.trim() !== "") {
      return identity.uniqueName;
    }
  }
  return undefined;
}

function buildWorkItemUrl(settings: TrackerSettings, identifier: string): string {
  return `${settings.organizationUrl}/${encodeURIComponent(settings.projectName)}/_workitems/edit/${identifier}`;
}

function toIssue(item: AzureDevOpsWorkItem, settings: TrackerSettings): Issue {
  const title = item.fields["System.Title"];
  if (typeof title !== "string" || title.trim() === "") {
    throw new Error(`Azure DevOps work item ${item.id} has no valid System.Title`);
  }

  const stateValue = item.fields["System.State"];
  if (typeof stateValue !== "string" || stateValue.trim() === "") {
    throw new Error(`Azure DevOps work item ${item.id} has no valid System.State`);
  }

  const description = item.fields["System.Description"];
  const issueUrl =
    typeof item._links?.html?.href === "string" && item._links.html.href.trim() !== ""
      ? item._links.html.href
      : buildWorkItemUrl(settings, String(item.id));

  return {
    id: String(item.id),
    title,
    description: typeof description === "string" ? description : "",
    url: issueUrl,
    state: mapState(stateValue),
    labels: parseTags(item.fields["System.Tags"]),
    assignee: parseAssignee(item.fields["System.AssignedTo"]),
  };
}

function requestAzureDevOps<T>(
  method: "GET" | "POST" | "PATCH",
  url: URL,
  pat: string,
  body?: unknown,
  contentType = "application/json",
): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const auth = `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const req = request(
      {
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          Accept: "application/json",
          Authorization: auth,
          ...(payload
            ? {
                "Content-Type": contentType,
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
              reject(new Error(`Azure DevOps API returned HTTP ${status}: ${text.slice(0, 400)}`));
              return;
            }

            if (text.trim() === "") {
              reject(new Error("Azure DevOps API returned an empty response body"));
              return;
            }

            try {
              resolve(JSON.parse(text) as T);
            } catch (err) {
              reject(
                new Error(`Failed to parse Azure DevOps API JSON response: ${(err as Error).message}`),
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

async function fetchWorkItem(identifier: string, project: ProjectConfig): Promise<Issue> {
  const settings = getTrackerSettings(project);
  const id = normalizeIdentifier(identifier);
  const pat = getPat();

  if (pat) {
    const url = new URL(
      `${settings.organizationUrl}/${encodeURIComponent(settings.projectName)}/_apis/wit/workitems/${id}`,
    );
    url.searchParams.set("api-version", API_VERSION);
    url.searchParams.set("fields", WORK_ITEM_FIELDS.join(","));

    const data = await requestAzureDevOps<AzureDevOpsWorkItem>("GET", url, pat);
    return toIssue(data, settings);
  }

  const stdout = await az([
    "boards",
    "work-item",
    "show",
    "--id",
    id,
    "--org",
    settings.organizationUrl,
    "--output",
    "json",
  ]);

  let data: AzureDevOpsWorkItem;
  try {
    data = JSON.parse(stdout) as AzureDevOpsWorkItem;
  } catch {
    throw new Error("Failed to parse az boards work-item show output as JSON");
  }
  return toIssue(data, settings);
}

function createAzureDevOpsTracker(): Tracker {
  return {
    name: "azure-devops",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      return fetchWorkItem(identifier, project);
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const issue = await fetchWorkItem(identifier, project);
      return issue.state === "closed" || issue.state === "cancelled";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const settings = getTrackerSettings(project);
      const id = normalizeIdentifier(identifier);
      return buildWorkItemUrl(settings, id);
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      const match = url.match(/\/_workitems\/edit\/(\d+)/);
      if (match) {
        return `#${match[1]}`;
      }
      const parts = url.split("/");
      const lastPart = parts[parts.length - 1];
      return lastPart || url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      const id = normalizeIdentifier(identifier);
      return `feat/workitem-${id}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on Azure DevOps work item #${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Tags: ${issue.labels.join(", ")}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this work item. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const settings = getTrackerSettings(project);
      const pat = getPat();

      // Build WIQL query
      let stateFilter = "";
      if (filters.workflowStateName) {
        stateFilter = `AND [System.State] = '${filters.workflowStateName.replace(/'/g, "''")}'`;
      } else if (filters.state === "closed") {
        stateFilter = "AND [System.State] IN ('Closed', 'Done', 'Resolved', 'Completed')";
      } else if (filters.state !== "all") {
        stateFilter =
          "AND [System.State] NOT IN ('Closed', 'Done', 'Resolved', 'Completed', 'Removed')";
      }

      const limit = filters.limit ?? 30;
      const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${settings.projectName.replace(/'/g, "''")}' ${stateFilter} ORDER BY [System.ChangedDate] DESC`;

      let ids: number[];

      if (pat) {
        const url = new URL(
          `${settings.organizationUrl}/${encodeURIComponent(settings.projectName)}/_apis/wit/wiql`,
        );
        url.searchParams.set("api-version", API_VERSION);
        url.searchParams.set("$top", String(limit));

        const result = await requestAzureDevOps<{ workItems: Array<{ id: number }> }>(
          "POST",
          url,
          pat,
          { query: wiql },
        );
        ids = result.workItems.slice(0, limit).map((w) => w.id);
      } else {
        const stdout = await az([
          "boards",
          "query",
          "--wiql",
          wiql,
          "--org",
          settings.organizationUrl,
          "--output",
          "json",
        ]);
        const result: Array<{ id: number }> = JSON.parse(stdout);
        ids = result.slice(0, limit).map((w) => w.id);
      }

      if (ids.length === 0) return [];

      if (pat) {
        const url = new URL(`${settings.organizationUrl}/_apis/wit/workitems`);
        url.searchParams.set("ids", ids.join(","));
        url.searchParams.set("fields", WORK_ITEM_FIELDS.join(","));
        url.searchParams.set("api-version", API_VERSION);

        const result = await requestAzureDevOps<{ value: AzureDevOpsWorkItem[] }>(
          "GET",
          url,
          pat,
        );
        return result.value.map((item) => toIssue(item, settings));
      }

      const items = await Promise.all(
        ids.map((id) =>
          az([
            "boards",
            "work-item",
            "show",
            "--id",
            String(id),
            "--org",
            settings.organizationUrl,
            "--output",
            "json",
          ]).then((stdout) => toIssue(JSON.parse(stdout) as AzureDevOpsWorkItem, settings)),
        ),
      );
      return items;
    },

    async listComments(identifier: string, project: ProjectConfig): Promise<IssueComment[]> {
      const settings = getTrackerSettings(project);
      const id = normalizeIdentifier(identifier);
      const pat = getPat();

      if (pat) {
        const url = new URL(
          `${settings.organizationUrl}/${encodeURIComponent(settings.projectName)}/_apis/wit/workitems/${id}/comments`,
        );
        url.searchParams.set("api-version", "7.1-preview.3");

        const data = await requestAzureDevOps<AzureDevOpsCommentsResponse>("GET", url, pat);
        return data.comments.map((c) => ({
          id: String(c.id),
          body: c.text,
          author:
            c.createdBy?.displayName ?? c.createdBy?.uniqueName ?? undefined,
          createdAt: c.createdDate ? new Date(c.createdDate) : undefined,
          url: c.url ?? undefined,
        }));
      }

      // Azure CLI does not have a direct work-item comments command; skip gracefully.
      return [];
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      const settings = getTrackerSettings(project);
      const id = normalizeIdentifier(identifier);
      const pat = getPat();

      const patches: Array<{ op: string; path: string; value: unknown }> = [];

      // Handle state change — prefer workflowStateName for exact state, then generic state
      if (update.workflowStateName) {
        patches.push({ op: "add", path: "/fields/System.State", value: update.workflowStateName });
      } else if (update.state) {
        const stateValue =
          update.state === "closed"
            ? "Closed"
            : update.state === "open"
              ? "Active"
              : "Active"; // "in_progress" → Active
        patches.push({ op: "add", path: "/fields/System.State", value: stateValue });
      }

      // Handle description update
      if (update.description !== undefined) {
        patches.push({
          op: "add",
          path: "/fields/System.Description",
          value: update.description,
        });
      }

      // Handle assignee
      if (update.assignee) {
        patches.push({ op: "add", path: "/fields/System.AssignedTo", value: update.assignee });
      }

      // Handle tags (additive — append to existing)
      if (update.labels && update.labels.length > 0) {
        const issue = await fetchWorkItem(identifier, project);
        const existingTags = issue.labels;
        const merged = [...new Set([...existingTags, ...update.labels])];
        patches.push({ op: "add", path: "/fields/System.Tags", value: merged.join("; ") });
      }

      if (patches.length > 0) {
        if (pat) {
          const url = new URL(
            `${settings.organizationUrl}/${encodeURIComponent(settings.projectName)}/_apis/wit/workitems/${id}`,
          );
          url.searchParams.set("api-version", API_VERSION);
          await requestAzureDevOps("PATCH", url, pat, patches, "application/json-patch+json");
        } else {
          // Azure CLI path: handle state and description updates individually
          for (const patch of patches) {
            if (patch.path === "/fields/System.State") {
              await az([
                "boards",
                "work-item",
                "update",
                "--id",
                id,
                "--state",
                String(patch.value),
                "--org",
                settings.organizationUrl,
              ]);
            } else if (patch.path === "/fields/System.Description") {
              await az([
                "boards",
                "work-item",
                "update",
                "--id",
                id,
                "--description",
                String(patch.value),
                "--org",
                settings.organizationUrl,
              ]);
            }
          }
        }
      }

      // Handle comment (always via REST if PAT available, otherwise az CLI)
      if (update.comment) {
        if (pat) {
          const url = new URL(
            `${settings.organizationUrl}/${encodeURIComponent(settings.projectName)}/_apis/wit/workitems/${id}/comments`,
          );
          url.searchParams.set("api-version", "7.1-preview.3");
          await requestAzureDevOps("POST", url, pat, { text: update.comment });
        } else {
          await az([
            "boards",
            "work-item",
            "update",
            "--id",
            id,
            "--discussion",
            update.comment,
            "--org",
            settings.organizationUrl,
          ]);
        }
      }
    },
  };
}

export const manifest = {
  name: "azure-devops",
  slot: "tracker" as const,
  description: "Tracker plugin: Azure DevOps Work Items",
  version: "0.1.0",
};

export function create(): Tracker {
  return createAzureDevOpsTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
