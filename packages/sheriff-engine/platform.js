'use strict';

function nativeTriple({
  platform = process.platform,
  arch = process.arch,
  report = process.report,
} = {}) {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return `darwin-${arch}`;
  }
  if (platform === 'win32' && arch === 'x64') {
    return 'win32-x64-msvc';
  }
  if (platform === 'linux' && (arch === 'arm64' || arch === 'x64')) {
    let header;
    try {
      header = report?.getReport?.().header;
    } catch (error) {
      throw new Error(
        `Could not inspect the Node process report to detect libc for linux-${arch}.`,
        { cause: error },
      );
    }
    if (!header) {
      throw new Error(
        `Could not detect libc for linux-${arch}: process.report is unavailable.`,
      );
    }
    return `linux-${arch}-${header.glibcVersionRuntime ? 'gnu' : 'musl'}`;
  }
  throw new Error(
    `Unsupported Sheriff native platform triple: ${platform}-${arch}. ` +
      'Supported triples are darwin-arm64, darwin-x64, linux-x64-gnu, ' +
      'linux-x64-musl, linux-arm64-gnu, linux-arm64-musl, and win32-x64-msvc.',
  );
}

function nativeBinaryName(options) {
  return `sheriff-engine.${nativeTriple(options)}.node`;
}

module.exports = { nativeBinaryName, nativeTriple };
