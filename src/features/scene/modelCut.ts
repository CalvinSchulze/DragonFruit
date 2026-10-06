export function selectModelsForClipboard<T extends { id: string }>(
  models: readonly T[],
  ids: readonly string[],
): T[] {
  const idSet = new Set(ids);
  return models.filter((model) => idSet.has(model.id));
}

export function performModelCut(
  ids: string[],
  copySelectedModels: (targetIds: string[]) => boolean,
  /** Fire-and-forget: any return value is ignored. */
  deleteModels: (targetIds: string[]) => unknown,
): boolean {
  if (!copySelectedModels(ids)) return false;

  void deleteModels(ids);
  return true;
}