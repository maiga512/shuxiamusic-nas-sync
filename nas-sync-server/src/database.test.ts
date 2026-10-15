import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {SyncDatabase} from './database.ts';

const song = (id: string) => ({
  id,
  songmid: id,
  source: 'wy',
  title: `Song ${id}`,
  singer: 'Artist',
});

const withDatabase = (run: (database: SyncDatabase, userId: string, playlistId: string) => void) => {
  const directory = mkdtempSync(join(tmpdir(), 'shuxia-sync-test-'));
  const database = new SyncDatabase(join(directory, 'sync.sqlite'));
  const user = database.createUser({username: `test-${Date.now()}`, passwordHash: 'hash'});
  const playlist = database.createPlaylist(user.id, {
    localId: 'system:favorites',
    title: '我的喜欢',
    semanticType: 'favorites',
    songlist: [song('seed')],
  });
  assert.ok(playlist?.id);

  try {
    run(database, user.id, playlist.id);
  } finally {
    database.close();
    rmSync(directory, {recursive: true, force: true});
  }
};

test('snapshot marker reports the current revision and safe entity counts', () => {
  withDatabase((database, userId, playlistId) => {
    const marker = database.getSyncSnapshotMarker(userId);
    assert.equal(marker.revision, database.getCurrentRevision(userId));
    assert.equal(marker.counts.playlists, 1);
    assert.equal(marker.counts.favorites, 0);
    assert.equal(marker.counts.plugins, 0);
    assert.equal(marker.counts.podcasts, 0);
    assert.ok(playlistId);
  });
});

test('cross-device stale add cannot resurrect a later remove', () => {
  withDatabase((database, userId, playlistId) => {
    database.applySongOperation(userId, {
      operationId: 'seed-add',
      deviceId: 'seed-device',
      sequence: 1,
      occurredAtMs: 1_000,
      playlistId,
      action: 'add',
      trackKey: 'wy:1',
      song: song('1'),
    });
    const removed = database.applySongOperation(userId, {
      operationId: 'phone-remove',
      deviceId: 'phone',
      sequence: 1,
      occurredAtMs: 2_000,
      playlistId,
      action: 'remove',
      trackKey: 'wy:1',
    });
    assert.equal(removed?.changed, true);

    const delayedAdd = database.applySongOperation(userId, {
      operationId: 'desktop-delayed-add',
      deviceId: 'desktop',
      sequence: 1,
      occurredAtMs: 1_500,
      playlistId,
      action: 'add',
      trackKey: 'wy:1',
      song: song('1'),
    });

    assert.equal(delayedAdd?.stale, true);
    assert.equal(database.getPlaylistSongs(userId, playlistId)?.total, 1);
    assert.deepEqual(
      database.getPlaylistSongs(userId, playlistId)?.songs.map((item) => item.songmid),
      ['seed'],
    );
  });
});

test('playlist detail reuses one converted song array for list and songs', () => {
  withDatabase((database, userId, playlistId) => {
    const detail = database.getPlaylistSongs(userId, playlistId);
    assert.ok(detail);
    assert.strictEqual(detail.list, detail.songs);
    assert.equal(detail.list[0]?.songmid, 'seed');
  });
});

test('source-prefixed track ids collapse to one canonical song', () => {
  withDatabase((database, userId, playlistId) => {
    database.applySongOperation(userId, {
      operationId: 'prefixed-add', deviceId: 'android', sequence: 1, occurredAtMs: 1_000,
      playlistId, action: 'add', trackKey: 'wy:wy:duplicate', song: song('wy:duplicate'),
    });
    const duplicate = database.applySongOperation(userId, {
      operationId: 'canonical-add', deviceId: 'desktop', sequence: 1, occurredAtMs: 2_000,
      playlistId, action: 'add', trackKey: 'wy:duplicate', song: song('duplicate'),
    });

    assert.equal(duplicate?.changed, false);
    assert.equal(database.getPlaylistSongs(userId, playlistId)?.songs.filter((item) => item.songmid === 'duplicate').length, 1);
  });
});

test('waiting for sync events releases immediately when aborted', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'shuxia-sync-abort-test-'));
  const database = new SyncDatabase(join(directory, 'sync.sqlite'));
  const user = database.createUser({username: `abort-${Date.now()}`, passwordHash: 'hash'});
  const controller = new AbortController();

  try {
    const startedAt = Date.now();
    const waiting = database.waitForSyncEvents(user.id, 0, 20_000, controller.signal);
    controller.abort();
    const result = await waiting;
    assert.equal(result.events.length, 0);
    assert.ok(Date.now() - startedAt < 1_000);
  } finally {
    database.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('a write from one device wakes another device long poll immediately', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'shuxia-sync-wakeup-test-'));
  const database = new SyncDatabase(join(directory, 'sync.sqlite'));
  const user = database.createUser({username: `wakeup-${Date.now()}`, passwordHash: 'hash'});
  const playlist = database.createPlaylist(user.id, {
    localId: 'system:favorites',
    title: '我的喜欢',
    semanticType: 'favorites',
    songlist: [],
  });
  assert.ok(playlist?.id);
  const cursor = database.getSyncEvents(user.id, 0).revision;

  try {
    const startedAt = Date.now();
    const waiting = database.waitForSyncEvents(user.id, cursor, 5_000);
    setTimeout(() => {
      database.applySongOperation(user.id, {
        operationId: 'phone-favorite-add',
        deviceId: 'android',
        sequence: 1,
        occurredAtMs: Date.now(),
        playlistId: playlist.id,
        action: 'add',
        trackKey: 'wy:realtime',
        song: song('realtime'),
      });
    }, 25);

    const result = await waiting;
    assert.ok(Date.now() - startedAt < 1_000);
    assert.ok(result.nextRevision > cursor);
    assert.equal(result.events.some((event) => event.entityType === 'playlistSongs'), true);
  } finally {
    database.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('a genuinely later add still wins after a remove', () => {
  withDatabase((database, userId, playlistId) => {
    database.applySongOperation(userId, {
      operationId: 'add-1',
      deviceId: 'desktop',
      sequence: 1,
      occurredAtMs: 1_000,
      playlistId,
      action: 'add',
      trackKey: 'wy:2',
      song: song('2'),
    });
    database.applySongOperation(userId, {
      operationId: 'remove-1',
      deviceId: 'phone',
      sequence: 1,
      occurredAtMs: 2_000,
      playlistId,
      action: 'remove',
      trackKey: 'wy:2',
    });
    const laterAdd = database.applySongOperation(userId, {
      operationId: 'add-2',
      deviceId: 'desktop',
      sequence: 2,
      occurredAtMs: 3_000,
      playlistId,
      action: 'add',
      trackKey: 'wy:2',
      song: song('2'),
    });

    assert.equal(laterAdd?.changed, true);
    assert.equal(laterAdd?.stale, false);
    assert.ok(
      database
        .getPlaylistSongs(userId, playlistId)
        ?.songs.some((item) => item.songmid === '2'),
    );
  });
});

test('favorite snapshots and legacy bulk mutations cannot bypass operation history', () => {
  withDatabase((database, userId, playlistId) => {
    database.applySongOperation(userId, {
      operationId: 'remove-seed',
      deviceId: 'phone',
      sequence: 1,
      occurredAtMs: 2_000,
      playlistId,
      action: 'remove',
      trackKey: 'wy:seed',
    });

    database.updatePlaylist(userId, {
      playlistId,
      title: '我的喜欢',
      semanticType: 'favorites',
      songlist: [song('seed'), song('stale')],
    });
    const added = database.addSongs(userId, {playlistId, songlist: [song('legacy')]});
    const removed = database.removeSongs(userId, {playlistId, songmids: ['seed']});

    assert.equal(Boolean(added && 'skipped' in added && added.skipped), true);
    assert.equal(Boolean(removed && 'skipped' in removed && removed.skipped), true);
    assert.equal(database.getPlaylistSongs(userId, playlistId)?.total, 0);
  });
});

test('a stale playlist snapshot cannot resurrect a song after an explicit remove', () => {
  withDatabase((database, userId, playlistId) => {
    database.applySongOperation(userId, {
      operationId: 'snapshot-resurrection-add',
      deviceId: 'phone',
      sequence: 1,
      occurredAtMs: 1_000,
      playlistId,
      action: 'add',
      trackKey: 'wy:resurrection',
      song: song('resurrection'),
    });
    database.applySongOperation(userId, {
      operationId: 'snapshot-resurrection-remove',
      deviceId: 'phone',
      sequence: 2,
      occurredAtMs: 2_000,
      playlistId,
      action: 'remove',
      trackKey: 'wy:resurrection',
    });

    const stale = database.updatePlaylist(userId, {
      playlistId,
      title: '我的喜欢',
      semanticType: 'favorites',
      songlist: [song('resurrection')],
    });

    assert.equal(Boolean(stale), true);
    assert.deepEqual(
      database.getPlaylistSongs(userId, playlistId)?.songs.map((item) => item.songmid),
      ['seed'],
    );
    assert.equal(database.getSyncEvents(userId, 0).events.some((event) =>
      event.entityType === 'playlistSongs' && event.action === 'upsert' &&
      JSON.stringify(event.payload).includes('resurrection')), true);
  });
});

test('order-only snapshots can reorder favorites but cannot change membership', () => {
  withDatabase((database, userId, playlistId) => {
    database.applySongOperation(userId, {
      operationId: 'add-second',
      deviceId: 'desktop',
      sequence: 1,
      occurredAtMs: 2_000,
      playlistId,
      action: 'add',
      trackKey: 'wy:second',
      song: song('second'),
    });
    database.updatePlaylist(userId, {
      playlistId,
      title: '我的喜欢',
      semanticType: 'favorites',
      orderOnly: true,
      songlist: [song('second'), song('seed')],
    });
    assert.deepEqual(
      database.getPlaylistSongs(userId, playlistId)?.songs.map((item) => item.songmid),
      ['second', 'seed'],
    );

    database.updatePlaylist(userId, {
      playlistId,
      title: '我的喜欢',
      semanticType: 'favorites',
      orderOnly: true,
      songlist: [song('seed'), song('new')],
    });
    assert.deepEqual(
      database.getPlaylistSongs(userId, playlistId)?.songs.map((item) => item.songmid),
      ['second', 'seed'],
    );
  });
});


test('plugin operations union music-source scripts by identity and ignore stale later', () => {
  withDatabase((database, userId) => {
    const first = database.putPluginBlob('// @name Demo\n// @author A\nmodule.exports = {name:"Demo"}');
    const second = database.putPluginBlob('// @name Demo\n// @author A\nmodule.exports = {name:"Demo2"}');
    const added = database.applyPluginOperation(userId, {
      operationId: 'plugin-add-1',
      deviceId: 'phone',
      sequence: 1,
      occurredAtMs: 1_000,
      kind: 'music-source',
      action: 'upsert',
      name: 'Demo',
      author: 'A',
      version: '1.0.0',
      enabled: true,
      contentHash: first.contentHash,
    });
    assert.equal(added?.applied, true);
    const stale = database.applyPluginOperation(userId, {
      operationId: 'plugin-add-stale',
      deviceId: 'desktop',
      sequence: 1,
      occurredAtMs: 500,
      kind: 'music-source',
      action: 'upsert',
      name: 'Demo',
      author: 'A',
      version: '0.9.0',
      enabled: false,
      contentHash: second.contentHash,
    });
    assert.equal(stale?.stale, true);
    const items = database.listPlugins(userId);
    assert.equal(items.length, 1);
    assert.equal(items[0].contentHash, first.contentHash);
    assert.equal(items[0].enabled, true);
  });
});

test('capability upsert merges secrets and never stores plaintext in sqlite', () => {
  withDatabase((database, userId) => {
    database.applyPluginOperation(userId, {
      operationId: 'cap-1',
      deviceId: 'desktop',
      sequence: 1,
      occurredAtMs: 1_000,
      kind: 'capability',
      action: 'upsert',
      role: 'feiniu',
      config: {
        host: 'Fn.example.com',
        port: 11443,
        useHttps: true,
        username: 'song',
        password: 'secret-pass',
        accessCode: '1234',
      },
    });
    database.applyPluginOperation(userId, {
      operationId: 'cap-2',
      deviceId: 'phone',
      sequence: 1,
      occurredAtMs: 2_000,
      kind: 'capability',
      action: 'upsert',
      role: 'feiniu',
      config: {
        host: 'fn.example.com',
        port: 11443,
        useHttps: true,
        username: 'song',
        password: '',
        accessCode: '',
      },
    });
    const items = database.listPlugins(userId);
    assert.equal(items.length, 1);
    assert.equal(items[0].identityKey, 'capability:feiniu');
    assert.equal(items[0].config?.password, 'secret-pass');
    assert.equal(items[0].config?.accessCode, '1234');
    const events = database.getSyncEvents(userId, 0).events.filter((event) => event.entityType === 'plugin');
    assert.ok(events.length >= 1);
    const payload = JSON.stringify(events.at(-1)?.payload || {});
    assert.equal(payload.includes('secret-pass'), false);
    assert.equal(payload.includes('1234'), false);
  });
});

test('identical playlist metadata patches do not advance revision or emit events', () => {
  withDatabase((database, userId, playlistId) => {
    const before = database.getCurrentRevision(userId);
    const updated = database.updatePlaylist(userId, {
      playlistId,
      title: '我的喜欢',
      semanticType: 'favorites',
    });

    assert.equal(updated?.revision, before);
    assert.equal(database.getCurrentRevision(userId), before);
    assert.equal(database.getSyncEvents(userId, before).events.length, 0);
  });
});

test('identical plugin upserts do not advance revision or emit events', () => {
  withDatabase((database, userId) => {
    const blob = database.putPluginBlob('// @name Demo\n// @author A\nmodule.exports = {name:"Demo"}');
    const first = database.applyPluginOperation(userId, {
      operationId: 'plugin-first',
      deviceId: 'phone',
      sequence: 1,
      occurredAtMs: 1_000,
      kind: 'music-source',
      action: 'upsert',
      name: 'Demo',
      author: 'A',
      version: '1.0.0',
      enabled: true,
      contentHash: blob.contentHash,
    });
    const revisionAfterFirst = database.getCurrentRevision(userId);
    assert.equal(first?.changed, true);

    const duplicate = database.applyPluginOperation(userId, {
      operationId: 'plugin-duplicate',
      deviceId: 'phone',
      sequence: 2,
      occurredAtMs: 2_000,
      kind: 'music-source',
      action: 'upsert',
      name: 'Demo',
      author: 'A',
      version: '1.0.0',
      enabled: true,
      contentHash: blob.contentHash,
    });

    assert.equal(duplicate?.changed, false);
    assert.equal(database.getCurrentRevision(userId), revisionAfterFirst);
    assert.equal(database.getSyncEvents(userId, revisionAfterFirst).events.length, 0);
  });
});

test('removing one music-source plugin only tombstones its own identityKey, same-hash plugins survive', () => {
  withDatabase((database, userId) => {
    const blob = database.putPluginBlob('// @name Demo\n// @author A\nmodule.exports = {name:"Demo"}');
    database.applyPluginOperation(userId, {
      operationId: 'plugin-copy-a',
      deviceId: 'phone',
      sequence: 1,
      occurredAtMs: 1_000,
      kind: 'music-source',
      action: 'upsert',
      name: 'Demo',
      author: 'A',
      version: '1.0.0',
      enabled: true,
      contentHash: blob.contentHash,
    });
    database.applyPluginOperation(userId, {
      operationId: 'plugin-copy-b',
      deviceId: 'desktop',
      sequence: 1,
      occurredAtMs: 2_000,
      kind: 'music-source',
      action: 'upsert',
      name: 'Demo',
      author: 'B',
      version: '1.0.0',
      enabled: true,
      contentHash: blob.contentHash,
    });

    const items = database.listPlugins(userId);
    // 同 hash ≠ 同插件：两个不同 author 的插件是两个独立 identityKey，都必须保留。
    assert.equal(items.length, 2);

    const copyA = items.find((item) => item.identityKey.endsWith(':a'));
    const removed = database.applyPluginOperation(userId, {
      operationId: 'plugin-remove-a',
      deviceId: 'phone',
      sequence: 2,
      occurredAtMs: 3_000,
      kind: 'music-source',
      action: 'remove',
      identityKey: copyA?.identityKey || items[0].identityKey,
    });

    assert.equal(removed?.changed, true);
    // 删除只作用于被明确 remove 的那一个 identityKey；
    // 共用同一脚本的其他插件必须存活（旧级联行为会整批清空，已修复）。
    const afterRemove = database.listPlugins(userId);
    assert.equal(afterRemove.length, 1);
    assert.notEqual(afterRemove[0].identityKey, copyA?.identityKey);
    assert.equal(database.listPlugins(userId, {includeDeleted: true}).length, 2);
  });
});

test('old plugin upsert cannot resurrect a later delete, but a newer re-add can', () => {
  withDatabase((database, userId) => {
    const blob = database.putPluginBlob('// @name Demo\n// @author A\nmodule.exports = {name:"Demo"}');
    const added = database.applyPluginOperation(userId, {
      operationId: 'plugin-add-before-delete',
      deviceId: 'phone',
      sequence: 1,
      occurredAtMs: 1_000,
      kind: 'music-source',
      action: 'upsert',
      name: 'Demo',
      author: 'A',
      version: '1.0.0',
      enabled: true,
      contentHash: blob.contentHash,
    });
    assert.equal(added?.changed, true);
    const identityKey = database.listPlugins(userId)[0]?.identityKey || '';
    assert.notEqual(identityKey, '');

    database.applyPluginOperation(userId, {
      operationId: 'plugin-delete-after-add',
      deviceId: 'phone',
      sequence: 2,
      occurredAtMs: 3_000,
      kind: 'music-source',
      action: 'remove',
      identityKey,
    });
    assert.equal(database.listPlugins(userId).length, 0);

    const staleReAdd = database.applyPluginOperation(userId, {
      operationId: 'plugin-old-re-add',
      deviceId: 'desktop',
      sequence: 1,
      occurredAtMs: 2_000,
      kind: 'music-source',
      action: 'upsert',
      name: 'Demo',
      author: 'A',
      version: '1.0.0',
      enabled: true,
      contentHash: blob.contentHash,
    });
    assert.equal(staleReAdd?.stale, true);
    assert.equal(database.listPlugins(userId).length, 0);

    const newerReAdd = database.applyPluginOperation(userId, {
      operationId: 'plugin-new-re-add',
      deviceId: 'desktop',
      sequence: 2,
      occurredAtMs: 4_000,
      kind: 'music-source',
      action: 'upsert',
      name: 'Demo',
      author: 'A',
      version: '1.0.0',
      enabled: true,
      contentHash: blob.contentHash,
    });
    assert.equal(newerReAdd?.stale, false);
    assert.equal(database.listPlugins(userId).length, 1);
  });
});

test('sync pages expose the applied cursor without skipping future revisions', () => {
  withDatabase((database, userId, playlistId) => {
    database.addSongs(userId, {playlistId, songlist: [song('page-1')]});
    database.addSongs(userId, {playlistId, songlist: [song('page-2')]});
    const first = database.getSyncEvents(userId, 0);
    assert.ok(first.events.length > 0);
    assert.equal(first.nextRevision, first.events.at(-1)?.revision);
    assert.equal(first.hasMore, false);
    const next = database.getSyncEvents(userId, first.nextRevision);
    assert.equal(next.events.length, 0);
    assert.equal(next.nextRevision, next.revision);
    assert.equal(next.hasMore, false);
  });
});

test('oversized event pages request a full refresh instead of truncating data', () => {
  withDatabase((database, userId, playlistId) => {
    const regular = database.createPlaylist(userId, {localId: 'large-playlist', title: 'Large playlist', songlist: []});
    assert.ok(regular?.id);
    const cursor = database.getCurrentRevision(userId);
    database.addSongs(userId, {
      playlistId: regular.id,
      songlist: Array.from({length: 12_000}, (_, index) => ({
        ...song('large-' + index),
        title: 'large song ' + index + ' ' + 'x'.repeat(700),
      })),
    });

    const page = database.getSyncEvents(userId, cursor);
    assert.equal(page.requiresRefresh, true);
    assert.equal(page.events.length, 1);
    const event = page.events[0] as {payload?: {requiresRefresh?: boolean; playlistId?: string}};
    assert.equal(event.payload?.requiresRefresh, true);
    assert.equal(event.payload?.playlistId, regular.id);
  });
});

test('device revision updates return an HTTP-safe result and clamp progress', () => {
  withDatabase((database, userId) => {
    database.registerDevice(userId, 'android-test', 'Android test', 'android');
    const currentRevision = database.getCurrentRevision(userId);
    const result = database.updateDeviceSyncRevision(userId, 'android-test', currentRevision + 10_000);
    assert.deepEqual(result, {success: true, deviceId: 'android-test', revision: currentRevision});
    assert.equal(database.listDevices(userId).items[0]?.lastSyncedRevision, currentRevision);
  });
});

test('reorder operations reject partial or duplicated orders', () => {
  withDatabase((database, userId, playlistId) => {
    const second = database.createPlaylist(userId, {localId: 'second', title: '第二个', songlist: []});
    assert.ok(second?.id);
    assert.throws(() => database.reorderPlaylists(userId, [playlistId]), /必须包含全部且不重复/);
    assert.throws(() => database.reorderPlaylists(userId, [playlistId, playlistId]), /必须包含全部且不重复/);
    const reordered = database.reorderPlaylists(userId, [second!.id, playlistId]);
    assert.deepEqual(reordered.orderedIds, [second!.id, playlistId]);
    assert.deepEqual(database.listPlaylists(userId).map((item) => item.id), [second!.id, playlistId]);
  });
});

test('reorder operations reject stale base revisions without changing data', () => {
  withDatabase((database, userId, playlistId) => {
    const second = database.createPlaylist(userId, {localId: 'revision-second', title: '第二个', songlist: []});
    assert.ok(second?.id);
    const currentRevision = database.getCurrentRevision(userId);
    database.reorderPlaylists(userId, [playlistId, second!.id], currentRevision);
    const revisionAfterFirstOrder = database.getCurrentRevision(userId);
    assert.throws(
      () => database.reorderPlaylists(userId, [second!.id, playlistId], currentRevision),
      (error: any) => error?.statusCode === 409 && error?.conflict?.type === 'stale-base-revision',
    );
    assert.equal(database.getCurrentRevision(userId), revisionAfterFirstOrder);
    assert.deepEqual(database.listPlaylists(userId).map((item) => item.id), [playlistId, second!.id]);
  });
});

test('playlist snapshot rejects stale base revisions without changing song order', () => {
  withDatabase((database, userId, playlistId) => {
    database.applySongOperation(userId, {
      operationId: 'snapshot-add-second',
      deviceId: 'desktop',
      sequence: 1,
      occurredAtMs: 2_000,
      playlistId,
      action: 'add',
      trackKey: 'wy:second',
      song: song('second'),
    });
    const baseRevision = database.getCurrentRevision(userId);
    database.updatePlaylist(userId, {playlistId, title: '推进版本'});
    const revisionAfterConcurrentWrite = database.getCurrentRevision(userId);

    assert.throws(
      () => database.updatePlaylist(userId, {
        playlistId,
        semanticType: 'favorites',
        orderOnly: true,
        baseRevision,
        songlist: [song('second'), song('seed')],
      }),
      (error: any) => error?.statusCode === 409 && error?.conflict?.type === 'stale-base-revision',
    );
    assert.equal(database.getCurrentRevision(userId), revisionAfterConcurrentWrite);
    assert.deepEqual(
      database.getPlaylistSongs(userId, playlistId)?.songs.map((item) => item.songmid),
      ['second', 'seed'],
    );
  });
});

test('podcast reorder persists position and keeps pinned ordering', () => {
  withDatabase((database, userId) => {
    database.upsertFavorite(userId, {
      entityType: 'podcast', entityId: 'wy:podcast-a', source: 'wy', title: 'A',
      position: 0, pinned: false, metadata: {radioId: 'podcast-a', pinned: false},
    });
    database.upsertFavorite(userId, {
      entityType: 'podcast', entityId: 'wy:podcast-b', source: 'wy', title: 'B',
      position: 1, pinned: true, metadata: {radioId: 'podcast-b', pinned: true},
    });
    const cursor = database.getCurrentRevision(userId);
    const result = database.reorderFavorites(userId, 'podcast', ['wy:podcast-a', 'wy:podcast-b']);
    assert.deepEqual(result.orderedIds, ['wy:podcast-a', 'wy:podcast-b']);
    assert.deepEqual(database.listFavorites(userId, 'podcast').map((item) => item.entityId), ['wy:podcast-b', 'wy:podcast-a']);
    const event = database.getSyncEvents(userId, cursor).events.at(-1);
    assert.equal(event?.action, 'reorder');
    const payload = event?.payload as {entityType?: string; orderedIds?: string[]};
    assert.equal(payload?.entityType, 'podcast');
    assert.deepEqual(payload?.orderedIds, ['wy:podcast-a', 'wy:podcast-b']);
  });
});

test('favorite operation ids make retries idempotent', () => {
  withDatabase((database, userId) => {
    const first = database.upsertFavorite(userId, {
      operationId: 'podcast-upsert-1',
      entityType: 'podcast',
      entityId: 'wy:podcast-idempotent',
      source: 'wy',
      title: 'Idempotent podcast',
    });
    const revisionAfterFirst = database.getCurrentRevision(userId);
    const repeated = database.upsertFavorite(userId, {
      operationId: 'podcast-upsert-1',
      entityType: 'podcast',
      entityId: 'wy:podcast-idempotent',
      source: 'wy',
      title: 'Changed title must not replay',
    });

    assert.equal(repeated?.id, first?.id);
    assert.equal(repeated?.entityId, first?.entityId);
    assert.equal(repeated?.revision, first?.revision);
    assert.equal(repeated?.title, first?.title);
    assert.equal(database.getCurrentRevision(userId), revisionAfterFirst);
    assert.equal(database.getSyncEvents(userId, 0).events.filter((event) => event.entityType === 'favorite').length, 1);

    const deleted = database.deleteFavorite(userId, {
      operationId: 'podcast-delete-1',
      entityType: 'podcast',
      entityId: 'wy:podcast-idempotent',
    });
    const revisionAfterDelete = database.getCurrentRevision(userId);
    const repeatedDelete = database.deleteFavorite(userId, {
      operationId: 'podcast-delete-1',
      entityType: 'podcast',
      entityId: 'wy:podcast-idempotent',
    });

    const repeatedDeleteRecord = repeatedDelete as {id?: string; entityId?: string; revision?: number};
    const deletedRecord = deleted as {id?: string; entityId?: string; revision?: number};
    assert.equal(repeatedDeleteRecord.id, deletedRecord.id);
    assert.equal(repeatedDeleteRecord.entityId, deletedRecord.entityId);
    assert.equal(repeatedDeleteRecord.revision, deletedRecord.revision);
    assert.equal(database.getCurrentRevision(userId), revisionAfterDelete);
    assert.equal(database.getSyncEvents(userId, 0).events.filter((event) => event.entityType === 'favorite').length, 2);
  });

  test('unfavorite playlist also deletes the cloud songlist', () => {
    withDatabase((database, userId) => {
      const created = database.createPlaylist(userId, {
        localId: 'local-playlist-delete',
        title: '要取消的歌单',
        songlist: [song('keep')],
      });
      const playlistId = String(created?.id || '');
      assert.ok(playlistId);
      database.upsertFavorite(userId, {
        entityType: 'playlist',
        playlistId,
        title: '要取消的歌单',
      });

      database.deleteFavorite(userId, {entityType: 'playlist', playlistId});

      assert.equal(database.listPlaylists(userId).some((playlist) => playlist.id === playlistId), false);
      assert.equal(database.listFavorites(userId, 'playlist').some((item) => item.playlistId === playlistId), false);
      assert.equal(database.getPlaylistSongs(userId, playlistId), null);
      const events = database.getSyncEvents(userId, 0).events;
      assert.equal(events.some((event) => event.entityType === 'playlist' && event.action === 'delete' && event.entityId === playlistId), true);
    });
  });

  test('unfavorite does not delete 我的喜欢', () => {
    withDatabase((database, userId, favoritesId) => {
      database.upsertFavorite(userId, {
        entityType: 'playlist',
        playlistId: favoritesId,
        title: '我的喜欢',
      });

      database.deleteFavorite(userId, {entityType: 'playlist', playlistId: favoritesId});

      assert.equal(database.listPlaylists(userId).some((playlist) => playlist.id === favoritesId), true);
      assert.equal(database.getPlaylistSongs(userId, favoritesId)?.songs.length, 1);
    });
  });
});
