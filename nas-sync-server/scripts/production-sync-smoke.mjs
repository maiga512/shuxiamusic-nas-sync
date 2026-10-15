import assert from 'node:assert/strict'

const baseUrl = String(process.env.SHUXIA_SYNC_TEST_BASE_URL || 'http://127.0.0.1:31231').replace(/\/$/, '')
const adminToken = String(process.env.SHUXIA_SYNC_ADMIN_TOKEN || '')
assert.ok(adminToken, 'SHUXIA_SYNC_ADMIN_TOKEN is required')

const results = []
let testUserId = ''
let phoneToken = ''
let desktopToken = ''

const request = async (path, { method = 'GET', token = '', admin = false, body, timeoutMs = 30_000 } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(admin ? { 'x-admin-token': adminToken } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${payload.error || ''}`.trim())
  return payload
}

const check = async (name, run) => {
  const startedAt = Date.now()
  try {
    await run()
    results.push({ name, ok: true, elapsedMs: Date.now() - startedAt })
  } catch (error) {
    results.push({ name, ok: false, elapsedMs: Date.now() - startedAt, error: error.message })
  }
}

const auth = (token, body) => ({ method: 'POST', token, body })
const song = (id) => ({ id, songmid: id, source: 'wy', title: `SYNC_TEST_${id}`, singer: 'Codex Test' })

try {
  const username = `sync_acceptance_${Date.now()}`
  const created = await request('/admin/users', { method: 'POST', admin: true, body: { username } })
  testUserId = created.user.id
  const pair = await request('/admin/pair-codes', { method: 'POST', admin: true, body: { userId: testUserId, force: true } })
  const phone = await request('/auth/pair', { method: 'POST', body: { pairCode: pair.pairCode } })
  const desktop = await request('/auth/pair', { method: 'POST', body: { pairCode: pair.pairCode } })
  phoneToken = phone.accessToken
  desktopToken = desktop.accessToken

  await check('双设备注册与账号隔离', async () => {
    await request('/sync/register', auth(phoneToken, { deviceId: 'test-android', deviceName: 'Android acceptance', deviceType: 'android' }))
    await request('/sync/register', auth(desktopToken, { deviceId: 'test-mac', deviceName: 'Mac acceptance', deviceType: 'desktop' }))
    const devices = await request('/sync/devices', { token: phoneToken })
    assert.deepEqual(new Set(devices.items.map((item) => item.deviceId)), new Set(['test-android', 'test-mac']))
  })

  let favorites
  let playlistA
  let playlistB
  await check('手机备份歌单与歌曲到云端', async () => {
    favorites = await request('/playlists', auth(phoneToken, { localId: 'system:favorites', title: '我的喜欢', semanticType: 'favorites' }))
    playlistA = await request('/playlists', auth(phoneToken, { localId: 'test:a', title: 'SYNC_TEST_A', position: 1 }))
    playlistB = await request('/playlists', auth(phoneToken, { localId: 'test:b', title: 'SYNC_TEST_B', position: 2 }))
    await request(`/playlists/${playlistA.id}/songs`, auth(phoneToken, { songs: [song('a'), song('b'), song('c')] }))
    const detail = await request(`/playlists/${playlistA.id}/songs`, { token: desktopToken })
    assert.deepEqual(detail.songs.map((item) => item.id), ['a', 'b', 'c'])
  })

  await check('歌曲收藏添加取消与防旧操作复活', async () => {
    const now = Date.now()
    await request('/playlist-song-ops', auth(phoneToken, {
      operationId: 'phone-add-song', deviceId: 'test-android', sequence: 1, occurredAtMs: now,
      playlistId: favorites.id, action: 'add', trackKey: 'wy:fav', song: song('fav')
    }))
    await request('/playlist-song-ops', auth(desktopToken, {
      operationId: 'mac-remove-song', deviceId: 'test-mac', sequence: 1, occurredAtMs: now + 100,
      playlistId: favorites.id, action: 'remove', trackKey: 'wy:fav'
    }))
    const stale = await request('/playlist-song-ops', auth(phoneToken, {
      operationId: 'phone-delayed-add-song', deviceId: 'test-android', sequence: 2, occurredAtMs: now + 50,
      playlistId: favorites.id, action: 'add', trackKey: 'wy:fav', song: song('fav')
    }))
    assert.equal(stale.stale, true)
    const detail = await request(`/playlists/${favorites.id}/songs`, { token: phoneToken })
    assert.equal(detail.songs.some((item) => item.id === 'fav'), false)
  })

  await check('歌单顺序与歌单歌曲顺序', async () => {
    const playlists = await request('/playlists', { token: desktopToken })
    const orderedPlaylistIds = playlists.map((item) => item.id).reverse()
    await request('/playlist-reorder', auth(desktopToken, { orderedIds: orderedPlaylistIds }))
    assert.deepEqual((await request('/playlists', { token: phoneToken })).map((item) => item.id), orderedPlaylistIds)

    const current = await request(`/playlists/${playlistA.id}/songs`, { token: phoneToken })
    const reordered = [...current.songs].reverse()
    await request(`/playlists/${playlistA.id}`, {
      method: 'PATCH', token: desktopToken, body: { title: playlistA.title, songs: reordered, orderOnly: true }
    })
    assert.deepEqual((await request(`/playlists/${playlistA.id}/songs`, { token: phoneToken })).songs.map((item) => item.id), reordered.map((item) => item.id))
  })

  await check('播客收藏取消置顶与顺序', async () => {
    const podcasts = [
      { entityType: 'podcast', entityId: 'test:podcast:1', sourcePlaylistId: '1', title: 'SYNC_TEST_PODCAST_1', source: 'test', position: 0, pinned: false },
      { entityType: 'podcast', entityId: 'test:podcast:2', sourcePlaylistId: '2', title: 'SYNC_TEST_PODCAST_2', source: 'test', position: 1, pinned: false }
    ]
    for (const item of podcasts) await request('/favorites', auth(phoneToken, item))
    await request('/favorites', auth(desktopToken, { ...podcasts[1], pinned: true }))
    await request('/favorite-reorder', auth(desktopToken, { entityType: 'podcast', orderedIds: ['test:podcast:2', 'test:podcast:1'] }))
    let items = (await request('/favorites?entityType=podcast', { token: phoneToken })).items
    assert.deepEqual(items.map((item) => item.entityId), ['test:podcast:2', 'test:podcast:1'])
    assert.equal(items[0].pinned, true)
    await request('/favorites/podcast/test%3Apodcast%3A1', { method: 'DELETE', token: phoneToken })
    items = (await request('/favorites?entityType=podcast', { token: desktopToken })).items
    assert.deepEqual(items.map((item) => item.entityId), ['test:podcast:2'])
  })

  let pluginHash
  await check('插件新增更新启停删除与顺序', async () => {
    const blob = await request('/plugin-blobs', auth(phoneToken, { script: '/* SYNC_TEST_PLUGIN */\nmodule.exports = {}' }))
    pluginHash = blob.contentHash
    const now = Date.now()
    for (const [index, identityKey] of ['music-source:test-one', 'music-source:test-two'].entries()) {
      await request('/plugin-ops', auth(phoneToken, {
        operationId: `phone-plugin-${index}`, deviceId: 'test-android', sequence: index + 1, occurredAtMs: now + index,
        identityKey, action: 'upsert', kind: 'music-source', name: `SYNC_TEST_PLUGIN_${index + 1}`, author: 'Codex Test',
        version: '1.0.0', enabled: index === 0, disabledSources: index === 0 ? [] : ['kw'], contentHash: pluginHash, position: index
      }))
    }
    await request('/plugin-reorder', auth(desktopToken, { orderedIds: ['music-source:test-two', 'music-source:test-one'] }))
    let plugins = (await request('/plugins', { token: desktopToken })).items
    assert.deepEqual(plugins.map((item) => item.identityKey), ['music-source:test-two', 'music-source:test-one'])
    assert.equal(plugins[1].enabled, true)
    await request('/plugin-ops', auth(desktopToken, {
      operationId: 'mac-plugin-disable', deviceId: 'test-mac', sequence: 1, occurredAtMs: now + 100,
      identityKey: 'music-source:test-one', action: 'upsert', kind: 'music-source', name: 'SYNC_TEST_PLUGIN_1', author: 'Codex Test',
      version: '1.0.1', enabled: false, disabledSources: ['tx'], contentHash: pluginHash, position: 1
    }))
    plugins = (await request('/plugins', { token: phoneToken })).items
    assert.equal(plugins.find((item) => item.identityKey === 'music-source:test-one').enabled, false)
    await request('/plugin-ops', auth(phoneToken, {
      operationId: 'phone-plugin-remove', deviceId: 'test-android', sequence: 3, occurredAtMs: now + 200,
      identityKey: 'music-source:test-two', action: 'remove', kind: 'music-source'
    }))
    plugins = (await request('/plugins', { token: desktopToken })).items
    assert.deepEqual(plugins.map((item) => item.identityKey), ['music-source:test-one'])
  })

  await check('另一端写入后长轮询即时唤醒', async () => {
    const cursor = (await request('/sync?sinceRevision=999999999999', { token: desktopToken })).revision
    const startedAt = Date.now()
    const waiting = request(`/sync/wait?sinceRevision=${cursor}&timeout=5000`, { token: desktopToken, timeoutMs: 7_000 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await request(`/playlists/${playlistB.id}`, { method: 'PATCH', token: phoneToken, body: { title: 'SYNC_TEST_B_REALTIME' } })
    const result = await waiting
    assert.ok(Date.now() - startedAt < 2_000)
    assert.ok(result.nextRevision > cursor)
    assert.ok(result.events.some((event) => event.entityType === 'playlist'))
  })

  await check('分页游标、设备进度与删除事件', async () => {
    const first = await request('/sync?sinceRevision=0', { token: phoneToken })
    assert.ok(Number.isFinite(first.nextRevision))
    assert.equal(typeof first.hasMore, 'boolean')
    await request('/sync/device-revision', auth(phoneToken, { deviceId: 'test-android', revision: first.nextRevision }))
    const devices = await request('/sync/devices', { token: desktopToken })
    assert.equal(devices.items.find((item) => item.deviceId === 'test-android').lastSyncedRevision, first.nextRevision)
    const beforeDelete = first.revision
    await request(`/playlists/${playlistB.id}`, { method: 'DELETE', token: desktopToken })
    const changes = await request(`/sync?sinceRevision=${beforeDelete}`, { token: phoneToken })
    assert.ok(changes.events.some((event) => event.entityType === 'playlist' && event.action === 'delete'))
  })
} finally {
  if (testUserId) {
    await request('/admin/users', { method: 'DELETE', admin: true, body: { userId: testUserId, confirmText: '我要删除' } }).catch(() => {})
  }
}

console.log(JSON.stringify({ ok: results.every((item) => item.ok), results }, null, 2))
if (results.some((item) => !item.ok)) process.exitCode = 1
