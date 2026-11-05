import { type ProgressResponse, ProgressResponseSchema } from "@chess-coach/shared";

export type FetchProgress = () => Promise<ProgressResponse>;

export const fetchProgressFromServer: FetchProgress = async () => {
  const response = await fetch("/api/progress");
  if (!response.ok) throw new Error(`progress: ${response.status}`);
  return ProgressResponseSchema.parse(await response.json());
};
