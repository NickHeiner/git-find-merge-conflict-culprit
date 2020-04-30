#! /usr/bin/env node

const execa = require('execa');
const _ = require('lodash');

const execGit = async (...args) => (await execa('git', args)).stdout;

async function main() {
  const status = await execGit('status', '--porcelain');
  const lineRegex = /([A-Z][A-Z]?)\s+(.*)/;

  const currentRef = await execGit('rev-parse', '--abbrev-ref', 'HEAD');
  const mergeBase = await execGit('merge-base', currentRef, 'master');

  const conflicts = await Promise.all(status
    .split('\n')
    .map(line => {
      const [, modificationCode, filePath] = lineRegex.exec(line);
      return {modificationCode, filePath};
    })
    .filter(({modificationCode}) => modificationCode.length === 2)
    .map(async conflictedFile => {
      const culpritStdout = await execGit(
        'log', 'master', '--format=%H',`${mergeBase}..origin/master`, '--', conflictedFile.filePath);

      const culprits = culpritStdout.split('\n');

      return {
        ...conflictedFile,
        culprits
      }
    }));

  const culpritCommits = _(conflicts)
    .map(({culprits, ...rest}) => culprits.map(culprit => ({culprit, ...rest})))
    .flatten()
    .groupBy('culprit')
    .mapValues(async (conflicts, culprit) => {
      const separator = '|';
      const culpritStdout = await execGit('show', culprit, '--quiet', `--format=%ce${separator}%s`)
      const [email, subject] = culpritStdout.split(separator);
      return {
        email, 
        subject,
        conflicts
      }
    })
    .value();
  
  console.log(culpritCommits);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});