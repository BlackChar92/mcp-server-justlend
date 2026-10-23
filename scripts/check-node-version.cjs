// Match the exact Node.js release declared in package.json.
function isSupportedNodeVersion(version) {
  return version === '24.22.1' || version === 'v24.22.1';
}

module.exports = { isSupportedNodeVersion };

if (require.main === module && !isSupportedNodeVersion(process.version)) {
  console.error(`Node.js 24.22.1 is required; current version: ${process.version}.`);
  process.exitCode = 1;
}
