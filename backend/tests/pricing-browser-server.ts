import { createPricingFixture } from './pricing-fixture.js';

const fixture = await createPricingFixture(5189);
console.log(`Pricing test fixture listening at ${fixture.url}`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await fixture.close();
  process.exit(0);
}
fixture.app.post('/__test/shutdown', (_req, res) => {
  fixture.disposeData();
  res.json({ ok: true });
  setTimeout(stop, 50);
});
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
