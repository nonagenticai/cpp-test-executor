/**
 * Zero-collection in C++: reportable where it CAN be measured, and explicitly
 * flagged as unknown where it cannot.
 *
 * cpp is the one language in this family where zero-collection is not always
 * observable. `ctest --output-on-failure` SUPPRESSES the child gtest summary on
 * a passing run, and ctest's own "... out of N" counts registered ctest
 * ENTRIES -- the generated CMakeLists registers exactly one -- so that N is 1
 * for a suite of 50 cases AND for a suite of zero.
 *
 * Reporting that state as `no_tests_run: false` would assert a measurement we
 * do not have. `no_tests_run_unknown` names it instead.
 */
const os = require('os');
const pathMod = require('path');
const fsReal = require('fs').promises;
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const testWorkspace = pathMod.join(os.tmpdir(), `cpptest-zero-${process.pid}`);
process.env.TEST_WORKSPACE = testWorkspace;

jest.mock('child_process', () => {
  const original = jest.requireActual('child_process');
  return { ...original, spawn: jest.fn() };
});

const childProcess = require('child_process');
const request = require('supertest');
const { app, describeCppTestCount } = require('../../src/cpp_test_service');

function createMockChild(stdoutData, stderrData, exitCode) {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = new Readable({ read() {} });
  child.kill = jest.fn();
  // Deliberately NOT the 10ms `setTimeout` the older suites use to defer
  // 'close'. That helper races: 'close' fires on a fixed timer while the
  // stdout/stderr data propagate through stream events, so under scheduling
  // pressure the close can win and the service sees EMPTY output -- which
  // here would silently change the verdict under test. Waiting for both
  // streams to actually end makes the ordering a fact instead of a bet.
  let ended = 0;
  const maybeClose = () => { if (++ended === 2) child.emit('close', exitCode); };
  child.stdout.on('end', maybeClose);
  child.stderr.on('end', maybeClose);
  child.stdout.resume();
  child.stderr.resume();

  process.nextTick(() => {
    if (stdoutData) child.stdout.push(stdoutData);
    child.stdout.push(null);
    if (stderrData) child.stderr.push(stderrData);
    child.stderr.push(null);
  });
  return child;
}

/** configure, build, then the test step gets `testOut`/`testExit`. */
function mockPipeline(testOut, testExit) {
  let call = 0;
  childProcess.spawn.mockImplementation(() => {
    call += 1;
    if (call === 3) return createMockChild(testOut, '', testExit);
    return createMockChild('ok', '', 0);
  });
}

const GTEST_ZERO = '[==========] Running 0 tests from 0 test suites.\n[==========] 0 tests from 0 test suites ran. (0 ms total)\n';
const GTEST_TWO = '[==========] Running 2 tests from 1 test suite.\n[  PASSED  ] 2 tests.\n';
const CTEST_PASS = '100% tests passed, 0 tests failed out of 1\n';

// What `ctest --output-on-failure -V` actually prints: the child's stdout is
// echoed, each line behind a "N: " stream prefix, followed by ctest's own
// entry-count summary. This is the LIVE shape -- cmake is the default
// buildSystem -- so these are the cases that decide whether production can
// still fake a green.
const CTEST_V_ZERO =
  'test 1\n    Start 1: unit_tests\n' +
  '1: [==========] Running 0 tests from 0 test suites.\n' +
  '1: [==========] 0 tests from 0 test suites ran. (0 ms total)\n' +
  '1: [  PASSED  ] 0 tests.\n' +
  '1/1 Test #1: unit_tests ....................   Passed    0.01 sec\n' +
  '100% tests passed, 0 tests failed out of 1\n';

const CTEST_V_TWO =
  'test 1\n    Start 1: unit_tests\n' +
  '1: [==========] Running 2 tests from 1 test suite.\n' +
  '1: [  PASSED  ] 2 tests.\n' +
  '1/1 Test #1: unit_tests ....................   Passed    0.01 sec\n' +
  '100% tests passed, 0 tests failed out of 1\n';

beforeAll(async () => { await fsReal.mkdir(testWorkspace, { recursive: true }); });
afterAll(async () => { try { await fsReal.rm(testWorkspace, { recursive: true, force: true }); } catch { /* ignore */ } });
beforeEach(() => { childProcess.spawn.mockReset(); });

describe('describeCppTestCount separates an authoritative count from ctest entries', () => {
  test('gtest "Running N tests" is authoritative, and survives N=0', () => {
    // This is the ONLY line gtest prints when it collected nothing -- the
    // "[  PASSED  ] N tests." line is absent on a zero-case run.
    expect(describeCppTestCount(GTEST_ZERO)).toEqual({
      count: 0, source: 'gtest', authoritative: true,
    });
  });

  test('gtest PASSED summary is authoritative', () => {
    expect(describeCppTestCount(GTEST_TWO)).toEqual({
      count: 2, source: 'gtest', authoritative: true,
    });
  });

  test('ctest "out of N" is NOT authoritative -- it counts entries, not cases', () => {
    const m = describeCppTestCount(CTEST_PASS);
    expect(m.source).toBe('ctest');
    expect(m.authoritative).toBe(false);
    // The trap in one assertion: a green ctest run reports 1 whether the
    // binary ran 50 cases or none at all.
    expect(m.count).toBe(1);
  });

  test('ctest -V: the prefixed gtest zero line is still authoritative', () => {
    expect(describeCppTestCount(CTEST_V_ZERO)).toEqual({
      count: 0, source: 'gtest', authoritative: true,
    });
  });

  test('ctest -V: gtest lines win over ctest\'s entry count', () => {
    // "out of 1" is present in this output. Reading it instead would report 1.
    expect(describeCppTestCount(CTEST_V_TWO)).toEqual({
      count: 2, source: 'gtest', authoritative: true,
    });
  });

  test('a mid-line forged summary does not inflate the count', () => {
    // A test body printing this must not be able to manufacture a count.
    const forged = 'some output saying [  PASSED  ] 99 tests. inline\n100% tests passed, 0 tests failed out of 1\n';
    const m = describeCppTestCount(forged);
    expect(m.count).toBe(1);
    expect(m.source).toBe('ctest');
    expect(m.authoritative).toBe(false);
  });

  test('catch2 test-case count is authoritative', () => {
    const m = describeCppTestCount('All tests passed (7 assertions in 3 test cases)');
    expect(m).toEqual({ count: 3, source: 'catch2', authoritative: true });
  });

  test('unrecognized output is not authoritative', () => {
    expect(describeCppTestCount('some random build noise')).toEqual({
      count: 0, source: null, authoritative: false,
    });
  });
});

describe('no_tests_run on the /execute contract', () => {
  // ---- THE LIVE PATH: cmake -> ctest -V ----------------------------------
  test('LIVE cmake/ctest: a zero-case suite must NOT return success:true', async () => {
    // Acceptance criterion. Before `-V`, ctest swallowed the child summary and
    // the only number left was its own entry count (1), so this exact input
    // was graded GREEN with zero test bodies executed.
    mockPipeline(CTEST_V_ZERO, 0);

    const res = await request(app).post('/execute').send({
      code: 'int add(int a,int b){return a+b;}',
      testCode: '#include <gtest/gtest.h>\n',
      // buildSystem omitted on purpose: cmake is the default, i.e. the live path.
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.no_tests_run).toBe(true);
    expect(res.body.no_tests_run_unknown).toBe(false);
  });

  test('LIVE cmake/ctest: a real 2-case suite still passes and counts 2', async () => {
    // The other side of the same change: -V must not make real runs unreadable.
    // Note ctest's own "out of 1" is present here too -- if the gtest lines
    // were not preferred, this would report 1.
    mockPipeline(CTEST_V_TWO, 0);

    const res = await request(app).post('/execute').send({
      code: 'int add(int a,int b){return a+b;}',
      testCode: 'TEST(A,B){}',
    });

    expect(res.body.success).toBe(true);
    expect(res.body.testsRun).toBe(2);
    expect(res.body.no_tests_run).toBe(false);
    expect(res.body.no_tests_run_unknown).toBe(false);
  });

  // ---- Outcome 1 of 3: measurably zero ------------------------------------
  test('a gtest run that collected zero cases is a not-run, never a pass', async () => {
    // The live fake green this closes: the binary links gtest_main, runs
    // nothing, and EXITS 0. Before this change `success` followed the exit
    // code alone and graded it GREEN.
    mockPipeline(GTEST_ZERO, 0);

    const res = await request(app).post('/execute').send({
      code: 'int add(int a,int b){return a+b;}',
      testCode: '#include <gtest/gtest.h>\n',
      buildSystem: 'cmake',
    });

    expect(res.status).toBe(200);
    expect(res.body.no_tests_run).toBe(true);
    expect(res.body.noTestsRun).toBe(true);
    expect(res.body.no_tests_run_unknown).toBe(false);
    expect(res.body.success).toBe(false);
  });

  test('no testCode at all reports the contract spelling too', async () => {
    mockPipeline('ok', 0);

    const res = await request(app).post('/execute').send({
      code: 'int add(int a,int b){return a+b;}',
      buildSystem: 'cmake',
    });

    expect(res.body.no_tests_run).toBe(true);
    expect(res.body.noTestsRun).toBe(true);
    expect(res.body.success).toBe(false);
  });

  // ---- Outcome 2 of 3: everything passed ----------------------------------
  test('an all-passed gtest run is a pass and not a not-run', async () => {
    mockPipeline(GTEST_TWO, 0);

    const res = await request(app).post('/execute').send({
      code: 'int add(int a,int b){return a+b;}',
      testCode: 'TEST(A,B){}',
      buildSystem: 'cmake',
    });

    expect(res.body.testsRun).toBe(2);
    expect(res.body.no_tests_run).toBe(false);
    expect(res.body.no_tests_run_unknown).toBe(false);
    expect(res.body.success).toBe(true);
  });

  // ---- Outcome 3 of 3: genuine failure ------------------------------------
  test('a genuine test failure is a FAILURE, not a not-run', async () => {
    mockPipeline('[==========] Running 2 tests from 1 test suite.\n[  FAILED  ] 1 tests\n', 1);

    const res = await request(app).post('/execute').send({
      code: 'int add(int a,int b){return a+b;}',
      testCode: 'TEST(A,B){}',
      buildSystem: 'cmake',
    });

    expect(res.body.no_tests_run).toBe(false);
    expect(res.body.success).toBe(false);
  });

  // ---- The blind spot, named rather than hidden ---------------------------
  test('a passing ctest run with no child summary is UNKNOWN, not clean', async () => {
    // This is the shape the whole flag exists for. We cannot tell whether the
    // binary ran 50 cases or zero, so we must not claim either.
    mockPipeline(CTEST_PASS, 0);

    const res = await request(app).post('/execute').send({
      code: 'int add(int a,int b){return a+b;}',
      testCode: 'TEST(A,B){}',
      buildSystem: 'cmake',
    });

    expect(res.body.no_tests_run_unknown).toBe(true);
    // Not claimed as a measured zero either -- unknown is unknown.
    expect(res.body.no_tests_run).toBe(false);
  });
});
