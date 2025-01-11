export interface ScreenshotRequest {
  url: string;
  fullPage?: boolean;
}

export interface ScreenshotResponse {
  success: boolean;
  screenshot?: string;
  isEnd?: boolean;
  error?: string;
} 