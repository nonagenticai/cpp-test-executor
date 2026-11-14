/**
 * Tests for POST /validate endpoint
 */

const os = require('os');
const path = require('path');
const fsReal = require('fs').promises;
const { EventEmitter } = require('events');
const { Readable } = require('stream');

// Set TEST_WORKSPACE to a writable temp directory BEFORE loading the service
const testWorkspace = path.join(os.tmpdir(), `cpptest-validate-${process.pid}`);
process.env.TEST_WORKSPACE = testWorkspace;

// Mock child_process.spawn — jest hoists this above all requires
jest.mock('child_process', () => {
  const original = jest.requireActual('child_process');
  return {
    ...original,
    spawn: jest.fn(),
  };
});

const childProcess = require('child_process');
const request = require('supertest');
const { app } = require('../../src/cpp_test_service');

function createMockChild(stdoutData, stderrData, exitCode) {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = new Readable({ read() {} });
  child.kill = jest.fn();

  process.nextTick(() => {
    if (stdoutData) child.stdout.push(stdoutData);
    child.stdout.push(null);
    if (stderrData) child.stderr.push(stderrData);
    child.stderr.push(null);
    // Defer close so stream 'data' events can propagate first
    setTimeout(() => child.emit('close', exitCode), 10);
  });

  return child;
}

beforeAll(async () => {
  await fsReal.mkdir(testWorkspace, { recursive: true });
});

afterAll(async () => {
  try {
    await fsReal.rm(testWorkspace, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('POST /validate', () => {
  beforeEach(() => {
    childProcess.spawn.mockReset();
  });

  test('returns 400 when no code provided', async () => {
    const res = await request(app)
      .post('/validate')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('No code provided');
  });

  test('returns 400 when code is empty string', async () => {
    const res = await request(app)
      .post('/validate')
      .send({ code: '' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('returns syntaxValid:true for code that compiles successfully', async () => {
    let callCount = 0;
    childProcess.spawn.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // g++ syntax check — success
        return createMockChild('', '', 0);
      }
      // cppcheck — success
      return createMockChild('cppcheck output', '', 0);
    });

    const res = await request(app)
      .post('/validate')
      .send({ code: '#include <iostream>\nint main() { return 0; }' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.syntaxValid).toBe(true);
    expect(res.body).toHaveProperty('compilerOutput');
    expect(res.body).toHaveProperty('staticAnalysis');
    expect(res.body.staticAnalysis).toHaveProperty('output');
  });

  test('returns syntaxValid:false for code with syntax errors', async () => {
    let callCount = 0;
    childProcess.spawn.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // g++ fails
        return createMockChild('', 'error: expected ; at end', 1);
      }
      return createMockChild('', '', 0);
    });

    const res = await request(app)
      .post('/validate')
      .send({ code: 'int main() { return }' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.syntaxValid).toBe(false);
    expect(res.body.compilerOutput).toContain('expected');
  });

  test('includes static analysis output and warnings', async () => {
    let callCount = 0;
    childProcess.spawn.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return createMockChild('', '', 0);
      }
      return createMockChild('<?xml analysis>', 'warning: unused variable', 0);
    });

    const res = await request(app)
      .post('/validate')
      .send({ code: 'int main() { int x; return 0; }' });

    expect(res.status).toBe(200);
    expect(res.body.staticAnalysis.output).toContain('<?xml analysis>');
    expect(res.body.staticAnalysis.warnings).toContain('unused variable');
  });

  test('cleans up temp directory after validation', async () => {
    childProcess.spawn.mockImplementation(() => createMockChild('', '', 0));

    const res = await request(app)
      .post('/validate')
      .send({ code: 'int main() {}' });

    expect(res.status).toBe(200);
    // The validation subdirectory should have been cleaned up
    const validationDir = path.join(testWorkspace, 'validation');
    let entries = [];
    try {
      entries = await fsReal.readdir(validationDir);
    } catch {
      // dir doesn't exist means it was cleaned
    }
    expect(entries.length).toBe(0);
  });

  test('returns 500 when an unexpected error occurs', async () => {
    // Force spawn to emit an error event, causing executeCommand to reject
    childProcess.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stdout = new Readable({ read() {} });
      child.stderr = new Readable({ read() {} });
      child.stdin = new Readable({ read() {} });
      child.kill = jest.fn();
      process.nextTick(() => {
        child.emit('error', new Error('spawn g++ ENOENT'));
      });
      return child;
    });

    const res = await request(app)
      .post('/validate')
      .send({ code: 'int main() {}' });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toContain('ENOENT');
  });

  test('compiler output prefers stderr over stdout', async () => {
    let callCount = 0;
    childProcess.spawn.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // g++ outputs warnings to stderr
        return createMockChild('', 'warning: implicit conversion', 0);
      }
      return createMockChild('', '', 0);
    });

    const res = await request(app)
      .post('/validate')
      .send({ code: 'int main() { float x = 1.5; int y = x; return y; }' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // compilerOutput = compileResult.stderr || compileResult.stdout
    expect(res.body.compilerOutput).toContain('warning: implicit conversion');
  });
});
