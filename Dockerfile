# syntax=docker/dockerfile:1.7
#
# C++ Test Executor — ONE image, two stages.
#
# This was a two-image chain: Dockerfile.base built `cpp-test-executor-base` into the estate's
# private registry and the app pinned it by digest. For the public repository the chain is folded
# into a single build — `toolchain` is the old base (Debian 12 + the compilers, CMake, test
# frameworks and node), `app` is the service. One artefact to publish, nothing to pin.
FROM docker.io/library/debian:12-slim AS toolchain

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget ca-certificates gnupg \
    gcc g++ clang cmake make ninja-build \
    libgtest-dev catch2 libcppunit-dev \
    cppcheck clang-tidy clang-format \
    valgrind lcov gcovr git \
    && rm -rf /var/lib/apt/lists/*

# Debian 12's apt nodejs is v18; the service declares engines >=22.
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# libgtest-dev ships SOURCES only — without this there is no libgtest.a to link
# against, and every generated CMakeLists/Makefile that references gtest fails
# at link time rather than at configure time.
RUN cd /usr/src/googletest && \
    cmake -B build && \
    cmake --build build && \
    cmake --install build

# ── Application ──────────────────────────────────────────────────────────────
FROM toolchain AS app


RUN mkdir -p /app/test_services /app/test_workspace /app/reports /app/config

WORKDIR /app/test_services

COPY src/package.json src/package-lock.json /app/test_services/
COPY src/cpp_test_service.js src/common.js /app/test_services/

RUN npm ci && npm cache clean --force

EXPOSE 8094

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:8094/health || exit 1

CMD ["node", "cpp_test_service.js"]
