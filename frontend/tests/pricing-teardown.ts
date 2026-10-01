export default async function teardown() {
  const response = await fetch('http://127.0.0.1:5189/__test/shutdown', { method: 'POST' });
  if (!response.ok) throw new Error('Pricing fixture cleanup failed.');
}
