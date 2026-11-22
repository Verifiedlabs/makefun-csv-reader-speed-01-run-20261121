import { closeSync, openSync, readFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';
import { transduceToFd } from './solve.js';

process.umask(0o022);
setFlagsFromString('--no-incremental-marking --no-concurrent-marking --no-turbofan --no-concurrent-recompilation --no-lazy-feedback-allocation');

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const inBuf = readFileSync(`${INPUT_DIR}/cases.json`);
const fd = openSync(`${OUTPUT_DIR}/answers.json`, 'w', 0o644);
transduceToFd(inBuf, fd);
closeSync(fd);
