export interface ScreenshotRequest {
  url: string;
  fullPage?: boolean;
  /** 普通截图模式：只截当前视口 */
  singleShot?: boolean;
  /** 分段截图时本次要截取的页面纵坐标起点，由服务端在响应里回传 */
  offset?: number;
  /** 单次请求最多返回几段，默认 6，上限 12 */
  maxSegments?: number;
}

export interface ScreenshotSegment {
  /** 该段在页面坐标系中的纵坐标起点 */
  offset: number;
  /** 该段高度，最后一段可能不足一个视口 */
  height: number;
  /** base64 编码的 PNG */
  image: string;
}

export interface ScreenshotResponse {
  success: boolean;
  /** 本次请求截取到的所有分段 */
  segments?: ScreenshotSegment[];
  /** 第一段的别名，保留用于兼容单段调用方 */
  screenshot?: string;
  /** 是否已到达页面底部，没有更多可截内容 */
  isEnd?: boolean;
  /** 下一次分段截图应当传入的 offset */
  nextOffset?: number;
  /** 页面总高度，便于前端展示进度 */
  pageHeight?: number;
  /** 服务端当前的并发压力，便于观测 */
  queue?: { active: number; waiting: number };
  error?: string;
}
