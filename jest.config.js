/** @type {import('jest').Config} */
export default {
    testMatch: ['**/tests/**/*.test.js'],
    testEnvironment: 'node',
    transform: {},
    // Guards against --runInBand / --maxWorkers=1 -- see roadmap card 39e02f07
    // and tests/guards/no-single-worker.globalSetup.js for why.
    globalSetup: '<rootDir>/tests/guards/no-single-worker.globalSetup.js',
};
