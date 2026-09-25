import assert from 'node:assert/strict';
import test from 'node:test';

import {isStaleFavoriteWrite} from './favoriteLww.ts';

const podcastFavoriteKey = (source: string | undefined, radioId: string) => `${source || 'wy'}:${radioId}`;

const normalizePodcastFavorite = (payload: any) => {
  const metadata = payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  const entityId = String(payload?.entityId || '').trim();
  const radioIdRaw = String(payload?.radioId || metadata.radioId || entityId).trim();
  const radioId = radioIdRaw.includes(':') ? radioIdRaw.slice(radioIdRaw.indexOf(':') + 1) : radioIdRaw;
  const title = String(payload?.title || payload?.name || metadata.title || '').trim() || radioId;
  if (!radioId) return null;
  return {
    id: String(payload?.id || podcastFavoriteKey(payload?.source, radioId)),
    radioId,
    source: payload?.source,
    title,
  };
};

const applySyncEvent = (
  current: Array<{ radioId: string; title: string }>,
  payload: unknown,
  deleted = false,
) => {
  const favorite = normalizePodcastFavorite(payload);
  if (!favorite) return current;
  const next = current.filter((item) => item.radioId !== favorite.radioId);
  return deleted ? next : [...next, favorite];
};

test('podcast favorite without title still upserts and deletes by radioId', () => {
  const created = normalizePodcastFavorite({
    entityType: 'podcast',
    entityId: 'wy:12345',
    metadata: { radioId: '12345' },
  });
  assert.ok(created);
  assert.equal(created.radioId, '12345');
  assert.equal(created.title, '12345');

  const listed = applySyncEvent([], created, false);
  assert.equal(listed.length, 1);

  const deleted = applySyncEvent(listed, { entityId: 'wy:12345' }, true);
  assert.equal(deleted.length, 0);
});

test('later podcast unfavorite is not overwritten by an older favorite', () => {
  assert.equal(isStaleFavoriteWrite(2_000, 1_000, true, false), true);
  assert.equal(isStaleFavoriteWrite(1_000, 2_000, false, true), false);
  assert.equal(isStaleFavoriteWrite(1_000, 1_000, true, false), true);
});
