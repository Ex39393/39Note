import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)));
const verifiers = [
  {
    id: 'targeted-purge',
    label: 'Targeted Purge and responsive UI',
    path: join(workspace, 'scripts', 'verify-targeted-purge-home-native.mjs'),
  },
  {
    id: 'restore-phase-b',
    label: 'Restore Phase B IndexedDB safety',
    path: join(workspace, 'scripts', 'verify-restore-phase-b-native.mjs'),
  },
  {
    id: 'restore-phase-c',
    label: 'Restore Phase C crash recovery',
    path: join(workspace, 'scripts', 'verify-restore-phase-c-native.mjs'),
  },
];

const browsers = [
  {
    id: 'chrome',
    label: 'Google Chrome',
    paths: [
      process.env.LOCALAPPDATA
        ? join(
            process.env.LOCALAPPDATA,
            'Google',
            'Chrome',
            'Application',
            'chrome.exe',
          )
        : '',
      process.env.PROGRAMFILES
        ? join(
            process.env.PROGRAMFILES,
            'Google',
            'Chrome',
            'Application',
            'chrome.exe',
          )
        : '',
      process.env['PROGRAMFILES(X86)']
        ? join(
            process.env['PROGRAMFILES(X86)'],
            'Google',
            'Chrome',
            'Application',
            'chrome.exe',
          )
        : '',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ],
  },
  {
    id: 'edge',
    label: 'Microsoft Edge',
    paths: [
      process.env.LOCALAPPDATA
        ? join(
            process.env.LOCALAPPDATA,
            'Microsoft',
            'Edge',
            'Application',
            'msedge.exe',
          )
        : '',
      process.env.PROGRAMFILES
        ? join(
            process.env.PROGRAMFILES,
            'Microsoft',
            'Edge',
            'Application',
            'msedge.exe',
          )
        : '',
      process.env['PROGRAMFILES(X86)']
        ? join(
            process.env['PROGRAMFILES(X86)'],
            'Microsoft',
            'Edge',
            'Application',
            'msedge.exe',
          )
        : '',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
  },
].map((browser) => ({
  ...browser,
  executable: browser.paths.find((candidate) => candidate && existsSync(candidate)),
}));

const missing = browsers.filter((browser) => !browser.executable);
if (missing.length) {
  throw new Error(
    `The native browser matrix requires ${missing.map((browser) => browser.label).join(' and ')}.`,
  );
}

for (const browser of browsers) {
  console.log(`\nBROWSER MATRIX — ${browser.label}`);
  for (const verifier of verifiers) {
    console.log(`\n${verifier.label}`);
    const exitCode = await runVerifier(verifier.path, browser.executable, browser.id);
    if (exitCode !== 0) {
      throw new Error(
        `${browser.label} ${verifier.id} verification exited with code ${exitCode}.`,
      );
    }
  }
}

console.log(
  '\nPASS — Chrome and Edge passed desktop, 390×844 touch, and Restore Phase B/C verification',
);

function runVerifier(verifier, executable, label) {
  return new Promise((resolveExit, rejectExit) => {
    const child = spawn(process.execPath, [verifier], {
      cwd: workspace,
      env: {
        ...process.env,
        BROWSER_MATRIX_LABEL: label,
        CHROME_PATH: executable,
      },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => {
      if (signal) {
        rejectExit(new Error(`${label} verification was terminated by ${signal}.`));
        return;
      }
      resolveExit(code ?? 1);
    });
  });
}
