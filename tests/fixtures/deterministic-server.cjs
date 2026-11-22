'use strict';
// Loaded only by the isolated integration-test child process. Production always
// uses node:crypto's unmodified randomInt; deterministic rolls keep tests stable.
const crypto = require('node:crypto');
crypto.randomInt = function(min, max) {
  if (max === undefined) return min - 1;
  return max - 1;
};
if (process.env.MURIM_TEST_SHORT_TURNS === '1') {
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms === 30000 ? 700 : ms, ...args);
}
