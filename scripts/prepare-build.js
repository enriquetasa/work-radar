'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validatePublishableKey } = require('../sync/key-validation');

function releaseConfig(env) {
  const url = (env.WORK_RADAR_RELEASE_SUPABASE_URL || '').trim();
  const key = (env.WORK_RADAR_RELEASE_SUPABASE_KEY || '').trim();
  if (!url && !key && env.WORK_RADAR_REQUIRE_SYNC !== '1') return {};
  if (!url || !key) {
    throw new Error(
      'Set both WORK_RADAR_RELEASE_SUPABASE_URL and WORK_RADAR_RELEASE_SUPABASE_KEY.'
    );
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('The release Supabase URL must be a valid HTTPS origin.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      'The release Supabase URL must be an HTTPS origin without credentials or a path.'
    );
  }
  const validation = validatePublishableKey(key);
  // Do not echo validation details: a malformed JWT role can contain user input.
  if (!validation.ok)
    throw new Error('Release builds require a publishable or anon key, never a secret key.');
  return { url: parsed.origin, publishableKey: validation.key };
}

function writeReleaseConfig(projectDir, env = process.env) {
  const target = path.join(projectDir, 'build', 'release-sync-config.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Remove stale configuration even when the next build fails validation.
  fs.rmSync(target, { force: true });
  const config = releaseConfig(env);
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

module.exports = async function prepareBuild(context) {
  const projectDir = context.packager.projectDir;
  const config = writeReleaseConfig(projectDir);
  execFileSync(process.execPath, [path.join(projectDir, 'scripts', 'make-icon.js')], {
    cwd: projectDir,
    stdio: 'inherit',
  });
  console.log(
    config.url
      ? 'Packaging with cloud sync configured.'
      : 'Packaging without bundled sync configuration.'
  );
};
module.exports.releaseConfig = releaseConfig;
module.exports.writeReleaseConfig = writeReleaseConfig;
