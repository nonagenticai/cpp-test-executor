/**
 * Tests for POST /execute endpoint
 */

const os = require('os');
const pathMod = require('path');
const fsReal = require('fs').promises;
const { EventEmitter } = require('events');
const { Readable } = require('stream');

// Set TEST_WORKSPACE to a writable temp directory BEFORE loading the service
const testWorkspace = pathMod.join(os.tmpdir(), `cpptest-execute-${process.pid}`);
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

describe('POST /execute', () => {
  beforeEach(() => {
    childProcess.spawn.mockReset();
  });

  test('returns executionId and expected structure with cmake build', async () => {
    childProcess.spawn.mockImplementation(() => createMockChild('ok', '', 0));

    const res = await request(app)
      .post('/execute')
      .send({
        code: 'int main() { return 0; }',
        testCode: 'TEST(X, Y) {}',
        buildSystem: 'cmake',
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('executionId');
    expect(res.body.executionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(res.body.buildSystem).toBe('cmake');
    expect(res.body).toHaveProperty('steps');
    expect(res.body).toHaveProperty('duration');
    expect(typeof res.body.duration).toBe('number');
    expect(res.body.success).toBe(true);
  });

  test('runs configure + build + test with testCode', async () => {
    childProcess.spawn.mockImplementation(() => createMockChild('ok', '', 0));

    const res = await request(app)
      .post('/execute')
      .send({
        code: 'int add(int a, int b) { return a+b; }',
        testCode: 'TEST(Add, Basic) { EXPECT_EQ(3, add(1,2)); }',
        framework: 'gtest',
        buildSystem: 'cmake',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const stepNames = res.body.steps.map((s) => s.name);
    expect(stepNames).toEqual(['configure', 'build', 'test']);

    for (const step of res.body.steps) {
      expect(step.success).toBe(true);
      expect(step).toHaveProperty('output');
      expect(step).toHaveProperty('errors');
      expect(step).toHaveProperty('duration');
    }
  });

  test('stops on configure failure', async () => {
    childProcess.spawn.mockImplementation(() =>
      createMockChild('', 'cmake error: no compiler', 1)
    );

    const res = await request(app)
      .post('/execute')
      .send({ code: 'int main() {}', buildSystem: 'cmake' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.steps.length).toBe(1);
    expect(res.body.steps[0].name).toBe('configure');
    expect(res.body.steps[0].success).toBe(false);
    expect(res.body.steps[0].errors).toContain('cmake error');
  });

  test('stops on build failure after successful configure', async () => {
    let callCount = 0;
    childProcess.spawn.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return createMockChild('configured', '', 0);
      return createMockChild('', 'error: undefined reference', 1);
    });

    const res = await request(app)
      .post('/execute')
      .send({ code: 'int main() { foo(); }', buildSystem: 'cmake' });

    expect(res.body.success).toBe(false);
    expect(res.body.steps.length).toBe(2);
    expect(res.body.steps[0].name).toBe('configure');
    expect(res.body.steps[0].success).toBe(true);
    expect(res.body.steps[1].name).toBe('build');
    expect(res.body.steps[1].success).toBe(false);
  });

  test('reports test failure', async () => {
    let callCount = 0;
    childProcess.spawn.mockImplementation(() => {
      callCount++;
      if (callCount <= 2) return createMockChild('ok', '', 0);
      return createMockChild('1 test FAILED', 'test_runner exited with 1', 1);
    });

    const res = await request(app)
      .post('/execute')
      .send({
        code: 'int add(int a, int b) { return a; }',
        testCode: 'TEST(Add, Wrong) { EXPECT_EQ(add(1,2), 3); }',
        buildSystem: 'cmake',
      });

    expect(res.body.success).toBe(false);
    expect(res.body.steps[2].name).toBe('test');
    expect(res.body.steps[2].success).toBe(false);
    expect(res.body.steps[2].output).toContain('FAILED');
  });

  test('skips configure step for make build system', async () => {
    childProcess.spawn.mockImplementation(() => createMockChild('ok', '', 0));

    const res = await request(app)
      .post('/execute')
      .send({ code: 'int main() { return 0; }', testCode: 'TEST(X, Y) {}', buildSystem: 'make' });

    const stepNames = res.body.steps.map((s) => s.name);
    expect(stepNames).not.toContain('configure');
    expect(stepNames).toContain('build');
    expect(res.body.success).toBe(true);
  });

  test('generates coverage when enableCoverage is true', async () => {
    let callCount = 0;
    childProcess.spawn.mockImplementation(() => {
      callCount++;
      // configure=1, build=2, test=3, coverage=4
      if (callCount === 4) {
        return createMockChild('Lines: 85.2%', '', 0);
      }
      return createMockChild('ok', '', 0);
    });

    const res = await request(app)
      .post('/execute')
      .send({
        code: 'int main() {}',
        testCode: 'TEST(X, Y) {}',
        enableCoverage: true,
        buildSystem: 'cmake',
      });

    expect(res.body.success).toBe(true);
    expect(res.body.coverage).not.toBeNull();
    expect(res.body.coverage.success).toBe(true);
    expect(res.body.coverage.output).toContain('Lines: 85.2%');
    expect(res.body.coverage.reportPath).toContain('coverage-report');
  });

  test('coverage is null when not enabled', async () => {
    childProcess.spawn.mockImplementation(() => createMockChild('ok', '', 0));
    const res = await request(app)
      .post('/execute')
      .send({ code: 'int main() {}', buildSystem: 'cmake' });
    expect(res.body.coverage).toBeNull();
  });

  test('coverage is null when tests fail even if enabled', async () => {
    let callCount = 0;
    childProcess.spawn.mockImplementation(() => {
      callCount++;
      if (callCount === 3) return createMockChild('FAIL', '', 1);
      return createMockChild('ok', '', 0);
    });

    const res = await request(app)
      .post('/execute')
      .send({
        code: 'int main() {}',
        testCode: 'TEST(X, Y) { FAIL(); }',
        enableCoverage: true,
        buildSystem: 'cmake',
      });

    expect(res.body.success).toBe(false);
    expect(res.body.coverage).toBeNull();
  });

  test('runs static analysis when enableStaticAnalysis is true', async () => {
    let callCount = 0;
    childProcess.spawn.mockImplementation(() => {
      callCount++;
      // No testCode: configure=1, build=2, SA=3
      if (callCount === 3) {
        return createMockChild('<cppcheck>clean</cppcheck>', 'style warning', 0);
      }
      return createMockChild('ok', '', 0);
    });

    const res = await request(app)
      .post('/execute')
      .send({
        code: 'int main() { return 0; }',
        enableStaticAnalysis: true,
        buildSystem: 'cmake',
      });

    expect(res.body.staticAnalysis).not.toBeNull();
    expect(res.body.staticAnalysis.success).toBe(true);
    expect(res.body.staticAnalysis.output).toContain('cppcheck');
    expect(res.body.staticAnalysis.warnings).toContain('style warning');
  });

  test('static analysis runs even when tests fail', async () => {
    let callCount = 0;
    childProcess.spawn.mockImplementation(() => {
      callCount++;
      // configure=1, build=2, test=3 (fail), SA=4
      if (callCount === 3) return createMockChild('FAIL', '', 1);
      if (callCount === 4) return createMockChild('analysis done', '', 0);
      return createMockChild('ok', '', 0);
    });

    const res = await request(app)
      .post('/execute')
      .send({
        code: 'int main() {}',
        testCode: 'TEST(X, Y) { FAIL(); }',
        enableStaticAnalysis: true,
        buildSystem: 'cmake',
      });

    // SA runs regardless of test success
    expect(res.body.staticAnalysis).not.toBeNull();
    expect(res.body.staticAnalysis.success).toBe(true);
  });

  test('static analysis is null when not enabled', async () => {
    childProcess.spawn.mockImplementation(() => createMockChild('ok', '', 0));
    const res = await request(app)
      .post('/execute')
      .send({ code: 'int main() {}', buildSystem: 'cmake' });
    expect(res.body.staticAnalysis).toBeNull();
  });

  test('runs valgrind memory check when enabled and tests pass', async () => {
    let callCount = 0;
    childProcess.spawn.mockImplementation(() => {
      callCount++;
      // configure=1, build=2, test=3, valgrind=4
      if (callCount === 4) {
        return createMockChild(
          'All heap blocks were freed',
          'definitely lost: 0 bytes',
          0
        );
      }
      return createMockChild('ok', '', 0);
    });

    const res = await request(app)
      .post('/execute')
      .send({
        code: 'int main() {}',
        testCode: 'TEST(X, Y) {}',
        enableMemoryCheck: true,
        buildSystem: 'cmake',
      });

    expect(res.body.memoryCheck).not.toBeNull();
    expect(res.body.memoryCheck.success).toBe(true);
    expect(res.body.memoryCheck.output).toContain('heap blocks were freed');
    expect(res.body.memoryCheck.errors).toContain('definitely lost: 0');
    expect(res.body.memoryCheck.xmlReport).toContain('memcheck.xml');
  });

  test('memory check is null when tests fail', async () => {
    let callCount = 0;
    childProcess.spawn.mockImplementation(() => {
      callCount++;
      if (callCount === 3) return createMockChild('FAIL', '', 1);
      return createMockChild('ok', '', 0);
    });

    const res = await request(app)
      .post('/execute')
      .send({
        code: 'int main() {}',
        testCode: 'TEST(X, Y) { FAIL(); }',
        enableMemoryCheck: true,
        buildSystem: 'cmake',
      });

    expect(res.body.success).toBe(false);
    expect(res.body.memoryCheck).toBeNull();
  });

  test('returns all analysis fields together', async () => {
    childProcess.spawn.mockImplementation(() => createMockChild('ok', '', 0));

    const res = await request(app)
      .post('/execute')
      .send({
        code: 'int main() {}',
        testCode: 'TEST(X, Y) {}',
        enableCoverage: true,
        enableStaticAnalysis: true,
        enableMemoryCheck: true,
        buildSystem: 'cmake',
      });

    expect(res.body.success).toBe(true);
    expect(res.body.coverage).not.toBeNull();
    expect(res.body.staticAnalysis).not.toBeNull();
    expect(res.body.memoryCheck).not.toBeNull();
  });

  test('uses default parameter values', async () => {
    childProcess.spawn.mockImplementation(() => createMockChild('ok', '', 0));

    const res = await request(app)
      .post('/execute')
      .send({ code: 'int main() { return 0; }' });

    expect(res.body.testType).toBe('unit');
    expect(res.body.framework).toBe('gtest');
    expect(res.body.buildSystem).toBe('cmake');
  });

  test('handles empty code', async () => {
    childProcess.spawn.mockImplementation(() => createMockChild('ok', '', 0));

    const res = await request(app)
      .post('/execute')
      .send({ code: '', buildSystem: 'cmake' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('executionId');
  });

  test('code that builds but has no tests is NOT a pass', async () => {
    // Build succeeds (configure=1, build=2) but no test_code is supplied.
    // The old behavior auto-passed (results.success = true); now it must fail.
    childProcess.spawn.mockImplementation(() => createMockChild('ok', '', 0));

    const res = await request(app)
      .post('/execute')
      .send({ code: 'int main() { return 0; }', buildSystem: 'cmake' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.noTestsRun).toBe(true);
    expect(res.body.testsRun).toBe(0);
  });

  test('returns 500 on unexpected error', async () => {
    childProcess.spawn.mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });

    const res = await request(app)
      .post('/execute')
      .send({ code: 'int main() {}', buildSystem: 'cmake' });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Test execution failed');
    expect(res.body).toHaveProperty('executionId');
    expect(res.body).toHaveProperty('duration');
  });

  test('cleans up workspace on success', async () => {
    childProcess.spawn.mockImplementation(() => createMockChild('ok', '', 0));

    const res = await request(app)
      .post('/execute')
      .send({ code: 'int main() {}', testCode: 'TEST(X, Y) {}', buildSystem: 'cmake' });

    expect(res.body.success).toBe(true);
    const wsDir = pathMod.join(testWorkspace, res.body.executionId);
    let exists = true;
    try { await fsReal.access(wsDir); } catch { exists = false; }
    expect(exists).toBe(false);
  });

  test('keeps workspace on failure for debugging', async () => {
    childProcess.spawn.mockImplementation(() =>
      createMockChild('', 'cmake error', 1)
    );

    const res = await request(app)
      .post('/execute')
      .send({ code: 'int main() {}', buildSystem: 'cmake' });

    expect(res.body.success).toBe(false);
    const wsDir = pathMod.join(testWorkspace, res.body.executionId);
    let exists = false;
    try { await fsReal.access(wsDir); exists = true; } catch { exists = false; }
    expect(exists).toBe(true);

    await fsReal.rm(wsDir, { recursive: true, force: true });
  });

  test('writes CMakeLists.txt for cmake build', async () => {
    childProcess.spawn.mockImplementation(() =>
      createMockChild('', 'cmake error', 1)
    );

    const res = await request(app)
      .post('/execute')
      .send({ code: 'int main() {}', buildSystem: 'cmake' });

    const cmakeFile = pathMod.join(testWorkspace, res.body.executionId, 'CMakeLists.txt');
    const content = await fsReal.readFile(cmakeFile, 'utf-8');
    expect(content).toContain('cmake_minimum_required');
    expect(content).toContain('project(TestProject)');
    expect(content).toContain('CMAKE_CXX_STANDARD 17');

    await fsReal.rm(pathMod.join(testWorkspace, res.body.executionId), { recursive: true, force: true });
  });

  test('does not write CMakeLists.txt for make build', async () => {
    childProcess.spawn.mockImplementation(() =>
      createMockChild('', 'make error', 1)
    );

    const res = await request(app)
      .post('/execute')
      .send({ code: 'int main() {}', buildSystem: 'make' });

    const cmakeFile = pathMod.join(testWorkspace, res.body.executionId, 'CMakeLists.txt');
    let exists = false;
    try { await fsReal.access(cmakeFile); exists = true; } catch { exists = false; }
    expect(exists).toBe(false);

    await fsReal.rm(pathMod.join(testWorkspace, res.body.executionId), { recursive: true, force: true });
  });
});
