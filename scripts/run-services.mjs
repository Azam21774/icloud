import { spawn } from 'node:child_process';

const mode = process.env.RUN_MODE === 'start' ? 'start' : 'dev';
const apiPort = process.env.API_PORT || '3001';
const webPort = process.env.WEB_PORT || process.env.PORT || '5000';
const webBasePath = process.env.BASE_PATH || '/';
const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
let shuttingDown = false;

const services = [
  {
    name: 'API server',
    args: ['--filter', '@workspace/api-server', 'run', mode],
    env: { PORT: apiPort },
  },
  {
    name: 'Web app',
    args: ['--filter', '@workspace/icloud-invitations', 'run', mode],
    env: { PORT: webPort, API_PORT: apiPort, BASE_PATH: webBasePath },
  },
];

const children = services.map((service) => {
  const child = spawn(packageManager, service.args, {
    stdio: 'inherit',
    env: { ...process.env, ...service.env },
  });
  child.on('error', (error) => {
    process.stderr.write(`${service.name} failed to start: ${error.message}\n`);
    stopAll(1);
  });
  child.on('exit', (code) => {
    if (!shuttingDown) {
      process.stderr.write(`${service.name} stopped unexpectedly.\n`);
      stopAll(code && code > 0 ? code : 1);
    }
  });
  return child;
});

function stopAll(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  const forceExit = setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 5000);
  forceExit.unref();
}

process.on('SIGINT', () => stopAll(130));
process.on('SIGTERM', () => stopAll(143));