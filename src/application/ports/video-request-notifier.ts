export type StatusMessage = {
  messageId: number;
};

export type OutboundVideo = {
  filePath: string;
  fileName: string;
  caption: string;
};

export interface VideoRequestNotifier {
  sendInvalidUrl(): Promise<void>;
  sendAccepted(): Promise<StatusMessage>;
  updateStatus(statusMessage: StatusMessage, text: string): Promise<void>;
  sendVideo(video: OutboundVideo): Promise<void>;
}
