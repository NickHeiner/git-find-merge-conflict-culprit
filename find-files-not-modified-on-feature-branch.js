#! /usr/bin/env node

const _ = require('lodash');
const pLimit = require('p-limit');
const pSeries = require('p-series');
const Progress = require('progress');
const yargs = require('yargs');
const os = require('os');
const log = require('nth-log');
const path = require('path');
const makeDir = require('make-dir');
const execa = require('execa');

require('hard-rejection/register');

const execaWithLogging = (command, args, level = 'trace') => log.logStep(
  {args: args.join(' '), step: `spawning ${command}`, level}, 
  async (logProgress, updateLogMetadata) => {
    const process = await execa(command, args);
    updateLogMetadata(_.pick(process, 'stdout', 'stderr', 'code'));
    return process.stdout;
  });

const execGit = (...args) => execaWithLogging('git', args, 'trace');

/**
 * Sometimes, when doing a merge commit, I'd do the migration as part of the merge commit. That'll produce changes
 * we want to keep around. However, this tool will not consider those commits to be a sign that the file is
 * legitimately modified on the feature-branch. That means that this tool is overzealous in how many files it tries
 * to reset to the base branch.
 * 
 * If there are commits that you wanted to exclude but failed to do, then it's a real pain to go back and re-exclude 
 * them. Make it easier to verify that all the commits you want to exclude are excluded.
 * 
 * I think I'm also observing this changing files too eagerly.
 */

async function main() {
  const {argv} = yargs
    .strict()
    // Base and Compare may be misleading names.
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
    .option('includeFiles', {
      describe: 'Only change files in this set. Combined with loglevel=trace, this can be helpful for debugging ' +
        'why a specific file is modified or not.',
      type: 'array'
    })
    .option('excludeFiles', {
      describe: 'Never change these files. ' +
      // This rule is too broad.
      // eslint-disable-next-line quotes
        `Use this option to filter out false positives, where the tool resets the file to "baseBranch", but shouldn't.`,
      default: [],
      type: 'array'
    })
    .option('logFilesToCheckAndStop', {
      describe: 'Log files to check, then stop. Implies `dry`.',
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

  const excludeCommitFullHashes = 
    await Promise.all(argv.excludeCommits.map(hash => promiseLimit(() => execGit('rev-parse', hash))));

  log.debug({..._.pick(argv, 'excludeCommits'), excludeCommitFullHashes}, 'Expanded exclude commit short hashes.');

  // We want to use --name-status instead of --name-only. Renamed files won't appear in --name-only.
  // This also makes the entire script much faster. The long poll is calling `log` on every changed file. 
  // With --name-only, we have to call `log` on more files, because --name-status tells us which files were modified,
  // whereas --name-only lists all files that were added/removed/modified/etc. In my current runs, this means that we're
  // running `log` on 50% as many files.
  const files = parseNameStatus(
    // We want it to be compare..mergeBase, because if a file was deleted in compare, we want it to show up in the diff
    // as `added`, because then the rest of this code reads better. 
    (await execGit('diff', `${argv.compareBranch}..${mergeBase}`, '--name-status')).split('\n'),
    _.pick(argv, 'includeFiles', 'excludeFiles')
  );

  if (argv.logFilesToCheckAndStop) {
    log.warn({files});
    return;
  }

  const filesNotModifiedOnCompareBranch = await findErroneouslyModifiedFiles();

  const filesThatOnlyExistOnCompareBranchButWereNotModifiedThere = 
    _.intersection(filesNotModifiedOnCompareBranch, files.removed);

  log.info({
    toDelete: filesThatOnlyExistOnCompareBranchButWereNotModifiedThere,
    toDeleteCount: filesThatOnlyExistOnCompareBranchButWereNotModifiedThere.length,
    toCheckOut: filesNotModifiedOnCompareBranch,
    toCheckOutCount: filesNotModifiedOnCompareBranch.length,
    toMove: files.fullyRenamed,
    toMoveCount: files.fullyRenamed.length
  });

  if (argv.dry) {
    log.warn('Not modifying the local directory. Pass `--dry false` to modify.');
  } else {
    const toCheckOut = [...filesNotModifiedOnCompareBranch, ...files.added];
    if (toCheckOut.length) {
      await execGit('checkout', mergeBase, '--', ...toCheckOut);
    }
    if (filesThatOnlyExistOnCompareBranchButWereNotModifiedThere.length) {
      await execGit('rm', ...filesThatOnlyExistOnCompareBranchButWereNotModifiedThere);
    }
    await pSeries(files.fullyRenamed.map(({nameOnBase, nameOnCompare}) => async () => {
      await makeDir(path.dirname(nameOnBase));
      return execGit('mv', nameOnCompare, nameOnBase);
    }));
  }

  async function findErroneouslyModifiedFiles() {
    // This will look a bit funny when it updates, because it doesn't update at a constant interval. (It updates
    // whenever a new git process is spawned.)
    const progressBar = new Progress(':elapseds :bar (:current/:total | :percent)', {total: files.modified.length});
  
    const commitFilePairs = await Promise.all(files.modified.map(async filePath => {
      const compareBranchCommits = (await (promiseLimit(() => {
        progressBar.tick();
        // This will sometimes erroneously return no output. I believe it's related to interactive v. non-interactive
        // mode. If you execute this command on the shell, you'll get output. If you do `command | cat`, you won't.
        return execGit('log', '--format=%H', '--no-merges', argv.compareBranch, `^${mergeBase}`, '--', filePath);
      }))).split('\n');
      const commitsToReport = _(compareBranchCommits)
        .difference(excludeCommitFullHashes)
        .compact()
        .value();
  
      log.trace({filePath, commitsToReport, compareBranchCommits});
      
      return [filePath, commitsToReport];
    }));
  
    return _.reject(commitFilePairs, ([, commitsToReport]) => commitsToReport.length)
      .map(([file]) => file);
  }
}

function parseNameStatus(nameStatusOutputLines, {includeFiles, excludeFiles}) {
  const parsed = _(nameStatusOutputLines)
    .map(line => line.split('\t'))
    .groupBy(([status]) => status)
    .mapValues((pairs, status) => pairs.flatMap(line => {
      const fileNames = line.slice(1);
      if ((includeFiles && !_.intersection(fileNames, includeFiles).length) || 
          _.intersection(fileNames, excludeFiles).length) {
        return null;
      }
      if (status === 'R100') {
        return {
          // This ordering is dependent on us passing "base..compare" to git diff above, as opposed to "compare..base".
          nameOnBase: line[2], 
          nameOnCompare: line[1] 
        };
      }
      return fileNames;
    }))
    .mapValues(files => _.compact(files))
    .value();

  const knownKeys = ['A', 'D', 'M', 'R100'];
  const unknownKeys = _.difference(Object.keys(parsed), knownKeys);
  if (unknownKeys.length) {
    throw new Error(
      `Bug: parseNameStatus() saw one or more diff codes in --name-status that it did not recognize: ${unknownKeys}`
    );
  }

  return {
    added: parsed.A || [],
    removed: parsed.D || [],
    modified: parsed.M || [],
    fullyRenamed: parsed.R100 || []
  };
}

main();