/* eslint-disable @typescript-eslint/no-require-imports */
// Test worker for the synckit channel-poisoning regression spec: echoes the
// requested delay after sleeping for it, so a call can outlive the timeout.
const { runAsWorker } = require('synckit');

runAsWorker(
  (ms) => new Promise((resolve) => setTimeout(() => resolve(ms), ms)),
);
