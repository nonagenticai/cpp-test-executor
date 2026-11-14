const path = require('path');

module.exports = {
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  testEnvironment: 'node',
  setupFilesAfterEnv: [path.join(__dirname, 'tests', 'setup-tenant-header.cjs')],
  modulePaths: [path.join(__dirname, 'src', 'node_modules')],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/node_modules/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov'],
  verbose: true,
};
