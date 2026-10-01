export interface ScreenshotRequest {
  url: string;
  fullPage?: boolean;
  /** 普通截图模式：只截当前视口 */
  singleShot?: boolean;
  /** 分段截图时本次要截取的页面纵坐标起点，由服务端在响应里回传 */
  offset?: number;
}

export interface ScreenshotResponse {
  success: boolean;
  screenshot?: string;
  /** 是否已到达页面底部，没有更多可截内容 */
  isEnd?: boolean;
  /** 下一次分段截图应当传入的 offset */
  nextOffset?: number;
  error?: string;
}
