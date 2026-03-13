export type PathAliasPolicy = {
  allowFinalSymlinkForUnlink?: boolean;
  allowFinalHardlinkForUnlink?: boolean;
};

export const PATH_ALIAS_POLICIES = {
  default: {} as PathAliasPolicy,
  unlink: {
    allowFinalSymlinkForUnlink: true,
    allowFinalHardlinkForUnlink: true,
  } as PathAliasPolicy,
};

export async function assertNoPathAliasEscape(_params: {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
  policy?: PathAliasPolicy;
}): Promise<void> {
  // Browser-core compatibility shim: alias/hardlink validation was pruned.
}
