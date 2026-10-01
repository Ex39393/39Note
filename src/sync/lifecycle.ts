export function shouldWarnBeforeUnload(
  dirty: boolean,
  hasCloudTarget: boolean,
): boolean {
  return dirty && hasCloudTarget;
}
