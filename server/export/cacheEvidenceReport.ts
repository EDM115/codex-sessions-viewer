import type { DatabaseSync } from "node:sqlite";

import { cachedThreadClassification } from "#server/metadata/threadClassification.ts";
import { sourceGenerationSchema } from "#shared/types/conversation.ts";

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : null;
  } catch {
    return null;
  }
}

export function inspectCacheEvidence(database: DatabaseSync) {
  const tables = new Set(
    database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .map((row) => row["name"]),
  );
  const report = {
    authority: "saved-viewer-observations-not-current-source-validation" as const,
    catalogRows: 0,
    hiddenInternals: 0,
    unresolvedClassification: 0,
    unresolvedProjectMappings: 0,
    missingSourcePaths: 0,
    sourceFormats: { plain: 0, zstd: 0, unsupported: 0 },
    materializedGenerations: {
      validated: 0,
      legacyOrInvalid: 0,
      incompleteEncodedReads: 0,
      decodedBytes: 0,
    },
    nativeProjection: {
      verifiedAssociations: 0,
      coveredDependencies: 0,
      missingLineage: 0,
      nextOrdinalMaximum: null as number | null,
      nextByteMaximum: null as number | null,
    },
    diagnosticsByCode: {} as Record<string, number>,
    decodeReuse: "not-persisted-observe-selected-request" as const,
  };
  if (tables.has("session_catalog")) {
    for (const row of database
      .prepare("SELECT source_path, session_kind, structural_evidence_json FROM session_catalog")
      .all()) {
      report.catalogRows += 1;
      const classification = cachedThreadClassification(
        row["structural_evidence_json"] === null
          ? null
          : (object(row["structural_evidence_json"]) ?? {}),
        String(row["session_kind"]),
      );
      if (classification.visibility === "internal") {
        report.hiddenInternals += 1;
      }
      if (classification.visibility === "unresolved") {
        report.unresolvedClassification += 1;
      }
      const path = row["source_path"];
      if (typeof path !== "string" || path.length === 0) {
        report.missingSourcePaths += 1;
      } else if (path.endsWith(".jsonl.zst")) {
        report.sourceFormats.zstd += 1;
      } else if (path.endsWith(".jsonl")) {
        report.sourceFormats.plain += 1;
      } else {
        report.sourceFormats.unsupported += 1;
      }
    }
  }
  if (tables.has("catalog_sidebar")) {
    const library = object(
      database.prepare("SELECT payload_json FROM catalog_sidebar WHERE id = 1").get()?.[
        "payload_json"
      ],
    );
    const projects = new Set(
      Array.isArray(library?.["projects"])
        ? library["projects"].flatMap((entry: unknown) =>
            typeof entry === "object" &&
            entry !== null &&
            "id" in entry &&
            typeof entry.id === "string"
              ? [entry.id]
              : [],
          )
        : [],
    );
    for (const thread of Array.isArray(library?.["threads"]) ? library["threads"] : []) {
      if (
        typeof thread === "object" &&
        thread !== null &&
        "projectId" in thread &&
        typeof thread.projectId === "string" &&
        !projects.has(thread.projectId)
      ) {
        report.unresolvedProjectMappings += 1;
      }
    }
  }
  if (tables.has("source_files")) {
    const columns = new Set(
      database
        .prepare("PRAGMA table_info(source_files)")
        .all()
        .map((row) => row["name"]),
    );
    for (const row of database
      .prepare(
        `SELECT size, parsed_bytes, ${columns.has("generation_json") ? "generation_json" : "NULL AS generation_json"} FROM source_files`,
      )
      .all()) {
      if (Number(row["parsed_bytes"]) < Number(row["size"])) {
        report.materializedGenerations.incompleteEncodedReads += 1;
      }
      const generation = sourceGenerationSchema.safeParse(object(row["generation_json"]));
      if (generation.success && generation.data.encodedSha256 !== null) {
        report.materializedGenerations.validated += 1;
        report.materializedGenerations.decodedBytes += generation.data.decodedSize ?? 0;
      } else {
        report.materializedGenerations.legacyOrInvalid += 1;
      }
    }
  }
  if (tables.has("verified_history_projections")) {
    for (const row of database
      .prepare("SELECT evidence_json FROM verified_history_projections")
      .all()) {
      const evidence = object(row["evidence_json"]);
      if (evidence?.["version"] !== 2 || !Array.isArray(evidence["dependencies"])) {
        continue;
      }
      report.nativeProjection.verifiedAssociations += 1;
      if (evidence["dependencies"].length === 0) {
        report.nativeProjection.missingLineage += 1;
      }
      for (const dependency of evidence["dependencies"]) {
        if (typeof dependency !== "object" || dependency === null) {
          report.nativeProjection.missingLineage += 1;
          continue;
        }
        report.nativeProjection.coveredDependencies += 1;
        if (
          !("physicalRolloutId" in dependency) ||
          typeof dependency.physicalRolloutId !== "string"
        ) {
          report.nativeProjection.missingLineage += 1;
        }
        if ("nextOrdinal" in dependency && typeof dependency.nextOrdinal === "number") {
          report.nativeProjection.nextOrdinalMaximum = Math.max(
            report.nativeProjection.nextOrdinalMaximum ?? 0,
            dependency.nextOrdinal,
          );
        }
        if ("endExclusive" in dependency && typeof dependency.endExclusive === "number") {
          report.nativeProjection.nextByteMaximum = Math.max(
            report.nativeProjection.nextByteMaximum ?? 0,
            dependency.endExclusive,
          );
        }
      }
    }
  }
  if (tables.has("diagnostics")) {
    for (const row of database
      .prepare("SELECT code, COUNT(*) AS count FROM diagnostics GROUP BY code")
      .all()) {
      if (typeof row["code"] === "string" && typeof row["count"] === "number") {
        report.diagnosticsByCode[row["code"]] = row["count"];
      }
    }
  }
  return report;
}
