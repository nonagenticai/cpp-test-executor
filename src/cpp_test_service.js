#!/usr/bin/env node

/**
 * C++ Test Execution Service
 * 
 * Comprehensive C++ testing service with:
 * - Multiple test frameworks (Google Test, Catch2, CppUnit)
 * - Build systems (CMake, Make, Ninja)
 * - Code coverage (gcov, lcov)
 * - Static analysis (cppcheck, clang-tidy)
 * - Memory checking (valgrind)
 * - Code formatting (clang-format)
 */

const {
    createLogger,
    setupExpress,
    tenantGuard,
    installGracefulShutdown,
} = require('./common');
const { spawn, exec } = require('child_process');
const { rateLimit } = require('express-rate-limit');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// Configuration
const PORT = process.env.PORT || process.env.CPP_TEST_PORT || 8094;
const EXECUTION_TIMEOUT = parseInt(process.env.EXECUTION_TIMEOUT || '300') * 1000; // 5 minutes for C++ builds
const TEST_WORKSPACE = process.env.TEST_WORKSPACE || '/app/test_workspace';
const REPORTS_DIR = process.env.REPORTS_DIR || '/app/reports';

// ── Rate limiting ───────────────────────────────────────────────────────────
// /execute scaffolds, writes, configures, builds and tests a C++ project on
// disk; /validate writes a source file and runs g++ and cppcheck. Each request
// is seconds to minutes of CPU and scratch-disk churn, and CodeQL
// js/missing-rate-limiting raised both routes. This is an in-process counter
// keyed on the caller's address: the orchestrator is the only caller
// (tenantGuard), so there is one meaningful bucket, and an external attacker
// cannot bypass it by rotating addresses. Defaults: 60 requests per 60 s,
// overridable with RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS. Invalid overrides
// fall back to the default rather than disabling the limit.
function positiveIntFromEnv(name, fallback) {
    const parsed = Number.parseInt(process.env[name], 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const RATE_LIMIT_MAX = positiveIntFromEnv('RATE_LIMIT_MAX', 60);
const RATE_LIMIT_WINDOW_MS = positiveIntFromEnv('RATE_LIMIT_WINDOW_MS', 60 * 1000);

const expensiveRouteLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: RATE_LIMIT_MAX,
    standardHeaders: true, // RateLimit-Limit / -Remaining / -Reset on responses
    legacyHeaders: false,
    message: { error: 'Too many requests', detail: 'This executor is rate-limited.' },
});

// Initialize Express app with shared setup + orchestrator-only tenant guard
const app = setupExpress({ jsonLimit: '50mb' });
app.use(tenantGuard());

// Logging utility
const log = createLogger();

// Supported testing frameworks and tools
const CPP_TOOLS = {
    'gtest': {
        name: 'Google Test',
        commands: {
            test: 'ctest --output-on-failure -V',
            build: 'cmake --build . --parallel',
            configure: 'cmake ..'
        },
        patterns: {
            test_files: ['*test*.cpp', '*Test*.cpp', 'test_*.cpp'],
            headers: ['*test*.h', '*Test*.h', 'test_*.h']
        }
    },
    'catch2': {
        name: 'Catch2',
        commands: {
            test: './test_runner',
            build: 'g++ -std=c++17 -I/usr/include/catch2 -o test_runner'
        },
        patterns: {
            test_files: ['*test*.cpp', '*Test*.cpp'],
            headers: ['catch.hpp', 'catch2/*.hpp']
        }
    },
    'cppunit': {
        name: 'CppUnit',
        commands: {
            test: './test_runner',
            build: 'g++ -std=c++17 -lcppunit -o test_runner'
        },
        patterns: {
            test_files: ['*Test.cpp', 'Test*.cpp'],
            headers: ['cppunit/*.h']
        }
    }
};

// Build systems
/**
 * Remove block comments with a single left-to-right scan.
 *
 * The regex it replaces, /\/\*[\s\S]*?\*\//g, was flagged as
 * js/polynomial-redos: on an unterminated '/*' followed by many 'a/*'
 * repetitions the lazy group retries the closing star-slash from every
 * position of the suffix, and the global flag then restarts that scan at every
 * later '/*'. Each candidate start is skipped with indexOf and a match consumes
 * its bytes, so the whole input is walked once. An unterminated '/*' is left
 * untouched, exactly as the old regex left it.
 */
function stripBlockComments(code) {
    let output = '';
    let index = 0;
    for (;;) {
        const start = code.indexOf('/*', index);
        if (start === -1) {
            return output + code.slice(index);
        }
        output += code.slice(index, start);
        const end = code.indexOf('*/', start + 2);
        if (end === -1) {
            return output + code.slice(start);
        }
        output += ' ';
        index = end + 2;
    }
}

/**
 * Remove line comments with a single left-to-right scan.
 *
 * Equivalent to the old global line-comment replace: everything from '//' up
 * to (not including) the next newline is removed, so a trailing carriage
 * return is part of the comment. Kept as a scanner for the same reason as
 * stripBlockComments — no repeated re-scanning of the suffix.
 */
function stripLineComments(code) {
    let output = '';
    let index = 0;
    for (;;) {
        const start = code.indexOf('//', index);
        if (start === -1) {
            return output + code.slice(index);
        }
        output += code.slice(index, start) + ' ';
        const newline = code.indexOf('\n', start + 2);
        if (newline === -1) {
            return output;
        }
        index = newline; // keep the newline itself
    }
}

/**
 * Does the submitted code define its own entry point?
 *
 * This decides the whole shape of the generated build. The old template
 * answered "always yes": it emitted `add_executable(main main.cpp)` guarded
 * only by `if(EXISTS "<path>")`, and main.cpp is written unconditionally (even
 * for empty code), so that guard was always true. Library-style code -- the
 * normal thing to unit-test -- therefore always failed to link with
 * `undefined reference to 'main'`.
 */
function codeDefinesMain(code) {
    if (!code) return false;
    // Strip comments and string/char literals FIRST. The naive test matched
    // `main(` anywhere, so a source file whose only mention of main was prose --
    //     // Helpers extracted from main() in app.cpp
    // -- was treated as defining an entry point. That emitted
    // `add_executable(main main.cpp)` against a file with no main(), i.e. the
    // exact `undefined reference to 'main'` this function exists to prevent,
    // and on the make path it also dropped code_under_test.o from the link line.
    const stripped = stripCharLiterals(
        stripStringLiterals(
            stripLineComments(stripBlockComments(code || ''))
        )
    );

    // Require a DEFINITION, not a declaration: the parameter list must be
    // followed by a body. `int main();` is a forward declaration -- linking as
    // if it were a definition fails exactly like having no main at all.
    // The optional group covers trailing return types and qualifiers.
    // Not handled, and deliberately so: a main() inside `#if 0`. Detecting that
    // needs a preprocessor, and guessing wrong is worse than the honest answer.
    return /(^|[^\w:])main\s*\([^;()]*\)\s*(?:->[^{;]+)?\{/.test(stripped);
}

/**
 * A code unit that ECMAScript's `.` refuses to match.
 */
function isLineTerminator(ch) {
    const code = ch.charCodeAt(0);
    return code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
}

/**
 * Replace quoted literals with `replacement`, scanning each candidate once.
 *
 * This replaces /"(?:\\.|[^"\\])*"/g (and the single-quote form), which CodeQL
 * flagged as js/polynomial-redos: on '"' followed by many '\"' repetitions the
 * engine exhausts the escape pairs, finds no closing quote, then restarts at
 * the next quote inside the run and re-reads the same suffix — once per
 * repetition. The scanner walks from each opening quote to its close: an
 * escape pair is exactly two code units and cannot contain a line terminator
 * (`.` does not match one), a closing quote ends the literal, and anything
 * else is consumed.
 *
 * A start that fails is not retried at every quote it passed. Every quote
 * between the opening quote and the failure point was itself consumed as part
 * of an escape pair, so a fresh start at one of them follows the identical
 * token path from that position and fails in the same place; at EOF the same
 * argument says nothing in the remainder can match at all. Those regions are
 * therefore skipped in one step, which is what keeps this linear.
 */
function stripQuotedLiterals(code, quote, replacement) {
    let output = '';
    let index = 0;
    for (;;) {
        const start = code.indexOf(quote, index);
        if (start === -1) {
            return output + code.slice(index);
        }

        let cursor = start + 1;
        let close = -1;
        let failedAt = -1;
        while (cursor < code.length) {
            const ch = code[cursor];
            if (ch === '\\') {
                const next = code[cursor + 1];
                if (next === undefined || isLineTerminator(next)) {
                    failedAt = cursor;
                    break;
                }
                cursor += 2;
                continue;
            }
            if (ch === quote) {
                close = cursor;
                break;
            }
            cursor += 1;
        }

        if (close === -1) {
            if (failedAt === -1) {
                // Ran off the end without a closing quote: no quote after the
                // opening one can start a match either, so the remainder is
                // unchanged.
                return output + code.slice(index);
            }
            // Skip the whole failed candidate region in one step.
            output += code.slice(index, failedAt);
            index = failedAt;
            continue;
        }

        output += code.slice(index, start) + replacement;
        index = close + 1;
    }
}

/** Replace string literals with an empty literal. */
function stripStringLiterals(code) {
    return stripQuotedLiterals(code, '"', '""');
}

/** Replace character literals with an empty literal. */
function stripCharLiterals(code) {
    return stripQuotedLiterals(code, "'", "''");
}

/**
 * Render CMakeLists.txt for the cmake and ninja build systems.
 *
 * The defect this replaces: `test_runner` was built from test.cpp alone and
 * linked only against the test framework, so the submitted code's translation
 * unit was never on the link line. Any test calling a function defined in
 * `code` failed with "undefined reference" -- i.e. the service's primary use
 * case could not work.
 */
function renderCMakeLists({ code, testCode, framework, testFile }) {
    const hasMain = codeDefinesMain(code);
    void testCode;
    return `
cmake_minimum_required(VERSION 3.10)
project(TestProject)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Find required packages
find_package(GTest QUIET)
find_package(Catch2 QUIET)

${hasMain
        ? `# The submitted code defines main(), so build it as a program. It is
# deliberately NOT linked into test_runner: the test framework supplies its own
# main(), and pulling this object in as well is a duplicate-symbol link error.
# A test binary in this mode must be self-contained.
add_executable(main main.cpp)`
        : `# The submitted code has no main(), so it IS the unit under test. Build it as
# a static library and link it into the test binary -- without this, any test
# that calls a function defined in the submitted code fails to link with
# "undefined reference".
add_library(code_under_test STATIC main.cpp)`}

# Add test executable if test code exists
if(EXISTS "${testFile}")
    add_executable(test_runner test.cpp)

    if(TARGET code_under_test)
        target_link_libraries(test_runner code_under_test)
    endif()

    # Link with appropriate test framework. cppunit is advertised by
    # /frameworks and accepted by /execute, so it needs a branch here -- without
    # one it linked NOTHING and failed with a wall of undefined references to
    # CppUnit symbols.
    find_package(Threads REQUIRED)
    if(GTest_FOUND AND "${framework}" STREQUAL "gtest")
        target_link_libraries(test_runner GTest::GTest GTest::Main Threads::Threads)
    elseif(Catch2_FOUND AND "${framework}" STREQUAL "catch2")
        target_link_libraries(test_runner Catch2::Catch2 Threads::Threads)
    elseif("${framework}" STREQUAL "cppunit")
        target_link_libraries(test_runner cppunit Threads::Threads)
    else()
        message(FATAL_ERROR "framework '${framework}' is not available in this image")
    endif()

    # Enable testing
    enable_testing()
    add_test(NAME unit_tests COMMAND test_runner)
endif()
`;
}

/**
 * Render a Makefile for the `make` build system.
 *
 * `make` was advertised by /frameworks and accepted by /execute, but no
 * Makefile was ever generated, so `make -j$(nproc)` always died with
 * "No targets specified and no makefile found".
 *
 * Sources are referenced as ../main.cpp because every build step runs with
 * cwd = <workspace>/build.
 */
function renderMakefile({ code, testCode, framework }) {
    const hasMain = codeDefinesMain(code);
    // cppunit is advertised by /frameworks and accepted by /execute. It used to
    // fall through to the gtest libs, so a cppunit request linked the wrong
    // framework and died on undefined CppUnit symbols.
    const frameworkLibs = {
        catch2: '-lCatch2Main -lCatch2',
        cppunit: '-lcppunit',
        gtest: '-lgtest -lgtest_main',
    }[framework] || '-lgtest -lgtest_main';
    // Mirror the CMake rule: link the unit under test in only when it does not
    // carry its own main().
    const testDeps = hasMain ? '' : ' code_under_test.o';
    // `all` must match what `cmake --build .` does, which is build EVERY target.
    // Listing only test_runner meant a broken `main` (e.g. a declaration-only
    // entry point) failed under cmake and passed under make on identical input.
    const allTargets = [
        ...(hasMain ? ['main'] : ['code_under_test.o']),
        ...(testCode ? ['test_runner'] : []),
    ].join(' ');
    return [
        'CXX ?= g++',
        'CXXFLAGS ?= -std=c++17',
        `LDLIBS ?= ${frameworkLibs} -pthread`,
        '',
        '.PHONY: all test clean',
        `all: ${allTargets}`,
        '',
        'code_under_test.o: ../main.cpp',
        '\t$(CXX) $(CXXFLAGS) -c ../main.cpp -o code_under_test.o',
        '',
        ...(hasMain
            ? ['main: ../main.cpp', '\t$(CXX) $(CXXFLAGS) ../main.cpp -o main', '']
            : []),
        ...(testCode
            ? [
                `test_runner: ../test.cpp${testDeps}`,
                `\t$(CXX) $(CXXFLAGS) ../test.cpp${testDeps} $(LDLIBS) -o test_runner`,
                '',
                'test: test_runner',
                '\t./test_runner',
                '',
            ]
            // No test code is a FAILURE, matching ctest, which exits 8 when no
            // tests are registered. Echoing a message and exiting 0 reported a
            // green run that executed nothing -- under cmake the same input went
            // red.
            : [
                'test:',
                '\t@echo "no test code supplied — nothing to run" >&2',
                '\t@exit 1',
                '',
            ]),
        'clean:',
        '\trm -f main test_runner code_under_test.o',
        '',
    ].join('\n');
}

// ⚠️ The `-V` on both ctest lines is LOAD-BEARING, not noise.
//
// `ctest --output-on-failure` alone SUPPRESSES the child test binary's stdout
// on a PASSING run. That stdout is the only place gtest reports how many test
// CASES it collected, so without it the sole surviving number is ctest's own
// "... out of N" -- which counts registered ctest ENTRIES, and the generated
// CMakeLists registers exactly ONE. That N is 1 for a suite of 50 cases AND
// for a suite of ZERO, so a zero-case suite exited 0 and was graded GREEN.
//
// `-V` keeps the child summary, which makes the count authoritative on exactly
// the runs where a fake green would otherwise be invisible. ⛔ Do not "tidy"
// it away.
//
// ninja uses ctest directly rather than the `ninja test` target for the same
// reason: that target shells out to ctest with no way to pass -V through, so
// it carried an identical blind spot. Both cmake and ninja generators emit
// CTestTestfile.cmake, so invoking ctest in the build dir is equivalent.
//
// `make` needs none of this: its generated `test:` target runs ./test_runner
// directly, so gtest's output was never suppressed on that path.
const BUILD_SYSTEMS = {
    'cmake': {
        name: 'CMake',
        configure: 'cmake ..',
        build: 'cmake --build . --parallel',
        test: 'ctest --output-on-failure -V'
    },
    'make': {
        name: 'Make',
        configure: null,
        build: 'make -j$(nproc)',
        test: 'make test'
    },
    'ninja': {
        name: 'Ninja',
        configure: 'cmake -GNinja ..',
        build: 'ninja',
        test: 'ctest --output-on-failure -V'
    }
};

// Human-readable type name for error messages. `typeof []` is 'object', which
// is useless to a caller who sent an array by mistake, so report 'array'.
function describeType(value) {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    return typeof value;
}

// Utility functions
async function ensureDirectory(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
        return true;
    } catch (error) {
        log.error('Failed to create directory', { path: dirPath, error: error.message });
        return false;
    }
}

async function executeCommand(command, options = {}) {
    return new Promise((resolve, reject) => {
        const timeout = options.timeout || EXECUTION_TIMEOUT;
        const cwd = options.cwd || process.cwd();
        const env = { ...process.env, ...options.env };

        log.debug('Executing command', { command, cwd, timeout });

        const child = spawn('bash', ['-c', command], {
            cwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeout);

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            
            const result = {
                success: code === 0 && !timedOut,
                exitCode: code,
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                timedOut,
                command,
                duration: Date.now() - (options.startTime || Date.now())
            };

            log.debug('Command completed', result);
            resolve(result);
        });

        child.on('error', (error) => {
            clearTimeout(timer);
            log.error('Command execution error', { command, error: error.message });
            reject(error);
        });
    });
}

/**
 * Like countCppTests, but also reports WHERE the number came from and whether
 * that source is authoritative for "how many test cases actually ran".
 *
 * This distinction is the whole reason zero-collection is hard in C++:
 *
 *  - `gtest`  — "[  PASSED  ] N tests." counts real TEST() bodies. Authoritative.
 *  - `catch2` — "in N test cases" counts real test cases. Authoritative.
 *  - `ctest`  — "... out of N" counts registered ctest ENTRIES, and the
 *               generated CMakeLists registers exactly ONE
 *               (`add_test(NAME unit_tests COMMAND test_runner)`). So this N is
 *               1 for a suite of 50 gtest cases AND 1 for a suite of zero.
 *               NOT authoritative — it cannot see zero-collection at all.
 *
 * Worse, the runner is invoked as `ctest --output-on-failure`, which SUPPRESSES
 * the child gtest summary on a PASSING run. So on exactly the runs where a
 * fake green would matter, the authoritative source is not in the output.
 *
 * Returning `authoritative: false` is how that blind spot is surfaced instead
 * of being silently rendered as "zero tests did not happen".
 */
function describeCppTestCount(output) {
    if (!output) return { count: 0, source: null, authoritative: false };

    // Anchored to line start, optionally behind ctest -V's "N: " stream prefix.
    // Unanchored, a submitted test that merely PRINTS "[  PASSED  ] 99 tests."
    // mid-line would inflate the count and turn a not-run into a clean run --
    // the same forgery csharp's anchored summary matcher guards against.
    // ⚠️ Honest limitation: under `ctest -V` the child's own stdout is echoed
    // WITH that same prefix, so anchoring raises the bar but cannot fully
    // separate a forged summary from a real one. Closing that needs structured
    // output (--gtest_output=json), which the runner does not currently emit.
    let total = 0;
    const gtest = output.match(/^(?:\s*\d+:\s*)?\[\s*(?:PASSED|FAILED)\s*\]\s+(\d+)\s+tests?/gim);
    if (gtest) {
        for (const m of gtest) {
            const n = m.match(/\]\s+(\d+)\s+tests?/i);
            if (n) total += parseInt(n[1], 10);
        }
        if (total > 0) return { count: total, source: 'gtest', authoritative: true };
    }
    // gtest also announces collection up front, and THIS line is present even
    // when the count is zero ("Running 0 tests from 0 test suites."), which the
    // "[  PASSED  ] N tests." line is not. It is the only authoritative signal
    // for a zero-collection gtest run.
    const gtestRunning = output.match(/^(?:\s*\d+:\s*)?\[=+\]\s+Running\s+(\d+)\s+tests?\s+from\s+\d+\s+test\s+su/im);
    if (gtestRunning) {
        return { count: parseInt(gtestRunning[1], 10), source: 'gtest', authoritative: true };
    }
    const catch2 = output.match(/in\s+(\d+)\s+test cases?/i);
    if (catch2) {
        return { count: parseInt(catch2[1], 10), source: 'catch2', authoritative: true };
    }
    const ctest = output.match(/out of\s+(\d+)/i);
    if (ctest) {
        // Deliberately NOT authoritative — see the block comment above.
        return { count: parseInt(ctest[1], 10), source: 'ctest', authoritative: false };
    }
    return { count: 0, source: null, authoritative: false };
}

// Best-effort count of executed tests from common C++ test-runner output
// (gtest, ctest, Catch2). Returns 0 when no recognizable summary is present.
// Informational only — it does not by itself decide pass/fail.
function countCppTests(output) {
    if (!output) return 0;
    // gtest: "[  PASSED  ] 5 tests." / "[  FAILED  ] 2 tests"
    let total = 0;
    const gtest = output.match(/\[\s*(?:PASSED|FAILED)\s*\]\s+(\d+)\s+tests?/gi);
    if (gtest) {
        for (const m of gtest) {
            const n = m.match(/(\d+)/);
            if (n) total += parseInt(n[1], 10);
        }
        if (total > 0) return total;
    }
    // ctest: "100% tests passed, 0 tests failed out of 7"
    const ctest = output.match(/out of\s+(\d+)/i);
    if (ctest) return parseInt(ctest[1], 10);
    // Catch2: "All tests passed (N assertions in M test cases)"
    const catch2 = output.match(/in\s+(\d+)\s+test cases?/i);
    if (catch2) return parseInt(catch2[1], 10);
    return 0;
}

// Detect build system
async function detectBuildSystem(projectPath) {
    try {
        const files = await fs.readdir(projectPath);
        
        if (files.includes('CMakeLists.txt')) {
            return 'cmake';
        } else if (files.includes('Makefile') || files.includes('makefile')) {
            return 'make';
        } else if (files.includes('build.ninja')) {
            return 'ninja';
        }
        
        // Default to cmake for C++ projects
        return 'cmake';
    } catch (error) {
        log.warn('Error detecting build system', { error: error.message });
        return 'cmake';
    }
}

// Detect test framework
async function detectTestFramework(projectPath) {
    try {
        const files = await fs.readdir(projectPath, { recursive: true });
        const allFiles = files.join(' ').toLowerCase();
        
        if (allFiles.includes('gtest') || allFiles.includes('googletest')) {
            return 'gtest';
        } else if (allFiles.includes('catch2') || allFiles.includes('catch.hpp')) {
            return 'catch2';
        } else if (allFiles.includes('cppunit')) {
            return 'cppunit';
        }
        
        // Default to gtest
        return 'gtest';
    } catch (error) {
        log.warn('Error detecting test framework', { error: error.message });
        return 'gtest';
    }
}

// API Endpoints

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'cpp-test-executor',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        port: PORT
    });
});

// Get available frameworks
app.get('/frameworks', (req, res) => {
    res.json({
        frameworks: CPP_TOOLS,
        buildSystems: BUILD_SYSTEMS,
        supportedExtensions: ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++', '.c', '.h'],
        features: [
            'unit testing',
            'integration testing', 
            'code coverage',
            'static analysis',
            'memory checking',
            'performance testing'
        ]
    });
});

// Code validation endpoint
app.post('/validate', expensiveRouteLimiter, async (req, res) => {
    try {
        const { code, language = 'cpp' } = req.body;
        
        if (!code) {
            return res.status(400).json({
                success: false,
                error: 'No code provided'
            });
        }

        // fs.writeFile accepts strings and buffers; anything else (object,
        // array, number) throws deep inside fs and surfaces as a 500 that
        // names nothing. Reject it here so the caller learns which field is
        // wrong and what we actually received.
        if (typeof code !== 'string') {
            return res.status(400).json({
                success: false,
                error: `Invalid 'code': expected string, received ${describeType(code)}`
            });
        }

        // Create temporary file for validation
        const tempId = crypto.randomUUID();
        const tempDir = path.join(TEST_WORKSPACE, 'validation', tempId);
        await ensureDirectory(tempDir);
        
        const sourceFile = path.join(tempDir, 'validation.cpp');
        await fs.writeFile(sourceFile, code);

        // Compile to check for syntax errors
        const compileResult = await executeCommand(
            `g++ -std=c++17 -fsyntax-only "${sourceFile}"`,
            { cwd: tempDir, timeout: 30000 }
        );

        // Run static analysis
        const cppcheckResult = await executeCommand(
            `cppcheck --enable=all --inconclusive --xml "${sourceFile}" 2>&1`,
            { cwd: tempDir, timeout: 30000 }
        );

        // Cleanup
        await fs.rm(tempDir, { recursive: true, force: true });

        res.json({
            success: compileResult.success,
            syntaxValid: compileResult.success,
            compilerOutput: compileResult.stderr || compileResult.stdout,
            staticAnalysis: {
                output: cppcheckResult.stdout,
                warnings: cppcheckResult.stderr
            }
        });

    } catch (error) {
        log.error('Code validation error', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Validation failed',
            details: error.message
        });
    }
});

// Main test execution endpoint
app.post('/execute', expensiveRouteLimiter, async (req, res) => {
    const startTime = Date.now();
    const executionId = crypto.randomUUID();
    
    try {
        const {
            code,
            testCode = '',
            testType = 'unit',
            framework = 'gtest',
            buildSystem = 'cmake',
            timeout = 300,
            enableCoverage = false,
            enableStaticAnalysis = false,
            enableMemoryCheck = false
        } = req.body;

        // `buildSystem` and `framework` are caller-supplied and are used as
        // lookup keys / interpolated into the generated CMakeLists.txt, so an
        // unknown or non-string value either blows up with a TypeError (a 500
        // that tells the caller nothing) or reaches cmake as arbitrary text.
        // The supported values are DERIVED from the tables below rather than
        // re-listed, so a new entry can never drift out of the guard.
        // Same contract for `code` itself. `code || ''` further down means a
        // non-string reaches fs.writeFile and 500s with an fs-level message that
        // never names the field. An absent `code` is still allowed here — the
        // empty-source path is pre-existing behaviour and not this guard's business.
        for (const [field, value] of [['code', code], ['testCode', testCode]]) {
            if (value !== undefined && value !== null && typeof value !== 'string') {
                return res.status(400).json({
                    executionId,
                    success: false,
                    error: `Invalid '${field}': expected string, received ${describeType(value)}`,
                    details: 'Source fields must be strings',
                    duration: Date.now() - startTime
                });
            }
        }

        // `typeof === 'string'` FIRST, and it is not redundant: a property key is
        // coerced with String(), so `['cmake']` stringifies to "cmake" and would
        // sail through hasOwnProperty alone — then break downstream as a 500.
        const supportedBuildSystems = Object.keys(BUILD_SYSTEMS);
        if (typeof buildSystem !== 'string'
            || !Object.prototype.hasOwnProperty.call(BUILD_SYSTEMS, buildSystem)) {
            return res.status(400).json({
                executionId,
                success: false,
                error: `Invalid 'buildSystem': ${JSON.stringify(buildSystem)}`,
                details: `Supported build systems: ${supportedBuildSystems.join(', ')}`,
                duration: Date.now() - startTime
            });
        }

        const supportedFrameworks = Object.keys(CPP_TOOLS);
        if (typeof framework !== 'string'
            || !Object.prototype.hasOwnProperty.call(CPP_TOOLS, framework)) {
            return res.status(400).json({
                executionId,
                success: false,
                error: `Invalid 'framework': ${JSON.stringify(framework)}`,
                details: `Supported frameworks: ${supportedFrameworks.join(', ')}`,
                duration: Date.now() - startTime
            });
        }

        log.info('Starting C++ test execution', {
            executionId,
            testType,
            framework,
            buildSystem,
            enableCoverage,
            enableStaticAnalysis,
            enableMemoryCheck
        });

        // Create execution workspace
        const workspaceDir = path.join(TEST_WORKSPACE, executionId);
        const buildDir = path.join(workspaceDir, 'build');
        await ensureDirectory(workspaceDir);
        await ensureDirectory(buildDir);

        // Write source files
        const sourceFile = path.join(workspaceDir, 'main.cpp');
        const testFile = path.join(workspaceDir, 'test.cpp');
        
        await fs.writeFile(sourceFile, code || '');
        if (testCode) {
            await fs.writeFile(testFile, testCode);
        }

        // Build files are rendered by pure functions (see renderCMakeLists /
        // renderMakefile above) so they can be asserted on directly. The
        // workspace is rm -rf'd at the end of every request, so a test cannot
        // inspect what was written; keeping the templates pure is what makes
        // this behaviour gateable at all.
        //
        // `ninja` runs `cmake -GNinja ..`, so it needs the SAME CMakeLists.txt --
        // the old `buildSystem === 'cmake'` guard meant ninja configured against
        // a directory with no CMakeLists in it.
        if (buildSystem === 'cmake' || buildSystem === 'ninja') {
            await fs.writeFile(
                path.join(workspaceDir, 'CMakeLists.txt'),
                renderCMakeLists({ code, testCode, framework, testFile })
            );
        } else if (buildSystem === 'make') {
            // The Makefile goes in buildDir, NOT workspaceDir: every build step
            // runs with `cwd: buildDir` (see Step 2 below), which is also why the
            // sources are referenced as ../main.cpp and ../test.cpp.
            await fs.writeFile(
                path.join(buildDir, 'Makefile'),
                renderMakefile({ code, testCode, framework })
            );
        }

        const results = {
            executionId,
            testType,
            framework,
            buildSystem,
            success: false,
            testsRun: 0,
            noTestsRun: false,
            // Snake_case `no_tests_run` is the `/execute` contract spelling the
            // orchestrator reads (see python/javascript/go). This service only
            // ever emitted camelCase `noTestsRun`, so zero-collection was
            // unreportable to the caller. Both are emitted; camelCase is kept
            // because tests/unit/execute.test.js pins it.
            no_tests_run: false,
            // ⚠️ Zero-collection is NOT always measurable in C++. See
            // describeCppTestCount() and the comment at the test step: on a
            // PASSING `ctest` run the only count available is ctest's own
            // "out of N", which counts registered ctest ENTRIES (always 1
            // here), not test cases. When that is all we have, this flag says
            // so rather than letting `no_tests_run: false` assert a
            // measurement we do not have. An unreportable state reported as a
            // clean run is the defect; this makes the absence visible.
            no_tests_run_unknown: false,
            steps: [],
            coverage: null,
            staticAnalysis: null,
            memoryCheck: null,
            duration: 0
        };

        // Step 1: Configure build system
        if (BUILD_SYSTEMS[buildSystem].configure) {
            const configureResult = await executeCommand(
                BUILD_SYSTEMS[buildSystem].configure,
                { cwd: buildDir, timeout: timeout * 1000 }
            );
            
            results.steps.push({
                name: 'configure',
                success: configureResult.success,
                output: configureResult.stdout,
                errors: configureResult.stderr,
                duration: configureResult.duration
            });

            if (!configureResult.success) {
                results.duration = Date.now() - startTime;
                return res.json(results);
            }
        }

        // Step 2: Build project
        const buildResult = await executeCommand(
            BUILD_SYSTEMS[buildSystem].build,
            { cwd: buildDir, timeout: timeout * 1000 }
        );

        results.steps.push({
            name: 'build',
            success: buildResult.success,
            output: buildResult.stdout,
            errors: buildResult.stderr,
            duration: buildResult.duration
        });

        if (!buildResult.success) {
            results.duration = Date.now() - startTime;
            return res.json(results);
        }

        // Step 3: Run tests
        if (testCode) {
            const testResult = await executeCommand(
                BUILD_SYSTEMS[buildSystem].test,
                { cwd: buildDir, timeout: timeout * 1000 }
            );

            results.steps.push({
                name: 'test',
                success: testResult.success,
                output: testResult.stdout,
                errors: testResult.stderr,
                duration: testResult.duration
            });

            // Tests were supplied and the test command executed. cpp has no
            // single reliable count source across gtest/ctest/catch2, so the
            // count is best-effort/informational and does NOT gate the verdict
            // — the verdict follows whether the test command passed.
            results.testsRun = countCppTests(testResult.stdout);
            results.success = testResult.success;

            // Report zero-collection when -- and ONLY when -- we can actually
            // measure it. `ctest --output-on-failure` gives us nothing but its
            // own entry count on a passing run, so for that shape the honest
            // answer is "unknown", not "false".
            //
            // ⚠️ THE DEFECT THIS GUARDS IS CLOSED IN THIS FILE. The comment
            // that stood here called it a "KNOWN LIVE DEFECT" whose "real fix
            // ... belongs in its own change" -- this IS that change, so read
            // the reasoning, not the status.
            //
            // What was true: `results.success = testResult.success` has no
            // count gate, so testCode that compiles but registers zero TEST()
            // bodies links gtest_main, runs nothing, exits 0, and was graded
            // GREEN.
            //
            // ⭐ Why the obvious gate was NOT the fix, and this still matters:
            // gating on `results.testsRun > 0` is VACUOUS under ctest -- that
            // value is the ENTRY count and reads 1 even for a zero-case suite,
            // so the gate could never fail. The count had to become
            // authoritative before any gate over it could mean anything.
            // Anyone tempted to "simplify" this back to a testsRun check is
            // re-introducing a gate that cannot fail.
            //
            // The fix: ctest is now invoked verbosely (-V), so the child gtest
            // summary survives instead of being suppressed and
            // `describeCppTestCount` can return source:"gtest",
            // authoritative:true. `no_tests_run_unknown` remains the honest
            // answer for the runs where no authoritative count is recoverable
            // -- it is never a pass and never a fail.
            const measurement = describeCppTestCount(testResult.stdout);
            results.no_tests_run =
                measurement.authoritative && measurement.count === 0 && testResult.success;
            results.no_tests_run_unknown = !measurement.authoritative;
            if (results.no_tests_run) {
                // Never a pass: nothing was verified.
                results.success = false;
                results.noTestsRun = true;
            }
        } else {
            // No test_code supplied: the code built, but nothing was verified.
            // Per tournament policy this is NOT a pass.
            results.success = false;
            results.noTestsRun = true;
            // Contract spelling, alongside the camelCase one above.
            results.no_tests_run = true;
            results.steps.push({
                name: 'test',
                success: false,
                output: '',
                errors: 'no tests were run',
                duration: 0
            });
        }

        // Step 4: Code coverage (if enabled)
        if (enableCoverage && results.success) {
            const coverageResult = await executeCommand(
                'lcov --capture --directory . --output-file coverage.info && genhtml coverage.info --output-directory coverage-report',
                { cwd: buildDir, timeout: 60000 }
            );

            results.coverage = {
                success: coverageResult.success,
                output: coverageResult.stdout,
                reportPath: coverageResult.success ? path.join(buildDir, 'coverage-report') : null
            };
        }

        // Step 5: Static analysis (if enabled)
        if (enableStaticAnalysis) {
            const cppcheckResult = await executeCommand(
                `cppcheck --enable=all --xml-version=2 "${workspaceDir}" 2>&1`,
                { cwd: workspaceDir, timeout: 60000 }
            );

            results.staticAnalysis = {
                success: cppcheckResult.success,
                output: cppcheckResult.stdout,
                warnings: cppcheckResult.stderr
            };
        }

        // Step 6: Memory check (if enabled)
        if (enableMemoryCheck && results.success) {
            const executable = path.join(buildDir, 'test_runner');
            const memcheckResult = await executeCommand(
                `valgrind --tool=memcheck --leak-check=full --xml=yes --xml-file=memcheck.xml "${executable}"`,
                { cwd: buildDir, timeout: 120000 }
            );

            results.memoryCheck = {
                success: memcheckResult.success,
                output: memcheckResult.stdout,
                errors: memcheckResult.stderr,
                xmlReport: path.join(buildDir, 'memcheck.xml')
            };
        }

        results.duration = Date.now() - startTime;

        // Cleanup workspace (keep for debugging if failed)
        if (results.success) {
            await fs.rm(workspaceDir, { recursive: true, force: true });
        }

        log.info('C++ test execution completed', { 
            executionId, 
            success: results.success, 
            duration: results.duration 
        });

        res.json(results);

    } catch (error) {
        log.error('Test execution error', { 
            executionId, 
            error: error.message, 
            stack: error.stack 
        });
        
        res.status(500).json({
            executionId,
            success: false,
            error: 'Test execution failed',
            details: error.message,
            duration: Date.now() - startTime
        });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    log.error('Unhandled error', { 
        error: error.message, 
        stack: error.stack,
        url: req.url,
        method: req.method 
    });
    
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        details: error.message
    });
});

// Initialize directories and start server
async function startServer() {
    try {
        await ensureDirectory(TEST_WORKSPACE);
        await ensureDirectory(REPORTS_DIR);
        
        app.listen(PORT, () => {
            log.info('C++ Test Execution Service started', { 
                port: PORT,
                workspace: TEST_WORKSPACE,
                reports: REPORTS_DIR,
                timeout: EXECUTION_TIMEOUT / 1000 + 's'
            });
        });
    } catch (error) {
        log.error('Failed to start server', { error: error.message });
        process.exit(1);
    }
}

// Handle graceful shutdown
installGracefulShutdown({ log });

// Start the server only when run directly
if (require.main === module) {
    startServer();
}

// Export for testing
module.exports = {
    app,
    ensureDirectory,
    executeCommand,
    detectBuildSystem,
    detectTestFramework,
    // Exported so the generated build files can be asserted on directly. The
    // request handler rm -rf's its workspace before returning, so rendering has
    // to be pure and separately reachable for this behaviour to be gateable.
    codeDefinesMain,
    renderCMakeLists,
    renderMakefile,
    stripBlockComments,
    stripLineComments,
    stripStringLiterals,
    stripCharLiterals,
    // Exported so the "is this count authoritative?" rule is assertable on its
    // own. The blind spot it encodes is the point of the whole change.
    describeCppTestCount,
    CPP_TOOLS,
    BUILD_SYSTEMS,
    startServer
};
