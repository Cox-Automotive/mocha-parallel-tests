'use strict';

import EventEmitter from 'events';
import path from 'path';
import debug from 'debug';
import Mocha from 'mocha';
import RequireCacheWatcher from './utils/require-cache-watcher';

const debugLog = debug('mocha-parallel-tests:watcher');
const cacheWatcher = new RequireCacheWatcher;
const pendingTests = [];
const testsList = [];

let maxParallel = Number.POSITIVE_INFINITY;
let retryCount = 0;
let ignoreStdOutput = false;

const runners = new Map;
const testFilesFailes = new Map;

const streams = ['stderr', 'stdout'];
const originalWrites = {};

export const stdStreamsEmitter = new EventEmitter;
stdStreamsEmitter.setMaxListeners(0); // Disable EventEmitter memory leak warning

// empty function
const noop = () => {};

const getRunnerId = (testFile, suiteIndex) => {
    return `${testFile}:${suiteIndex}`;
};

/**
 * Get intersection between arrays
 * 
 * @param {Array} a
 * @param {Array} b
 * @return {Array}
 */
const intersection = (a, b) => {
    const bSet = new Set(b);
    const commonElementsSet = new Set(a.filter(x => bSet.has(x)));

    return [...commonElementsSet];
};

const getSuiteFile = executionStack => {
    const stackFiles = executionStack.split('\n').reduce((stackFiles, chunk) => {
        const matches = chunk.match(/\((.+?):[\d]+:[\d]+\)/);

        if (matches && !stackFiles.includes(matches[1])) {
            stackFiles.push(matches[1]);
        }

        return stackFiles;
    }, []);

    const commonFiles = intersection(stackFiles, testsList);
    return commonFiles.length ? commonFiles[0] : null;
};

const getSuiteHumanIndex = (suiteIndex) => {
    return (suiteIndex === -1) ? '(all)' : `#${suiteIndex}`;
};

const scheduleMochaRun = ({file, suiteIndex = -1, options, throttledCalls}) => {
    const relativeFile = path.relative(__filename, file);
    const fileRunners = [];
    const suiteHumanIndex = getSuiteHumanIndex(suiteIndex);

    debugLog(`Run mocha suite ${suiteHumanIndex} from file: ${relativeFile}`);

    // start ignoring std output
    ignoreStdOutput = true;

    const stateMark = cacheWatcher.getStateMark();
    cacheWatcher.flushRequireCache(stateMark);

    const mocha = new Mocha();
    mocha.addFile(file);

    /**
     * Suites are stored inside `mocha.suite.suites` array
     * but it's populated only after mocha.run() is called.
     *
     * The fact is that when mocha.run() is called
     * it loads test files first with mocha.loadFiles()
     *
     * What mocha.loadFiles() does is: it iterates over all test files
     * and emits 3 events: "pre-require", "require" and "post-require"
     *
     * "pre-require" is somewhat intresting to us:
     * it populates hook functions needed for suite execution (before, beforeAll etc)
     *
     * "require" and "post-require" are not so much intresting but "require" requires test files
     * which leads to populating `suites` property of `mocha.suite`.
     *
     * At the same time nothing has happened to this moment, so it's safe to just stop here
     * and realize how much suites does the file have
     *
     * loadFiles() requires test files which can also require files
     * these files should be then removed from require cache
     * @see https://github.com/yandex/mocha-parallel-tests/issues/39
     */
    mocha.loadFiles();
    debugLog(`Suites length is ${mocha.suite.suites.length} for ${file}`);

    // stop watching require.cache changes
    const beforeTestsRunCacheStateMark = cacheWatcher.getStateMark(); 

    // stop ignoring std output
    ignoreStdOutput = false;

    const onEnd = suiteIndex => {
        const suiteHumanIndex = getSuiteHumanIndex(suiteIndex);

        return () => {
            debugLog(`Suite ${suiteHumanIndex} processed (success): ${relativeFile}`);

            const runnerId = getRunnerId(file, suiteIndex);
            runners.delete(runnerId);

            // run pending tests if any
            if (runners.size || pendingTests.length) {
                runTestsRecursive({options, throttledCalls});
            }
        };
    };

    const onFail = suiteIndex => {
        const runnerId = getRunnerId(file, suiteIndex);
        const suiteHumanIndex = getSuiteHumanIndex(suiteIndex);

        return testArg => {
            if (!testArg.file && testArg.type !== 'hook') {
                return;
            }

            debugLog(`Suite ${suiteHumanIndex} processed (fail): ${relativeFile}`);

            testFilesFailes.set(
                runnerId,
                testFilesFailes.get(runnerId) + 1
            );

            // if number of fails of this file exceeds retryCount, do nothing
            // otherwise re-add this file into queue
            if (testFilesFailes.get(runnerId) <= retryCount) {
                originalWrites.stderr(`[${relativeFile}]:[${suiteIndex}] try #${testFilesFailes.get(runnerId)} failed: ${testArg.err.message}\n`);

                // notify reporter about retry
                fileRunners[suiteIndex].emit('failRetry', file);

                // stop listening to `end` event
                fileRunners[suiteIndex].removeAllListeners('end');

                // and mock all further events
                fileRunners[suiteIndex].emit = noop;

                // send event to reporter constructor
                // so that it can clear intercepted messages
                stdStreamsEmitter.emit('fail', file);

                debugLog(`Test failed, re-run it: ${relativeFile}`);
                runners.delete(runnerId);

                // remove test file from require.cache otherwise it won't run
                delete require.cache[file];

                // re-add test file back to queue
                addTest(file, suiteIndex);

                // re-run pending tests
                runTestsRecursive({options, throttledCalls});
            }
        };
    };

    // files without test suites have zero length of `mocha.suite.suites` array
    const testsSuites = Math.max(mocha.suite.suites.length, 1);

    if (testsSuites > 1 && suiteIndex === -1) {
        // if file contains more than 1 test suite, options.testsLength should be increased
        // otherwise reporter doesn't know anything about this file and could emit end before
        // it should actually be emitted
        options.testsLength += testsSuites - 1;
    }

    for (let i = 0; i < testsSuites; i++) {
        if (suiteIndex !== -1 && suiteIndex !== i) {
            continue;
        }

        /**
         * Suites are being populated by calling describe
         * Describe(), before() and after() are set via global.describe in mocha itself
         * The only way we can re-run describes is to clear cache associated with the test file
         */
        cacheWatcher.flushRequireCache(beforeTestsRunCacheStateMark);

        const mocha = new Mocha(options);
        mocha.addFile(file);

        for (let {method, args} of throttledCalls) {
            mocha[method](...args);
        }

        /**
         * This is a simple hack to let all describes inside one file run in parallel.
         * Mocha emits 3 hooks: "pre-require" to populate hooks, "require" which does nothing
         * but require(testFile) is happening under the hood and "post-require" which is also
         * useless. Luckily it's useful for us: it's possible to change suites number inside
         * of post-require handler. Using this we can set `mocha` from the 1st loop to run
         * only 1st suite, `mocha` from the 2nd loop to run 2nd etc
         */
        mocha.suite.on('post-require', () => {
            // delete all suites except the one with current index
            if (mocha.suite.suites.length) {
                mocha.suite.suites = [mocha.suite.suites[i]];
            }
        });

        const runner = mocha.run();

        // delayed tests emit `waiting` event
        // however simple javascript files are executed without timeout
        // and by this time `end` event has already happened
        // we also can't subscribe to `start` event because it is synchronous
        // the only way to know does this file contain tests is `total` property of runner object
        if (runner.total) {
            runner
                .on('end', onEnd(i))
                .on('fail', onFail(i));
        } else {
            setImmediate(onEnd(i));
        }

        fileRunners.push(runner);
    }

    return fileRunners;
};

// save stream original functions for further calls
streams.forEach(streamName => {
    const stream = process[streamName];
    originalWrites[streamName] = stream.write.bind(stream);

    // mute standard streams
    // also replace process.stdout.write with process.stderr.write
    // because this is current mocha behaviour
    stream.write = arg => {
        // sometimes we need to ignore data which is written to std output
        // for instance when suites number calculation is in progress
        if (!ignoreStdOutput) {
            const currentExecStack = new Error().stack;
            const suiteTestFile = getSuiteFile(currentExecStack, arg);

            if (suiteTestFile) {
                stdStreamsEmitter.emit('message', {
                    streamName,
                    file: suiteTestFile,
                    message: arg
                });
            } else { // this write is from reporter
                originalWrites[streamName](arg);
            }
        }

        return stream;
    };
});

const runTestsRecursive = ({options, throttledCalls}) => {
    while (pendingTests.length) {
        if (runners.size === maxParallel) {
            debugLog(`Hit maximum parallel tests running number (${maxParallel}), wait`);
            break;
        }

        const {file: testFile, suiteIndex} = pendingTests.shift();
        const fileRunners = scheduleMochaRun({
            options,
            throttledCalls,
            suiteIndex,
            file: testFile
        });

        debugLog(`Chose test file from queue: ${path.relative(__filename, testFile)}`);

        fileRunners.forEach((runner, i) => {
            const runnerId = getRunnerId(testFile, i);

            testFilesFailes.set(runnerId, testFilesFailes.get(runnerId) || 0);
            runners.set(runnerId, runner);
        });
    }
};

export const setOptions = options => {
    maxParallel = options.maxParallelTests;
    retryCount = options.retryCount || 0;
};

export const addTest = (file, suiteIndex = -1) => {
    pendingTests.push({file, suiteIndex});
    testsList.push(file);
};

export const runTests = ({
    options,
    throttledCalls = []
}) => {
    cacheWatcher.start();

    runTestsRecursive({
        options,
        throttledCalls
    });
};
