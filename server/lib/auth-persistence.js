let writeAdapter = null;

export function configureAuthWriteAdapter(adapter) {
  writeAdapter = adapter;
}

export function authWritesRequireCommit() {
  return !!writeAdapter?.primary;
}

export async function commitAuthGroups(...groups) {
  if (!writeAdapter?.primary) return { required: false };
  return writeAdapter.commit(groups.flat().filter(Boolean));
}
