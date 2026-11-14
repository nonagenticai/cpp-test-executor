/**
 * Tests for GET /frameworks, GET /tools, GET /info, and 404 handling
 */

const request = require('supertest');
const { app, CPP_TOOLS, BUILD_SYSTEMS, startServer } = require('../../src/cpp_test_service');

describe('GET /frameworks', () => {
  test('returns 200 status code', async () => {
    const res = await request(app).get('/frameworks');
    expect(res.status).toBe(200);
  });

  test('includes all three test frameworks', async () => {
    const res = await request(app).get('/frameworks');
    const fw = res.body.frameworks;
    expect(fw).toHaveProperty('gtest');
    expect(fw).toHaveProperty('catch2');
    expect(fw).toHaveProperty('cppunit');
  });

  test('gtest framework has correct name', async () => {
    const res = await request(app).get('/frameworks');
    expect(res.body.frameworks.gtest.name).toBe('Google Test');
  });

  test('catch2 framework has correct name', async () => {
    const res = await request(app).get('/frameworks');
    expect(res.body.frameworks.catch2.name).toBe('Catch2');
  });

  test('cppunit framework has correct name', async () => {
    const res = await request(app).get('/frameworks');
    expect(res.body.frameworks.cppunit.name).toBe('CppUnit');
  });

  test('includes all three build systems', async () => {
    const res = await request(app).get('/frameworks');
    const bs = res.body.buildSystems;
    expect(bs).toHaveProperty('cmake');
    expect(bs).toHaveProperty('make');
    expect(bs).toHaveProperty('ninja');
  });

  test('cmake build system has correct config', async () => {
    const res = await request(app).get('/frameworks');
    const cmake = res.body.buildSystems.cmake;
    expect(cmake.name).toBe('CMake');
    expect(cmake.configure).toBe('cmake ..');
    expect(cmake.build).toBe('cmake --build . --parallel');
    expect(cmake.test).toBe('ctest --output-on-failure -V');
  });

  test('make build system has null configure', async () => {
    const res = await request(app).get('/frameworks');
    expect(res.body.buildSystems.make.configure).toBeNull();
  });

  test('returns supported C++ extensions', async () => {
    const res = await request(app).get('/frameworks');
    const exts = res.body.supportedExtensions;
    expect(exts).toContain('.cpp');
    expect(exts).toContain('.cc');
    expect(exts).toContain('.h');
    expect(exts).toContain('.hpp');
    expect(exts).toContain('.c');
  });

  test('returns features list', async () => {
    const res = await request(app).get('/frameworks');
    const features = res.body.features;
    expect(features).toContain('unit testing');
    expect(features).toContain('code coverage');
    expect(features).toContain('static analysis');
    expect(features).toContain('memory checking');
  });
});

describe('CPP_TOOLS export', () => {
  test('gtest has command entries', () => {
    expect(CPP_TOOLS.gtest.commands.test).toBe('ctest --output-on-failure -V');
    expect(CPP_TOOLS.gtest.commands.build).toBe('cmake --build . --parallel');
    expect(CPP_TOOLS.gtest.commands.configure).toBe('cmake ..');
  });

  test('catch2 has command entries', () => {
    expect(CPP_TOOLS.catch2.commands.test).toBe('./test_runner');
  });

  test('cppunit has command entries', () => {
    expect(CPP_TOOLS.cppunit.commands.test).toBe('./test_runner');
  });

  test('all tools have patterns', () => {
    for (const [, tool] of Object.entries(CPP_TOOLS)) {
      expect(tool.patterns).toHaveProperty('test_files');
      expect(Array.isArray(tool.patterns.test_files)).toBe(true);
    }
  });
});

describe('BUILD_SYSTEMS export', () => {
  test('cmake has all commands', () => {
    expect(BUILD_SYSTEMS.cmake.configure).toBe('cmake ..');
    expect(BUILD_SYSTEMS.cmake.build).toBe('cmake --build . --parallel');
    expect(BUILD_SYSTEMS.cmake.test).toBe('ctest --output-on-failure -V');
  });

  test('make has no configure step', () => {
    expect(BUILD_SYSTEMS.make.configure).toBeNull();
  });

  test('ninja uses cmake with GNinja generator', () => {
    expect(BUILD_SYSTEMS.ninja.configure).toBe('cmake -GNinja ..');
  });
});

describe('startServer', () => {
  test('is a function', () => {
    expect(typeof startServer).toBe('function');
  });

  test('starts server and resolves without error', async () => {
    // startServer calls app.listen() — we intercept to avoid binding a port
    const listenSpy = jest.spyOn(app, 'listen').mockImplementation((port, cb) => {
      if (cb) cb();
      return { close: jest.fn() };
    });

    await startServer();

    expect(listenSpy).toHaveBeenCalled();
    listenSpy.mockRestore();
  });

  test('handles listen error gracefully', async () => {
    const listenSpy = jest.spyOn(app, 'listen').mockImplementation(() => {
      throw new Error('EADDRINUSE');
    });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});

    await startServer();

    expect(exitSpy).toHaveBeenCalledWith(1);
    listenSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe('404 handling', () => {
  test('returns 404 for unknown routes', async () => {
    const res = await request(app).get('/nonexistent');
    expect(res.status).toBe(404);
  });

  test('returns 404 for GET /tools (not implemented)', async () => {
    const res = await request(app).get('/tools');
    expect(res.status).toBe(404);
  });

  test('returns 404 for GET /info (not implemented)', async () => {
    const res = await request(app).get('/info');
    expect(res.status).toBe(404);
  });
});
