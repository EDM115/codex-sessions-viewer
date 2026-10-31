import type { DatabaseSync } from "node:sqlite";

import { cachedThreadClassification } from "#server/metadata/threadClassification.ts";
import { sourceGenerationSchema } from "#shared/types/conversation.ts";

interface EvidenceSection {
  availability: "available" | "unavailable" | "invalid" | "partial";
  diagnostics: string[];
}

function tableSection(
  database: DatabaseSync,
  tables: ReadonlySet<unknown>,
  table: string,
  required: readonly string[],
): EvidenceSection {
  if (!tables.has(table)) {
    return { availability: "unavailable", diagnostics: ["table-missing"] };
  }
  const columns = new Set(
    database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row["name"]),
  );
  const diagnostics = required
    .filter((column) => !columns.has(column))
    .map((column) => `column-missing:${column}`);
  return { availability: diagnostics.length ? "unavailable" : "available", diagnostics };
}

function partial(section: EvidenceSection, reason: string) {
  section.availability = "partial";
  if (!section.diagnostics.includes(reason)) {
    section.diagnostics.push(reason);
  }
}

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
    sections: {
      catalog: tableSection(database, tables, "session_catalog", [
        "source_path",
        "session_kind",
        "structural_evidence_json",
      ]),
      projectMappings: tableSection(database, tables, "catalog_sidebar", ["id", "payload_json"]),
      materializedGenerations: tableSection(database, tables, "source_files", [
        "size",
        "parsed_bytes",
      ]),
      nativeProjection: tableSection(database, tables, "verified_history_projections", [
        "evidence_json",
      ]),
      diagnostics: tableSection(database, tables, "diagnostics", ["code"]),
    },
    catalogRows: 0,
    hiddenInternals: 0,
    unresolvedClassification: 0,
    unresolvedProjectMappings: null as number | null,
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
  if (report.sections.catalog.availability === "available") {
    for (const row of database
      .prepare("SELECT source_path, session_kind, structural_evidence_json FROM session_catalog")
      .all()) {
      report.catalogRows += 1;
      if (
        row["structural_evidence_json"] === null ||
        object(row["structural_evidence_json"]) === null
      ) {
        partial(report.sections.catalog, "classification-evidence-unavailable");
      }
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
  if (report.sections.projectMappings.availability === "available") {
    const section = report.sections.projectMappings;
    const row = database.prepare("SELECT payload_json FROM catalog_sidebar WHERE id = 1").get();
    const library = object(row?.["payload_json"]);
    if (row === undefined) {
      section.availability = "unavailable";
      section.diagnostics.push("row-missing");
    } else if (library === null) {
      section.availability = "invalid";
      section.diagnostics.push("payload-invalid");
    } else {
      const projects = library["projects"];
      const threads = library["threads"];
      if (!Array.isArray(projects) || !Array.isArray(threads)) {
        partial(section, "aggregate-fields-invalid");
      } else {
        const ids = new Set<string>();
        for (const project of projects) {
          if (
            typeof project === "object" &&
            project !== null &&
            "id" in project &&
            typeof project.id === "string"
          ) {
            ids.add(project.id);
          } else {
            partial(section, "project-entry-invalid");
          }
        }
        let unresolved = 0;
        for (const thread of threads) {
          if (
            typeof thread !== "object" ||
            thread === null ||
            !("projectId" in thread) ||
            (thread.projectId !== null && typeof thread.projectId !== "string")
          ) {
            partial(section, "thread-entry-invalid");
          } else if (typeof thread.projectId === "string" && !ids.has(thread.projectId)) {
            unresolved += 1;
          }
        }
        if (section.availability === "available") {
          report.unresolvedProjectMappings = unresolved;
        }
      }
    }
  }
  if (report.sections.materializedGenerations.availability === "available") {
    const columns = new Set(
      database
        .prepare("PRAGMA table_info(source_files)")
        .all()
        .map((row) => row["name"]),
    );
    if (!columns.has("generation_json")) {
      partial(report.sections.materializedGenerations, "column-missing:generation_json");
    }
    for (const row of database
      .prepare(
        `SELECT size, parsed_bytes, ${columns.has("generation_json") ? "generation_json" : "NULL AS generation_json"} FROM source_files`,
      )
      .all()) {
      if (Number(row["parsed_bytes"]) < Number(row["size"])) {
        report.materializedGenerations.incompleteEncodedReads += 1;
      }
      if (typeof row["size"] !== "number" || typeof row["parsed_bytes"] !== "number") {
        partial(report.sections.materializedGenerations, "encoded-size-invalid");
      }
      const generation = sourceGenerationSchema.safeParse(object(row["generation_json"]));
      if (generation.success && generation.data.encodedSha256 !== null) {
        report.materializedGenerations.validated += 1;
        report.materializedGenerations.decodedBytes += generation.data.decodedSize ?? 0;
        if (generation.data.decodedSize === null) {
          partial(report.sections.materializedGenerations, "decoded-size-unavailable");
        }
      } else {
        report.materializedGenerations.legacyOrInvalid += 1;
        partial(report.sections.materializedGenerations, "generation-invalid");
      }
    }
  }
  if (report.sections.nativeProjection.availability === "available") {
    for (const row of database
      .prepare("SELECT evidence_json FROM verified_history_projections")
      .all()) {
      const evidence = object(row["evidence_json"]);
      if (evidence?.["version"] !== 2 || !Array.isArray(evidence["dependencies"])) {
        partial(report.sections.nativeProjection, "projection-evidence-invalid");
        continue;
      }
      report.nativeProjection.verifiedAssociations += 1;
      if (evidence["dependencies"].length === 0) {
        report.nativeProjection.missingLineage += 1;
        partial(report.sections.nativeProjection, "lineage-unavailable");
      }
      for (const dependency of evidence["dependencies"]) {
        if (typeof dependency !== "object" || dependency === null) {
          report.nativeProjection.missingLineage += 1;
          partial(report.sections.nativeProjection, "lineage-entry-invalid");
          continue;
        }
        report.nativeProjection.coveredDependencies += 1;
        if (
          !("physicalRolloutId" in dependency) ||
          typeof dependency.physicalRolloutId !== "string"
        ) {
          report.nativeProjection.missingLineage += 1;
          partial(report.sections.nativeProjection, "lineage-identity-unavailable");
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
  if (report.sections.diagnostics.availability === "available") {
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
