const execa = require('execa');
const tempy = require('tempy');
const cpy = require('cpy');
const path = require('path');
const packageJson = require('../package');
const globby = require('globby');
const fs = require('fs');
const _ = require('lodash');
const log = require('nth-log');

test('git-find-files-not-modified-on-feature-branch', async () => {
  const testDir = await tempy.directory();

  log.debug({testDir}, 'Created test directory');

  await cpy('', testDir, {
    cwd: path.join(__dirname, '__fixtures__'),
    parents: true
  });
  await execa('mv', ['git', '.git'], {cwd: testDir});

  const binPath = path.resolve(__dirname, '..', packageJson.bin['git-find-files-not-modified-on-feature-branch']);

  await execa(binPath, [
    '--compareBranch', 'compare',
    '--baseBranch', 'base',
    '--dry', 'false'
  ], {cwd: testDir});

  const filePaths = await globby(path.join('**', '*.*'), {cwd: testDir});
  const fileContents = _(filePaths)
    .map(filePath => [filePath, fs.readFileSync(path.join(testDir, filePath), 'utf8')])
    .fromPairs()
    .value();

  expect(fileContents).toMatchSnapshot();
});