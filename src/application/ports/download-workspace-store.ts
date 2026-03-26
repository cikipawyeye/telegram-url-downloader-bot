export type DownloadWorkspace = {
  dirPath: string;
};

export interface DownloadWorkspaceStore {
  prepareRoot(): Promise<void>;
  create(userId: string): Promise<DownloadWorkspace>;
  remove(workspace: DownloadWorkspace): Promise<void>;
}
