import { execFileSync } from 'node:child_process';

try {
  execFileSync('git', ['config', 'core.hooksPath', '.git-hooks'], {
    stdio: 'ignore',
  });
} catch {
  // Not a git repository (e.g. Docker build). Hooks are irrelevant here.
}