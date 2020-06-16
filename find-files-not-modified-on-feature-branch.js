#! /usr/bin/env node

const execa = require('execa');
const _ = require('lodash');
const pProps = require('p-props');
const pLimit = require('p-limit');
const chalk = require('chalk');
const Progress = require('progress');
const yargs = require('yargs');
const os = require('os');

require('hard-rejection/register');

const execGit = async (...args) => (await execa('git', args)).stdout;

async function main() {
  const {argv} = yargs
    .option('baseBranch', {
      describe: 'You are looking for files that were only modified on this branch.',
      default: 'master'
    })
    .option('compareBranch', {
      default: 'head',
      describe: "This is the branch you're trying to bring in closer sync with baseBranch."
    })
    .option('concurrentGitProcesses', {
      describe: 'The number of concurrent git processes that will be run.',
      default: os.cpus().length - 2
    })
    .option('excludeCommits', {
      describe: 'When looking for commits on the compare branch and not the base branch, ' +
        'ignore these commits from the base branch. You may use this if you have automated transformations, like a ' +
        "codemod, on the compare branch, but you don't want to consider those as changes for the purpose of " +
        'this search.',
      type: 'array'
    });
    
  const trackedFiles = (await execGit('ls-tree', '-r', 'master', '--name-only')).split('\n');
    
  const progressBar = new Progress(':bar (:percent)', {total: trackedFiles.length});
  const promiseLimit = pLimit(argv.concurrentGitProcesses);
  const commitFilePairs = await Promise.all(trackedFiles.map(async filePath => {
    progressBar.tick();
    const compareBranchCommits = (promiseLimit(await execGit(
      'log', '--format=%H', '--no-merges', argv.compareBranch, `^${argv.baseBranch}`, '--', filePath
    ))).split('\n');
    const commitsToReport = _.difference(compareBranchCommits, argv.excludeCommits);
    return [filePath, commitsToReport];
  }))

  const filesNotModifiedOnFeatureBranch = _.filter(commitFilePairs, ([, commitsToReport]) => commitsToReport.length);
  filesNotModifiedOnFeatureBranch.forEach(file => console.log(file));
}

main();