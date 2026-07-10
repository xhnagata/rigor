import { EXIT, RigorError } from "./errors.js";
import { textField } from "./util.js";
import type { Policy } from "./types.js";

export const GOVERNANCE_SCHEMA = "rigor.governance.v1" as const;

export interface GovernanceFinding {
  id: string;
  status: "satisfied" | "failed" | "unverifiable";
  detail: string;
}

export interface GovernanceReport {
  schemaVersion: typeof GOVERNANCE_SCHEMA;
  repository: string;
  branch: string;
  requiredCheckContext: string;
  governedPaths: string[];
  findings: GovernanceFinding[];
  status: "passed" | "failed";
}

export interface GitHubResponse {
  status: number;
  body: unknown;
}

export type GitHubReader = (requestPath: string) => Promise<GitHubResponse>;

export interface RepositoryRef {
  owner: string;
  repo: string;
}

export function parseRepository(value: unknown): RepositoryRef {
  const text = textField(value, "--repo", 200);
  const match =
    /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9._-]{1,100})$/u.exec(
      text,
    );
  const owner = match?.[1];
  const repo = match?.[2];
  if (!owner || !repo || repo === "." || repo === "..") {
    throw new RigorError(
      "--repo must be an owner/name repository reference",
      EXIT.inputError,
    );
  }
  return { owner, repo };
}

export function parseBranch(value: unknown): string {
  const text = textField(value, "--branch", 255);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f ~^:?*[\\]/u.test(text) || text.includes("..")) {
    throw new RigorError(
      "--branch contains unsupported characters",
      EXIT.inputError,
    );
  }
  return text;
}

export function githubReader(
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): GitHubReader {
  if (token !== undefined && !/^[!-~]{1,512}$/u.test(token)) {
    throw new RigorError(
      "GitHub token contains unsupported characters",
      EXIT.inputError,
    );
  }
  return async (requestPath) => {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "rigor-governance",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${requestPath}`, {
        method: "GET",
        headers,
        redirect: "error",
      });
    } catch {
      return { status: 0, body: null };
    }
    let body: unknown = null;
    try {
      body = (await response.json()) as unknown;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };
}

export interface CodeownersEntry {
  pattern: string;
  owners: string[];
}

function splitCodeownersLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (char === "\\" && i + 1 < line.length) {
      current += line[i + 1]!;
      i += 1;
    } else if (char === "#") {
      break;
    } else if (char === " " || char === "\t") {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

export function parseCodeowners(text: string): CodeownersEntry[] {
  const entries: CodeownersEntry[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const tokens = splitCodeownersLine(rawLine);
    const pattern = tokens[0];
    if (!pattern) continue;
    // GitHub CODEOWNERS has no negation; such lines are invalid and ignored.
    if (pattern.startsWith("!")) continue;
    entries.push({ pattern, owners: tokens.slice(1) });
  }
  return entries;
}

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}

function codeownersPatternToRegExp(pattern: string): RegExp {
  let body = pattern;
  let directoryOnly = false;
  if (body.endsWith("/")) {
    directoryOnly = true;
    body = body.slice(0, -1);
  }
  let anchored = false;
  if (body.startsWith("/")) {
    anchored = true;
    body = body.slice(1);
  } else if (body.includes("/")) {
    anchored = true;
  }
  let source = anchored ? "^" : "^(?:.*/)?";
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!;
    if (char === "*") {
      if (body[i + 1] === "*") {
        i += 1;
        if (body[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else source += ".*";
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += escapeRegex(char);
  }
  const last = body[body.length - 1];
  if (directoryOnly) source += "/.*";
  else if (last !== "*" && last !== "?") source += "(?:/.*)?";
  return new RegExp(`${source}$`, "u");
}

export function codeownersOwners(
  entries: CodeownersEntry[],
  pathname: string,
): string[] {
  let owners: string[] = [];
  for (const entry of entries) {
    if (codeownersPatternToRegExp(entry.pattern).test(pathname)) {
      owners = entry.owners;
    }
  }
  return owners;
}

export function representativePaths(policy: Policy): string[] {
  const paths = new Set<string>();
  for (const rule of policy.rules) {
    if (!rule.protected) continue;
    for (const glob of rule.paths) {
      paths.add(
        glob
          .split("/")
          .map((segment) =>
            segment === "**"
              ? "governed"
              : segment
                  .replaceAll("**", "governed")
                  .replaceAll("*", "governed")
                  .replaceAll("?", "x"),
          )
          .join("/"),
      );
    }
  }
  return [...paths].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface BranchFacts {
  pullRequestRule: boolean;
  approvals: number;
  dismissStale: boolean;
  codeOwnerReview: boolean;
  lastPushApproval: boolean;
  contexts: string[];
  forcePushBlocked: boolean;
  deletionBlocked: boolean;
}

function rulesetFacts(body: unknown): BranchFacts {
  const facts: BranchFacts = {
    pullRequestRule: false,
    approvals: 0,
    dismissStale: false,
    codeOwnerReview: false,
    lastPushApproval: false,
    contexts: [],
    forcePushBlocked: false,
    deletionBlocked: false,
  };
  if (!Array.isArray(body)) return facts;
  for (const item of body) {
    if (!isRecord(item)) continue;
    const parameters = isRecord(item.parameters) ? item.parameters : {};
    if (item.type === "pull_request") {
      facts.pullRequestRule = true;
      const count = parameters.required_approving_review_count;
      if (typeof count === "number" && count > facts.approvals)
        facts.approvals = count;
      if (parameters.dismiss_stale_reviews_on_push === true)
        facts.dismissStale = true;
      if (parameters.require_code_owner_review === true)
        facts.codeOwnerReview = true;
      if (parameters.require_last_push_approval === true)
        facts.lastPushApproval = true;
    } else if (item.type === "required_status_checks") {
      const checks = parameters.required_status_checks;
      if (Array.isArray(checks)) {
        for (const check of checks) {
          if (isRecord(check) && typeof check.context === "string")
            facts.contexts.push(check.context);
        }
      }
    } else if (item.type === "non_fast_forward") facts.forcePushBlocked = true;
    else if (item.type === "deletion") facts.deletionBlocked = true;
  }
  return facts;
}

function classicFacts(body: unknown): BranchFacts {
  const facts: BranchFacts = {
    pullRequestRule: false,
    approvals: 0,
    dismissStale: false,
    codeOwnerReview: false,
    lastPushApproval: false,
    contexts: [],
    forcePushBlocked: false,
    deletionBlocked: false,
  };
  if (!isRecord(body)) return facts;
  const reviews = body.required_pull_request_reviews;
  if (isRecord(reviews)) {
    facts.pullRequestRule = true;
    const count = reviews.required_approving_review_count;
    if (typeof count === "number") facts.approvals = count;
    if (reviews.dismiss_stale_reviews === true) facts.dismissStale = true;
    if (reviews.require_code_owner_reviews === true)
      facts.codeOwnerReview = true;
    if (reviews.require_last_push_approval === true)
      facts.lastPushApproval = true;
  }
  const checks = body.required_status_checks;
  if (isRecord(checks)) {
    if (Array.isArray(checks.contexts)) {
      for (const context of checks.contexts) {
        if (typeof context === "string") facts.contexts.push(context);
      }
    }
    if (Array.isArray(checks.checks)) {
      for (const check of checks.checks) {
        if (isRecord(check) && typeof check.context === "string")
          facts.contexts.push(check.context);
      }
    }
  }
  const forcePushes = body.allow_force_pushes;
  if (isRecord(forcePushes) && forcePushes.enabled === false)
    facts.forcePushBlocked = true;
  const deletions = body.allow_deletions;
  if (isRecord(deletions) && deletions.enabled === false)
    facts.deletionBlocked = true;
  return facts;
}

export interface CodeownersState {
  state: "found" | "missing" | "unverifiable";
  source: string;
  text: string;
}

export interface GovernanceEvaluation {
  repository: string;
  branch: string;
  requiredCheckContext: string;
  governedPaths: string[];
  rules: GitHubResponse;
  protection: GitHubResponse;
  codeowners: CodeownersState;
  environments: GitHubResponse;
}

export function evaluateGovernance(
  input: GovernanceEvaluation,
): GovernanceReport {
  const findings: GovernanceFinding[] = [];
  const rulesKnown = input.rules.status === 200;
  // 404 means the classic protection is absent, which is a known negative.
  const classicKnown =
    input.protection.status === 200 || input.protection.status === 404;
  const ruleset = rulesetFacts(rulesKnown ? input.rules.body : null);
  const classic = classicFacts(
    input.protection.status === 200 ? input.protection.body : null,
  );
  const branchRequirement = (
    id: string,
    fromRuleset: boolean,
    fromClassic: boolean,
    requirement: string,
  ): void => {
    if ((rulesKnown && fromRuleset) || (classicKnown && fromClassic)) {
      findings.push({ id, status: "satisfied", detail: requirement });
    } else if (!rulesKnown && !classicKnown) {
      findings.push({
        id,
        status: "unverifiable",
        detail: `${requirement}: branch rules and classic protection could not be read with the available credentials`,
      });
    } else if (!classicKnown) {
      findings.push({
        id,
        status: "unverifiable",
        detail: `${requirement}: not satisfied by rulesets, and classic protection could not be read with the available credentials`,
      });
    } else {
      findings.push({
        id,
        status: "failed",
        detail: `${requirement}: not required by any active ruleset or classic protection on ${input.branch}`,
      });
    }
  };
  branchRequirement(
    "pull-request-required",
    ruleset.pullRequestRule,
    classic.pullRequestRule,
    "pull requests are required before merging",
  );
  branchRequirement(
    "approval-count",
    ruleset.approvals >= 1,
    classic.approvals >= 1,
    "at least one approving review is required",
  );
  branchRequirement(
    "stale-review-dismissal",
    ruleset.dismissStale,
    classic.dismissStale,
    "stale approvals are dismissed on new commits",
  );
  branchRequirement(
    "code-owner-review",
    ruleset.codeOwnerReview,
    classic.codeOwnerReview,
    "review from code owners is required",
  );
  branchRequirement(
    "last-push-approval",
    ruleset.lastPushApproval,
    classic.lastPushApproval,
    "approval from someone other than the last pusher is required",
  );
  branchRequirement(
    "required-check",
    ruleset.contexts.includes(input.requiredCheckContext),
    classic.contexts.includes(input.requiredCheckContext),
    `the status check "${input.requiredCheckContext}" is required`,
  );
  branchRequirement(
    "force-push-blocked",
    ruleset.forcePushBlocked,
    classic.forcePushBlocked,
    "force pushes are blocked",
  );
  branchRequirement(
    "deletion-blocked",
    ruleset.deletionBlocked,
    classic.deletionBlocked,
    "branch deletion is blocked",
  );
  if (input.codeowners.state === "unverifiable") {
    findings.push({
      id: "codeowners-coverage",
      status: "unverifiable",
      detail: "CODEOWNERS could not be read with the available credentials",
    });
  } else if (input.codeowners.state === "missing") {
    findings.push({
      id: "codeowners-coverage",
      status: "failed",
      detail:
        "no CODEOWNERS file exists at .github/CODEOWNERS, CODEOWNERS, or docs/CODEOWNERS",
    });
  } else {
    const entries = parseCodeowners(input.codeowners.text);
    const uncovered = input.governedPaths.filter(
      (pathname) => codeownersOwners(entries, pathname).length === 0,
    );
    findings.push(
      uncovered.length === 0
        ? {
            id: "codeowners-coverage",
            status: "satisfied",
            detail: `${input.codeowners.source} assigns owners to every policy-protected path`,
          }
        : {
            id: "codeowners-coverage",
            status: "failed",
            detail: `${input.codeowners.source} leaves policy-protected paths without owners: ${uncovered.join(", ")}`,
          },
    );
  }
  if (input.environments.status === 200 && isRecord(input.environments.body)) {
    const list = Array.isArray(input.environments.body.environments)
      ? input.environments.body.environments
      : [];
    const unprotected: string[] = [];
    for (const environment of list) {
      if (!isRecord(environment)) continue;
      const name =
        typeof environment.name === "string" ? environment.name : "unnamed";
      const rules = environment.protection_rules;
      if (!Array.isArray(rules) || rules.length === 0) unprotected.push(name);
    }
    if (list.length === 0) {
      findings.push({
        id: "deployment-environments",
        status: "satisfied",
        detail: "no deployment environments are configured",
      });
    } else if (unprotected.length === 0) {
      findings.push({
        id: "deployment-environments",
        status: "satisfied",
        detail: `all ${String(list.length)} deployment environments have protection rules`,
      });
    } else {
      findings.push({
        id: "deployment-environments",
        status: "failed",
        detail: `deployment environments without protection rules: ${unprotected.join(", ")}`,
      });
    }
  } else {
    findings.push({
      id: "deployment-environments",
      status: "unverifiable",
      detail:
        "deployment environments could not be read with the available credentials",
    });
  }
  return {
    schemaVersion: GOVERNANCE_SCHEMA,
    repository: input.repository,
    branch: input.branch,
    requiredCheckContext: input.requiredCheckContext,
    governedPaths: input.governedPaths,
    findings,
    status: findings.every((finding) => finding.status === "satisfied")
      ? "passed"
      : "failed",
  };
}

const CODEOWNERS_LOCATIONS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
];

async function readCodeowners(
  read: GitHubReader,
  base: string,
): Promise<CodeownersState> {
  let unverifiable = false;
  for (const location of CODEOWNERS_LOCATIONS) {
    const response = await read(
      `${base}/contents/${location
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
    );
    if (response.status === 200 && isRecord(response.body)) {
      const content = response.body.content;
      if (typeof content === "string") {
        try {
          return {
            state: "found",
            source: location,
            text: Buffer.from(content, "base64").toString("utf8"),
          };
        } catch {
          unverifiable = true;
        }
      }
    } else if (response.status !== 404) unverifiable = true;
  }
  return {
    state: unverifiable ? "unverifiable" : "missing",
    source: "",
    text: "",
  };
}

export interface GovernanceOptions {
  owner: string;
  repo: string;
  branch: string;
  requiredCheckContext: string;
}

export async function governanceVerify(
  policy: Policy,
  options: GovernanceOptions,
  read: GitHubReader,
): Promise<GovernanceReport> {
  const base = `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`;
  const branch = encodeURIComponent(options.branch);
  const rules = await read(`${base}/rules/branches/${branch}`);
  const protection = await read(`${base}/branches/${branch}/protection`);
  const codeowners = await readCodeowners(read, base);
  const environments = await read(`${base}/environments`);
  return evaluateGovernance({
    repository: `${options.owner}/${options.repo}`,
    branch: options.branch,
    requiredCheckContext: options.requiredCheckContext,
    governedPaths: representativePaths(policy),
    rules,
    protection,
    codeowners,
    environments,
  });
}
