const {
    codeDefinesMain,
    stripBlockComments,
    stripLineComments,
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
