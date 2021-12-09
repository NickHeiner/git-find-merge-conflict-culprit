#! /usr/bin/env node

import yargs from 'yargs';
import execa from 'execa';
import createLogger from 'nth-log';
import {stringify as csvStringify} from 'csv-stringify/sync';

const log = createLogger.default({name: 'repo-timeseries'});

const {argv} = yargs(process.argv)
  .options({
    repo: {
      alias: 'r',
      type: 'string',
      default: process.cwd(),
      description: 'The repo to query. Defaults to the current working directory.'
    },
    sinceDate: {
      alias: 'd',
      type: 'string',
      description: 'If provided, a date to pass to `git rev-list --since`.' +
        'See the format required in https://git-scm.com/docs/git-rev-list.'
    }
  })
  .strict();

async function queryFileExtensionCount(gitRef) {
  const trackedFiles = (await execa('git', ['ls-tree', '-r', '--name-only', gitRef])).stdout.split('\n');

  const countMatchingRegex = regex => trackedFiles.filter(filePath => regex.test(filePath)).length;

  const countJsFiles = countMatchingRegex(/\.js$/);
  const countTsFiles = countMatchingRegex(/\.tsx?$/);

  log.debug({gitRef, trackedFiles, countJsFiles, countTsFiles}, 'ls-tree');

  return {
    countJsFiles,
    countTsFiles,
    countCombined: countJsFiles + countTsFiles
  };
}

async function runQuery() {
  const revListArgs = ['rev-list', '--reverse'];
  if (argv.sinceDate) {
    revListArgs.push(`--since=${argv.sinceDate}`);
  }
  revListArgs.push('HEAD');
  const {stdout: revListResult} = await execa('git', revListArgs);
  const commits = revListResult.split('\n');

  return Promise.all(commits.map(async commit => ({
    commit,
    ...(await queryFileExtensionCount(commit))
  })));
}

async function main() {
  try {
    log.trace(argv);
    const result = await runQuery();
    log.debug({result});
    const csv = csvStringify(result, {header: true});
    console.log(csv);
  } catch (e) {
    // Just stringifying the error may omit some fields we care about.
    console.log(e);
    process.exit(1);
  }
}

main();