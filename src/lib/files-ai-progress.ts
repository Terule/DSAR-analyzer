/** The Files tile reads "AI review" while the AI is still judging this run's files. */
export function filesAiReview(
  state:
    | {
        status: string;
        done: number;
        total: number;
        ai?: { done: number; total: number };
      }
    | undefined,
): { label: string; detail: string } | null {
  if (!state || state.status !== "processing" || !state.ai) return null;
  if (state.ai.total <= 0 || state.ai.done >= state.ai.total) return null;
  return {
    label: "AI review",
    detail: `${state.ai.done}/${state.ai.total} reviewed`,
  };
}
