# cpp-test-executor

Sandboxed C++ test execution service for the code_graph_helper platform. Accepts C++ source code and test code over HTTP, compiles and runs them inside the container using the requested build system and test framework, and returns structured results including build output, test results, code coverage, static analysis, and memory checking.

This is one of seven language-specific test executor sidecars. The `coding-testing` service (port 8689) dispatches test execution requests to it and aggregates results.

## Port: 8094

## Architecture

Single-file Express.js server (`src/cpp_test_service.js`) running inside a Debian container that has the full C++ toolchain pre-installed. Each execution request gets its own temporary workspace directory under `/app/test_workspace`, runs through configure/build/test steps, and cleans up on success (preserves workspace on failure for debugging).

### Pre-installed Tools

| Category | Tools |
|----------|-------|
| Compilers | gcc, g++, clang |
| Build systems | cmake, make, ninja |
| Test frameworks | Google Test (GTest), Catch2, CppUnit |
| Static analysis | cppcheck, clang-tidy, clang-format |
| Memory checking | valgrind |
| Coverage | lcov, gcovr |

## API

### `GET /health`

Health check. Returns service name, version, timestamp, port.

**Response:**
```json
{
  "status": "healthy",
  "service": "cpp-test-executor",
  "version": "1.0.0",
  "timestamp": "2026-03-10T12:00:00.000Z",
  "port": 8094
}
```

### `GET /frameworks`

Lists available test frameworks, build systems, supported file extensions, and feature capabilities.

**Response:**
```json
{
  "frameworks": { "gtest": {...}, "catch2": {...}, "cppunit": {...} },
  "buildSystems": { "cmake": {...}, "make": {...}, "ninja": {...} },
  "supportedExtensions": [".cpp", ".cc", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".h++", ".c", ".h"],
  "features": ["unit testing", "integration testing", "code coverage", "static analysis", "memory checking", "performance testing"]
}
```

### `POST /validate`

Syntax-checks C++ code (compiles with `-fsyntax-only`) and runs cppcheck static analysis without executing anything.

**Request body:**
```json
{
  "code": "#include <iostream>\nint main() { ... }",
  "language": "cpp"
}
```

**Response:**
```json
{
  "success": true,
  "syntaxValid": true,
  "compilerOutput": "",
  "staticAnalysis": {
    "output": "...",
    "warnings": "..."
  }
}
```

### `POST /execute`

Main endpoint. Writes source and test files to a temp workspace, generates a build file, configures, builds, runs tests, and optionally runs coverage/static analysis/memory checks.

**Build file generation.** `cmake` and `ninja` both get a `CMakeLists.txt` (ninja configures with `cmake -GNinja ..`, so it needs the same file); `make` gets a `Makefile` written into the build dir, which is why its rules reference `../main.cpp`.

**How your `code` is treated depends on whether it defines `main()`:**

| `code` | build shape |
|---|---|
| no `main()` (the normal case for unit tests) | compiled into a static library and **linked into the test binary**, so your test can call anything it defines |
| defines `main()` | built as a standalone program and deliberately **not** linked into the test binary — the test framework supplies its own `main()`, and linking both is a duplicate-symbol error. A test in this mode must be self-contained. |

Detection ignores `main(` appearing in comments and string literals, and treats a forward declaration (`int main();`) as *not* a definition. A `main()` inside `#if 0` is not detected as disabled — that would need a preprocessor.

**Request body:**
```json
{
  "code": "// source code",
  "testCode": "// test code (GTest, Catch2, or CppUnit)",
  "testType": "unit",
  "framework": "gtest",
  "buildSystem": "cmake",
  "timeout": 300,
  "enableCoverage": false,
  "enableStaticAnalysis": false,
  "enableMemoryCheck": false
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `code` | string | required | Source code to compile |
| `testCode` | string | `""` | Test code; if empty, only compilation is verified |
| `testType` | string | `"unit"` | Label only (unit, integration, etc.) |
| `framework` | string | `"gtest"` | `gtest`, `catch2`, or `cppunit` |
| `buildSystem` | string | `"cmake"` | `cmake`, `make`, or `ninja` |
| `timeout` | number | `300` | Per-step timeout in seconds |
| `enableCoverage` | bool | `false` | Run lcov/genhtml after tests pass |
| `enableStaticAnalysis` | bool | `false` | Run cppcheck on workspace |
| `enableMemoryCheck` | bool | `false` | Run valgrind on test binary |

**Response:**
```json
{
  "executionId": "uuid",
  "testType": "unit",
  "framework": "gtest",
  "buildSystem": "cmake",
  "success": true,
  "steps": [
    { "name": "configure", "success": true, "output": "...", "errors": "...", "duration": 1234 },
    { "name": "build", "success": true, "output": "...", "errors": "...", "duration": 5678 },
    { "name": "test", "success": true, "output": "...", "errors": "...", "duration": 910 }
  ],
  "coverage": null,
  "staticAnalysis": null,
  "memoryCheck": null,
  "duration": 7822
}
```

Execution stops early if configure or build fails -- subsequent steps are skipped and `success` is `false`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8094` | Listen port |
| `CPP_TEST_PORT` | `8094` | Alternate port variable (fallback) |
| `EXECUTION_TIMEOUT` | `300` | Default per-step timeout in seconds |
| `TEST_WORKSPACE` | `/app/test_workspace` | Temp directory for build workspaces |
| `REPORTS_DIR` | `/app/reports` | Directory for generated reports |

## Dependencies

- **Upstream caller:** `coding-testing` (port 8689) sends requests to `http://cpp-test-executor:8094/execute` via `HttpTestRunner`
- **No downstream dependencies** -- this service only shells out to local compiler/test tools
- **Node.js packages:** express, uuid (see `src/package.json`)

## Running

```bash
# Standalone via docker-compose
docker compose up -d

# As part of the full platform (from code_graph_helper root)
docker compose up -d cpp-test-executor
```

## CI/CD

GitHub Actions on `nonagenticai/cpp-test-executor`, via the public `ci-workflows` archetype on GitHub-hosted runners. On every PR and on `main`:
1. Secret scan and private-infrastructure scan
2. `npm ci`, eslint, the jest suite
3. Image build and a `/health` smoke against it
4. From `main`: push `sha-<commit>` + `latest` to `ghcr.io/nonagenticai/cpp-test-executor` with a SLSA provenance attestation

There is no deploy job: this service is retired from the estate's cluster, and the repository is published so its tests, image build and job contract stay reproducible.
