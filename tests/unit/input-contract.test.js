/**
 * Input-contract tests: malformed request bodies must produce a 400 that
 * names the offending field, never a 500 from fs/TypeError deeper in the
 * handler. Also pins the "no build command is run" property — a rejected
 * request must not reach spawn() at all.
 */

const os = require('os');
const pathMod = require('path');
const fsReal = require('fs').promises;
const { EventEmitter } = require('events');
const { Readable } = require('stream');

// Set TEST_WORKSPACE to a writable temp directory BEFORE loading the service
const testWorkspace = pathMod.join(os.tmpdir(), `cpptest-contract-${process.pid}`);
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
const { app, BUILD_SYSTEMS, CPP_TOOLS } = require('../../src/cpp_test_service');

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

describe('POST /validate code type contract', () => {
  beforeEach(() => {
    childProcess.spawn.mockReset();
  });

  test('returns 400 naming the field when code is an object', async () => {
    const res = await request(app)
      .post('/validate')
      .send({ code: { src: 'int main() {}' } });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("'code'");
    expect(res.body.error).toContain('object');
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  test('returns 400 reporting "array" (not "object") when code is an array', async () => {
    const res = await request(app)
      .post('/validate')
      .send({ code: ['int main() {}'] });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("'code'");
    // typeof [] === 'object' would be useless to the caller
    expect(res.body.error).toContain('array');
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  test('returns 400 naming the field when code is a number', async () => {
    const res = await request(app)
      .post('/validate')
      .send({ code: 42 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("'code'");
    expect(res.body.error).toContain('number');
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  test('returns 400 when code is a boolean', async () => {
    const res = await request(app)
      .post('/validate')
      .send({ code: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('boolean');
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  test('pre-existing falsy-code 400 response shape is unchanged', async () => {
    const missing = await request(app).post('/validate').send({});
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ success: false, error: 'No code provided' });

    const empty = await request(app).post('/validate').send({ code: '' });
    expect(empty.status).toBe(400);
    expect(empty.body).toEqual({ success: false, error: 'No code provided' });

    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  test('a string code still reaches compilation', async () => {
    childProcess.spawn.mockImplementation(() => createMockChild('', '', 0));

    const res = await request(app)
      .post('/validate')
      .send({ code: 'int main() { return 0; }' });

    expect(res.status).toBe(200);
    expect(res.body.syntaxValid).toBe(true);
    expect(childProcess.spawn).toHaveBeenCalled();
  });
});

describe('POST /execute buildSystem contract', () => {
  beforeEach(() => {
    childProcess.spawn.mockReset();
  });

  test('returns 400 listing supported values for an unknown buildSystem', async () => {
    const res = await request(app)
      .post('/execute')
      .send({ code: 'int main() {}', buildSystem: 'bazel' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("'buildSystem'");
    for (const key of Object.keys(BUILD_SYSTEMS)) {
      expect(res.body.details).toContain(key);
    }
    // Nothing may be built for a rejected request
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  test('returns 400 (not a TypeError 500) for a non-string buildSystem', async () => {
    for (const bad of [{ name: 'cmake' }, ['cmake'], 7, null]) {
      childProcess.spawn.mockReset();
      const res = await request(app)
        .post('/execute')
        .send({ code: 'int main() {}', buildSystem: bad });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("'buildSystem'");
      expect(childProcess.spawn).not.toHaveBeenCalled();
    }
  });

  test('rejects a buildSystem that is only an inherited Object property', async () => {
    // 'constructor'/'toString' exist on every object via the prototype chain;
    // an `in`-style check would let them through into the command lookup.
    for (const bad of ['constructor', 'toString', '__proto__']) {
      childProcess.spawn.mockReset();
      const res = await request(app)
        .post('/execute')
        .send({ code: 'int main() {}', buildSystem: bad });

      expect(res.status).toBe(400);
      expect(childProcess.spawn).not.toHaveBeenCalled();
    }
  });

  test.each(Object.keys(BUILD_SYSTEMS))(
    'supported buildSystem %s still executes',
    async (buildSystem) => {
      childProcess.spawn.mockImplementation(() => createMockChild('ok', '', 0));

      const res = await request(app)
        .post('/execute')
        .send({
          code: 'int main() { return 0; }',
          testCode: 'TEST(X, Y) {}',
          buildSystem,
        });

      expect(res.status).toBe(200);
      expect(res.body.buildSystem).toBe(buildSystem);
      expect(res.body.success).toBe(true);
      expect(res.body.steps.map((s) => s.name)).toContain('build');
      expect(childProcess.spawn).toHaveBeenCalled();
    }
  );
});

describe('POST /execute framework contract', () => {
  beforeEach(() => {
    childProcess.spawn.mockReset();
  });

  test('returns 400 listing supported values for an unknown framework', async () => {
    const res = await request(app)
      .post('/execute')
      .send({ code: 'int main() {}', framework: 'doctest' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("'framework'");
    for (const key of Object.keys(CPP_TOOLS)) {
      expect(res.body.details).toContain(key);
    }
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  test('framework injection payload never reaches the generated CMakeLists.txt', async () => {
    // framework is interpolated into CMakeLists.txt, which cmake then
    // executes — the allowlist is what keeps arbitrary text out of it.
    const res = await request(app)
      .post('/execute')
      .send({
        code: 'int main() {}',
        framework: '" STREQUAL "" ) \nexecute_process(COMMAND touch /tmp/pwned)\nif( "',
      });

    expect(res.status).toBe(400);
    expect(childProcess.spawn).not.toHaveBeenCalled();

    const wsDir = pathMod.join(testWorkspace, res.body.executionId);
    let exists = false;
    try { await fsReal.access(wsDir); exists = true; } catch { exists = false; }
    expect(exists).toBe(false);
  });

  test.each(Object.keys(CPP_TOOLS))(
    'supported framework %s still executes',
    async (framework) => {
      childProcess.spawn.mockImplementation(() => createMockChild('ok', '', 0));

      const res = await request(app)
        .post('/execute')
        .send({
          code: 'int main() { return 0; }',
          testCode: 'TEST(X, Y) {}',
          framework,
          buildSystem: 'cmake',
        });

      expect(res.status).toBe(200);
      expect(res.body.framework).toBe(framework);
      expect(res.body.success).toBe(true);
    }
  );
});
