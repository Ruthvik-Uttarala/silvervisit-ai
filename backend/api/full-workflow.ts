import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { handleFullWorkflowDiagnostic } from "../src/routes/fullWorkflowDiagnostic";

export default async function handler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleFullWorkflowDiagnostic(res, randomUUID());
}
