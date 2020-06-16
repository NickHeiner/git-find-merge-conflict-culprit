#! /usr/bin/env node

const execa = require('execa');
const _ = require('lodash');
const pLimit = require('p-limit');
const Progress = require('progress');
const yargs = require('yargs');
const os = require('os');
const log = require('nth-log');

require('hard-rejection/register');

const execGit = async (...args) => {
  log.trace({args}, 'Spawning git');
  return (await execa('git', args)).stdout;
};

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
      default: os.cpus().length - 1
    })
    .option('excludeCommits', {
      describe: 'When looking for commits on the compare branch and not the base branch, ' +
        'ignore these commits from the base branch. You may use this if you have automated transformations, like a ' +
        "codemod, on the compare branch, but you don't want to consider those as changes for the purpose of " +
        'this search.',
      default: [],
      type: 'array'
    })
    .option('bareOutput', {
      describe: 'Output a newline-separated list of files. Useful for scripting. ' +
        'You probably want to use this in conjunction with env var loglevel=warn.',
      default: false,
      type: 'boolean'
    });

  const promiseLimit = pLimit(argv.concurrentGitProcesses);
    
  const trackedFiles = (await promiseLimit(() => execGit('ls-tree', '-r', 'master', '--name-only'))).split('\n');
  const excludeCommitFullHashes = 
    await Promise.all(argv.excludeCommits.map(hash => promiseLimit(() => execGit('rev-parse', hash))));

  log.debug({..._.pick(argv, 'excludeCommits'), excludeCommitFullHashes}, 'Expanded exclude commit short hashes.');

  const progressBar = new Progress(':bar (:percent)', {total: trackedFiles.length});
  const commitFilePairs = await Promise.all(trackedFiles.map(async filePath => {
    const compareBranchCommits = (await (promiseLimit(() => {
      progressBar.tick();
      return execGit('log', '--format=%H', '--no-merges', argv.compareBranch, `^${argv.baseBranch}`, '--', filePath);
    }))).split('\n');
    const commitsToReport = _(compareBranchCommits)
      .difference(excludeCommitFullHashes)
      .compact()
      .value();
    return [filePath, commitsToReport];
  }));

  const filesNotModifiedOnCompareBranch = _.reject(commitFilePairs, ([, commitsToReport]) => commitsToReport.length);

  log.info({
    countTrackedFiles: trackedFiles.length,
    countFilesNotModifiedOnCompareBranch: filesNotModifiedOnCompareBranch.length
  }, 'Complete.');

  filesNotModifiedOnCompareBranch.forEach(([file, commits]) => log.debug({file, commits}));

  if (argv.bareOutput) {
    filesNotModifiedOnCompareBranch.map(([file]) => file).forEach(file => console.log(file));
  }
}

main();