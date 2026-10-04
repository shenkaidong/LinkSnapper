/**
 * test:unit 的注册入口。`node --import ./scripts/ts-alias-register.mjs --test ...`
 *
 * 分开两个文件是有意的：register 只能加载一次，而 hooks 里是纯 ESM 导出，
 * 直接 `--experimental-loader` 会跟 Node 22 的新 loader 模型打架。
 */

import { register } from 'node:module'

// 第二参数必须是字符串形式的 URL，传 URL 对象会被当成相对路径拼出非法 URL。
register('./ts-alias-hooks.mjs', import.meta.url)
