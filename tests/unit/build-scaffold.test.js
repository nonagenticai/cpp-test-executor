/**
 * Tests for the generated build files (CMakeLists.txt / Makefile).
 *
 * WHY THIS FILE EXISTS
 *
 * A live probe of the deployed service showed that /execute could not run the
 * one thing this service is for. Sending library-style code plus a gtest that
 * calls it produced:
 *
 *   /usr/bin/ld: CMakeFiles/test_runner.dir/test.cpp.o: in function
 *   `AddTest_Works_Test::TestBody()': undefined reference to `add(int, int)'
 *   /usr/bin/ld: Scrt1.o: in function `_start': undefined reference to `main'
 *
 * because the template built `test_runner` from test.cpp alone -- the submitted
 * code's translation unit was never on the link line -- and always emitted
 * `add_executable(main main.cpp)`, which requires a main() the code does not have.
 *
 * The existing suite could not catch this: tests/unit/execute.test.js mocks
 * child_process.spawn wholesale, so no compiler ever runs and a fabricated
 * exit code 0 is asserted as success. It uses essentially the same payload that
 * fails in production and reports green.
 *
 * These tests assert on the RENDERED BUILD FILE instead, which is the artifact
 * that was wrong. They need no compiler, so they run anywhere -- deliberately
 * not `it.skip`-guarded on toolchain availability, since a test that silently
 * skips is a test that proves nothing.
 */

const {
    codeDefinesMain,
    renderCMakeLists,
    renderMakefile,
} = require('../../src/cpp_test_service');

const LIB_CODE = 'int add(int a, int b) { return a + b; }';
const MAIN_CODE = 'int add(int a,int b){return a+b;}\nint main(){ return add(1,1) == 2 ? 0 : 1; }';
const GTEST = '#include <gtest/gtest.h>\nint add(int,int);\nTEST(AddTest, Works){ EXPECT_EQ(add(2,2),4); }';
const TEST_FILE = '/app/test_workspace/abc/test.cpp';

describe('codeDefinesMain', () => {
    it('is false for a plain library function', () => {
        expect(codeDefinesMain(LIB_CODE)).toBe(false);
    });

    it('is true when main() is defined', () => {
        expect(codeDefinesMain(MAIN_CODE)).toBe(true);
    });

    it('is false for empty or missing code', () => {
        expect(codeDefinesMain('')).toBe(false);
        expect(codeDefinesMain(undefined)).toBe(false);
    });

    it('does not mistake a substring like domain() for main()', () => {
        expect(codeDefinesMain('int domain(int x){return x;}')).toBe(false);
    });

    // Every case below was a FALSE POSITIVE in the first implementation, which
    // matched `main(` anywhere in the raw text. Each one made the generator emit
    // `add_executable(main main.cpp)` for a file with no entry point -- i.e. it
    // reintroduced the exact `undefined reference to 'main'` this code exists to
    // prevent, and on the make path also dropped code_under_test.o from the link.
    it('ignores main() mentioned in a line comment', () => {
        expect(codeDefinesMain('// Helpers extracted from main() in app.cpp\nint add(int a,int b){return a+b;}')).toBe(false);
    });

    it('ignores main() mentioned in a block comment', () => {
        expect(codeDefinesMain('/* was int main() { ... } */\nint add(int a,int b){return a+b;}')).toBe(false);
    });

    it('ignores main( inside a string literal', () => {
        expect(codeDefinesMain('#include <string>\nstd::string s = "main(";')).toBe(false);
    });

    it('treats a forward declaration as NOT a definition', () => {
        // `int main();` links exactly like having no main at all.
        expect(codeDefinesMain('int main();\nint add(int a,int b){return a+b;}')).toBe(false);
    });

    it('still detects a real main() with arguments and a body', () => {
        expect(codeDefinesMain('int main(int argc, char** argv) { return 0; }')).toBe(true);
    });

    it('detects a real main() with the brace on the next line', () => {
        expect(codeDefinesMain('int main()\n{\n    return 0;\n}')).toBe(true);
    });
});

describe('renderCMakeLists — library-style code (the broken case)', () => {
    const cmake = renderCMakeLists({
        code: LIB_CODE, testCode: GTEST, framework: 'gtest', testFile: TEST_FILE,
    });

    it('builds the submitted code as a linkable library', () => {
        expect(cmake).toContain('add_library(code_under_test STATIC main.cpp)');
    });

    // THE regression assertion. Without this link line the test binary cannot
    // resolve anything the submitted code defines.
    it('links the code under test into test_runner', () => {
        expect(cmake).toContain('target_link_libraries(test_runner code_under_test)');
    });

    it('does NOT build a main executable, which would demand a main() the code lacks', () => {
        expect(cmake).not.toContain('add_executable(main main.cpp)');
    });

    it('still links the gtest framework', () => {
        expect(cmake).toContain('target_link_libraries(test_runner GTest::GTest GTest::Main Threads::Threads)');
    });

    it('registers the test with ctest', () => {
        expect(cmake).toContain('add_test(NAME unit_tests COMMAND test_runner)');
    });
});

describe('renderCMakeLists — code that carries its own main()', () => {
    const cmake = renderCMakeLists({
        code: MAIN_CODE, testCode: GTEST, framework: 'gtest', testFile: TEST_FILE,
    });

    it('builds it as a program', () => {
        expect(cmake).toContain('add_executable(main main.cpp)');
    });

    // Linking it in as well would collide with the framework's own main().
    it('does not also build it as a library', () => {
        expect(cmake).not.toContain('add_library(code_under_test STATIC main.cpp)');
    });
});

describe('renderCMakeLists — framework selection', () => {
    it('links Catch2 when requested', () => {
        const cmake = renderCMakeLists({
            code: LIB_CODE, testCode: GTEST, framework: 'catch2', testFile: TEST_FILE,
        });
        expect(cmake).toContain('"catch2" STREQUAL "catch2"');
        expect(cmake).toContain('target_link_libraries(test_runner Catch2::Catch2 Threads::Threads)');
    });
});

describe('renderMakefile', () => {
    const mk = renderMakefile({ code: LIB_CODE, testCode: GTEST, framework: 'gtest' });

    // Build steps run with cwd=<workspace>/build, so a bare `main.cpp` would
    // not resolve.
    it('references sources one level up, matching the build cwd', () => {
        expect(mk).toContain('../main.cpp');
        expect(mk).toContain('../test.cpp');
    });

    it('links the code under test into test_runner', () => {
        expect(mk).toContain('test_runner: ../test.cpp code_under_test.o');
    });

    it('provides the targets BUILD_SYSTEMS.make actually invokes', () => {
        // BUILD_SYSTEMS.make runs `make -j$(nproc)` then `make test`.
        expect(mk).toMatch(/^all:/m);
        expect(mk).toMatch(/^test:/m);
    });

    it('uses tab-indented recipes, or make rejects the file', () => {
        const recipeLines = mk.split('\n').filter((l) => l.startsWith('\t'));
        expect(recipeLines.length).toBeGreaterThan(0);
        expect(mk).not.toMatch(/^ {4}\$\(CXX\)/m);
    });

    it('omits the object dependency when the code has its own main()', () => {
        const withMain = renderMakefile({ code: MAIN_CODE, testCode: GTEST, framework: 'gtest' });
        expect(withMain).toContain('test_runner: ../test.cpp\n');
        expect(withMain).not.toContain('test_runner: ../test.cpp code_under_test.o');
    });
});

describe('renderMakefile / renderCMakeLists — parity between build systems', () => {
    // These two render paths are handed identical input by /execute, so a
    // disagreement means the same submission passes under one buildSystem and
    // fails under the other.
    it('make builds every target cmake would, not just test_runner', () => {
        // `cmake --build .` builds ALL targets. Listing only test_runner meant a
        // broken `main` failed under cmake and passed under make.
        const withMain = renderMakefile({ code: MAIN_CODE, testCode: GTEST, framework: 'gtest' });
        expect(withMain).toMatch(/^all:.*\bmain\b/m);
        expect(withMain).toMatch(/^all:.*\btest_runner\b/m);

        const libOnly = renderMakefile({ code: LIB_CODE, testCode: GTEST, framework: 'gtest' });
        expect(libOnly).toMatch(/^all:.*\bcode_under_test\.o\b/m);
        expect(libOnly).not.toMatch(/^all:.*\bmain\b/m);
    });

    it('make FAILS with no test code, matching ctest exit 8', () => {
        const mk = renderMakefile({ code: LIB_CODE, testCode: '', framework: 'gtest' });
        // Previously: `@echo "no test code supplied"` then exit 0 — a green run
        // that executed nothing, while cmake went red on the same input.
        expect(mk).toMatch(/^\texit 1$|@exit 1/m);
        expect(mk).not.toMatch(/^\t@echo "no test code supplied"$/m);
    });

    it('links cppunit rather than silently falling back to gtest', () => {
        const mk = renderMakefile({ code: LIB_CODE, testCode: GTEST, framework: 'cppunit' });
        expect(mk).toContain('-lcppunit');
        expect(mk).not.toContain('-lgtest');
    });

    it('cmake has a cppunit branch and fails loudly on an unknown framework', () => {
        const cmake = renderCMakeLists({
            code: LIB_CODE, testCode: GTEST, framework: 'cppunit', testFile: TEST_FILE,
        });
        expect(cmake).toContain('target_link_libraries(test_runner cppunit');
        // Without an else, an unmatched framework linked NOTHING and died on a
        // wall of undefined symbols instead of naming the cause.
        expect(cmake).toContain('FATAL_ERROR');
    });

    it('both paths link a threading library for gtest', () => {
        const cmake = renderCMakeLists({
            code: LIB_CODE, testCode: GTEST, framework: 'gtest', testFile: TEST_FILE,
        });
        const mk = renderMakefile({ code: LIB_CODE, testCode: GTEST, framework: 'gtest' });
        expect(cmake).toContain('Threads::Threads');
        expect(mk).toContain('-pthread');
    });
});
