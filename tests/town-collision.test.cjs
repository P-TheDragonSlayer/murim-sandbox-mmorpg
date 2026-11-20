const test = require('node:test');
const assert = require('node:assert/strict');
const { SPAWNS, isWalkable, canTraverse, nearestWalkable } = require('../shared/town-collision.cjs');
test('spawn locations are walkable while buildings and out-of-map points are blocked', () => {
  for (const p of SPAWNS) assert.equal(isWalkable(p.x, p.y), true);
  assert.equal(isWalkable(350, 200), false);
  assert.equal(isWalkable(-1, 500), false);
  assert.equal(isWalkable(350, 601), false);
});
test('movement must stay on the plaza for the whole path', () => {
  assert.equal(canTraverse(350, 500, 374, 500), true);
  assert.equal(canTraverse(350, 380, 350, 356), false);
  // Both endpoints are walkable, but the diagonal passes outside the plaza.
  assert.equal(isWalkable(40,480), true);
  assert.equal(isWalkable(1320,200), true);
  assert.equal(canTraverse(40,480,1320,200), false);
});

test('lantern base is blocked and legacy positions relocate to nearby walkable ground', () => {
  assert.equal(isWalkable(976,552), true);
  assert.equal(isWalkable(1000,552), false);
  assert.equal(canTraverse(976,552,1000,552), false);
  const moved = nearestWalkable(1000,552);
  assert.equal(isWalkable(moved.x,moved.y), true);
  assert.ok(Math.hypot(moved.x-1000,moved.y-552)<100);
});
