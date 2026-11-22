import {
  type SaveRepertoireIdeaResponse,
  SaveRepertoireIdeaResponseSchema,
} from "@chess-coach/shared";

export type SaveRepertoireNote = (
  positionId: number,
  idea: string,
) => Promise<SaveRepertoireIdeaResponse>;

export async function saveRepertoireNote(
  positionId: number,
  idea: string,
): Promise<SaveRepertoireIdeaResponse> {
  const response = await fetch(`/api/repertoires/positions/${positionId}/idea`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idea }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return SaveRepertoireIdeaResponseSchema.parse(await response.json());
}
