import { ScreenshotRequest, ScreenshotResponse } from '../types/screenshot';

class ApiClient {
  private static readonly BASE_URL = '/api';

  private static async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(`${this.BASE_URL}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return response.json();
  }

  public static async takeScreenshot(
    data: ScreenshotRequest
  ): Promise<ScreenshotResponse> {
    return this.request<ScreenshotResponse>('/screenshot', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }
} 