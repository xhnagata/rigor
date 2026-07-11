import { EXIT, RigorError } from "./errors.js";
import {
  AVAILABILITY_SCHEMA,
  type AvailabilityReport,
  type AvailabilityState,
  type CandidateAvailability,
  type CodexPluginPresence,
  type EnvironmentObservation,
  type ModelCandidate,
  type ModelProfiles,
} from "./types.js";
import { artifactId, hash, record, textField } from "./util.js";

/**
 * Documented, bounded environment-variable interface read by the default probe.
 * Reading these performs no installation, authentication, or network access and
 * never scrapes undocumented UI output. Any variable that is absent is treated
 * as an explicit "unknown", never fabricated.
 *
 * - CLAUDE_PLUGIN_ROOT / CLAUDE_CODE_ENTRYPOINT: presence of the Claude Code
 *   plugin execution environment (set by Claude Code itself).
 * - CLAUDE_CODE_VERSION: Claude Code tool version, if exported.
 * - ANTHROPIC_MODEL: the configured Claude model identity (unverified).
 * - RIGOR_CODEX_PLUGIN_PRESENT: codex-plugin-cc presence declared by the
 *   orchestrator after observing the plugin through Claude Code's own plugin
 *   listing. Recognized truthy/falsey values map to present/absent; any other
 *   or absent value stays unknown so absence is only asserted when observed.
 * - RIGOR_CODEX_PLUGIN_VERSION: codex-plugin-cc version, if observed.
 */
const CLAUDE_PRESENCE_VARS = ["CLAUDE_PLUGIN_ROOT", "CLAUDE_CODE_ENTRYPOINT"];
const TRUTHY = new Set(["1", "true", "yes", "present"]);
const FALSEY = new Set(["0", "false", "no", "absent"]);

function boundedVersion(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || trimmed.includes("\0"))
    return null;
  return trimmed;
}

function codexPresence(value: string | undefined): CodexPluginPresence {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  if (TRUTHY.has(normalized)) return "present";
  if (FALSEY.has(normalized)) return "absent";
  return "unknown";
}

/**
 * Default local probe. Reads only the documented environment variables above.
 * Any unexpected failure or malformed value fails safe: probeSupported becomes
 * false and every state derives to `unknown` instead of `available`.
 */
export function probeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): EnvironmentObservation {
  try {
    const claudeVersion = boundedVersion(env.CLAUDE_CODE_VERSION);
    const configuredRaw =
      typeof env.ANTHROPIC_MODEL === "string"
        ? env.ANTHROPIC_MODEL.trim()
        : null;
    const configuredModel =
      configuredRaw !== null &&
      configuredRaw.length > 0 &&
      configuredRaw.length <= 256 &&
      !configuredRaw.includes("\0")
        ? configuredRaw
        : null;
    return {
      probeSupported: true,
      claudeCode: {
        present: CLAUDE_PRESENCE_VARS.some(
          (name) =>
            typeof env[name] === "string" && (env[name] as string).length > 0,
        ),
        version: claudeVersion,
      },
      configuredModel,
      codexPlugin: {
        presence: codexPresence(env.RIGOR_CODEX_PLUGIN_PRESENT),
        version: boundedVersion(env.RIGOR_CODEX_PLUGIN_VERSION),
      },
    };
  } catch {
    return {
      probeSupported: false,
      claudeCode: { present: false, version: null },
      configuredModel: null,
      codexPlugin: { presence: "unknown", version: null },
    };
  }
}

function deriveState(
  candidate: ModelCandidate,
  observation: EnvironmentObservation,
): { state: AvailabilityState; reason: string; toolVersion: string | null } {
  // Incompatibility is a static property of the provider type, so it must
  // survive an unsupported probe instead of degrading to unknown.
  if (
    candidate.provider !== "claude" &&
    candidate.provider !== "codex-plugin-cc"
  )
    return {
      state: "incompatible",
      reason:
        "Provider cannot be invoked by the Claude Code execution layer (only claude and codex-plugin-cc are supported).",
      toolVersion: null,
    };
  if (!observation.probeSupported)
    return {
      state: "unknown",
      reason: "Environment probing is unsupported; availability is unknown.",
      toolVersion: null,
    };
  if (candidate.provider === "claude") {
    if (observation.claudeCode.present)
      return {
        state: "available",
        reason:
          "Claude Code execution environment observed; runtime model identity remains unverified.",
        toolVersion: observation.claudeCode.version,
      };
    return {
      state: "unknown",
      reason:
        "Claude Code environment not observable through documented variables; availability is unknown.",
      toolVersion: observation.claudeCode.version,
    };
  }
  if (observation.codexPlugin.presence === "present")
    return {
      state: "available",
      reason: "codex-plugin-cc declared present by the orchestrator.",
      toolVersion: observation.codexPlugin.version,
    };
  if (observation.codexPlugin.presence === "absent")
    return {
      state: "unavailable",
      reason: "codex-plugin-cc declared absent by the orchestrator.",
      toolVersion: observation.codexPlugin.version,
    };
  return {
    state: "unknown",
    reason:
      "codex-plugin-cc presence not declared through documented variables; availability is unknown.",
    toolVersion: observation.codexPlugin.version,
  };
}

/**
 * Build a versioned availability report by applying an environment observation
 * to each configured candidate. Pure and deterministic given (profiles,
 * observation, now); the caller supplies the observation so tests never depend
 * on live machine state.
 */
export function buildAvailabilityReport(
  profiles: ModelProfiles,
  observation: EnvironmentObservation,
  now = new Date(),
): AvailabilityReport {
  const observedAt = now.toISOString();
  const candidates: CandidateAvailability[] = profiles.candidates.map(
    (candidate) => {
      const derived = deriveState(candidate, observation);
      return {
        candidateId: candidate.id,
        provider: candidate.provider,
        state: derived.state,
        reason: derived.reason,
        observedAt,
        toolVersion: derived.toolVersion,
      };
    },
  );
  return {
    schemaVersion: AVAILABILITY_SCHEMA,
    artifactId: artifactId("availability"),
    createdAt: observedAt,
    modelProfilesHash: hash(profiles),
    probeStatus: observation.probeSupported ? "supported" : "unsupported",
    environment: {
      claudeCode: {
        present: observation.claudeCode.present,
        version: observation.claudeCode.version,
      },
      configuredModel:
        observation.configuredModel === null
          ? null
          : { value: observation.configuredModel, attestation: "unverified" },
      codexPlugin: {
        presence: observation.codexPlugin.presence,
        version: observation.codexPlugin.version,
      },
    },
    candidates,
  };
}

const availabilityStates: AvailabilityState[] = [
  "available",
  "unavailable",
  "unknown",
  "incompatible",
];
const codexPresences: CodexPluginPresence[] = ["present", "absent", "unknown"];

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new RigorError(`${name} is invalid`, EXIT.inputError);
  return value as T;
}

function optionalVersion(value: unknown, name: string): string | null {
  if (value === null) return null;
  return textField(value, name, 128);
}

/**
 * Fail-closed parser for a persisted availability report. Rejects malformed or
 * unknown-schema artifacts (input error) rather than silently trusting them.
 */
export function parseAvailabilityReport(value: unknown): AvailabilityReport {
  const item = record(value, "availability report");
  if (item.schemaVersion !== AVAILABILITY_SCHEMA)
    throw new RigorError(
      "Unsupported availability report schema",
      EXIT.inputError,
    );
  const environment = record(item.environment, "environment");
  const claudeCode = record(environment.claudeCode, "environment.claudeCode");
  const codexPlugin = record(
    environment.codexPlugin,
    "environment.codexPlugin",
  );
  if (typeof claudeCode.present !== "boolean")
    throw new RigorError(
      "environment.claudeCode.present must be boolean",
      EXIT.inputError,
    );
  let configuredModel: AvailabilityReport["environment"]["configuredModel"] =
    null;
  if (environment.configuredModel !== null) {
    const configured = record(
      environment.configuredModel,
      "environment.configuredModel",
    );
    if (configured.attestation !== "unverified")
      throw new RigorError(
        "configuredModel.attestation must be unverified",
        EXIT.inputError,
      );
    configuredModel = {
      value: textField(configured.value, "configuredModel.value", 256),
      attestation: "unverified",
    };
  }
  if (!Array.isArray(item.candidates))
    throw new RigorError("candidates must be an array", EXIT.inputError);
  const candidates = item.candidates.map((raw, index) => {
    const candidate = record(raw, `candidates[${index}]`);
    return {
      candidateId: textField(
        candidate.candidateId,
        `candidates[${index}].candidateId`,
        128,
      ),
      provider: textField(
        candidate.provider,
        `candidates[${index}].provider`,
        128,
      ),
      state: oneOf(
        candidate.state,
        availabilityStates,
        `candidates[${index}].state`,
      ),
      reason: textField(candidate.reason, `candidates[${index}].reason`, 1000),
      observedAt: textField(
        candidate.observedAt,
        `candidates[${index}].observedAt`,
        128,
      ),
      toolVersion: optionalVersion(
        candidate.toolVersion,
        `candidates[${index}].toolVersion`,
      ),
    };
  });
  return {
    schemaVersion: AVAILABILITY_SCHEMA,
    artifactId: textField(item.artifactId, "artifactId", 128),
    createdAt: textField(item.createdAt, "createdAt", 128),
    modelProfilesHash: textField(
      item.modelProfilesHash,
      "modelProfilesHash",
      128,
    ),
    probeStatus: oneOf(
      item.probeStatus,
      ["supported", "unsupported"] as const,
      "probeStatus",
    ),
    environment: {
      claudeCode: {
        present: claudeCode.present,
        version: optionalVersion(
          claudeCode.version,
          "environment.claudeCode.version",
        ),
      },
      configuredModel,
      codexPlugin: {
        presence: oneOf(
          codexPlugin.presence,
          codexPresences,
          "environment.codexPlugin.presence",
        ),
        version: optionalVersion(
          codexPlugin.version,
          "environment.codexPlugin.version",
        ),
      },
    },
    candidates,
  };
}
