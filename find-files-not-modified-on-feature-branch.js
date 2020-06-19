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

/**
 * Sometimes, when doing a merge commit, I'd do the migration as part of the merge commit. That'll produce changes
 * we want to keep around. However, this tool will not consider those commits to be a sign that the file is
 * legitimately modified on the feature-branch. That means that this tool is overzealous in how many files it tries
 * to reset to the base branch.
 * 
 * Git seems to use --name-status = "D" when a file was renamed, under certain circumstances. I'm not sure this tool
 * handles that case properly.
 * 
 * If there are commits that you wanted to exclude but failed to do, then it's a real pain to go back and re-exclude 
 * them. Make it easier to verify that all the commits you want to exclude are excluded.
 * 
 * I think I'm also observing this changing files too eagerly.
 */

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
    })
    .option('dry', {
      describe: 'Log plan without taking action.',
      default: true,
      type: 'boolean'
    });

  const promiseLimit = pLimit(argv.concurrentGitProcesses);

  const mergeBase = await execGit('merge-base', argv.baseBranch, argv.compareBranch);

  // This may omit files that appear only in `mergeBase`.
  // We may want to use `baseFiles` here instead, for a more exhaustive search.
  const differentFiles = (await execGit('diff', `${mergeBase}..${argv.compareBranch}`, '--name-only')).split('\n');
  const excludeCommitFullHashes = 
    await Promise.all(argv.excludeCommits.map(hash => promiseLimit(() => execGit('rev-parse', hash))));

  log.debug({..._.pick(argv, 'excludeCommits'), excludeCommitFullHashes}, 'Expanded exclude commit short hashes.');

  // This will look a bit funny when it updates, because it doesn't update at a constant interval. (It updates
  // whenever a new git process is spawned.)
  const progressBar = new Progress(':elapseds :bar (:current/:total | :percent)', {total: differentFiles.length});

  const commitFilePairs = await Promise.all(differentFiles.map(async filePath => {
    const compareBranchCommits = (await (promiseLimit(() => {
      progressBar.tick();
      return execGit('log', '--format=%H', '--no-merges', argv.compareBranch, `^${mergeBase}`, '--', filePath);
    }))).split('\n');
    const commitsToReport = _(compareBranchCommits)
      .difference(excludeCommitFullHashes)
      .compact()
      .value();
    return [filePath, commitsToReport];
  }));

  const filesNotModifiedOnCompareBranch = _.reject(commitFilePairs, ([, commitsToReport]) => commitsToReport.length)
    .map(([file]) => file);

  // Using `--name-status` with the diff between compare and base could be a better alternative here.
  const baseFiles = (await execGit('ls-tree', '-r', '--name-only', mergeBase)).split('\n');

  const filesThatOnlyExistOnCompareBranchButWereNotModifiedThere = 
    _.difference(filesNotModifiedOnCompareBranch, baseFiles);

  const filesThatAlsoExistOnBaseBranch = _.intersection(filesNotModifiedOnCompareBranch, baseFiles);

  log.info({
    toDelete: filesThatOnlyExistOnCompareBranchButWereNotModifiedThere,
    toDeleteCount: filesThatOnlyExistOnCompareBranchButWereNotModifiedThere.length,
    toCheckOut: filesThatAlsoExistOnBaseBranch,
    toCheckOutCount: filesThatAlsoExistOnBaseBranch.length
  });

  if (argv.dry) {
    log.warn('Not modifying the local directory. Pass `--dry false` to modify.');
  } else {
    await execGit('checkout', mergeBase, '--', ...filesThatAlsoExistOnBaseBranch);
    await execGit('rm', ...filesThatOnlyExistOnCompareBranchButWereNotModifiedThere);
  }

  // if (argv.bareOutput) {
  //   filesNotModifiedOnCompareBranch.forEach(file => console.log(file.replace(' ', '\ ')));
  // } else {
  //   log.info({
  //     countTrackedFiles: differentFiles.length,
  //     countFilesNotModifiedOnCompareBranch: filesNotModifiedOnCompareBranch.length,
  //     filesNotModifiedOnCompareBranch
  //   }, 'Complete.');
  // }
}

main();