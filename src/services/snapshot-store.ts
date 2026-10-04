/**
 * 视觉变更监控的存储层。
 *
 * 只回答一个问题：把一张基准图存在哪、怎么取、怎么不把磁盘撑爆。
 * 像素比对（耗费 CPU 的那部分）在 `snapshot-diff.ts`，这里不碰。
 *
 * 几个刻意的取舍：
 *   - **不用数据库**。基准图就是文件，顺手就能被 `rsync` / 挂载卷备份，
 *     容器里挂一个 volume 就跨重启存活。
 *   - **key 必须白名单校验**。key 拼进了文件路径，任何 `..`、斜杠、空字节
 *     都等于给这个接口开了一个任意文件读写的口子。
 *   - **默认自带 LRU**。没人会主动清理，磁盘被基准图撑满之后整个服务先崩，
 *     到时候想起来清理已经晚了，所以配额在这里兜住。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { HttpError } from '@/utils/http-error'

export const DEFAULT_SNAPSHOT_DIR = '.snapshots'

/** key 只允许 URL 安全字符：长度 1–64，不能有路径分隔符 */
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** 默认最多保留多少个基准图。超出后按修改时间淘汰最旧的。 */
export const DEFAULT_MAX_SNAPSHOTS = 200

export interface SnapshotMeta {
  key: string
  url: string
  /** 生成基准图时用的截图参数（已归一化），便于事后复现 */
  params: Record<string, unknown>
  format: string
  savedAt: string
  bytes: number
}

function resolveDir(): string {
  const configured = process.env.SNAPSHOT_DIR?.trim()
  if (configured) return path.resolve(configured)
  return path.resolve(process.cwd(), DEFAULT_SNAPSHOT_DIR)
}

/**
 * key 校验 + 路径拼接。
 *
 * 白名单校验优先于「拼好路径再判断前缀」—— 后者在 Node 里因为 path.resolve
 * 会先规范化 `..`，边界情况多。直接拒绝不合规字符更短也更可靠。
 */
export function snapshotPath(key: string): string {
  if (!KEY_PATTERN.test(key)) {
    throw new HttpError(400, 'snapshot key 只允许字母、数字、下划线和短横线，长度 1-64')
  }
  const dir = resolveDir()
  return path.join(dir, `${key}.png`)
}

export function snapshotMetaPath(key: string): string {
  if (!KEY_PATTERN.test(key)) {
    throw new HttpError(400, 'snapshot key 只允许字母、数字、下划线和短横线，长度 1-64')
  }
  const dir = resolveDir()
  return path.join(dir, `${key}.json`)
}

/**
 * 由「URL + 截图参数」推出 key。
 *
 * 这样调用方不传 key 也能自动对齐：同一地址 + 同一组参数永远命中同一份基准，
 * 换一个视口尺寸或 darkMode 就自动是一份新的基准，不需要人去记 id。
 */
export function deriveSnapshotKey(url: string, params: Record<string, unknown>): string {
  const stable = Object.keys(params)
    .sort()
    .map(name => `${name}=${JSON.stringify(params[name])}`)
    .join('&')

  return createHash('sha1').update(`${url}|${stable}`).digest('hex').slice(0, 16)
}

export async function ensureSnapshotDir(): Promise<string> {
  const dir = resolveDir()
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * 基准图是否已经存在（只看图，不看元数据，避免元数据写失败导致永远存不了）。
 *
 * key 校验必须放在 try 外面：早先写在 try 里，非法的 `../../etc/passwd`
 * 会被 catch 吞成「基准不存在」，冒烟里表现为 404 而不是 400 ——
 * 攻击者用一个穿越的 key 就能把参数校验错误伪装成「你还没存过基准」。
 */
export async function snapshotExists(key: string): Promise<boolean> {
  const file = snapshotPath(key)
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

export async function saveSnapshot(key: string, png: Buffer, meta: Omit<SnapshotMeta, 'bytes'>): Promise<SnapshotMeta> {
  await ensureSnapshotDir()

  const record: SnapshotMeta = { ...meta, bytes: png.byteLength }
  await writeFile(snapshotPath(key), png)
  await writeFile(snapshotMetaPath(key), JSON.stringify(record, null, 2))

  await enforceQuota()
  return record
}

export async function loadSnapshot(key: string): Promise<{ png: Buffer; meta: SnapshotMeta | null }> {
  // 基准图与元数据都是「取不到就算没有」：文件不存在、目录还没创建、
  // 元数据损坏，都不应该把这个接口变成 500，调用方要的是「没有基准」这个结论。
  const [pngFile, metaFile] = await Promise.all([
    readFile(snapshotPath(key)).catch(() => null),
    readFile(snapshotMetaPath(key)).catch(() => null),
  ])

  let meta: SnapshotMeta | null = null
  if (metaFile) {
    try {
      meta = JSON.parse(metaFile.toString('utf8')) as SnapshotMeta
    } catch {
      meta = null
    }
  }

  return { png: pngFile ?? Buffer.alloc(0), meta }
}

/** 配额：调用方显式传的优先，其次环境变量 MAX_SNAPSHOTS，最后默认值 */
function resolveQuota(max?: number): number {
  if (typeof max === 'number' && Number.isFinite(max)) return max

  const fromEnv = Number(process.env.MAX_SNAPSHOTS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.trunc(fromEnv)
  return DEFAULT_MAX_SNAPSHOTS
}

/** 目录里已有的基准图数量。写操作前后各调一次以维持上限。 */
export async function enforceQuota(max?: number): Promise<void> {
  const limit = resolveQuota(max)
  const dir = await ensureSnapshotDir()

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }

  const pngs = entries.filter(name => name.endsWith('.png'))
  if (pngs.length <= limit) return

  // 按修改时间升序，淘汰最旧的。并行 stat 不划算，串行读 mtime 也就几百次 IO。
  const withTime: Array<{ name: string; mtimeMs: number }> = []
  for (const name of pngs) {
    try {
      const info = await stat(path.join(dir, name))
      withTime.push({ name, mtimeMs: info.mtimeMs })
    } catch {
      /* 读不到就当它不存在，下一轮自然被清掉 */
    }
  }

  withTime.sort((a, b) => a.mtimeMs - b.mtimeMs)

  const excess = withTime.slice(0, withTime.length - limit)
  await Promise.all(
    excess.map(entry => Promise.all([rm(path.join(dir, entry.name), { force: true }), rm(path.join(dir, entry.name.replace(/\.png$/, '.json')), { force: true })]))
  )
}
