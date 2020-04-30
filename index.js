#! /usr/bin/env node

const execa = require('execa');
const _ = require('lodash');
const pProps = require('p-props');
const chalk = require('chalk');

require('hard-rejection/register');

const execGit = async (...args) => (await execa('git', args)).stdout;

async function main() {
  const status = await execGit('status', '--porcelain');
  const lineRegex = /([A-Z][A-Z]?)\s+(.*)/;

  const currentRef = await execGit('rev-parse', '--abbrev-ref', 'HEAD');
  const mergeBase = await execGit('merge-base', currentRef, 'master');

  const conflicts = _.compact(await Promise.all(status
    .split('\n')
    .map(line => {
      const [, modificationCode, filePath] = lineRegex.exec(line);
      return {modificationCode, filePath};
    })
    .filter(({modificationCode}) => modificationCode.length === 2)
    .map(async conflictedFile => {
      const culpritStdout = await execGit(
        'log', 'master', '--format=%H', `${mergeBase}..origin/master`, '--', conflictedFile.filePath);

      if (!culpritStdout) {
        return null;
      }

      const culprits = culpritStdout.split('\n');

      return {
        ...conflictedFile,
        culprits
      };
    })));

  const culpritCommits = await pProps(_(conflicts)
    .map(({culprits, ...rest}) => culprits.map(culprit => ({culprit, ...rest})))
    .flatten()
    .groupBy('culprit')
    .mapValues(async (conflicts, culprit) => {
      const separator = '|';
      const culpritStdout = await execGit('show', culprit, '--quiet', `--format=%ce${separator}%s`);
      const [email, subject] = culpritStdout.split(separator);
      return {
        email, 
        subject,
        conflicts
      };
    })
    .value());

  _.forEach(culpritCommits, ({conflicts, email, subject}, culprit) => {
    console.log(`${chalk.cyan(culprit)} ${chalk.green(email)} ${chalk.red(subject)}`);
    conflicts.forEach(({filePath, modificationCode}) => {
      console.log(`\t* ${chalk.magenta(modificationCode)} ${chalk.yellow(filePath)}`);
    });
  });
}

main();