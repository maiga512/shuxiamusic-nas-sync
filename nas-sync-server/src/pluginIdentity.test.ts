import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalizeCapabilityConfig,
  capabilityIdentityKey,
  mergeCapabilityConfig,
  musicSourceIdentityKey,
} from './pluginIdentity.ts';

test('music-source identity is stable across spacing and case', () => {
  assert.equal(
    musicSourceIdentityKey('  Demo Plugin ', 'Ceru Music'),
    musicSourceIdentityKey('demo plugin', 'ceru music'),
  );
  assert.equal(musicSourceIdentityKey('Demo', ''), 'music-source:demo:_');
});

test('capability identity maps roles to a single binding', () => {
  assert.equal(capabilityIdentityKey('FeiNiu'), 'capability:feiniu');
  assert.equal(capabilityIdentityKey('nas-sync'), 'capability:nas-sync');
});

test('feiniu config keeps secrets when the next payload leaves them blank', () => {
  const merged = mergeCapabilityConfig(
    'feiniu',
    {
      host: 'Fn.example.com:11443',
      useHttps: true,
      username: 'song',
      password: 'secret-pass',
      accessCode: '1234',
    },
    {
      host: 'fn.example.com',
      port: 11443,
      useHttps: true,
      username: 'song',
      password: '',
      accessCode: '',
    },
  );
  assert.equal(merged.host, 'fn.example.com');
  assert.equal(merged.port, 11443);
  assert.equal(merged.password, 'secret-pass');
  assert.equal(merged.accessCode, '1234');
});

test('nas-sync capability never canonicalizes tokens or sync mode', () => {
  const config = canonicalizeCapabilityConfig('nas-sync', {
    host: 'https://lyserver.11111888.xyz:11443',
    useHttps: true,
    pairCode: '_ABC',
    accessToken: 'should-not-sync',
    syncMode: 'auto',
  });
  assert.equal(config.host, 'lyserver.11111888.xyz');
  assert.equal(config.port, 11443);
  assert.equal(config.useHttps, true);
  assert.equal(config.pairCode, '_ABC');
  assert.equal('accessToken' in config, false);
  assert.equal('syncMode' in config, false);
});
