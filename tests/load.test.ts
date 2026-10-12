import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

test('real Pi resource loader discovers package without user credentials or model calls', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-msg-load-'));
  const extensionPath = process.env.PI_MSG_TEST_EXTENSION ?? resolve('extensions/index.ts');
  try {
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [extensionPath],
      noSkills: true, noPromptTemplates: true, noThemes: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions.find(e => e.resolvedPath === extensionPath);
    assert.ok(extension, 'real file-based extension loaded');
    assert.deepEqual([...extension.tools.keys()].sort(), ['msg_delivery', 'msg_inbox', 'msg_read', 'msg_send']);
    assert.ok(extension.commands.has('msg'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
