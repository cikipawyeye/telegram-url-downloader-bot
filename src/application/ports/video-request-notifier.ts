export type StatusMessage = {
  messageId: number;
};

export type OutboundVideo = {
  filePath: string;
  fileName: string;
  caption: string;
};

export type OutboundScreenshot = {
  filePath: string;
  fileName: string;
  caption: string;
};

export interface VideoRequestNotifier {
  sendInvalidUrl(): Promise<void>;
  sendAccepted(): Promise<StatusMessage>;
  updateStatus(statusMessage: StatusMessage, text: string): Promise<void>;
  updateProgress(statusMessage: StatusMessage, text: string): Promise<void>;
  sendScreenshots(screenshots: OutboundScreenshot[]): Promise<void>;
  sendVideo(video: OutboundVideo): Promise<void>;
}
