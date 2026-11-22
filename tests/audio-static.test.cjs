'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

test('background audio supports complete and ranged mobile requests', { timeout: 15000 }, async () => {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'murim-audio-test-'));
  const server = spawn(process.execPath, [path.join(__dirname, '../server/index.cjs')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', MURIM_DATA_PATH: path.join(temporary, 'state.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  try {
    for (let i = 0; i < 200 && !output.includes('Murim prototype') && server.exitCode === null; i++) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.match(output, /Murim prototype/);
    const file = fs.readFileSync(path.join(__dirname, '../public/audio/background-ditto.mp3'));
    const url = `http://127.0.0.1:${port}/public/audio/background-ditto.mp3`;
    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.match(full.headers.get('content-type'), /^audio\/mpeg/);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), file);
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), file.length);
    const partial = await fetch(url, { headers: { range: 'bytes=0-31' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), `bytes 0-31/${file.length}`);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), file.subarray(0, 32));
    const suffix = await fetch(url, { headers: { range: 'bytes=-10' } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), file.subarray(-10));
    const invalid = await fetch(url, { headers: { range: `bytes=${file.length}-` } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get('content-range'), `bytes */${file.length}`);
  } finally {
    if (server.exitCode === null) {
      const closed = new Promise(resolve => server.once('exit', resolve));
      server.kill();
      await closed;
    }
    if (path.dirname(temporary) === os.tmpdir() && path.basename(temporary).startsWith('murim-audio-test-')) {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
});
