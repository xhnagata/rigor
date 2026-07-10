# Threat model

## Assets

Rigor protects source confidentiality, secrets, repository integrity, production and billing boundaries, policy integrity, evidence lineage, and reviewer attention. Task, contract, attempt, verification, review, and event records share stable IDs.

## Trust boundaries

- **Claude Code and plugin:** useful automation, but its model output and local hooks are not authoritative.
- **Rigor CLI:** deterministic local evaluator. Its output is only as trustworthy as the executable and working tree that produced it.
- **Target repository:** user-controlled input, including paths, symlinks, policy, Git metadata, and commands.
- **Pull-request CI:** independently checks the exact base/head objects. It must not trust a contributor's claimed SHA, tier, path list, or pass result.
- **GitHub controls and humans:** required checks, branch protection, CODEOWNERS, and an independent approver are the authoritative merge boundary.
- **External services/models:** no content may cross this boundary unless policy says it is exportable. Rigor itself performs no upload.
- **GitHub API (read-only, `rigor governance` only):** the single remote endpoint Rigor calls. Transmitted data is limited to the URL-encoded owner, repository, and branch in the request path plus an optional token in the `authorization` header; no repository content, evidence, or prose is sent. The host is fixed to `https://api.github.com`, the method is hard-coded to GET (there is no code path that issues another verb), redirects are refused, every request times out after 10 seconds, and response bodies over 1 MB or that fail to decode are discarded. List requests use `per_page=100`, and a response whose `Link` header advertises a `rel="next"` page is treated as unverifiable so no requirement is decided on partially fetched data. The token is read only from `RIGOR_GITHUB_TOKEN`, then `GITHUB_TOKEN`, then `GH_TOKEN`, is validated as printable ASCII, and is never logged or persisted. Transport and API errors are collapsed into an `unverifiable` finding without echoing response bodies, and unverifiable findings fail closed (exit 2). The API's answers are treated as observations about GitHub configuration, never as proof that a control cannot be bypassed by an administrator.

## Threats and responses

| Threat or failure                                             | MVP response                                                                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Path traversal, absolute paths, newline paths, symlink escape | lexical normalization, repository containment and symlink checks; unsafe input fails closed                       |
| Policy removal or weakening in a PR                           | base policy is loaded independently; weakening and protected policy changes require the highest tier and approval |
| Fabricated or stale evidence                                  | CI derives base/head and changed paths from Git; evidence identifiers and SHAs are cross-checked                  |
| Test command weakened while evidence still says pass          | CI detects policy/check definition changes and requires explicit high-risk handling; it runs head commands itself |
| Sensitive content copied into evidence                        | schemas store paths, hashes, statuses, and user-supplied summaries; raw command output is not persisted           |
| Hook bypass or plugin disablement                             | documented as local feedback only; CI and branch protection remain authoritative                                  |
| Malicious verification command                                | setup creates conservative commands; policy changes are protected and reviewed; commands run without a shell      |
| Endless repeated attempts                                     | escalation records attempt fingerprints and warns on duplicates                                                   |
| Model self-approval or model-name spoofing                    | model declarations never satisfy a control or human-approval requirement                                          |

## Not guaranteed

Rigor does not detect every secret, prove intent, prove test quality, attest the local binary, prevent administrators from bypassing GitHub, or make irreversible operations safe. It does not enforce production deployment controls. CI described here validates repository evidence and policy; organizational identity and approval correctness remain GitHub/organization responsibilities.
