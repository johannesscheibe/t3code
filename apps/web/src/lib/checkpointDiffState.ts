import { type CheckpointDiffState } from "@t3tools/client-runtime/state/threads";

import {
  type ThreadCheckpointDiffTarget,
  useCheckpointDiff as useCheckpointDiffQuery,
} from "../state/queries";

export function useCheckpointDiff(
  target: ThreadCheckpointDiffTarget,
  options?: { readonly enabled?: boolean },
): CheckpointDiffState {
  const state = useCheckpointDiffQuery(target, options);
  return {
    data: state.data,
    error: state.error,
    isPending: state.isPending,
  };
}
