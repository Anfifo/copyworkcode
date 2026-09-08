import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HOME_ENV } from '../src/core/dataHome';

// Loaded before any test file, so every test that touches the store writes
// under a folder of its own, whether or not it asked for one.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-test-home-'));
process.env[HOME_ENV] = home;
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
