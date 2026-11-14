/**
 * Tests for helper/utility functions:
 * - ensureDirectory
 * - detectBuildSystem
 * - detectTestFramework
 * - executeCommand
 */

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

// We need to require the service module. Since startServer is guarded
// by require.main === module, it won't auto-start.
const {
  ensureDirectory,
  detectBuildSystem,
  detectTestFramework,
  executeCommand,
} = require('../../src/cpp_test_service');

// ── ensureDirectory ─────────────────────────────────────────────────

describe('ensureDirectory', () => {
  let tempBase;

  beforeEach(async () => {
    tempBase = path.join(os.tmpdir(), `cpptest-ensure-${Date.now()}`);
  });

  afterEach(async () => {
    try {
      await fs.rm(tempBase, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test('creates a new directory successfully', async () => {
    const dirPath = path.join(tempBase, 'subdir', 'nested');
    const result = await ensureDirectory(dirPath);
    expect(result).toBe(true);

    const stat = await fs.stat(dirPath);
    expect(stat.isDirectory()).toBe(true);
  });

  test('returns true when directory already exists', async () => {
    await fs.mkdir(tempBase, { recursive: true });
    const result = await ensureDirectory(tempBase);
    expect(result).toBe(true);
  });

  test('returns false on creation error', async () => {
    // Use a path that will fail — null byte in path is invalid
    const badPath = '/dev/null/impossible_dir';
    const result = await ensureDirectory(badPath);
    expect(result).toBe(false);
  });
});

// ── detectBuildSystem ───────────────────────────────────────────────

describe('detectBuildSystem', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `cpptest-build-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('returns "cmake" when CMakeLists.txt exists', async () => {
    await fs.writeFile(path.join(tempDir, 'CMakeLists.txt'), '');
    const result = await detectBuildSystem(tempDir);
    expect(result).toBe('cmake');
  });

  test('returns "make" when Makefile exists', async () => {
    await fs.writeFile(path.join(tempDir, 'Makefile'), '');
    const result = await detectBuildSystem(tempDir);
    expect(result).toBe('make');
  });

  test('returns "ninja" when build.ninja exists', async () => {
    await fs.writeFile(path.join(tempDir, 'build.ninja'), '');
    const result = await detectBuildSystem(tempDir);
    expect(result).toBe('ninja');
  });

  test('returns default "cmake" when no build files exist', async () => {
    // Empty directory - no build files
    const result = await detectBuildSystem(tempDir);
    expect(result).toBe('cmake');
  });

  test('returns default "cmake" on read error (nonexistent dir)', async () => {
    const result = await detectBuildSystem('/nonexistent/path/does/not/exist');
    expect(result).toBe('cmake');
  });

  test('prefers CMakeLists.txt over Makefile when both present', async () => {
    await fs.writeFile(path.join(tempDir, 'CMakeLists.txt'), '');
    await fs.writeFile(path.join(tempDir, 'Makefile'), '');
    const result = await detectBuildSystem(tempDir);
    expect(result).toBe('cmake');
  });
});

// ── detectTestFramework ─────────────────────────────────────────────

describe('detectTestFramework', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `cpptest-fw-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('returns "gtest" when file name contains "gtest"', async () => {
    await fs.writeFile(path.join(tempDir, 'gtest_main.cpp'), '');
    const result = await detectTestFramework(tempDir);
    expect(result).toBe('gtest');
  });

  test('returns "gtest" when file name contains "googletest"', async () => {
    await fs.mkdir(path.join(tempDir, 'googletest'));
    const result = await detectTestFramework(tempDir);
    expect(result).toBe('gtest');
  });

  test('returns "catch2" when file name contains "catch2"', async () => {
    await fs.mkdir(path.join(tempDir, 'catch2'));
    const result = await detectTestFramework(tempDir);
    expect(result).toBe('catch2');
  });

  test('returns "catch2" when catch.hpp file exists', async () => {
    await fs.writeFile(path.join(tempDir, 'catch.hpp'), '');
    const result = await detectTestFramework(tempDir);
    expect(result).toBe('catch2');
  });

  test('returns "cppunit" when file name contains "cppunit"', async () => {
    await fs.mkdir(path.join(tempDir, 'cppunit'));
    const result = await detectTestFramework(tempDir);
    expect(result).toBe('cppunit');
  });

  test('returns default "gtest" when no framework files found', async () => {
    await fs.writeFile(path.join(tempDir, 'main.cpp'), '');
    const result = await detectTestFramework(tempDir);
    expect(result).toBe('gtest');
  });

  test('returns default "gtest" on read error (nonexistent dir)', async () => {
    const result = await detectTestFramework('/nonexistent/path');
    expect(result).toBe('gtest');
  });
});

// ── executeCommand ──────────────────────────────────────────────────

describe('executeCommand', () => {
  test('returns success result with stdout for successful command', async () => {
    const result = await executeCommand('echo hello');
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello');
    expect(result.timedOut).toBe(false);
    expect(result.command).toBe('echo hello');
  });

  test('captures stderr output', async () => {
    const result = await executeCommand('echo error_msg >&2');
    expect(result.success).toBe(true);
    expect(result.stderr).toBe('error_msg');
  });

  test('returns failure for non-zero exit code', async () => {
    const result = await executeCommand('exit 42');
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });

  test('handles timeout by killing the process', async () => {
    const result = await executeCommand('sleep 30', { timeout: 500 });
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
  }, 10000);

  test('uses custom cwd', async () => {
    const result = await executeCommand('pwd', { cwd: '/tmp' });
    expect(result.success).toBe(true);
    // /tmp may resolve to /private/tmp on macOS
    expect(result.stdout).toMatch(/\/tmp/);
  });

  test('rejects on spawn error (invalid cwd)', async () => {
    await expect(
      executeCommand('echo hi', { cwd: '/nonexistent_dir_xyz' })
    ).rejects.toThrow();
  });

  test('passes custom environment variables', async () => {
    const result = await executeCommand('echo $MY_TEST_VAR', {
      env: { MY_TEST_VAR: 'test_value_123' },
    });
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('test_value_123');
  });
});
