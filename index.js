#! /usr/bin/env node

const fs = require('fs');
const execa = require('execa');
const _ = require('lodash');
const pProps = require('p-props');
const chalk = require('chalk');
const findUp = require('find-up');
const path = require('path');

require('hard-rejection/register');

const execGit = async (...args) => (await execa('git', args)).stdout;

const getMergeHead = async () => {
  const gitDir = await findUp('.git', {type: 'directory'});
  const mergeHeadPath = path.join(gitDir, 'MERGE_HEAD');
  try {
    return fs.readFileSync(mergeHeadPath, 'utf-8').trim();
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log(`There is no merge in progress, because "${mergeHeadPath}" is missing.`);
      return;
    }
    throw e;
  }
};

async function main() {
  const status = await execGit('status', '--porcelain');
  const lineRegex = /([A-Z][A-Z]?)\s+(.*)/;

  const currentRef = await execGit('rev-parse', '--abbrev-ref', 'HEAD');
  const mergeBase = await execGit('merge-base', currentRef, 'master');
  const mergeHead = await getMergeHead();
  if (!mergeHead) {
    process.exit(1);
  }

  const conflicts = _.compact(await Promise.all(_(status)
    .split('\n')
    .reject(line => line.startsWith('??'))
    .map(line => {
      const match = lineRegex.exec(line);
      if (!match) {
        const err = new Error(`A line from "git status --porcelain" didn't match the line-parsing regex: "${line}"`);
        Object.assign(err, {line, lineRegex});
        throw err;
      }

      const [, modificationCode, filePath] = match;
      return {modificationCode, filePath};
    })
    .filter(({modificationCode}) => modificationCode.length === 2)
    .map(async conflictedFile => {
      const culpritStdout = await execGit(
        'log', '--format=%h', `${mergeBase}..${mergeHead}`, '--', conflictedFile.filePath);

      if (!culpritStdout) {
        return null;
      }

      const culprits = culpritStdout.split('\n');

      return {
        ...conflictedFile,
        culprits
      };
    })
    .value()));

  const getOtherCulprits = (filePath, currentCulprit) => _.without(
    _(conflicts).find({filePath}).culprits,
    currentCulprit
  );

  const culpritCommits = await pProps(_(conflicts)
    .map(({culprits, ...rest}) => culprits.map(culprit => ({culprit, ...rest})))
    .flatten()
    .groupBy('culprit')
    .mapValues(async (conflicts, culprit) => {
      const separator = '|';
      const culpritStdout = await execGit('show', culprit, '--quiet', `--format=%ce${separator}%s${separator}%ad`);
      const [email, subject, date] = culpritStdout.split(separator);
      return {
        email, 
        subject,
        date,
        conflicts
      };
    })
    .value());

  console.log('Git XX status code is <us><them>');
  _(culpritCommits)
    .toPairs()
    .sortBy(([, {date}]) => date)
    .reverse()
    .forEach(([culprit, {conflicts, email, subject, date}]) => {
      console.log(`${chalk.cyan(culprit)} ${chalk.green(email)} ${chalk.red(subject)} ${date}`);
      conflicts.forEach(({filePath, modificationCode}) => {
        const otherCulprits = getOtherCulprits(filePath, culprit);
        const otherCulpritMessage = otherCulprits.length 
          ? ` (Also modified on ${otherCulprits.map(culprit => chalk.cyan(culprit)).join(', ')}.)`
          : '';
        console.log(`\t* ${chalk.magenta(modificationCode)} ${chalk.yellow(filePath)}${otherCulpritMessage}`);
      });
    });
}

main();