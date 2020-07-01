const execa = require('execa');
const tempy = require('tempy');
const cpy = require('cpy');
const path = require('path');
const packageJson = require('../package');
const globby = require('globby');
const fs = require('fs');
const _ = require('lodash');

test('git-find-files-not-modified-on-feature-branch', async () => {
  const testDir = await tempy.dir();
  await cpy(path.join('__fixtures__', '**', '*.*'), testDir, {dot: true});
  await execa('mv', path.join(testDir, 'git'), path.join(testDir, '.git'));

  const binPath = path.resolve(__dirname, '..', packageJson.bin['git-find-files-not-modified-on-feature-branch']);

  await execa(binPath, [
    '--compareBranch', 'compare',
    '--baseBranch', 'base',
    '--dry', 'false'
  ], {cwd: testDir});

  const filePaths = await globby(path.join(testDir, '**', '*.*'));
  const fileContents = _(filePaths)
    .map(filePath => [filePath, fs.readFileSync(filePath, 'utf8')])
    .fromPairs()
    .value();

  expect(fileContents).toMatchSnapshot();
});