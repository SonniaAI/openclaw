import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../../../agents/glob-pattern.js";
import { normalizeToolPolicyName } from "../../../agents/tool-policy-shared.js";
import { visitConfigValueTree } from "../../../config/value-tree.js";
import { isToolPolicyPath } from "./legacy-tool-policy-scopes.js";

type LegacyToolNameMigration = {
  legacyName: string;
  canonicalName: string;
};

export const TASK_SUGGESTION_TOOL_NAME_MIGRATION = {
  legacyName: "spawn_task",
  canonicalName: "suggest_task",
} as const satisfies LegacyToolNameMigration;

export const IMAGE_INSPECTION_TOOL_NAME_MIGRATION = {
  legacyName: "image",
  canonicalName: "view_image",
} as const satisfies LegacyToolNameMigration;

function inspectLegacyToolNameList(value: unknown, migration: LegacyToolNameMigration) {
  if (!Array.isArray(value)) {
    return null;
  }
  const entries = value.filter((entry): entry is string => typeof entry === "string");
  const legacyName = normalizeToolPolicyName(migration.legacyName);
  const patterns = compileGlobPatterns({ raw: entries, normalize: normalizeToolPolicyName });
  const exactLegacy = entries.some((entry) => normalizeToolPolicyName(entry) === legacyName);
  return {
    exactLegacy,
    appendCanonical:
      !exactLegacy &&
      matchesAnyGlobPattern(legacyName, patterns) &&
      !matchesAnyGlobPattern(normalizeToolPolicyName(migration.canonicalName), patterns),
  };
}

export function hasLegacyToolNameList(value: unknown, migration: LegacyToolNameMigration): boolean {
  const state = inspectLegacyToolNameList(value, migration);
  return state?.exactLegacy === true || state?.appendCanonical === true;
}

export function migrateLegacyToolNameList(
  value: unknown,
  migration: LegacyToolNameMigration,
): boolean {
  const state = inspectLegacyToolNameList(value, migration);
  if (!state || !Array.isArray(value)) {
    return false;
  }
  let mutated = false;
  if (state.exactLegacy) {
    const legacyName = normalizeToolPolicyName(migration.legacyName);
    for (const [index, entry] of value.entries()) {
      if (typeof entry === "string" && normalizeToolPolicyName(entry) === legacyName) {
        value[index] = migration.canonicalName;
        mutated = true;
      }
    }
  }
  if (state.appendCanonical) {
    value.push(migration.canonicalName);
    mutated = true;
  }
  return mutated;
}

function collectLegacyToolNamePaths(
  value: unknown,
  path: string[],
  migration: LegacyToolNameMigration,
  migrate: boolean,
): string[] {
  const matchedPaths: string[] = [];
  visitConfigValueTree(
    value,
    (candidate, currentPath) => {
      if (isRecord(candidate)) {
        const listKeys = isToolPolicyPath(currentPath) ? ["allow", "alsoAllow", "deny"] : [];
        if (Object.hasOwn(candidate, "toolsAllow")) {
          listKeys.push("toolsAllow");
        }
        for (const key of listKeys) {
          const matched = migrate
            ? migrateLegacyToolNameList(candidate[key], migration)
            : hasLegacyToolNameList(candidate[key], migration);
          if (matched) {
            matchedPaths.push([...currentPath, key].join("."));
          }
        }
      }
      return true;
    },
    path,
  );
  return matchedPaths;
}

export function findLegacyToolNamePaths(
  value: unknown,
  migration: LegacyToolNameMigration,
  path: string[] = [],
): string[] {
  return collectLegacyToolNamePaths(value, path, migration, false);
}

export function migrateLegacyToolNamePolicies(
  value: unknown,
  migration: LegacyToolNameMigration,
  path: string[] = [],
): string[] {
  return collectLegacyToolNamePaths(value, path, migration, true);
}
