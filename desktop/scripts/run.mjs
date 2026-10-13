#!/usr/bin/env node
// Starts the built app with Electron, passing any arguments on (`--self-test`, an address...).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');

const env = { ...process.env };
// Editors built on Electron set this in their terminals; with it, Electron would start as
// plain Node and the app would not open.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [DESKTOP, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
