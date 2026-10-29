import * as z from "zod";

import { guardianApprovalEvidenceSchema } from "./conversation.ts";
import { historyCoverageSchema, reviewSourceRecordSchema } from "./history.ts";

export const guardianReviewSchema = guardianApprovalEvidenceSchema.extend({
  guardianSessionId: z.string().nullable(),
  parentThreadId: z.string().nullable(),
  rawEventIds: z.array(z.string()),
  toolName: z.string().nullable().optional(),
  toolNamespace: z.string().nullable().optional(),
  requestedAt: z.string().nullable().optional(),
  sourceRecords: z.array(reviewSourceRecordSchema).optional(),
});
export type GuardianReview = z.infer<typeof guardianReviewSchema>;
const unmatchedReviewSchema = z.strictObject({
  review: guardianReviewSchema,
  reason: z.enum([
    "missing-scope",
    "missing-tool-or-turn",
    "missing-target",
    "conflicting-targets",
    "ambiguous-target",
    "standalone-denial",
  ]),
});
export interface ApprovalAssociations {
  matches: Map<string, GuardianReview[]>;
  unattached: Array<z.infer<typeof unmatchedReviewSchema>>;
}
export const approvalParentSourceSchema = z.strictObject({
  availability: z.enum(["complete", "partial", "unresolved"]),
  historyEpoch: z.string().nullable(),
  contentRevision: z.string().nullable(),
  coverage: historyCoverageSchema.nullable(),
});
export const approvalEvidenceResultSchema = z.strictObject({
  sessionId: z.string(),
  matched: z.array(
    z.strictObject({ activityId: z.string(), attempts: z.array(guardianReviewSchema) }),
  ),
  unattached: z.array(unmatchedReviewSchema),
  parentSource: approvalParentSourceSchema.optional(),
});
export type ApprovalEvidenceResult = z.infer<typeof approvalEvidenceResultSchema>;
