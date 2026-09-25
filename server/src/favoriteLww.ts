export const isStaleFavoriteWrite = (
  existingOccurredAtMs: number,
  incomingOccurredAtMs: number,
  existingDeleted: boolean,
  incomingDelete: boolean,
): boolean => {
  if (incomingOccurredAtMs <= 0 || existingOccurredAtMs <= 0) return false;
  if (incomingOccurredAtMs < existingOccurredAtMs) return true;
  if (incomingOccurredAtMs > existingOccurredAtMs) return false;
  if (existingDeleted && incomingDelete) return true;
  if (incomingDelete) return false;
  return true;
};
