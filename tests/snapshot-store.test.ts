/**
 * 视觉变更监控：基准图的存储。
 *
 * 这里测的都是容易出事的部分：
 * key 拼进文件路径会路径穿越；配额没人清理会把磁盘写满；覆盖写入会写坏旧基准。
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  deriveSnapshotKey,
  enforceQuota,
  loadSnapshot,
  saveSnapshot,
  snapshotExists,
  snapshotPath,
  snapshotMetaPath,
} from '../src/services/snapshot-store.ts'

const originalDir = process.env.SNAPSHOT_DIR

/** 每个用例用全新临时目录：共享快照目录就会出现「你改了我、我改了你」的假失败 */
async function tempDirs(count: number): Promise<string[]> {
  return Promise.all(
    Array.from({ length: count }, () => mkdtemp(path.join(tmpdir(), 'linksnapper-snap-')))
  )
}

afterEach(() => {
  if (originalDir === undefined) delete process.env.SNAPSHOT_DIR
  else process.env.SNAPSHOT_DIR = originalDir
})

describe('snapshot key', () => {
  test('路径穿越与非白名单字符一律拒绝', () => {
    const candidates = ['../etc/passwd', 'a/b', '..', 'con/..', '', 'a'.repeat(65), 'key with space', 'key\n']

    for (const bad of candidates) {
      assert.throws(() => snapshotPath(bad), /snapshot key/, `key=${JSON.stringify(bad)} 应当被拒绝`)
    }
  })

  test('合法 key 拼出来的路径始终在存储目录内', async () => {
    const dirs = await tempDirs(1)
    process.env.SNAPSHOT_DIR = path.join(...dirs, 'snapshots')

    assert.equal(snapshotPath('abc-123_XY'), path.resolve(process.env.SNAPSHOT_DIR, 'abc-123_XY.png'))
    assert.equal(snapshotMetaPath('abc-123_XY'), path.resolve(process.env.SNAPSHOT_DIR, 'abc-123_XY.json'))
  })

  test('由 url + 参数推出的 key 稳定且只包含白名单字符', () => {
    const first = deriveSnapshotKey('https://example.com/a?b=1', { darkMode: true, viewport: { width: 1280 } })
    const second = deriveSnapshotKey('https://example.com/a?b=1', { viewport: { width: 1280 }, darkMode: true })
    const other = deriveSnapshotKey('https://example.com/a?b=1', { darkMode: false })

    assert.equal(first, second, '参数顺序不同也要命中同一份基准')
    assert.notEqual(first, other, '参数不同应是不同的基准')
    assert.match(first, /^[a-f0-9]{16}$/)
  })
})

describe('snapshot 存储', () => {
  test('保存后能读回图与元数据，覆盖写入不残留旧内容', async () => {
    const dirs = await tempDirs(1)
    process.env.SNAPSHOT_DIR = dirs[0]

    const meta = await saveSnapshot('k1', Buffer.from('first-payload'), {
      key: 'k1',
      url: 'https://example.com',
      params: { darkMode: true },
      format: 'png',
      savedAt: '2026-10-05T00:00:00.000Z',
    })
    assert.equal(meta.bytes, Buffer.byteLength('first-payload'))

    assert.ok(await snapshotExists('k1'))
    assert.equal((await loadSnapshot('k1')).png.toString(), 'first-payload')
    assert.equal((await loadSnapshot('k1')).meta?.params.darkMode, true)

    await saveSnapshot('k1', Buffer.from('second-payload'), {
      key: 'k1',
      url: 'https://example.com',
      params: {},
      format: 'png',
      savedAt: '2026-10-06T00:00:00.000Z',
    })
    assert.equal((await loadSnapshot('k1')).png.toString(), 'second-payload', '覆盖后必须是新内容')
  })

  test('元数据损坏不影响基准图可用', async () => {
    const dirs = await tempDirs(1)
    process.env.SNAPSHOT_DIR = dirs[0]

    await saveSnapshot('k2', Buffer.from('image'), {
      key: 'k2',
      url: 'https://example.com',
      params: {},
      format: 'png',
      savedAt: 'now',
    })
    await writeFile(snapshotMetaPath('k2'), 'this-is-not-json')

    const loaded = await loadSnapshot('k2')
    assert.equal(loaded.png.toString(), 'image')
    assert.equal(loaded.meta, null)
  })

  test('不存在的 key 读出来是空，而不是抛异常', async () => {
    const dirs = await tempDirs(1)
    process.env.SNAPSHOT_DIR = dirs[0]

    assert.equal(await snapshotExists('missing'), false)
    assert.equal((await loadSnapshot('missing')).png.toString(), '')
  })

  test('超出配额淘汰最旧的基准，并连带清掉元数据', async () => {
    const dirs = await tempDirs(1)
    process.env.SNAPSHOT_DIR = dirs[0]

    for (let i = 0; i < 5; i++) {
      await saveSnapshot(`k${i}`, Buffer.from(`img-${i}`), {
        key: `k${i}`,
        url: `https://example.com/${i}`,
        params: {},
        format: 'png',
        savedAt: 'now',
      })
      // 每写完一个就把时间戳往后推，淘汰顺序才确定，不靠文件系统写入快慢
      const target = snapshotPath(`k${i}`)
      await utimes(target, new Date(Date.now() + i * 1000), new Date(Date.now() + i * 1000))
    }

    await enforceQuota(2)

    const remaining = (await readdir(dirs[0])).filter(name => name.endsWith('.png')).sort()
    assert.deepEqual(remaining, ['k3.png', 'k4.png'])
    assert.equal(await snapshotExists('k0'), false)
    assert.ok(
      !(await readdir(dirs[0])).includes('k0.json'),
      '元数据要跟着一起删，否则目录里只剩孤儿 json'
    )
  })
})
