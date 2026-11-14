/**
 * Tests for GET /health endpoint
 */

const request = require('supertest');
const { app } = require('../../src/cpp_test_service');

describe('GET /health', () => {
  test('returns 200 status code', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  test('returns status "healthy"', async () => {
    const res = await request(app).get('/health');
    expect(res.body.status).toBe('healthy');
  });

  test('returns correct service name', async () => {
    const res = await request(app).get('/health');
    expect(res.body.service).toBe('cpp-test-executor');
  });

  test('returns version string', async () => {
    const res = await request(app).get('/health');
    expect(res.body.version).toBe('1.0.0');
  });

  test('returns a valid ISO timestamp', async () => {
    const res = await request(app).get('/health');
    expect(res.body.timestamp).toBeDefined();
    const parsed = new Date(res.body.timestamp);
    expect(parsed.toISOString()).toBe(res.body.timestamp);
  });

  test('returns port field', async () => {
    const res = await request(app).get('/health');
    // PORT comes from env or defaults to 8094
    expect(res.body.port).toBeDefined();
  });

  test('has all expected fields', async () => {
    const res = await request(app).get('/health');
    expect(res.body).toEqual(
      expect.objectContaining({
        status: 'healthy',
        service: 'cpp-test-executor',
        version: '1.0.0',
      })
    );
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('port');
  });
});
