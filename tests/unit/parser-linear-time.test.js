const {
    codeDefinesMain,
    stripBlockComments,
    stripLineComments,
    stripStringLiterals,
    stripCharLiterals,
} = require('../../src/cpp_test_service');

// Regression tests for alert js/polynomial-redos on codeDefinesMain's comment
// stripping (src/cpp_test_service.js): the block-comment regex re-scanned the
// suffix for a closing star-slash from every opening start, so the alert's
// named shape ('/*' followed by many 'a/*' repetitions) is quadratic. The
// explicit budget is deliberately loose so a loaded CI box cannot flake; the
// linear scanner finishes this input in milliseconds.
const LINEAR_TIME_BUDGET_MS = 2000;

function measure(fn) {
    const started = process.hrtime.bigint();
    const value = fn();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    return { value, elapsedMs };
}

describe('codeDefinesMain comment stripping is linear (js/polynomial-redos regression)', () => {
    test("unterminated '/*' followed by many 'a/*' repetitions", () => {
        const code = `/*${'a/*'.repeat(60000)}`; // ~180 KB
        const { value, elapsedMs } = measure(() => codeDefinesMain(code));

        expect(elapsedMs).toBeLessThan(LINEAR_TIME_BUDGET_MS);
        expect(value).toBe(false);
    });

    test('many complete block comments followed by a definition', () => {
        const code = `${'/* x */'.repeat(20000)}int main() { return 0; }`;
        const { value, elapsedMs } = measure(() => codeDefinesMain(code));

        expect(elapsedMs).toBeLessThan(LINEAR_TIME_BUDGET_MS);
        expect(value).toBe(true);
    });
});

describe('comment stripping preserves the old regex semantics', () => {
    test.each([
        ['a/*b*/c', 'a c'],
        ['a/*b*/c/*d*/e', 'a c e'],
        ['a/*b', 'a/*b'], // unterminated: the old regex left it alone
        ['a/**/b', 'a b'],
        ['a/b*c', 'a/b*c'],
    ])('stripBlockComments(%j) -> %j', (input, expected) => {
        expect(stripBlockComments(input)).toBe(expected);
    });

    test.each([
        ['a//b\nc', 'a \nc'],
        ['a//b', 'a '],
        ['a//b\r\nc', 'a \nc'], // [^\n] consumed the CR
        ['a/b/c', 'a/b/c'],
        ['//only', ' '],
    ])('stripLineComments(%j) -> %j', (input, expected) => {
        expect(stripLineComments(input)).toBe(expected);
    });
});

describe('codeDefinesMain semantics preserved by the linear scan', () => {
    test.each([
        ['int main() { return 0; }', true],
        ['int main(void) { }', true],
        ['auto main() -> int { return 0; }', true],
        ['int main ( )\n{', true],
        ['int main();', false], // declaration, not definition
        ['// int main() {}\nint f();', false],
        ['/* int main() {} */ int f();', false],
        ['int f() { return 0; } // main() {}', false],
        ['const char* s = "int main() {}";', false],
        ["char c = '{'; int f();", false],
        ['domain() {}', false], // \w boundary
        ['::main() {}', false], // ':' boundary
        ['/* unterminated comment with main() {}', true] // old regex left it, so main() is seen
    ])('codeDefinesMain(%j) -> %s', (code, expected) => {
        expect(codeDefinesMain(code)).toBe(expected);
    });
});

describe('quoted-literal stripping is linear (js/polynomial-redos regression)', () => {
    // The alert's exact shape: '"' followed by many '\"' repetitions. With no
    // closing quote the old regex restarted at every escaped quote and re-read
    // the suffix; with one it consumed the run in a single pass.
    test("'\"' followed by many '\\\"' repetitions with no closing quote", () => {
        const code = `"${'\\"'.repeat(200000)}`;
        const { value, elapsedMs } = measure(() => stripStringLiterals(code));

        expect(elapsedMs).toBeLessThan(LINEAR_TIME_BUDGET_MS);
        expect(value).toBe(code);
    });

    test("'\"' followed by many '\\\"' repetitions and a closing quote", () => {
        const code = `"${'\\"'.repeat(200000)}"`;
        const { value, elapsedMs } = measure(() => stripStringLiterals(code));

        expect(elapsedMs).toBeLessThan(LINEAR_TIME_BUDGET_MS);
        expect(value).toBe('""');
    });

    test('a long backslash run with no closing quote', () => {
        const code = `"${'\\'.repeat(200000)}`;
        const { value, elapsedMs } = measure(() => stripStringLiterals(code));

        expect(elapsedMs).toBeLessThan(LINEAR_TIME_BUDGET_MS);
        expect(value).toBe(code);
    });

    test('codeDefinesMain on an adversarial escaped-quote literal stays linear', () => {
        const code = `const char* main_s = "${'\\"'.repeat(200000)}`;
        const { value, elapsedMs } = measure(() => codeDefinesMain(code));

        expect(elapsedMs).toBeLessThan(LINEAR_TIME_BUDGET_MS);
        expect(value).toBe(false);
    });
});

describe('quoted-literal stripping preserves the old regex semantics', () => {
    test.each([
        ['a"b"c', 'a""c'],
        ['a"b"c"d"e', 'a""c""e'],
        ['a"b', 'a"b'], // unterminated: unchanged
        [String.raw`"a\"b"`, '""'], // escaped quote is part of the literal
        [String.raw`"a\\"b"`, '""b"'], // escaped backslash, then a real close
        ['"a\\\nb"', '"a\\\nb"'], // backslash + newline is not an escape pair
        ['a/b', 'a/b'],
    ])('stripStringLiterals(%j) -> %j', (input, expected) => {
        expect(stripStringLiterals(input)).toBe(expected);
    });

    test.each([
        ["a'x'y", "a''y"],
        ["'x", "'x"], // unterminated
        [String.raw`'\''`, "''"], // escaped quote is part of the literal
        ["a/b", 'a/b'],
    ])('stripCharLiterals(%j) -> %j', (input, expected) => {
        expect(stripCharLiterals(input)).toBe(expected);
    });
});
